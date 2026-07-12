import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LspManager } from "../src/lsp/manager.js";
import { executeLspDiagnostics } from "../src/tools.js";

const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const FIXTURE_READY_TIMEOUT_MS = 3_000;
const PROMPT_ABORT_TIMEOUT_MS = 500;

type ProcessTreePids = {
	readonly wrapper: number;
	readonly descendant: number;
};

class FakeCargoReadinessTimeoutError extends Error {
	override readonly name = "FakeCargoReadinessTimeoutError";
}

class PromptAbortTimeoutError extends Error {
	override readonly name = "PromptAbortTimeoutError";
}

let fixtureDirectory = "";
let rustProjectDirectory = "";
let wrapperPidFile = "";
let descendantPidFile = "";
let previousPath: string | undefined;
let previousNodeOptions: string | undefined;
let previousProjectConfig: string | undefined;
let previousUserConfig: string | undefined;
const activePids = new Set<number>();

function write(relativePath: string, content: string): string {
	const absolute = join(rustProjectDirectory, relativePath);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
	return absolute;
}

function readPid(path: string): number | undefined {
	if (!existsSync(path)) return undefined;
	const pid = Number(readFileSync(path, "utf8"));
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function readProcessTreePids(): ProcessTreePids | undefined {
	const wrapper = readPid(wrapperPidFile);
	const descendant = readPid(descendantPidFile);
	return wrapper === undefined || descendant === undefined ? undefined : { wrapper, descendant };
}

function waitForProcessTree(): Promise<ProcessTreePids> {
	return new Promise((resolveReady, rejectReady) => {
		let timeout: NodeJS.Timeout | undefined;
		let interval: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (timeout !== undefined) clearTimeout(timeout);
			if (interval !== undefined) clearInterval(interval);
		};
		const fail = (error: Error) => {
			cleanup();
			rejectReady(error);
		};
		function readReadyPids(): void {
			const pids = readProcessTreePids();
			if (pids === undefined) return;
			cleanup();
			activePids.add(pids.wrapper);
			activePids.add(pids.descendant);
			resolveReady(pids);
		}

		timeout = setTimeout(
			() =>
				fail(
					new FakeCargoReadinessTimeoutError(
						`fake Cargo process tree did not become ready (wrapper=${String(readPid(wrapperPidFile))}, descendant=${String(readPid(descendantPidFile))})`,
					),
				),
			FIXTURE_READY_TIMEOUT_MS,
		);
		interval = setInterval(readReadyPids, 25);
		if (typeof interval.unref === "function") interval.unref();
		readReadyPids();
	});
}

function isMissingProcessError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isMissingProcessError(error)) return false;
		throw error;
	}
}

function killPidBestEffort(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (!isMissingProcessError(error)) throw error;
	}
}

async function expectProcessTreeGone(pids: ProcessTreePids): Promise<void> {
	await expect
		.poll(() => ({ wrapper: isPidAlive(pids.wrapper), descendant: isPidAlive(pids.descendant) }), {
			timeout: PROCESS_EXIT_TIMEOUT_MS,
			interval: 25,
		})
		.toEqual({ wrapper: false, descendant: false });
}

async function expectPromptAbort(promise: Promise<unknown>): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		const timeoutPromise = new Promise<never>((_resolveTimeout, rejectTimeout) => {
			timeout = setTimeout(
				() =>
					rejectTimeout(new PromptAbortTimeoutError("directory diagnostics did not reject promptly after abort")),
				PROMPT_ABORT_TIMEOUT_MS,
			);
		});
		await expect(Promise.race([promise, timeoutPromise])).rejects.toMatchObject({ name: "AbortError" });
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function waitForCargoStart(diagnostics: Promise<unknown>): Promise<ProcessTreePids> {
	return Promise.race([
		waitForProcessTree(),
		diagnostics.then(
			() => {
				throw new Error("directory diagnostics resolved before fake Cargo started");
			},
			(error: unknown) => {
				throw error;
			},
		),
	]);
}

function restoreEnvironment(): void {
	if (previousPath === undefined) delete process.env["PATH"];
	else process.env["PATH"] = previousPath;
	if (previousNodeOptions === undefined) delete process.env["NODE_OPTIONS"];
	else process.env["NODE_OPTIONS"] = previousNodeOptions;
	if (previousProjectConfig === undefined) delete process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"];
	else process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"] = previousProjectConfig;
	if (previousUserConfig === undefined) delete process.env["LSP_TOOLS_MCP_USER_CONFIG"];
	else process.env["LSP_TOOLS_MCP_USER_CONFIG"] = previousUserConfig;
	delete process.env["FAKE_CARGO_WRAPPER_PID_FILE"];
	delete process.env["FAKE_CARGO_DESCENDANT_PID_FILE"];
	delete process.env["FAKE_CARGO_NODE_EXECUTABLE"];
}

describe("executeLspDiagnostics directory cancellation", () => {
	beforeEach(() => {
		fixtureDirectory = mkdtempSync(join(tmpdir(), "lsp-directory-cancel-"));
		rustProjectDirectory = join(fixtureDirectory, "project");
		const binaryDirectory = join(fixtureDirectory, "bin");
		mkdirSync(rustProjectDirectory);
		mkdirSync(binaryDirectory);
		wrapperPidFile = join(fixtureDirectory, "wrapper.pid");
		descendantPidFile = join(fixtureDirectory, "descendant.pid");

		const cargoExecutable = join(binaryDirectory, process.platform === "win32" ? "cargo.exe" : "cargo");
		if (process.platform === "win32") {
			copyFileSync(process.execPath, cargoExecutable);
		} else {
			writeFileSync(cargoExecutable, `#!/usr/bin/env node\nrequire("./fake-cargo.cjs")\n`);
			chmodSync(cargoExecutable, 0o755);
		}
		writeFileSync(
			join(binaryDirectory, "fake-cargo.cjs"),
			[
				'const { spawn } = require("node:child_process")',
				'const { writeFileSync } = require("node:fs")',
				'const wrapperPidFile = process.env["FAKE_CARGO_WRAPPER_PID_FILE"]',
				'const descendantPidFile = process.env["FAKE_CARGO_DESCENDANT_PID_FILE"]',
				'const nodeExecutable = process.env["FAKE_CARGO_NODE_EXECUTABLE"]',
				"if (wrapperPidFile === undefined || descendantPidFile === undefined || nodeExecutable === undefined) process.exit(2)",
				"const descendantEnv = { ...process.env }",
				'delete descendantEnv["NODE_OPTIONS"]',
				"const descendant = spawn(nodeExecutable, ['-e', 'setInterval(() => {}, 1000)'], {",
				"  env: descendantEnv,",
				"  stdio: 'ignore',",
				"  windowsHide: true,",
				"})",
				"if (descendant.pid === undefined) process.exit(3)",
				"writeFileSync(wrapperPidFile, String(process.pid))",
				"writeFileSync(descendantPidFile, String(descendant.pid))",
				"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)",
			].join("\n"),
		);
		writeFileSync(join(binaryDirectory, process.platform === "win32" ? "rust-analyzer.exe" : "rust-analyzer"), "");

		const projectConfigPath = join(fixtureDirectory, "lsp-client.json");
		writeFileSync(
			projectConfigPath,
			JSON.stringify({
				lsp: {
					rust: { command: ["rust-analyzer"], extensions: [".rs"], priority: 100 },
				},
			}),
		);

		previousPath = process.env["PATH"];
		previousNodeOptions = process.env["NODE_OPTIONS"];
		previousProjectConfig = process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"];
		previousUserConfig = process.env["LSP_TOOLS_MCP_USER_CONFIG"];
		process.env["PATH"] =
			previousPath === undefined ? binaryDirectory : `${binaryDirectory}${delimiter}${previousPath}`;
		if (process.platform === "win32") {
			process.env["NODE_OPTIONS"] = [
				previousNodeOptions,
				`--require=${JSON.stringify(join(binaryDirectory, "fake-cargo.cjs"))}`,
			]
				.filter((value) => value !== undefined && value.length > 0)
				.join(" ");
		}
		process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"] = projectConfigPath;
		process.env["LSP_TOOLS_MCP_USER_CONFIG"] = join(fixtureDirectory, "missing-user-config.json");
		process.env["FAKE_CARGO_WRAPPER_PID_FILE"] = wrapperPidFile;
		process.env["FAKE_CARGO_DESCENDANT_PID_FILE"] = descendantPidFile;
		process.env["FAKE_CARGO_NODE_EXECUTABLE"] = process.execPath;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const pid of activePids) killPidBestEffort(pid);
		activePids.clear();
		restoreEnvironment();
		rmSync(fixtureDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	it("#given a Rust directory with live Cargo metadata #when the request aborts #then diagnostics reject promptly and clean up before LSP acquisition", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "cancel-me"\nversion = "0.1.0"\nedition = "2021"\n');
		write("crates/a/src/lib.rs", "pub fn value() -> i32 { 1 }\n");
		write("crates/a/src/main.rs", "fn main() {}\n");
		write("crates/a/src/extra.rs", "pub const EXTRA: i32 = 2;\n");
		const getClientSpy = vi
			.spyOn(LspManager.prototype, "getClient")
			.mockImplementation((root, server) =>
				Promise.reject(
					new Error(`LspManager.getClient was called before cancellation (server=${server.id}, root=${root})`),
				),
			);
		const controller = new AbortController();
		const diagnostics = executeLspDiagnostics({ filePath: rustProjectDirectory }, controller.signal);
		void diagnostics.catch(() => undefined);
		const pids = await waitForCargoStart(diagnostics);
		expect({ wrapper: isPidAlive(pids.wrapper), descendant: isPidAlive(pids.descendant) }).toEqual({
			wrapper: true,
			descendant: true,
		});

		// When
		controller.abort();

		// Then
		await expectPromptAbort(diagnostics);
		await expectProcessTreeGone(pids);
		expect(getClientSpy).not.toHaveBeenCalled();
	}, 10_000);
});

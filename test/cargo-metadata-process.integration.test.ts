import { type ChildProcess, spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultCargoMetadataLoader } from "../src/lsp/cargo-metadata-process.js";

const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const FIXTURE_READY_TIMEOUT_MS = 3_000;
const CLI_EXIT_TIMEOUT_MS = 2_000;
const CARGO_METADATA_PROCESS_SIGNALS: readonly NodeJS.Signals[] =
	process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
const CLI_TERMINATION_SIGNALS: readonly NodeJS.Signals[] = process.platform === "win32" ? [] : ["SIGTERM", "SIGINT"];

type ProcessTreePids = {
	readonly wrapper: number;
	readonly descendant: number;
};

type ProcessSignalListener = (...args: never[]) => unknown;

class FakeCargoReadinessTimeoutError extends Error {
	override readonly name = "FakeCargoReadinessTimeoutError";
}

let fixtureDirectory = "";
let binaryDirectory = "";
let preloadPath = "";
let wrapperPidFile = "";
let descendantPidFile = "";
const activePids = new Set<number>();

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

async function waitForProcessTree(): Promise<ProcessTreePids> {
	await expect.poll(() => readProcessTreePids(), { timeout: FIXTURE_READY_TIMEOUT_MS, interval: 10 }).toBeDefined();
	const pids = readProcessTreePids();
	if (pids === undefined) {
		throw new FakeCargoReadinessTimeoutError("fake Cargo process tree did not become ready");
	}
	activePids.add(pids.wrapper);
	activePids.add(pids.descendant);
	return pids;
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

function isChildAlive(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

async function stopChildAfterFailure(child: ChildProcess): Promise<void> {
	if (!isChildAlive(child)) return;
	child.kill("SIGKILL");
	await expect.poll(() => isChildAlive(child), { timeout: PROCESS_EXIT_TIMEOUT_MS, interval: 25 }).toBe(false);
}

async function expectProcessTreeGone(pids: ProcessTreePids): Promise<void> {
	await expect
		.poll(() => ({ wrapper: isPidAlive(pids.wrapper), descendant: isPidAlive(pids.descendant) }), {
			timeout: PROCESS_EXIT_TIMEOUT_MS,
			interval: 25,
		})
		.toEqual({ wrapper: false, descendant: false });
}

function findAddedListener(
	signal: NodeJS.Signals,
	before: readonly ProcessSignalListener[],
): ProcessSignalListener | undefined {
	return process.listeners(signal).find((listener) => !before.includes(listener));
}

function startCargoMetadata(signal?: AbortSignal): Promise<string> {
	const previousPath = process.env["PATH"];
	const previousNodeOptions = process.env["NODE_OPTIONS"];
	process.env["PATH"] = previousPath === undefined ? binaryDirectory : `${binaryDirectory}${delimiter}${previousPath}`;
	process.env["NODE_OPTIONS"] = [previousNodeOptions, `--require=${JSON.stringify(preloadPath)}`]
		.filter((value) => value !== undefined && value.length > 0)
		.join(" ");
	try {
		return defaultCargoMetadataLoader(join(fixtureDirectory, "Cargo.toml"), signal);
	} finally {
		if (previousPath === undefined) delete process.env["PATH"];
		else process.env["PATH"] = previousPath;
		if (previousNodeOptions === undefined) delete process.env["NODE_OPTIONS"];
		else process.env["NODE_OPTIONS"] = previousNodeOptions;
	}
}

beforeEach(() => {
	fixtureDirectory = mkdtempSync(join(tmpdir(), "cargo-metadata-process-tree-"));
	binaryDirectory = join(fixtureDirectory, "bin");
	mkdirSync(binaryDirectory);
	wrapperPidFile = join(fixtureDirectory, "wrapper.pid");
	descendantPidFile = join(fixtureDirectory, "descendant.pid");
	preloadPath = join(fixtureDirectory, "fake-cargo-preload.cjs");
	const descendantWorkerPath = join(fixtureDirectory, "fake-cargo-descendant.cjs");
	const descendantLauncherPath = join(fixtureDirectory, "fake-cargo-launcher.cjs");
	writeFileSync(
		descendantWorkerPath,
		[
			"for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) {",
			"  try {",
			"    process.on(signal, () => {})",
			"  } catch {}",
			"}",
			"setInterval(() => {}, 1000)",
		].join("\n"),
	);
	writeFileSync(
		descendantLauncherPath,
		[
			'const { spawn } = require("node:child_process")',
			'const { writeFileSync } = require("node:fs")',
			"const [nodeExecutable, descendantScriptPath, descendantPidFile] = process.argv.slice(2)",
			"if (nodeExecutable === undefined || descendantScriptPath === undefined || descendantPidFile === undefined) process.exit(2)",
			"const descendantEnv = { ...process.env }",
			'delete descendantEnv["NODE_OPTIONS"]',
			"const descendant = spawn(nodeExecutable, [descendantScriptPath], {",
			"  env: descendantEnv,",
			"  stdio: 'ignore',",
			"  windowsHide: true,",
			"})",
			"if (descendant.pid === undefined) process.exit(3)",
			"writeFileSync(descendantPidFile, String(descendant.pid))",
		].join("\n"),
	);
	writeFileSync(
		preloadPath,
		[
			'const { spawn } = require("node:child_process")',
			'const { writeFileSync } = require("node:fs")',
			'const { basename } = require("node:path")',
			'if (!basename(process.argv0).toLowerCase().startsWith("cargo")) return',
			`const wrapperPidFile = ${JSON.stringify(wrapperPidFile)}`,
			`const descendantPidFile = ${JSON.stringify(descendantPidFile)}`,
			`const nodeExecutable = ${JSON.stringify(process.execPath)}`,
			`const descendantWorkerPath = ${JSON.stringify(descendantWorkerPath)}`,
			`const descendantLauncherPath = ${JSON.stringify(descendantLauncherPath)}`,
			"const helper = spawn(nodeExecutable, [descendantLauncherPath, nodeExecutable, descendantWorkerPath, descendantPidFile], {",
			"  env: process.env,",
			"  stdio: 'ignore',",
			"  windowsHide: true,",
			"})",
			"helper.unref()",
			"writeFileSync(wrapperPidFile, String(process.pid))",
			"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)",
		].join("\n"),
	);
	const cargoExecutable = join(binaryDirectory, process.platform === "win32" ? "cargo.exe" : "cargo");
	if (process.platform === "win32") copyFileSync(process.execPath, cargoExecutable);
	else symlinkSync(process.execPath, cargoExecutable);
});

afterEach(() => {
	for (const pid of activePids) killPidBestEffort(pid);
	activePids.clear();
	rmSync(fixtureDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("defaultCargoMetadataLoader process lifecycle", () => {
	it("terminates the complete Cargo process tree when the request aborts", async () => {
		// Given
		const controller = new AbortController();
		const loading = startCargoMetadata(controller.signal);
		void loading.catch(() => undefined);
		const pids = await waitForProcessTree();
		expect([isPidAlive(pids.wrapper), isPidAlive(pids.descendant)]).toEqual([true, true]);

		// When
		controller.abort();

		// Then
		await expect(loading).rejects.toMatchObject({ name: "AbortError" });
		await expectProcessTreeGone(pids);
	}, 10_000);

	it("terminates the complete Cargo process tree when metadata times out", async () => {
		// Given
		const emergencyController = new AbortController();
		const loading = startCargoMetadata(emergencyController.signal);
		void loading.catch(() => undefined);
		const pids = await waitForProcessTree();
		expect([isPidAlive(pids.wrapper), isPidAlive(pids.descendant)]).toEqual([true, true]);

		try {
			// When / Then
			await expect(loading).rejects.toBeInstanceOf(Error);
			await expectProcessTreeGone(pids);
		} finally {
			emergencyController.abort();
		}
	}, 20_000);

	for (const signal of CARGO_METADATA_PROCESS_SIGNALS) {
		it(`terminates the complete Cargo process tree on ${signal}`, async () => {
			// Given
			const beforeListeners = process.listeners(signal);
			const loading = startCargoMetadata();
			void loading.catch(() => undefined);
			const pids = await waitForProcessTree();
			const listener = findAddedListener(signal, beforeListeners);
			expect(listener).toBeDefined();

			// When
			listener?.();

			// Then
			await expect(loading).rejects.toMatchObject({ name: "AbortError" });
			await expectProcessTreeGone(pids);
			await expect
				.poll(() => process.listeners(signal), { timeout: PROCESS_EXIT_TIMEOUT_MS, interval: 25 })
				.toEqual(beforeListeners);
		}, 10_000);
	}

	for (const signal of CLI_TERMINATION_SIGNALS) {
		it(`terminates the MCP CLI by ${signal} after cleaning the complete Cargo process tree`, async () => {
			// Given
			const sourceDirectory = join(fixtureDirectory, "src");
			mkdirSync(sourceDirectory);
			writeFileSync(join(fixtureDirectory, "Cargo.toml"), '[package]\nname = "signal-test"\nversion = "0.1.0"\n');
			const rustFile = join(sourceDirectory, "lib.rs");
			writeFileSync(rustFile, "pub fn value() -> i32 { 1 }\n");
			const rustAnalyzer = join(binaryDirectory, "rust-analyzer");
			symlinkSync(process.execPath, rustAnalyzer);
			const projectConfig = join(fixtureDirectory, "lsp-client.json");
			writeFileSync(
				projectConfig,
				JSON.stringify({ lsp: { rust: { command: ["rust-analyzer"], extensions: [".rs"], priority: 100 } } }),
			);
			const cli = spawn(process.execPath, [join(process.cwd(), "dist/cli.js"), "mcp"], {
				env: {
					...process.env,
					PATH: `${binaryDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
					NODE_OPTIONS: `--require=${JSON.stringify(preloadPath)}`,
					LSP_TOOLS_MCP_PROJECT_CONFIG: projectConfig,
					LSP_TOOLS_MCP_USER_CONFIG: join(fixtureDirectory, "missing-user-config.json"),
				},
				stdio: ["pipe", "ignore", "pipe"],
			});

			try {
				cli.stdin?.write(
					`${JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: { name: "diagnostics", arguments: { filePath: rustFile } },
					})}\n`,
				);
				const pids = await waitForProcessTree();
				expect({
					parent: isChildAlive(cli),
					wrapper: isPidAlive(pids.wrapper),
					descendant: isPidAlive(pids.descendant),
				}).toEqual({
					parent: true,
					wrapper: true,
					descendant: true,
				});

				// When
				cli.kill(signal);

				// Then
				await expect.poll(() => isChildAlive(cli), { timeout: CLI_EXIT_TIMEOUT_MS, interval: 25 }).toBe(false);
				expect(cli.signalCode).toBe(signal);
				await expectProcessTreeGone(pids);
			} finally {
				await stopChildAfterFailure(cli);
			}
		}, 10_000);
	}
});

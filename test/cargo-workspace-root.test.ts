import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpawnOptions = {
	readonly detached?: boolean;
	readonly signal?: AbortSignal;
	readonly stdio?: readonly [string, string, string];
	readonly windowsHide?: boolean;
};

class FakeReadableStream extends EventEmitter {
	encoding: BufferEncoding | undefined;

	setEncoding(encoding: BufferEncoding): this {
		this.encoding = encoding;
		return this;
	}
}

class FakeChildProcess extends EventEmitter {
	readonly stdout = new FakeReadableStream();
	readonly stderr = new FakeReadableStream();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	pid: number | undefined;
	private closed = false;
	private failed = false;

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killed = true;
		this.signalCode = signal;
		return true;
	}

	emitStdout(chunk: string): void {
		this.stdout.emit("data", chunk);
	}

	emitClose(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
		if (this.closed) return;
		this.closed = true;
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("close", code, signal);
	}

	emitAbortError(): void {
		if (this.closed || this.failed) return;
		this.failed = true;
		this.emit("error", abortError());
	}
}

type SpawnCall = {
	readonly command: string;
	readonly args: readonly string[];
	readonly options: SpawnOptions;
	readonly child: FakeChildProcess;
};

const childProcessMock = vi.hoisted(() => {
	const calls: SpawnCall[] = [];
	const spawn = vi.fn((command: string, args: string[], options: SpawnOptions) => {
		const child = new FakeChildProcess();
		options.signal?.addEventListener("abort", () => child.emitAbortError(), { once: true });
		calls.push({ command, args: [...args], options, child });
		return child;
	});
	return { calls, spawn };
});

vi.mock("node:child_process", () => ({
	spawn: childProcessMock.spawn,
}));

vi.mock("../src/lsp/server-installation.js", () => ({
	isServerInstalled: () => true,
}));

const { resolveCargoWorkspaceRoot } = await import("../src/lsp/cargo-workspace-root.js");
const { findWorkspaceRoot, withLspClient } = await import("../src/lsp/client-wrapper.js");

type CargoMetadataLoader = (manifestPath: string, signal?: AbortSignal) => Promise<string>;

const rustServer = { id: "rust", command: ["rust-analyzer"], extensions: [".rs"], priority: 0 };
const realpath = (path: string): string => realpathSync.native(path);

function cargoMetadata(workspaceRoot: string, manifestPaths: readonly string[]): string {
	return JSON.stringify({
		workspace_root: workspaceRoot,
		workspace_members: manifestPaths.map((_, index) => `member-${index}`),
		packages: manifestPaths.map((manifestPath, index) => ({
			id: `member-${index}`,
			manifest_path: manifestPath,
		})),
	});
}

function abortError(): Error {
	return new DOMException("Aborted", "AbortError");
}

function eventLoopTurn(): Promise<"event-loop"> {
	return new Promise((resolveTurn) => setImmediate(() => resolveTurn("event-loop")));
}

type ProcessSignalListener = (...args: never[]) => unknown;

function findAddedListener(
	signal: NodeJS.Signals,
	before: readonly ProcessSignalListener[],
): ProcessSignalListener | undefined {
	return process.listeners(signal).find((listener) => !before.includes(listener));
}

describe("resolveCargoWorkspaceRoot", () => {
	let root: string;

	beforeEach(() => {
		root = realpath(mkdtempSync(join(tmpdir(), "cargo-ws-root-")));
		childProcessMock.calls.length = 0;
		childProcessMock.spawn.mockClear();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function write(relativePath: string, content = ""): string {
		const absolute = join(root, relativePath);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
		return absolute;
	}

	it("uses the default async cargo process boundary with an abort signal", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		const memberManifest = write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");

		// When
		const resolution = resolveCargoWorkspaceRoot(file).then(() => "resolved");
		const firstTurn = eventLoopTurn();

		// Then
		await expect(Promise.race([resolution, firstTurn])).resolves.toBe("event-loop");
		expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
		expect(childProcessMock.calls[0]?.command).toBe("cargo");
		expect(childProcessMock.calls[0]?.args).toEqual([
			"metadata",
			"--no-deps",
			"--format-version",
			"1",
			"--manifest-path",
			memberManifest,
		]);
		expect(childProcessMock.calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
		childProcessMock.calls[0]?.child.emitStdout(cargoMetadata(root, [memberManifest]));
		childProcessMock.calls[0]?.child.emitClose(0, null);
		await expect(resolution).resolves.toBe("resolved");
	});

	it("aborts root resolution promptly when the request signal aborts", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const controller = new AbortController();

		// When
		const resolution = findWorkspaceRoot(file, rustServer, { signal: controller.signal }).then(
			() => "resolved",
			(error: unknown) => (error instanceof DOMException ? error.name : "unknown"),
		);
		controller.abort();

		// Then
		await expect(Promise.race([resolution, eventLoopTurn()])).resolves.toBe("AbortError");
	});

	it("aborts a waiter that joins an existing cargo metadata request", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const controller = new AbortController();
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockImplementation(
			() =>
				new Promise<string>(() => {
					return;
				}),
		);

		// When
		void resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader });
		const waiter = resolveCargoWorkspaceRoot(file, {
			cargoMetadataLoader: metadataLoader,
			signal: controller.signal,
		}).then(
			() => "resolved",
			(error: unknown) => (error instanceof DOMException ? error.name : "unknown"),
		);
		controller.abort();

		// Then
		await expect(Promise.race([waiter, eventLoopTurn()])).resolves.toBe("AbortError");
		expect(metadataLoader).toHaveBeenCalledTimes(1);
	});

	it("keeps the shared cargo metadata request alive when the initiating waiter aborts", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		const memberManifest = write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const firstController = new AbortController();
		let operationSignal: AbortSignal | undefined;
		let resolveMetadata: ((value: string) => void) | undefined;
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockImplementation(
			(_manifestPath, signal) =>
				new Promise<string>((resolveLoader) => {
					operationSignal = signal;
					resolveMetadata = resolveLoader;
				}),
		);

		// When
		const first = resolveCargoWorkspaceRoot(file, {
			cargoMetadataLoader: metadataLoader,
			signal: firstController.signal,
		}).then(
			() => "resolved",
			(error: unknown) => (error instanceof DOMException ? error.name : "unknown"),
		);
		const second = resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader });
		firstController.abort();
		await expect(Promise.race([first, eventLoopTurn()])).resolves.toBe("AbortError");

		// Then
		expect(operationSignal?.aborted).toBe(false);
		resolveMetadata?.(cargoMetadata(root, [memberManifest]));
		await expect(second).resolves.toBe(root);
		expect(metadataLoader).toHaveBeenCalledTimes(1);
	});

	it("aborts the shared cargo metadata request when all waiters abort", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		const file = write("crates/a/src/lib.rs", "");
		const firstController = new AbortController();
		const secondController = new AbortController();
		let operationSignal: AbortSignal | undefined;
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockImplementation(
			(_manifestPath, signal) =>
				new Promise<string>(() => {
					operationSignal = signal;
				}),
		);

		// When
		const first = resolveCargoWorkspaceRoot(file, {
			cargoMetadataLoader: metadataLoader,
			signal: firstController.signal,
		}).then(
			() => "resolved",
			(error: unknown) => (error instanceof DOMException ? error.name : "unknown"),
		);
		const second = resolveCargoWorkspaceRoot(file, {
			cargoMetadataLoader: metadataLoader,
			signal: secondController.signal,
		}).then(
			() => "resolved",
			(error: unknown) => (error instanceof DOMException ? error.name : "unknown"),
		);
		firstController.abort();
		await expect(Promise.race([first, eventLoopTurn()])).resolves.toBe("AbortError");
		expect(operationSignal?.aborted).toBe(false);
		secondController.abort();

		// Then
		await expect(Promise.race([second, eventLoopTurn()])).resolves.toBe("AbortError");
		expect(operationSignal?.aborted).toBe(true);
		expect(metadataLoader).toHaveBeenCalledTimes(1);
	});

	it("aborts active cargo processes on process signals and removes listeners after cleanup", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const beforeSigterm = process.listeners("SIGTERM");

		// When
		vi.useFakeTimers();
		try {
			const resolution = resolveCargoWorkspaceRoot(file).then(
				() => "resolved",
				(error: unknown) => (error instanceof DOMException ? error.name : "unknown"),
			);
			const listener = findAddedListener("SIGTERM", beforeSigterm);

			// Then
			expect(listener).toBeDefined();
			listener?.();
			await expect(resolution).resolves.toBe("AbortError");
			await vi.advanceTimersByTimeAsync(250);
			expect(process.listeners("SIGTERM")).toEqual(beforeSigterm);
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts cargo metadata before LSP acquisition when withLspClient receives an abort", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const controller = new AbortController();
		const acquireClient = vi.fn(async () => "unused");

		// When
		const resolution = withLspClient(file, acquireClient, "definition", {
			signal: controller.signal,
		}).then(
			() => "resolved",
			(error: unknown) => (error instanceof DOMException ? error.name : "unknown"),
		);
		controller.abort();

		// Then
		await expect(Promise.race([resolution, eventLoopTurn()])).resolves.toBe("AbortError");
		expect(acquireClient).not.toHaveBeenCalled();
	});
});

import { type ChildProcess, spawn } from "node:child_process";

import { terminateProcessTree } from "./process.js";
import { installProcessSignalCleanup } from "./process-signal-cleanup.js";

const CARGO_METADATA_MAX_BUFFER = 64 * 1024 * 1024;
const CARGO_METADATA_TIMEOUT_MS = 10_000;
const CARGO_METADATA_FORCE_KILL_DELAY_MS = 250;

export type CargoMetadataLoader = (manifestPath: string, signal?: AbortSignal) => Promise<string>;

interface ActiveCargoMetadataCleanup {
	readonly controller: AbortController;
	waitForTermination(): Promise<void>;
}

const activeCargoMetadataCleanups = new Set<ActiveCargoMetadataCleanup>();
let removeProcessSignalHandlers: (() => void) | undefined;

async function abortActiveCargoMetadata(): Promise<void> {
	const cleanups = [...activeCargoMetadataCleanups];
	for (const cleanup of cleanups) {
		if (!cleanup.controller.signal.aborted) cleanup.controller.abort();
	}
	await Promise.all(cleanups.map((cleanup) => cleanup.waitForTermination()));
}

function ensureProcessSignalHandlers(): void {
	if (removeProcessSignalHandlers !== undefined) return;
	removeProcessSignalHandlers = installProcessSignalCleanup(abortActiveCargoMetadata);
}

function registerCargoMetadataCleanup(controller: AbortController, waitForTermination: () => Promise<void>): void {
	activeCargoMetadataCleanups.add({ controller, waitForTermination });
}

function releaseCargoMetadataController(controller: AbortController): void {
	for (const cleanup of activeCargoMetadataCleanups) {
		if (cleanup.controller === controller) activeCargoMetadataCleanups.delete(cleanup);
	}
	if (activeCargoMetadataCleanups.size > 0) return;
	removeProcessSignalHandlers?.();
	removeProcessSignalHandlers = undefined;
}

function linkParentSignal(controller: AbortController, signal: AbortSignal | undefined): () => void {
	if (signal === undefined) return () => {};
	const abortFromParent = () => controller.abort(signal.reason);
	if (signal.aborted) {
		abortFromParent();
		return () => {};
	}
	signal.addEventListener("abort", abortFromParent, { once: true });
	return () => signal.removeEventListener("abort", abortFromParent);
}

export async function defaultCargoMetadataLoader(manifestPath: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const controller = new AbortController();
	const unlinkParentSignal = linkParentSignal(controller, signal);
	ensureProcessSignalHandlers();

	try {
		controller.signal.throwIfAborted();
		return await new Promise<string>((resolveLoader, rejectLoader) => {
			const stdoutChunks: string[] = [];
			const stderrChunks: string[] = [];
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let cargoProcess: ChildProcess | undefined;
			let cleanupStarted = false;
			let forceKillTimeout: NodeJS.Timeout | undefined;
			let timeoutError: Error | undefined;
			let terminationError: Error | undefined;
			let settled = false;
			let resolveTermination: (() => void) | undefined;
			const terminationComplete = new Promise<void>((resolve) => {
				resolveTermination = resolve;
			});
			const finishTermination = () => {
				resolveTermination?.();
				resolveTermination = undefined;
			};
			const terminateCargoProcessTree = (terminationSignal: NodeJS.Signals) => {
				if (cargoProcess !== undefined) terminateProcessTree(cargoProcess, terminationSignal);
			};
			const beginCargoCleanup = () => {
				if (cleanupStarted) return;
				cleanupStarted = true;
				terminateCargoProcessTree("SIGTERM");
				forceKillTimeout = setTimeout(() => {
					forceKillTimeout = undefined;
					terminateCargoProcessTree("SIGKILL");
					finishTermination();
				}, CARGO_METADATA_FORCE_KILL_DELAY_MS);
			};
			const clearCleanupTracking = () => {
				clearTimeout(timeout);
				controller.signal.removeEventListener("abort", beginCargoCleanup);
				if (!cleanupStarted) {
					if (forceKillTimeout !== undefined) {
						clearTimeout(forceKillTimeout);
						forceKillTimeout = undefined;
					}
					finishTermination();
					return;
				}
				if (forceKillTimeout === undefined) finishTermination();
			};
			const timeout = setTimeout(() => {
				timeoutError = new Error(`cargo metadata timed out after ${CARGO_METADATA_TIMEOUT_MS}ms`);
				timeoutError.name = "TimeoutError";
				beginCargoCleanup();
			}, CARGO_METADATA_TIMEOUT_MS);
			controller.signal.addEventListener("abort", beginCargoCleanup, { once: true });
			registerCargoMetadataCleanup(controller, () => terminationComplete);
			const commandArgs = ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifestPath];
			const rejectWithCurrentReason = (error: Error | unknown) => {
				rejectLoader(controller.signal.aborted ? controller.signal.reason : error);
			};
			const settle = (callback: () => void) => {
				if (settled) return;
				settled = true;
				callback();
			};
			const appendChunk = (chunks: string[], chunk: string, currentBytes: number): number => {
				const nextBytes = currentBytes + Buffer.byteLength(chunk, "utf8");
				if (nextBytes > CARGO_METADATA_MAX_BUFFER && terminationError === undefined) {
					terminationError = new RangeError("cargo metadata output exceeded maxBuffer");
					beginCargoCleanup();
				}
				chunks.push(chunk);
				return nextBytes;
			};
			cargoProcess = spawn("cargo", commandArgs, {
				detached: process.platform !== "win32",
				signal: controller.signal,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			cargoProcess.stdout?.setEncoding("utf8");
			cargoProcess.stderr?.setEncoding("utf8");
			cargoProcess.stdout?.on("data", (chunk: string) => {
				stdoutBytes = appendChunk(stdoutChunks, chunk, stdoutBytes);
			});
			cargoProcess.stderr?.on("data", (chunk: string) => {
				stderrBytes = appendChunk(stderrChunks, chunk, stderrBytes);
			});
			cargoProcess.once("error", (error) => {
				settle(() => {
					clearCleanupTracking();
					if (controller.signal.aborted) {
						rejectWithCurrentReason(error);
						return;
					}
					rejectLoader(error);
				});
			});
			cargoProcess.once("close", (code, closeSignal) => {
				settle(() => {
					clearCleanupTracking();
					if (controller.signal.aborted) {
						rejectWithCurrentReason(timeoutError);
						return;
					}
					if (timeoutError !== undefined) {
						rejectLoader(timeoutError);
						return;
					}
					if (terminationError !== undefined) {
						rejectLoader(terminationError);
						return;
					}
					if (code === 0 && closeSignal === null) {
						resolveLoader(stdoutChunks.join(""));
						return;
					}
					const stderrOutput = stderrChunks.join("").trim();
					const exitDetail = closeSignal === null ? `exit code ${code ?? 0}` : `signal ${closeSignal}`;
					rejectLoader(
						new Error(
							stderrOutput.length > 0
								? `cargo metadata failed with ${exitDetail}: ${stderrOutput}`
								: `cargo metadata failed with ${exitDetail}`,
						),
					);
				});
			});
		});
	} finally {
		unlinkParentSignal();
		releaseCargoMetadataController(controller);
	}
}

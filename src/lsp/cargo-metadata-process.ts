import { execFile } from "node:child_process";

const CARGO_METADATA_MAX_BUFFER = 64 * 1024 * 1024;
const CARGO_METADATA_TIMEOUT_MS = 10_000;

export type CargoMetadataLoader = (manifestPath: string, signal?: AbortSignal) => Promise<string>;

const activeCargoMetadataControllers = new Set<AbortController>();
let removeProcessSignalHandlers: (() => void) | undefined;

function processSignals(): readonly NodeJS.Signals[] {
	return process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
}

function abortActiveCargoMetadata(): void {
	for (const controller of activeCargoMetadataControllers) {
		if (!controller.signal.aborted) controller.abort();
	}
}

function ensureProcessSignalHandlers(): void {
	if (removeProcessSignalHandlers !== undefined) return;
	const handler = () => abortActiveCargoMetadata();
	const signals = processSignals();
	for (const signal of signals) {
		process.on(signal, handler);
	}
	removeProcessSignalHandlers = () => {
		for (const signal of signals) {
			process.removeListener(signal, handler);
		}
	};
}

function releaseCargoMetadataController(controller: AbortController): void {
	activeCargoMetadataControllers.delete(controller);
	if (activeCargoMetadataControllers.size > 0) return;
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
	activeCargoMetadataControllers.add(controller);
	ensureProcessSignalHandlers();

	try {
		controller.signal.throwIfAborted();
		return await new Promise<string>((resolveLoader, rejectLoader) => {
			execFile(
				"cargo",
				["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifestPath],
				{
					encoding: "utf8",
					timeout: CARGO_METADATA_TIMEOUT_MS,
					maxBuffer: CARGO_METADATA_MAX_BUFFER,
					signal: controller.signal,
				},
				(error, stdout) => {
					if (error) {
						rejectLoader(error);
						return;
					}
					resolveLoader(stdout);
				},
			);
		});
	} finally {
		unlinkParentSignal();
		releaseCargoMetadataController(controller);
	}
}

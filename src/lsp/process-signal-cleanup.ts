import { constants } from "node:os";

import { reportBestEffortCleanupError } from "./cleanup-errors.js";

const PROCESS_SIGNALS: readonly NodeJS.Signals[] =
	process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];

type ProcessSignalCleanup = () => void | Promise<void>;

export interface ProcessSignalCleanupOptions {
	readonly terminateParent?: boolean;
}

interface CleanupRegistration {
	readonly cleanup: ProcessSignalCleanup;
	readonly terminatesParent: boolean;
}

const registrations = new Set<CleanupRegistration>();
const signalHandlers = new Map<NodeJS.Signals, () => void>();
let handlersInstalled = false;
let handlingSignal = false;

function removeSignalHandlers(): void {
	if (!handlersInstalled) return;
	for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
	signalHandlers.clear();
	handlersInstalled = false;
}

function signalExitCode(signal: NodeJS.Signals): number {
	return 128 + (constants.signals[signal] ?? 1);
}

function terminateParent(signal: NodeJS.Signals): void {
	if (process.platform === "win32" && signal === "SIGBREAK") {
		process.exit(signalExitCode(signal));
	}
	try {
		process.kill(process.pid, signal);
	} catch (error) {
		reportBestEffortCleanupError("signal re-delivery", error);
		process.exit(signalExitCode(signal));
	}
}

async function runCleanup(registration: CleanupRegistration): Promise<void> {
	try {
		await registration.cleanup();
	} catch (error) {
		reportBestEffortCleanupError("signal cleanup", error);
	}
}

function handleSignal(signal: NodeJS.Signals): void {
	if (handlingSignal) return;
	handlingSignal = true;
	const activeRegistrations = [...registrations];
	const shouldTerminateParent = activeRegistrations.some((registration) => registration.terminatesParent);
	void Promise.all(activeRegistrations.map(runCleanup)).then(() => {
		removeSignalHandlers();
		if (shouldTerminateParent) {
			terminateParent(signal);
			return;
		}
		handlingSignal = false;
		if (registrations.size > 0) ensureSignalHandlers();
	});
}

function ensureSignalHandlers(): void {
	if (handlersInstalled) return;
	for (const signal of PROCESS_SIGNALS) {
		const handler = () => handleSignal(signal);
		signalHandlers.set(signal, handler);
		process.on(signal, handler);
	}
	handlersInstalled = true;
}

export function installProcessSignalCleanup(
	cleanup: ProcessSignalCleanup,
	options: ProcessSignalCleanupOptions = {},
): () => void {
	const registration: CleanupRegistration = {
		cleanup,
		terminatesParent: options.terminateParent ?? false,
	};
	registrations.add(registration);
	ensureSignalHandlers();

	return () => {
		registrations.delete(registration);
		if (registrations.size === 0 && !handlingSignal) removeSignalHandlers();
	};
}

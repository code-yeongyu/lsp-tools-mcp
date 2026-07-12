import { existsSync, lstatSync, readdirSync, type Stats } from "node:fs";
import { extname, join, resolve } from "node:path";
import { findWorkspaceRoot, formatServerLookupError } from "./client-wrapper.js";
import { DEFAULT_MAX_DIAGNOSTICS, DEFAULT_MAX_DIRECTORY_FILES } from "./constants.js";
import { LspInvalidPathError, LspServerLookupError } from "./errors.js";
import { filterDiagnosticsBySeverity, formatDiagnostic } from "./formatters.js";
import { getLspManager } from "./manager.js";
import { findServerForExtension } from "./server-resolution.js";
import type { Diagnostic, SeverityFilter } from "./types.js";

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", "out"]);

interface FileDiagnostic {
	filePath: string;
	diagnostic: Diagnostic;
}

interface DirectoryDiagnosticsOptions {
	readonly signal?: AbortSignal;
}

function isAbortError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new DOMException("Aborted", "AbortError");
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return promise;
	throwIfAborted(signal);
	return new Promise<T>((resolvePromise, rejectPromise) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			rejectPromise(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolvePromise(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				rejectPromise(error);
			},
		);
	});
}

export function collectFilesWithExtension(
	dir: string,
	extension: string,
	maxFiles: number,
	options: DirectoryDiagnosticsOptions = {},
): string[] {
	const files: string[] = [];
	const { signal } = options;

	function walk(currentDir: string): void {
		throwIfAborted(signal);
		if (files.length >= maxFiles) return;

		let entries: string[] = [];
		try {
			entries = readdirSync(currentDir);
		} catch {
			return;
		}

		for (const entry of entries) {
			throwIfAborted(signal);
			if (files.length >= maxFiles) return;

			const fullPath = join(currentDir, entry);

			let stat: Stats | undefined;
			try {
				stat = lstatSync(fullPath);
			} catch {
				continue;
			}

			if (!stat || stat.isSymbolicLink()) continue;

			if (stat.isDirectory()) {
				if (!SKIP_DIRECTORIES.has(entry)) {
					walk(fullPath);
				}
			} else if (stat.isFile() && extname(fullPath) === extension) {
				files.push(fullPath);
			}
			throwIfAborted(signal);
		}
	}

	walk(dir);
	throwIfAborted(signal);
	return files;
}

export async function aggregateDiagnosticsForDirectory(
	directory: string,
	extension: string,
	severity?: SeverityFilter,
	maxFiles: number = DEFAULT_MAX_DIRECTORY_FILES,
	options: DirectoryDiagnosticsOptions = {},
): Promise<string> {
	const { signal } = options;
	throwIfAborted(signal);
	const signalOptions: DirectoryDiagnosticsOptions = signal === undefined ? {} : { signal };
	if (!extension.startsWith(".")) {
		throw new LspInvalidPathError(
			`Extension must start with a dot (e.g., ".ts", not "${extension}"). Use ".${extension}" instead.`,
		);
	}

	const absDir = resolve(directory);
	if (!existsSync(absDir)) {
		throw new LspInvalidPathError(`Directory does not exist: ${absDir}`);
	}

	const serverResult = findServerForExtension(extension);
	if (serverResult.status !== "found") {
		throw new LspServerLookupError(formatServerLookupError(serverResult));
	}

	const server = serverResult.server;
	const allFiles = collectFilesWithExtension(absDir, extension, maxFiles + 1, signalOptions);
	const wasCapped = allFiles.length > maxFiles;
	const filesToProcess = allFiles.slice(0, maxFiles);
	throwIfAborted(signal);

	if (filesToProcess.length === 0) {
		return [
			`Directory: ${absDir}`,
			`Extension: ${extension}`,
			"Files scanned: 0",
			`No files found with extension "${extension}".`,
		].join("\n");
	}

	const root = await awaitWithAbort(findWorkspaceRoot(absDir, server, signalOptions), signal);
	throwIfAborted(signal);
	const manager = getLspManager();
	const allDiagnostics: FileDiagnostic[] = [];
	const fileErrors: { file: string; error: string }[] = [];

	const client = await manager.getClient(root, server, signal);
	try {
		for (const file of filesToProcess) {
			throwIfAborted(signal);
			try {
				const result = await awaitWithAbort(client.diagnostics(file), signal);
				throwIfAborted(signal);
				const filtered = filterDiagnosticsBySeverity(result.items, severity);
				allDiagnostics.push(
					...filtered.map((diagnostic) => ({
						filePath: file,
						diagnostic,
					})),
				);
			} catch (e) {
				if (signal?.aborted || isAbortError(e)) throw e;
				fileErrors.push({
					file,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
	} finally {
		manager.releaseClient(root, server.id);
	}

	const displayDiagnostics = allDiagnostics.slice(0, DEFAULT_MAX_DIAGNOSTICS);
	const wasDiagCapped = allDiagnostics.length > DEFAULT_MAX_DIAGNOSTICS;

	const lines: string[] = [
		`Directory: ${absDir}`,
		`Extension: ${extension}`,
		`Files scanned: ${filesToProcess.length}${wasCapped ? ` (capped at ${maxFiles})` : ""}`,
		`Files with errors: ${fileErrors.length}`,
		`Total diagnostics: ${allDiagnostics.length}`,
	];

	if (fileErrors.length > 0) {
		lines.push("", "File processing errors:");
		for (const { file, error } of fileErrors) {
			lines.push(`  ${file}: ${error}`);
		}
	}

	if (displayDiagnostics.length > 0) {
		lines.push("");
		for (const { filePath, diagnostic } of displayDiagnostics) {
			lines.push(`${filePath}: ${formatDiagnostic(diagnostic)}`);
		}
		if (wasDiagCapped) {
			lines.push("", `... (${allDiagnostics.length - DEFAULT_MAX_DIAGNOSTICS} more diagnostics not shown)`);
		}
	}

	return lines.join("\n");
}

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import type { LspClient } from "./client.js";
import {
	isLspDeadConnectionError,
	LspInvalidPathError,
	LspRequestTimeoutError,
	LspServerInitializingError,
	LspServerLookupError,
} from "./errors.js";
import { getLspManager, type LspManager } from "./manager.js";
import { findServerForExtension } from "./server-resolution.js";
import type { ResolvedServer, ServerLookupResult } from "./types.js";

const WORKSPACE_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"];

export function isDirectoryPath(filePath: string): boolean {
	try {
		return statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

const CARGO_WORKSPACE_TABLE = /^\s*\[workspace(\]|\.)/m;
const cargoWorkspaceRootCache = new Map<string, string>();

function realpathSafe(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

function nearestCargoManifestDir(startDir: string): string | undefined {
	let dir = startDir;
	let prev = "";
	while (dir !== prev) {
		if (existsSync(join(dir, "Cargo.toml"))) return dir;
		prev = dir;
		dir = dirname(dir);
	}
	return undefined;
}

function workspaceDeclaresExclude(tomlText: string): boolean {
	const match = tomlText.match(/^[ \t]*\[workspace\][ \t]*$/m);
	if (!match || match.index === undefined) return false;
	const afterHeader = tomlText.slice(match.index + match[0].length);
	const nextTable = afterHeader.search(/^[ \t]*\[/m);
	const section = nextTable === -1 ? afterHeader : afterHeader.slice(0, nextTable);
	return /^[ \t]*exclude[ \t]*=/m.test(section);
}

// rust-analyzer loads an entire Cargo workspace from any member crate, so every
// member must resolve to a single workspace root; otherwise the manager keys one
// multi-GB analyzer per crate. Ask Cargo for the authoritative workspace_root
// (which honours `exclude`, nested `[workspace]`s and `package.workspace`) and
// pre-fill every member so a large workspace costs a single `cargo metadata` call.
function cargoWorkspaceRoot(manifestDir: string): string | undefined {
	const cached = cargoWorkspaceRootCache.get(manifestDir);
	if (cached !== undefined) return cached;
	try {
		const output = execFileSync(
			"cargo",
			["metadata", "--no-deps", "--format-version", "1", "--manifest-path", join(manifestDir, "Cargo.toml")],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
		);
		const metadata = JSON.parse(output) as {
			workspace_root?: unknown;
			workspace_members?: unknown[];
			packages?: { id?: unknown; manifest_path?: unknown }[];
		};
		const rawRoot = metadata.workspace_root;
		if (typeof rawRoot !== "string" || rawRoot.length === 0) return undefined;
		const root = realpathSafe(rawRoot);
		const memberIds = new Set(
			(metadata.workspace_members ?? []).filter((id): id is string => typeof id === "string"),
		);
		for (const pkg of metadata.packages ?? []) {
			if (typeof pkg.id === "string" && memberIds.has(pkg.id) && typeof pkg.manifest_path === "string") {
				cargoWorkspaceRootCache.set(realpathSafe(dirname(pkg.manifest_path)), root);
			}
		}
		cargoWorkspaceRootCache.set(manifestDir, root);
		return root;
	} catch {
		return undefined;
	}
}

// Degraded fallback used only when `cargo` is unavailable (rust-analyzer itself
// needs it to load a project): return the nearest ancestor declaring a
// `[workspace]` table, unless that workspace declares `exclude` — in which case
// membership is ambiguous and we conservatively stay at the package directory.
function heuristicCargoWorkspaceRoot(startDir: string): string | undefined {
	let nearestPackage: string | undefined;
	let dir = startDir;
	let prev = "";
	while (dir !== prev) {
		const manifest = join(dir, "Cargo.toml");
		if (existsSync(manifest)) {
			nearestPackage ??= dir;
			try {
				const text = readFileSync(manifest, "utf8");
				if (CARGO_WORKSPACE_TABLE.test(text)) {
					return workspaceDeclaresExclude(text) ? (nearestPackage ?? dir) : dir;
				}
			} catch {
				// ignore an unreadable manifest and keep walking up
			}
		}
		prev = dir;
		dir = dirname(dir);
	}
	return nearestPackage;
}

export function findWorkspaceRoot(filePath: string, server?: ResolvedServer): string {
	const abs = resolve(filePath);
	let dir = abs;

	if (!isDirectoryPath(dir)) {
		dir = dirname(dir);
	}

	// rust-analyzer's analysis unit is the whole Cargo workspace, so collapse a
	// member crate onto its workspace root while leaving excluded or nested
	// projects (for example a cargo-fuzz `fuzz/`) at their own root.
	if (server?.id === "rust") {
		const realDir = realpathSafe(dir);
		const manifestDir = nearestCargoManifestDir(realDir);
		if (manifestDir !== undefined) {
			return cargoWorkspaceRoot(manifestDir) ?? heuristicCargoWorkspaceRoot(realDir) ?? manifestDir;
		}
	}

	let prevDir = "";
	while (dir !== prevDir) {
		for (const marker of WORKSPACE_MARKERS) {
			if (existsSync(join(dir, marker))) {
				return dir;
			}
		}
		prevDir = dir;
		dir = dirname(dir);
	}

	return dirname(abs);
}

export function formatServerLookupError(result: Exclude<ServerLookupResult, { status: "found" }>): string {
	if (result.status === "not_installed") {
		const { server, installHint } = result;
		return [
			`LSP server '${server.id}' is configured but NOT INSTALLED.`,
			"",
			`Command not found: ${server.command[0]}`,
			"",
			"To install:",
			`  ${installHint}`,
			"",
			`Supported extensions: ${server.extensions.join(", ")}`,
			"",
			"After installation, the server will be available automatically.",
		].join("\n");
	}

	return [
		`No LSP server configured for extension: ${result.extension}`,
		"",
		`Available servers: ${result.availableServers.slice(0, 10).join(", ")}${
			result.availableServers.length > 10 ? "..." : ""
		}`,
		"",
		"Configure a custom server in '.codex/lsp-client.json':",
		"  {",
		'    "lsp": {',
		'      "my-server": {',
		'        "command": ["my-lsp", "--stdio"],',
		`        "extensions": ["${result.extension}"]`,
		"      }",
		"    }",
		"  }",
	].join("\n");
}

export interface WithLspClientOptions {
	signal?: AbortSignal;
	manager?: LspManager;
}

const READ_ONLY_RETRY_TOOLS = new Set([
	"diagnostics",
	"definition",
	"references",
	"documentSymbols",
	"workspaceSymbols",
	"prepareRename",
]);

export async function withLspClient<T>(
	filePath: string,
	fn: (client: LspClient) => Promise<T>,
	toolName: string,
	options: WithLspClientOptions = {},
): Promise<T> {
	const absPath = resolve(filePath);

	if (isDirectoryPath(absPath)) {
		throw new LspInvalidPathError(
			"Directory paths are not supported by this LSP tool. " +
				"Use lsp.diagnostics with a directory path for directory diagnostics.",
		);
	}

	const ext = extname(absPath);
	const result = findServerForExtension(ext);
	if (result.status !== "found") {
		throw new LspServerLookupError(formatServerLookupError(result));
	}

	const server = result.server;
	const root = findWorkspaceRoot(absPath, server);
	const manager = options.manager ?? getLspManager();

	const acquireAndCall = async (allowRetry: boolean): Promise<T> => {
		const client = await manager.getClient(root, server, options.signal);

		try {
			return await fn(client);
		} catch (err) {
			if (allowRetry && READ_ONLY_RETRY_TOOLS.has(toolName) && isLspDeadConnectionError(err)) {
				manager.invalidateClient(root, server.id, client);
				return acquireAndCall(false);
			}

			if (err instanceof LspRequestTimeoutError) {
				if (manager.isServerInitializing(root, server.id)) {
					throw new LspServerInitializingError(err);
				}
			}
			throw err;
		} finally {
			manager.releaseClient(root, server.id);
		}
	};

	return acquireAndCall(true);
}

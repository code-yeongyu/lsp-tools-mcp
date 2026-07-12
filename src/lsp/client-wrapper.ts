import { statSync } from "node:fs";
import { extname, resolve } from "node:path";

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
import type { ServerLookupResult } from "./types.js";
import { type FindWorkspaceRootOptions, findWorkspaceRoot } from "./workspace-root.js";

export type { CargoMetadataLoader, FindWorkspaceRootOptions } from "./workspace-root.js";
export { findWorkspaceRoot };

export function isDirectoryPath(filePath: string): boolean {
	try {
		return statSync(filePath).isDirectory();
	} catch {
		return false;
	}
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

export interface WithLspClientOptions extends FindWorkspaceRootOptions {
	readonly manager?: LspManager;
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
	const { manager: optionManager, ...workspaceRootOptions } = options;
	const root = await findWorkspaceRoot(absPath, server, workspaceRootOptions);
	const manager = optionManager ?? getLspManager();

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

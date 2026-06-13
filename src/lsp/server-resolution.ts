import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getDisabledServerIds, getMergedServers } from "./config-loader.js";
import { BUILTIN_SERVERS, LSP_INSTALL_HINTS } from "./server-definitions.js";
import { isServerInstalled } from "./server-installation.js";
import type { ServerLookupResult } from "./types.js";

export interface ServerResolutionOptions {
	filePath?: string;
}

const BIOME_CONFIG_FILES = ["biome.json", "biome.jsonc"] as const;
const BIOME_PACKAGE_NAME = "@biomejs/biome";

export function findServerForExtension(ext: string, options: ServerResolutionOptions = {}): ServerLookupResult {
	const servers = getMergedServers();
	const activeServers = servers.filter((server) => isServerActiveForPath(server, options.filePath));

	for (const server of activeServers) {
		if (server.extensions.includes(ext) && isServerInstalled(server.command)) {
			const resolvedServer = {
				id: server.id,
				command: server.command,
				extensions: server.extensions,
				priority: server.priority,
			};
			if (server.env !== undefined) {
				return {
					status: "found",
					server: {
						...resolvedServer,
						env: server.env,
						...(server.initialization === undefined ? {} : { initialization: server.initialization }),
					},
				};
			}
			return {
				status: "found",
				server: {
					...resolvedServer,
					...(server.initialization === undefined ? {} : { initialization: server.initialization }),
				},
			};
		}
	}

	for (const server of activeServers) {
		if (server.extensions.includes(ext)) {
			const installHint =
				LSP_INSTALL_HINTS[server.id] ?? `Install '${server.command[0]}' and ensure it's in your PATH`;
			return {
				status: "not_installed",
				server: {
					id: server.id,
					command: server.command,
					extensions: server.extensions,
				},
				installHint,
			};
		}
	}

	const availableServers = [...new Set(activeServers.map((s) => s.id))];
	return {
		status: "not_configured",
		extension: ext,
		availableServers,
	};
}

function isServerActiveForPath(server: { id: string; source: string }, filePath: string | undefined): boolean {
	if (server.source !== "builtin") return true;
	if (server.id !== "biome") return true;
	if (filePath === undefined) return true;
	return hasBiomeProjectOptIn(filePath);
}

function hasBiomeProjectOptIn(filePath: string): boolean {
	let dir = getStartDirectory(filePath);
	let previous = "";

	while (dir !== previous) {
		if (BIOME_CONFIG_FILES.some((fileName) => existsSync(join(dir, fileName)))) {
			return true;
		}
		if (packageJsonHasBiomeDependency(join(dir, "package.json"))) {
			return true;
		}

		previous = dir;
		dir = dirname(dir);
	}

	return false;
}

function getStartDirectory(filePath: string): string {
	const resolved = resolve(filePath);
	try {
		return statSync(resolved).isDirectory() ? resolved : dirname(resolved);
	} catch {
		return dirname(resolved);
	}
}

function packageJsonHasBiomeDependency(packageJsonPath: string): boolean {
	if (!existsSync(packageJsonPath)) return false;

	try {
		const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (!isRecord(parsed)) return false;
		return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((field) => {
			const dependencies = parsed[field];
			return isRecord(dependencies) && BIOME_PACKAGE_NAME in dependencies;
		});
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ServerStatus {
	id: string;
	installed: boolean;
	extensions: string[];
	disabled: boolean;
	source: string;
	priority: number;
}

export function getAllServers(): ServerStatus[] {
	const servers = getMergedServers();
	const disabled = getDisabledServerIds();

	const result: ServerStatus[] = [];
	const seen = new Set<string>();

	for (const server of servers) {
		if (seen.has(server.id)) continue;
		result.push({
			id: server.id,
			installed: isServerInstalled(server.command),
			extensions: server.extensions,
			disabled: false,
			source: server.source,
			priority: server.priority,
		});
		seen.add(server.id);
	}

	for (const id of disabled) {
		if (seen.has(id)) continue;
		const builtin = BUILTIN_SERVERS[id];
		result.push({
			id,
			installed: builtin ? isServerInstalled(builtin.command) : false,
			extensions: builtin?.extensions ?? [],
			disabled: true,
			source: "disabled",
			priority: 0,
		});
	}

	return result;
}

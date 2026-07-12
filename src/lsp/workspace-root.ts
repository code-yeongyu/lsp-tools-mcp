import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { type CargoWorkspaceRootOptions, resolveCargoWorkspaceRoot } from "./cargo-workspace-root.js";
import type { ResolvedServer } from "./types.js";

const WORKSPACE_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"];

export type { CargoMetadataLoader } from "./cargo-workspace-root.js";
export interface FindWorkspaceRootOptions extends CargoWorkspaceRootOptions {}

function isDirectoryPath(filePath: string): boolean {
	try {
		return statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

export async function findWorkspaceRoot(
	filePath: string,
	server?: ResolvedServer,
	options: FindWorkspaceRootOptions = {},
): Promise<string> {
	const abs = resolve(filePath);
	let dir = abs;

	if (!isDirectoryPath(dir)) {
		dir = dirname(dir);
	}

	if (server?.id === "rust") {
		const cargoRoot = await resolveCargoWorkspaceRoot(dir, options);
		if (cargoRoot !== undefined) return cargoRoot;
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

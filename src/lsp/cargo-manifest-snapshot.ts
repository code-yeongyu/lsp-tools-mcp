import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalManifest } from "./cargo-metadata-parser.js";

export interface ManifestSnapshot {
	readonly path: string;
	readonly content: string;
}

export function readManifestSnapshot(path: string): ManifestSnapshot | undefined {
	try {
		return { path, content: readFileSync(path, "utf8") };
	} catch {
		return undefined;
	}
}

export function snapshotsAreFresh(snapshots: readonly ManifestSnapshot[]): boolean {
	for (const snapshot of snapshots) {
		try {
			if (readFileSync(snapshot.path, "utf8") !== snapshot.content) return false;
		} catch {
			return false;
		}
	}
	return true;
}

function ancestorManifestPaths(manifestDir: string): readonly string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	let dir = manifestDir;
	let prev = "";
	while (dir !== prev) {
		const manifestPath = canonicalManifest(join(dir, "Cargo.toml"));
		if (manifestPath !== undefined && !seen.has(manifestPath)) {
			seen.add(manifestPath);
			paths.push(manifestPath);
		}
		prev = dir;
		dir = dirname(dir);
	}
	return paths;
}

export function readAncestorManifestSnapshots(manifestDir: string): readonly ManifestSnapshot[] | undefined {
	const snapshots: ManifestSnapshot[] = [];
	for (const manifestPath of ancestorManifestPaths(manifestDir)) {
		const snapshot = readManifestSnapshot(manifestPath);
		if (snapshot === undefined) return undefined;
		snapshots.push(snapshot);
	}
	return snapshots.length === 0 ? undefined : snapshots;
}

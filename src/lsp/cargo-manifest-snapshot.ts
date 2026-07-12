import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ManifestSnapshot {
	readonly path: string;
	readonly exists: boolean;
	readonly content: string | undefined;
}

function isMissingManifestError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = "code" in error ? error.code : undefined;
	return code === "ENOENT" || code === "ENOTDIR";
}

export function readManifestSnapshot(path: string, allowMissing = false): ManifestSnapshot | undefined {
	try {
		return { path, exists: true, content: readFileSync(path, "utf8") };
	} catch (error) {
		if (allowMissing && isMissingManifestError(error)) {
			return { path, exists: false, content: undefined };
		}
		return undefined;
	}
}

export function snapshotsAreFresh(snapshots: readonly ManifestSnapshot[]): boolean {
	for (const snapshot of snapshots) {
		const candidate = readManifestSnapshot(snapshot.path, true);
		if (candidate === undefined) return false;
		if (candidate.exists !== snapshot.exists) return false;
		if (!candidate.exists) continue;
		if (candidate.content !== snapshot.content) return false;
	}
	return true;
}

function ancestorManifestPaths(manifestDir: string): readonly string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	let dir = manifestDir;
	let prev = "";
	while (dir !== prev) {
		const manifestPath = join(dir, "Cargo.toml");
		if (!seen.has(manifestPath)) {
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
	const manifestPaths = ancestorManifestPaths(manifestDir);
	for (const [index, manifestPath] of manifestPaths.entries()) {
		const snapshot = readManifestSnapshot(manifestPath, true);
		if (snapshot === undefined) return undefined;
		if (index === 0 && !snapshot.exists) return undefined;
		snapshots.push(snapshot);
	}
	return snapshots.length === 0 ? undefined : snapshots;
}

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

interface ParsedCargoMetadata {
	readonly workspaceRoot: string;
	readonly memberManifestPaths: readonly string[];
}

export interface TrustedCargoMetadata {
	readonly workspaceRoot: string;
	readonly rootManifestPath: string;
	readonly memberManifestPaths: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalDirectory(path: string): string | undefined {
	try {
		const canonicalPath = realpathSync.native(path);
		return statSync(canonicalPath).isDirectory() ? canonicalPath : undefined;
	} catch {
		return undefined;
	}
}

export function canonicalManifest(path: string): string | undefined {
	try {
		const canonicalPath = realpathSync.native(path);
		return statSync(canonicalPath).isFile() ? canonicalPath : undefined;
	} catch {
		return undefined;
	}
}

function canReadFile(path: string): boolean {
	try {
		readFileSync(path, "utf8");
		return true;
	} catch {
		return false;
	}
}

function isContainedPath(root: string, path: string): boolean {
	const relativePath = relative(root, path);
	return (
		relativePath === "" ||
		(!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
	);
}

function parseCargoMetadata(output: string): ParsedCargoMetadata | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return undefined;
	}

	if (!isRecord(parsed)) return undefined;

	const workspaceRoot = parsed["workspace_root"];
	const workspaceMembers = parsed["workspace_members"];
	const packages = parsed["packages"];
	if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) return undefined;
	if (!Array.isArray(workspaceMembers) || !Array.isArray(packages)) return undefined;

	const memberIds = new Set<string>();
	for (const id of workspaceMembers) {
		if (typeof id !== "string") return undefined;
		memberIds.add(id);
	}

	const memberManifestPaths: string[] = [];
	for (const pkg of packages) {
		if (!isRecord(pkg)) return undefined;
		const id = pkg["id"];
		const manifestPath = pkg["manifest_path"];
		if (typeof id !== "string" || typeof manifestPath !== "string") return undefined;
		if (memberIds.has(id)) memberManifestPaths.push(manifestPath);
	}

	if (memberManifestPaths.length !== memberIds.size) return undefined;
	return { workspaceRoot, memberManifestPaths };
}

function validateCargoMetadata(
	requestedManifestPath: string,
	metadata: ParsedCargoMetadata,
): TrustedCargoMetadata | undefined {
	const workspaceRoot = canonicalDirectory(metadata.workspaceRoot);
	if (workspaceRoot === undefined) return undefined;

	const rootManifestPath = canonicalManifest(join(workspaceRoot, "Cargo.toml"));
	const requestedManifest = canonicalManifest(requestedManifestPath);
	if (rootManifestPath === undefined || requestedManifest === undefined) return undefined;
	if (!isContainedPath(workspaceRoot, requestedManifest)) return undefined;
	if (!canReadFile(rootManifestPath)) return undefined;

	const memberManifestPaths: string[] = [];
	const members = new Set<string>();
	for (const manifestPath of metadata.memberManifestPaths) {
		const canonicalPath = canonicalManifest(manifestPath);
		if (canonicalPath === undefined || !canReadFile(canonicalPath)) return undefined;
		if (!isContainedPath(workspaceRoot, canonicalPath)) return undefined;
		if (!members.has(canonicalPath)) {
			members.add(canonicalPath);
			memberManifestPaths.push(canonicalPath);
		}
	}

	if (requestedManifest !== rootManifestPath && !members.has(requestedManifest)) return undefined;
	return { workspaceRoot, rootManifestPath, memberManifestPaths };
}

export function parseTrustedCargoMetadata(
	requestedManifestPath: string,
	output: string,
): TrustedCargoMetadata | undefined {
	const parsed = parseCargoMetadata(output);
	return parsed === undefined ? undefined : validateCargoMetadata(requestedManifestPath, parsed);
}

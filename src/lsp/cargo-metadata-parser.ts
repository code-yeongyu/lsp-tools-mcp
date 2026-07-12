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

function readFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

type MultilineTomlQuote = '"""' | "'''";

function isEscaped(value: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}

function multilineQuoteAfter(line: string, initial: MultilineTomlQuote | undefined): MultilineTomlQuote | undefined {
	let multilineQuote = initial;
	let singleLineQuote: '"' | "'" | undefined;
	for (let index = 0; index < line.length; index += 1) {
		if (multilineQuote !== undefined) {
			if (line.startsWith(multilineQuote, index) && (multilineQuote === "'''" || !isEscaped(line, index))) {
				index += 2;
				multilineQuote = undefined;
			}
			continue;
		}
		if (singleLineQuote !== undefined) {
			if (line[index] === singleLineQuote && (singleLineQuote === "'" || !isEscaped(line, index))) {
				singleLineQuote = undefined;
			}
			continue;
		}
		if (line[index] === "#") break;
		if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
			multilineQuote = line.startsWith('"""', index) ? '"""' : "'''";
			index += 2;
			continue;
		}
		const character = line[index];
		if (character === '"' || character === "'") singleLineQuote = character;
	}
	return multilineQuote;
}

function declaresCargoWorkspace(content: string): boolean {
	let multilineQuote: MultilineTomlQuote | undefined;
	for (const line of content.split(/\r?\n/u)) {
		if (
			multilineQuote === undefined &&
			/^\s*\[\s*(?:workspace|"workspace"|'workspace')\s*\]\s*(?:#.*)?$/u.test(line)
		) {
			return true;
		}
		multilineQuote = multilineQuoteAfter(line, multilineQuote);
	}
	return false;
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
	const rootManifest = readFile(rootManifestPath);
	const requestedManifestContent = readFile(requestedManifest);
	if (rootManifest === undefined || requestedManifestContent === undefined) return undefined;
	if (requestedManifest !== rootManifestPath && declaresCargoWorkspace(requestedManifestContent)) return undefined;

	const memberManifestPaths: string[] = [];
	const members = new Set<string>();
	for (const manifestPath of metadata.memberManifestPaths) {
		const canonicalPath = canonicalManifest(manifestPath);
		if (canonicalPath === undefined) return undefined;
		if (!isContainedPath(workspaceRoot, canonicalPath)) return undefined;
		const content = readFile(canonicalPath);
		if (content === undefined) return undefined;
		if (canonicalPath !== rootManifestPath && declaresCargoWorkspace(content)) continue;
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

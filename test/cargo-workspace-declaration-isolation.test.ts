import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CargoMetadataLoader, resolveCargoWorkspaceRoot } from "../src/lsp/cargo-workspace-root.js";

interface WorkspaceDeclarationCase {
	readonly name: string;
	readonly manifest: string;
}

const workspaceDeclarations: readonly WorkspaceDeclarationCase[] = [
	{ name: "inline", manifest: 'workspace = { members = [], resolver = "2" }\n' },
	{ name: "dotted", manifest: 'workspace.members = []\nworkspace.resolver = "2"\n' },
];

const realpath = (path: string): string => realpathSync.native(path);

function cargoMetadata(workspaceRoot: string, manifestPaths: readonly string[]): string {
	return JSON.stringify({
		workspace_root: workspaceRoot,
		workspace_members: manifestPaths.map((_, index) => `member-${index}`),
		packages: manifestPaths.map((manifestPath, index) => ({
			id: `member-${index}`,
			manifest_path: manifestPath,
		})),
	});
}

describe("Cargo workspace declaration cache isolation", () => {
	let root: string;

	beforeEach(() => {
		root = realpath(mkdtempSync(join(tmpdir(), "cargo-declaration-isolation-")));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function write(relativePath: string, content = ""): string {
		const absolute = join(root, relativePath);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
		return absolute;
	}

	it.each(workspaceDeclarations)("does not publish a $name nested workspace from outer metadata", async ({
		manifest,
	}) => {
		// Given
		const outerManifest = write("Cargo.toml", '[workspace]\nmembers = ["tools/nested"]\nresolver = "2"\n');
		const outerFile = write("src/lib.rs");
		const nestedManifest = write("tools/nested/Cargo.toml", manifest);
		const nestedFile = write("tools/nested/src/lib.rs");
		const nestedRoot = dirname(nestedManifest);
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockResolvedValueOnce(cargoMetadata(root, [nestedManifest]))
			.mockResolvedValueOnce(cargoMetadata(nestedRoot, [nestedManifest]));

		// When
		const resolvedOuter = await resolveCargoWorkspaceRoot(outerFile, { cargoMetadataLoader: metadataLoader });
		const resolvedNested = await resolveCargoWorkspaceRoot(nestedFile, { cargoMetadataLoader: metadataLoader });

		// Then
		expect({ resolvedOuter, resolvedNested, loaderCalls: metadataLoader.mock.calls.length }).toEqual({
			resolvedOuter: root,
			resolvedNested: nestedRoot,
			loaderCalls: 2,
		});
		expect(metadataLoader).toHaveBeenNthCalledWith(1, outerManifest, expect.any(AbortSignal));
		expect(metadataLoader).toHaveBeenNthCalledWith(2, nestedManifest, expect.any(AbortSignal));
	});

	it.each(
		workspaceDeclarations,
	)("does not commit an ordinary member changed to a $name workspace while outer metadata is in flight", async ({
		manifest,
	}) => {
		// Given
		const outerManifest = write("Cargo.toml", '[workspace]\nmembers = ["tools/nested"]\nresolver = "2"\n');
		const outerFile = write("src/lib.rs");
		const nestedManifest = write("tools/nested/Cargo.toml", '[package]\nname = "nested"\nversion = "0.1.0"\n');
		const nestedFile = write("tools/nested/src/lib.rs");
		const nestedRoot = dirname(nestedManifest);
		let resolveOuterMetadata: ((value: string) => void) | undefined;
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolveMetadata) => {
						resolveOuterMetadata = resolveMetadata;
					}),
			)
			.mockResolvedValueOnce(cargoMetadata(nestedRoot, [nestedManifest]));
		const outerResolution = resolveCargoWorkspaceRoot(outerFile, { cargoMetadataLoader: metadataLoader });

		// When
		write("tools/nested/Cargo.toml", manifest);
		resolveOuterMetadata?.(cargoMetadata(root, [nestedManifest]));
		const resolvedOuter = await outerResolution;
		const resolvedNested = await resolveCargoWorkspaceRoot(nestedFile, { cargoMetadataLoader: metadataLoader });

		// Then
		expect({ resolvedOuter, resolvedNested, loaderCalls: metadataLoader.mock.calls.length }).toEqual({
			resolvedOuter: root,
			resolvedNested: nestedRoot,
			loaderCalls: 2,
		});
		expect(metadataLoader).toHaveBeenNthCalledWith(1, outerManifest, expect.any(AbortSignal));
		expect(metadataLoader).toHaveBeenNthCalledWith(2, nestedManifest, expect.any(AbortSignal));
	});

	it("does not publish malformed nested manifest content from outer metadata", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["tools/nested"]\nresolver = "2"\n');
		const outerFile = write("src/lib.rs");
		const nestedManifest = write("tools/nested/Cargo.toml", '[package\nname = "nested"\n');
		const nestedFile = write("tools/nested/src/lib.rs");
		const nestedRoot = dirname(nestedManifest);
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockResolvedValueOnce(cargoMetadata(root, [nestedManifest]))
			.mockResolvedValueOnce(cargoMetadata(nestedRoot, [nestedManifest]));

		// When
		await resolveCargoWorkspaceRoot(outerFile, { cargoMetadataLoader: metadataLoader });
		const resolvedNested = await resolveCargoWorkspaceRoot(nestedFile, { cargoMetadataLoader: metadataLoader });

		// Then
		expect({ resolvedNested, loaderCalls: metadataLoader.mock.calls.length }).toEqual({
			resolvedNested: nestedRoot,
			loaderCalls: 2,
		});
	});

	it("prefills an ordinary nested package from one outer metadata load", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["tools/nested"]\nresolver = "2"\n');
		const outerFile = write("src/lib.rs");
		const nestedManifest = write("tools/nested/Cargo.toml", '[package]\nname = "nested"\nversion = "0.1.0"\n');
		const nestedFile = write("tools/nested/src/lib.rs");
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockResolvedValue(cargoMetadata(root, [nestedManifest]));

		// When
		const resolvedOuter = await resolveCargoWorkspaceRoot(outerFile, { cargoMetadataLoader: metadataLoader });
		const resolvedNested = await resolveCargoWorkspaceRoot(nestedFile, { cargoMetadataLoader: metadataLoader });

		// Then
		expect([resolvedOuter, resolvedNested]).toEqual([root, root]);
		expect(metadataLoader).toHaveBeenCalledTimes(1);
	});
});

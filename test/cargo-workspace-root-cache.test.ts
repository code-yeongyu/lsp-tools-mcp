import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CargoMetadataLoader, resolveCargoWorkspaceRoot } from "../src/lsp/cargo-workspace-root.js";

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

function eventLoopTurn(): Promise<"event-loop"> {
	return new Promise((resolveTurn) => setImmediate(() => resolveTurn("event-loop")));
}

describe("resolveCargoWorkspaceRoot cache", () => {
	let root: string;

	beforeEach(() => {
		root = realpath(mkdtempSync(join(tmpdir(), "cargo-ws-cache-")));
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

	it("rejects stale in-flight metadata when an ancestor manifest changes before cargo resolves", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		const memberManifest = write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const memberDir = join(root, "crates/a");
		let resolveFirstMetadata: ((value: string) => void) | undefined;
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolveMetadata) => {
						resolveFirstMetadata = resolveMetadata;
					}),
			)
			.mockResolvedValueOnce(cargoMetadata(memberDir, [memberManifest]));

		// When
		const first = resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader });
		const concurrent = resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader });
		write("Cargo.toml", "[workspace]\nmembers = []\n");
		resolveFirstMetadata?.(cargoMetadata(root, [memberManifest]));

		// Then
		await expect(Promise.all([first, concurrent])).resolves.toEqual([memberDir, memberDir]);
		await expect(resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader })).resolves.toBe(memberDir);
		expect(metadataLoader).toHaveBeenCalledTimes(2);
	});

	it("starts fresh metadata when a request begins after an ancestor manifest edit", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		const memberManifest = write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const memberDir = join(root, "crates/a");
		let resolveFirstMetadata: ((value: string) => void) | undefined;
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolveMetadata) => {
						resolveFirstMetadata = resolveMetadata;
					}),
			)
			.mockResolvedValueOnce(cargoMetadata(root, [memberManifest]));
		const first = resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader });

		// When
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a", "crates/b"]\nresolver = "2"\n');
		const second = resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader });
		const secondBeforeFirst = await Promise.race([second, eventLoopTurn()]);
		resolveFirstMetadata?.(cargoMetadata(root, [memberManifest]));
		const [firstRoot, secondRoot] = await Promise.all([first, second]);

		// Then
		expect([secondBeforeFirst, secondRoot]).toEqual([root, root]);
		expect(metadataLoader).toHaveBeenCalledTimes(2);
		expect(firstRoot).toBe(memberDir);
	});

	it("falls back and backs off when valid-shaped metadata points at a missing workspace root", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		const memberManifest = write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const memberDir = join(root, "crates/a");
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockResolvedValue(cargoMetadata(join(root, "missing"), [memberManifest]));
		const now = vi.fn<() => number>().mockReturnValue(10_000);

		// When
		const first = await resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader, now });
		const second = await resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader, now });

		// Then
		expect([first, second]).toEqual([memberDir, memberDir]);
		expect(metadataLoader).toHaveBeenCalledTimes(1);
	});

	it("anchors metadata failure backoff to operation completion", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const memberDir = join(root, "crates/a");
		let nowMs = 30_000;
		const now = vi.fn<() => number>(() => nowMs);
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockImplementation(async () => {
			nowMs += 1_001;
			throw new Error("slow cargo failure");
		});

		// When
		const first = await resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader, now });
		const immediate = await resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader, now });

		// Then
		expect([first, immediate]).toEqual([memberDir, memberDir]);
		expect(metadataLoader).toHaveBeenCalledTimes(1);
	});

	it("falls back when valid-shaped metadata omits the requested member manifest", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a", "crates/b"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const otherManifest = write("crates/b/Cargo.toml", '[package]\nname = "b"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const memberDir = join(root, "crates/a");
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockResolvedValue(cargoMetadata(root, [otherManifest]));

		// When
		const resolved = await resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader });

		// Then
		expect(resolved).toBe(memberDir);
	});

	it("does not cache manifests outside the canonical workspace root", async () => {
		// Given
		const workspaceAManifest = write("workspace-a/Cargo.toml", "[workspace]\nmembers = []\n");
		const workspaceAFile = write("workspace-a/src/lib.rs", "");
		const workspaceBManifest = write("workspace-b/Cargo.toml", "[workspace]\nmembers = []\n");
		const workspaceBFile = write("workspace-b/src/lib.rs", "");
		const workspaceA = dirname(workspaceAManifest);
		const workspaceB = dirname(workspaceBManifest);
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockResolvedValueOnce(cargoMetadata(workspaceA, [workspaceAManifest, workspaceBManifest]))
			.mockResolvedValueOnce(cargoMetadata(workspaceB, [workspaceBManifest]));

		// When
		const resolvedA = await resolveCargoWorkspaceRoot(workspaceAFile, { cargoMetadataLoader: metadataLoader });
		const resolvedB = await resolveCargoWorkspaceRoot(workspaceBFile, { cargoMetadataLoader: metadataLoader });

		// Then
		expect([resolvedA, resolvedB]).toEqual([workspaceA, workspaceB]);
		expect(metadataLoader).toHaveBeenCalledTimes(2);
	});

	it("bypasses a recent metadata failure when an ancestor workspace manifest changes", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		const memberManifest = write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const memberDir = join(root, "crates/a");
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockRejectedValueOnce(new Error("temporary cargo failure"))
			.mockResolvedValueOnce(cargoMetadata(root, [memberManifest]));
		const now = vi.fn<() => number>().mockReturnValue(20_000);
		await expect(resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader, now })).resolves.toBe(
			memberDir,
		);

		// When
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a", "crates/b"]\nresolver = "2"\n');
		const resolved = await resolveCargoWorkspaceRoot(file, { cargoMetadataLoader: metadataLoader, now });

		// Then
		expect(resolved).toBe(root);
		expect(metadataLoader).toHaveBeenCalledTimes(2);
	});
});

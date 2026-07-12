import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CargoMetadataLoader, findWorkspaceRoot } from "../src/lsp/client-wrapper.js";
import type { ResolvedServer } from "../src/lsp/types.js";

const rustServer: ResolvedServer = { id: "rust", command: ["rust-analyzer"], extensions: [".rs"], priority: 0 };
const tsServer: ResolvedServer = {
	id: "typescript",
	command: ["typescript-language-server", "--stdio"],
	extensions: [".ts"],
	priority: 0,
};

const realpath = (p: string): string => realpathSync.native(p);

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

describe("findWorkspaceRoot", () => {
	let root: string;

	beforeEach(() => {
		root = realpath(mkdtempSync(join(tmpdir(), "find-ws-root-")));
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

	it("resolves a Cargo workspace member crate to the workspace root", async () => {
		const rootManifest = write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		const memberManifest = write(
			"crates/a/Cargo.toml",
			'[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		const file = write("crates/a/src/lib.rs", "pub fn a() {}\n");
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockResolvedValue(cargoMetadata(root, [memberManifest]));

		await expect(findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader })).resolves.toBe(root);
		expect(rootManifest).toBe(join(root, "Cargo.toml"));
	});

	it("resolves a workspace-excluded package to its own directory", async () => {
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nexclude = ["fuzz"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n');
		write("crates/a/src/lib.rs", "pub fn a() {}\n");
		const fuzzManifest = write("fuzz/Cargo.toml", '[package]\nname = "fuzz"\nversion = "0.1.0"\nedition = "2021"\n');
		const file = write("fuzz/src/lib.rs", "pub fn f() {}\n");
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockResolvedValue(cargoMetadata(join(root, "fuzz"), [fuzzManifest]));

		await expect(findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader })).resolves.toBe(
			join(root, "fuzz"),
		);
	});

	it("prefills workspace members with one metadata call", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a", "crates/b"]\nresolver = "2"\n');
		const manifestA = write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const manifestB = write("crates/b/Cargo.toml", '[package]\nname = "b"\nversion = "0.1.0"\n');
		const fileA = write("crates/a/src/lib.rs", "");
		const fileB = write("crates/b/src/lib.rs", "");
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockResolvedValue(cargoMetadata(root, [manifestA, manifestB]));

		// When
		const rootA = await findWorkspaceRoot(fileA, rustServer, { cargoMetadataLoader: metadataLoader });
		const rootB = await findWorkspaceRoot(fileB, rustServer, { cargoMetadataLoader: metadataLoader });

		// Then
		expect([rootA, rootB]).toEqual([root, root]);
		expect(metadataLoader).toHaveBeenCalledTimes(1);
	});

	it("stays at the nearest Cargo package when metadata loading fails", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockRejectedValue(new Error("cargo unavailable"));

		// When
		const resolved = await findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader });

		// Then
		expect(resolved).toBe(join(root, "crates/a"));
	});

	it("stays at the nearest Cargo package when metadata is malformed", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockResolvedValue(JSON.stringify({ workspace_root: root }));

		// When
		const resolved = await findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader });

		// Then
		expect(resolved).toBe(join(root, "crates/a"));
	});

	it("deduplicates concurrent metadata failures", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockRejectedValue(new Error("cargo unavailable"));

		// When
		const resolved = await Promise.all([
			findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader }),
			findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader }),
		]);

		// Then
		expect(resolved).toEqual([join(root, "crates/a"), join(root, "crates/a")]);
		expect(metadataLoader).toHaveBeenCalledTimes(1);
	});

	it("reuses a recent metadata failure for sequential requests", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockRejectedValue(new Error("cargo unavailable"));
		const now = vi.fn<() => number>().mockReturnValue(1_000);

		// When
		const first = await findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader, now });
		const second = await findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader, now });

		// Then
		expect([first, second]).toEqual([join(root, "crates/a"), join(root, "crates/a")]);
		expect(metadataLoader).toHaveBeenCalledTimes(1);
	});

	it("retries metadata after the failure backoff expires", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockRejectedValue(new Error("cargo unavailable"));
		let currentTimeMs = 2_000;
		const now = (): number => currentTimeMs;

		// When
		const first = await findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader, now });
		currentTimeMs += 1_001;
		const second = await findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader, now });

		// Then
		expect([first, second]).toEqual([join(root, "crates/a"), join(root, "crates/a")]);
		expect(metadataLoader).toHaveBeenCalledTimes(2);
	});

	it("bypasses a recent metadata failure when the member manifest changes", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const metadataLoader = vi.fn<CargoMetadataLoader>().mockRejectedValue(new Error("cargo unavailable"));
		const now = vi.fn<() => number>().mockReturnValue(3_000);
		await expect(findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader, now })).resolves.toBe(
			join(root, "crates/a"),
		);

		// When
		write("crates/a/Cargo.toml", '[package]\nname = "a-renamed"\nversion = "0.1.0"\n');
		const resolved = await findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader, now });

		// Then
		expect(resolved).toBe(join(root, "crates/a"));
		expect(metadataLoader).toHaveBeenCalledTimes(2);
	});

	it("invalidates a cached workspace root when the root manifest changes", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\n');
		const memberManifest = write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockResolvedValueOnce(cargoMetadata(root, [memberManifest]))
			.mockResolvedValueOnce(cargoMetadata(join(root, "crates/a"), [memberManifest]));
		await expect(findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader })).resolves.toBe(root);

		// When
		write("Cargo.toml", "[workspace]\nmembers = []\n");
		const resolved = await findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader });

		// Then
		expect(resolved).toBe(join(root, "crates/a"));
		expect(metadataLoader).toHaveBeenCalledTimes(2);
	});

	it("invalidates a cached workspace root when the member manifest changes", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\n');
		const memberManifest = write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
		const file = write("crates/a/src/lib.rs", "");
		const metadataLoader = vi
			.fn<CargoMetadataLoader>()
			.mockResolvedValueOnce(cargoMetadata(root, [memberManifest]))
			.mockResolvedValueOnce(cargoMetadata(join(root, "crates/a"), [memberManifest]));
		await expect(findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader })).resolves.toBe(root);

		// When
		write("crates/a/Cargo.toml", '[package]\nname = "a-renamed"\nversion = "0.1.0"\n');
		const resolved = await findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader });

		// Then
		expect(resolved).toBe(join(root, "crates/a"));
		expect(metadataLoader).toHaveBeenCalledTimes(2);
	});

	it("does not collapse to the Cargo workspace root for non-Rust servers", async () => {
		// Given
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n');
		const file = write("crates/a/src/lib.rs", "");
		const metadataLoader = vi.fn<CargoMetadataLoader>();

		// When / Then
		await expect(findWorkspaceRoot(file, tsServer, { cargoMetadataLoader: metadataLoader })).resolves.toBe(
			join(root, "crates/a"),
		);
		expect(metadataLoader).not.toHaveBeenCalled();
	});

	it("uses nearest-marker behavior when no server is provided", async () => {
		// Given
		write("package.json", "{}\n");
		const file = write("sub/deep/file.ts", "");
		const metadataLoader = vi.fn<CargoMetadataLoader>();

		// When / Then
		await expect(findWorkspaceRoot(file, undefined, { cargoMetadataLoader: metadataLoader })).resolves.toBe(root);
		expect(metadataLoader).not.toHaveBeenCalled();
	});

	it("falls back to the nearest marker for a Rust file outside any Cargo project", async () => {
		// Given
		write(".git/HEAD", "ref: refs/heads/main\n");
		const file = write("sub/orphan.rs", "");
		const metadataLoader = vi.fn<CargoMetadataLoader>();

		// When / Then
		await expect(findWorkspaceRoot(file, rustServer, { cargoMetadataLoader: metadataLoader })).resolves.toBe(root);
		expect(metadataLoader).not.toHaveBeenCalled();
	});
});

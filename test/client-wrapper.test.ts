import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkspaceRoot } from "../src/lsp/client-wrapper.js";
import type { ResolvedServer } from "../src/lsp/types.js";

const rustServer: ResolvedServer = { id: "rust", command: ["rust-analyzer"], extensions: [".rs"], priority: 0 };
const tsServer: ResolvedServer = {
	id: "typescript",
	command: ["typescript-language-server", "--stdio"],
	extensions: [".ts"],
	priority: 0,
};

const realpath = (p: string): string => realpathSync.native(p);

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

	it("resolves a Cargo workspace member crate to the workspace root", () => {
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n');
		const file = write("crates/a/src/lib.rs", "pub fn a() {}\n");

		expect(findWorkspaceRoot(file, rustServer)).toBe(root);
	});

	it("resolves a workspace-excluded package to its own directory", () => {
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nexclude = ["fuzz"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n');
		write("crates/a/src/lib.rs", "pub fn a() {}\n");
		write("fuzz/Cargo.toml", '[package]\nname = "fuzz"\nversion = "0.1.0"\nedition = "2021"\n');
		const file = write("fuzz/src/lib.rs", "pub fn f() {}\n");

		expect(findWorkspaceRoot(file, rustServer)).toBe(join(root, "fuzz"));
	});

	it("does not collapse to the Cargo workspace root for non-Rust servers", () => {
		write("Cargo.toml", '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
		write("crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n');
		const file = write("crates/a/src/lib.rs", "");

		expect(findWorkspaceRoot(file, tsServer)).toBe(join(root, "crates/a"));
	});

	it("uses nearest-marker behavior when no server is provided", () => {
		write("package.json", "{}\n");
		const file = write("sub/deep/file.ts", "");

		expect(findWorkspaceRoot(file)).toBe(root);
	});

	it("falls back to the nearest marker for a Rust file outside any Cargo project", () => {
		write(".git/HEAD", "ref: refs/heads/main\n");
		const file = write("sub/orphan.rs", "");

		expect(findWorkspaceRoot(file, rustServer)).toBe(root);
	});
});

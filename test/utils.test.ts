import { afterEach, describe, expect, it, vi } from "vitest";

import { LspProcessExitedError } from "../src/lsp/errors.js";
import {
	formatKnownLspStartupFailure,
	handleMissingDependencyError,
	normalizeDiagnosticUri,
} from "../src/lsp/utils.js";

describe("formatKnownLspStartupFailure", () => {
	it("#given rust-src component conflict #when formatting startup failure #then returns repair guidance", () => {
		// given
		const error = new LspProcessExitedError(
			"rust",
			"/repo",
			1,
			"failed to install component: 'rust-src', detected conflict: 'lib/rustlib/src/rust/library/Cargo.lock'",
		);

		// when
		const message = formatKnownLspStartupFailure(error);

		// then
		expect(message).toContain("rust-analyzer");
		expect(message).toContain("rustup component remove rust-src");
		expect(message).toContain("rustup component add rust-src");
		expect(message).toContain("detected conflict");
		expect(message).toContain("Cargo.lock");
		expect(message).not.toContain("automatic repair");
	});

	it("#given rust-analyzer sysroot error #when handling missing dependency #then returns repair guidance", () => {
		// given
		const error = new LspProcessExitedError(
			"rust",
			"/repo",
			1,
			"can't load standard library from sysroot\ntry installing `rust-src` the same way you installed `rustc`",
		);

		// when
		const message = handleMissingDependencyError(error);

		// then
		expect(message).toContain("rustup component remove rust-src");
		expect(message).toContain("rustup component add rust-src");
		expect(message).toContain("can't load standard library");
	});

	it("#given unrelated process exits #when formatting startup failure #then returns null", () => {
		// given
		const typescriptError = new LspProcessExitedError(
			"typescript",
			"/repo",
			1,
			"failed to install component: 'rust-src', detected conflict",
		);
		const rustPanic = new LspProcessExitedError("rust", "/repo", 1, "thread panicked while loading crate graph");

		// when / then
		expect(formatKnownLspStartupFailure(typescriptError)).toBeNull();
		expect(formatKnownLspStartupFailure(rustPanic)).toBeNull();
	});
});

describe("handleMissingDependencyError", () => {
	it("#given existing dependency messages #when handling error #then preserves current messages", () => {
		// given
		const notInstalled = new Error("LSP server 'typescript' is configured but NOT INSTALLED.");
		const notConfigured = new Error("No LSP server configured for extension: .md");

		// when / then
		expect(handleMissingDependencyError(notInstalled)).toBe(notInstalled.message);
		expect(handleMissingDependencyError(notConfigured)).toBe(notConfigured.message);
	});
});

describe("normalizeDiagnosticUri", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubPlatform(value: NodeJS.Platform): void {
		vi.stubGlobal("process", { ...process, platform: value });
	}

	it("#given windows didOpen and publishDiagnostics uris for the same file #when normalizing #then both match", () => {
		// given
		stubPlatform("win32");
		const didOpen = "file:///C:/workspace/proj/src/Index.ts";
		const published = "file:///c%3A/workspace/proj/src/Index.ts";

		// when
		const normalizedOpen = normalizeDiagnosticUri(didOpen);
		const normalizedPublished = normalizeDiagnosticUri(published);

		// then
		expect(normalizedOpen).toBe(normalizedPublished);
	});

	it("#given a windows uri #when normalizing #then only the drive letter is lowered and path case is preserved", () => {
		// given
		stubPlatform("win32");

		// when
		const normalized = normalizeDiagnosticUri("file:///C:/Workspace/Proj/MyComponent.ts");

		// then
		expect(normalized).toBe("file:///c:/Workspace/Proj/MyComponent.ts");
	});

	it("#given posix uris #when normalizing #then they are returned unchanged", () => {
		// given
		stubPlatform("linux");
		const upper = "file:///home/user/Foo.ts";
		const lower = "file:///home/user/foo.ts";

		// when / then
		expect(normalizeDiagnosticUri(upper)).toBe(upper);
		expect(normalizeDiagnosticUri(lower)).toBe(lower);
		expect(normalizeDiagnosticUri(upper)).not.toBe(normalizeDiagnosticUri(lower));
	});
});

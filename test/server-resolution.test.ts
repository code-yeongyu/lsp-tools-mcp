import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findServerForExtension } from "../src/lsp/server-resolution.js";

const tempDirectories: string[] = [];

type EnvSnapshot = {
	readonly project: string | undefined;
	readonly user: string | undefined;
};

function createFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lsp-tools-biome-"));
	tempDirectories.push(root);
	return root;
}

function useEmptyLspConfig(root: string): EnvSnapshot {
	const projectConfig = join(root, "project-lsp.json");
	const userConfig = join(root, "user-lsp.json");
	writeFileSync(projectConfig, JSON.stringify({ lsp: {} }));
	writeFileSync(userConfig, JSON.stringify({ lsp: {} }));

	const snapshot: EnvSnapshot = {
		project: process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"],
		user: process.env["LSP_TOOLS_MCP_USER_CONFIG"],
	};
	process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"] = projectConfig;
	process.env["LSP_TOOLS_MCP_USER_CONFIG"] = userConfig;
	return snapshot;
}

function restoreLspConfig(snapshot: EnvSnapshot): void {
	if (snapshot.project === undefined) {
		delete process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"];
	} else {
		process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"] = snapshot.project;
	}

	if (snapshot.user === undefined) {
		delete process.env["LSP_TOOLS_MCP_USER_CONFIG"];
	} else {
		process.env["LSP_TOOLS_MCP_USER_CONFIG"] = snapshot.user;
	}
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("server resolution", () => {
	it("#given css file without Biome opt-in #when resolving built-in servers #then does not select Biome", () => {
		// given
		const root = createFixture();
		const snapshot = useEmptyLspConfig(root);
		const cssPath = join(root, "style.css");
		writeFileSync(cssPath, "body { color: red; }\n");

		try {
			// when
			const result = findServerForExtension(".css", { filePath: cssPath });

			// then
			expect(result).toMatchObject({ status: "not_configured", extension: ".css" });
			if (result.status === "not_configured") {
				expect(result.availableServers).not.toContain("biome");
			}
		} finally {
			restoreLspConfig(snapshot);
		}
	});

	it("#given css file with Biome config #when resolving built-in servers #then selects Biome", () => {
		// given
		const root = createFixture();
		const snapshot = useEmptyLspConfig(root);
		const cssPath = join(root, "style.css");
		writeFileSync(cssPath, "body { color: red; }\n");
		writeFileSync(join(root, "biome.json"), "{}\n");

		try {
			// when
			const result = findServerForExtension(".css", { filePath: cssPath });

			// then
			expect(result).toMatchObject({
				status: "found",
				server: expect.objectContaining({ id: "biome" }),
			});
		} finally {
			restoreLspConfig(snapshot);
		}
	});

	it("#given css file with Biome jsonc config #when resolving built-in servers #then selects Biome", () => {
		// given
		const root = createFixture();
		const snapshot = useEmptyLspConfig(root);
		const cssPath = join(root, "style.css");
		writeFileSync(cssPath, "body { color: red; }\n");
		writeFileSync(join(root, "biome.jsonc"), "{}\n");

		try {
			// when
			const result = findServerForExtension(".css", { filePath: cssPath });

			// then
			expect(result).toMatchObject({
				status: "found",
				server: expect.objectContaining({ id: "biome" }),
			});
		} finally {
			restoreLspConfig(snapshot);
		}
	});

	it("#given css file with Biome package dependency #when resolving built-in servers #then selects Biome", () => {
		// given
		const root = createFixture();
		const snapshot = useEmptyLspConfig(root);
		const cssPath = join(root, "style.css");
		writeFileSync(cssPath, "body { color: red; }\n");
		writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "@biomejs/biome": "2.4.16" } }));

		try {
			// when
			const result = findServerForExtension(".css", { filePath: cssPath });

			// then
			expect(result).toMatchObject({
				status: "found",
				server: expect.objectContaining({ id: "biome" }),
			});
		} finally {
			restoreLspConfig(snapshot);
		}
	});
});

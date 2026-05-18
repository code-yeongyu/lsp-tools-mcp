import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { getConfigPaths } from "../src/lsp/config-loader.js";

describe("config loader", () => {
	it("uses Codex config locations instead of pi config locations", () => {
		const paths = getConfigPaths();
		const expectedSuffix = join(".codex", "lsp-client.json");
		const piMarker = `${sep}.pi${sep}`;

		expect(paths.project.endsWith(expectedSuffix)).toBe(true);
		expect(paths.user.endsWith(expectedSuffix)).toBe(true);
		expect(paths.project).not.toContain(piMarker);
		expect(paths.user).not.toContain(piMarker);
	});

	it("supports project and user config path overrides via environment variables", () => {
		const previousProject = process.env.LSP_TOOLS_MCP_PROJECT_CONFIG;
		const previousUser = process.env.LSP_TOOLS_MCP_USER_CONFIG;

		process.env.LSP_TOOLS_MCP_PROJECT_CONFIG = "config/lsp-opencode.json";
		process.env.LSP_TOOLS_MCP_USER_CONFIG = ".opencode/lsp.json";

		try {
			const paths = getConfigPaths();

			expect(paths.project).toBe(join(process.cwd(), "config", "lsp-opencode.json"));
			expect(paths.user).toBe(join(process.env.HOME ?? "", ".opencode", "lsp.json"));
		} finally {
			if (previousProject === undefined) {
				delete process.env.LSP_TOOLS_MCP_PROJECT_CONFIG;
			} else {
				process.env.LSP_TOOLS_MCP_PROJECT_CONFIG = previousProject;
			}

			if (previousUser === undefined) {
				delete process.env.LSP_TOOLS_MCP_USER_CONFIG;
			} else {
				process.env.LSP_TOOLS_MCP_USER_CONFIG = previousUser;
			}
		}
	});

	it("keeps absolute override paths unchanged", () => {
		const previousProject = process.env.LSP_TOOLS_MCP_PROJECT_CONFIG;
		const previousUser = process.env.LSP_TOOLS_MCP_USER_CONFIG;
		const absoluteProject = join(process.cwd(), "overrides", "project.json");
		const absoluteUser = join(process.cwd(), "overrides", "user.json");

		process.env.LSP_TOOLS_MCP_PROJECT_CONFIG = absoluteProject;
		process.env.LSP_TOOLS_MCP_USER_CONFIG = absoluteUser;

		try {
			const paths = getConfigPaths();

			expect(paths.project).toBe(absoluteProject);
			expect(paths.user).toBe(absoluteUser);
		} finally {
			if (previousProject === undefined) {
				delete process.env.LSP_TOOLS_MCP_PROJECT_CONFIG;
			} else {
				process.env.LSP_TOOLS_MCP_PROJECT_CONFIG = previousProject;
			}

			if (previousUser === undefined) {
				delete process.env.LSP_TOOLS_MCP_USER_CONFIG;
			} else {
				process.env.LSP_TOOLS_MCP_USER_CONFIG = previousUser;
			}
		}
	});
});

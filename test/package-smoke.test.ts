import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("package metadata", () => {
	it("#given packaged files #when validating entrypoints #then package metadata is consistent", () => {
		// given
		const packageJson = readJson("package.json");
		const cliSource = readFileSync("src/cli.ts", "utf8");

		// when
		const bin = packageJson.bin as Record<string, unknown>;
		const files = packageJson.files as string[];
		const dependencies = packageJson.dependencies as Record<string, unknown> | undefined;

		// then
		expect(packageJson.type).toBe("module");
		expect(packageJson.packageManager).toBe("npm@11.12.1");
		expect(packageJson.name).toBe("@code-yeongyu/lsp-tools-mcp");
		expect(packageJson.license).toBe("MIT");
		expect(dependencies ?? {}).toEqual({});
		expect(bin["lsp-tools-mcp"]).toBe("./dist/cli.js");
		expect(files).toEqual(["dist", "LICENSE", "NOTICE", "README.md", "CHANGELOG.md"]);
		expect(cliSource.startsWith("#!/usr/bin/env node")).toBe(true);
		expect(cliSource).toContain("Usage: lsp-tools-mcp [mcp]");
	});
});

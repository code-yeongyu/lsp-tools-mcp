import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { LspClient } from "../src/lsp/client.js";
import { fakeLspServerSource } from "./helpers/fake-lsp-server-source.js";

it("can request diagnostics from a server that requires InitializedParams", async () => {
	const root = mkdtempSync(join(tmpdir(), "lsp-initialization-"));
	const serverPath = join(root, "server.cjs");
	const filePath = join(root, "index.ts");
	writeFileSync(serverPath, fakeLspServerSource());
	writeFileSync(filePath, "export const value = 1;\n");
	const client = new LspClient(root, {
		id: "typescript",
		command: [process.execPath, serverPath],
		extensions: [".ts"],
		priority: 0,
	});

	try {
		await client.start();
		await client.initialize();
		await expect(client.diagnostics(filePath)).resolves.toEqual({ items: [] });
		expect(client.getDiagnosticPullErrors()).toEqual([]);
	} finally {
		await client.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

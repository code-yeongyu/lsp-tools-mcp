import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as clientWrapperModule from "../src/lsp/client-wrapper.js";
import { aggregateDiagnosticsForDirectory } from "../src/lsp/directory-diagnostics.js";
import * as managerModule from "../src/lsp/manager.js";
import { LspManager } from "../src/lsp/manager.js";
import * as serverResolutionModule from "../src/lsp/server-resolution.js";
import type { ResolvedServer } from "../src/lsp/types.js";
import { FakeLspClient, makeServer } from "./helpers/fake-lsp-client.js";

describe("directory diagnostics client cancellation ownership", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("#given an already-live client #when abort wins after acquisition #then the acquired reference is released exactly once", async () => {
		// Given
		const directory = mkdtempSync(join(tmpdir(), "directory-client-cancel-"));
		const server = makeServer("typescript");
		const manager = new LspManager({
			clientFactory: (root: string, resolvedServer: ResolvedServer) => new FakeLspClient(root, resolvedServer),
		});

		try {
			writeFileSync(join(directory, "index.ts"), "export const value = 1;\n");
			vi.spyOn(clientWrapperModule, "findWorkspaceRoot").mockResolvedValue(directory);
			vi.spyOn(serverResolutionModule, "findServerForExtension").mockReturnValue({ status: "found", server });
			vi.spyOn(managerModule, "getLspManager").mockReturnValue(manager);

			await manager.getClient(directory, server);
			manager.releaseClient(directory, server.id);
			expect(manager.getSnapshot()[0]?.refCount).toBe(0);

			const controller = new AbortController();
			const acquireClient = manager.getClient.bind(manager);
			const releaseSpy = vi.spyOn(manager, "releaseClient");
			vi.spyOn(manager, "getClient").mockImplementation((root, resolvedServer, signal) => {
				const acquisition = acquireClient(root, resolvedServer, signal);
				controller.abort();
				return acquisition;
			});

			// When
			const diagnostics = aggregateDiagnosticsForDirectory(directory, ".ts", undefined, 100, {
				signal: controller.signal,
			});

			// Then
			await expect(diagnostics).rejects.toMatchObject({ name: "AbortError" });
			expect(releaseSpy).toHaveBeenCalledTimes(1);
			expect(manager.getSnapshot()[0]?.refCount).toBe(0);
		} finally {
			await manager.stopAll();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

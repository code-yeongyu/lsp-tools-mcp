import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { LspClient } from "../src/lsp/client.js";
import { LspRequestTimeoutError } from "../src/lsp/errors.js";
import type { Diagnostic } from "../src/lsp/types.js";

import { makeServer } from "./helpers/fake-lsp-client.js";

const storedDiagnostic: Diagnostic = {
	range: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 5 },
	},
	message: "published diagnostic",
};

class TestDiagnosticsClient extends LspClient {
	diagnosticRequestCount = 0;

	constructor(supportsDiagnosticPull: boolean) {
		super("/workspace", makeServer("fake", [".ex"]));
		if (supportsDiagnosticPull) {
			this.serverCapabilities = { diagnosticProvider: {} };
		}
	}

	override async openFile(filePath: string): Promise<void> {
		const uri = pathToFileURL(resolve(filePath)).href;
		this.diagnosticsStore.set(uri, [storedDiagnostic]);
	}

	protected override async sendRequest<T>(method: string, ..._args: [] | [unknown]): Promise<T> {
		if (method !== "textDocument/diagnostic") {
			throw new Error(`unexpected request: ${method}`);
		}

		this.diagnosticRequestCount++;
		throw new LspRequestTimeoutError(method);
	}
}

describe("LspClient diagnostics", () => {
	it("#given server does not advertise diagnostic pull #when diagnostics are requested #then stored diagnostics are reused without a pull request", async () => {
		const client = new TestDiagnosticsClient(false);
		const filePath = "/workspace/lib/sample.ex";

		const result = await client.diagnostics(filePath);

		expect(result.items).toEqual([storedDiagnostic]);
		expect(client.diagnosticRequestCount).toBe(0);
		expect(client.getDiagnosticPullErrors()).toEqual([]);
	});

	it("#given diagnostic pull times out #when diagnostics are requested again #then stored diagnostics are reused without another pull request", async () => {
		const client = new TestDiagnosticsClient(true);
		const filePath = "/workspace/lib/sample.ex";

		const first = await client.diagnostics(filePath);
		const second = await client.diagnostics(filePath);

		expect(first.items).toEqual([storedDiagnostic]);
		expect(second.items).toEqual([storedDiagnostic]);
		expect(client.diagnosticRequestCount).toBe(1);
		expect(client.getDiagnosticPullErrors()).toEqual([]);
	});
});

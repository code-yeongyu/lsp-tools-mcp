import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { LspClient } from "../src/lsp/client.js";
import { JsonRpcConnection } from "../src/lsp/json-rpc-connection.js";
import * as processModule from "../src/lsp/process.js";
import type { Diagnostic } from "../src/lsp/types.js";

class DiagnosticProbe extends LspClient {
	constructor(private readonly failure: Error) {
		super("/unused", { id: "typescript", command: ["unused"], extensions: [".ts"], priority: 0 });
	}

	override async openFile(): Promise<void> {}

	protected override async sendRequest<T>(): Promise<T> {
		throw this.failure;
	}
}

describe("diagnostic failures", () => {
	it("rejects a crashed server instead of returning empty diagnostics", async () => {
		vi.useFakeTimers();
		try {
			const client = new DiagnosticProbe(new Error("language server exited"));
			const result = expect(client.diagnostics("probe.ts")).rejects.toThrow("language server exited");
			await vi.runAllTimersAsync();
			await result;
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["Method not found", "Unhandled method textDocument/diagnostic"])(
		"keeps push fallback for %s",
		async (message) => {
			vi.useFakeTimers();
			try {
				const client = new DiagnosticProbe(new Error(message));
				const result = expect(client.diagnostics("probe.ts")).resolves.toEqual({ items: [] });
				await vi.runAllTimersAsync();
				await result;
			} finally {
				vi.useRealTimers();
			}
		},
	);
});

const pushedDiagnostic: Diagnostic = {
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	severity: 1,
	message: "A pushed diagnostic",
};

interface SerializedPullError {
	code: number;
	message: string;
}

function respondToDiagnosticPull(
	clientOutput: PassThrough,
	serverOutput: PassThrough,
	error: SerializedPullError,
): void {
	clientOutput.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		const request = JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)) as Record<string, unknown>;
		if (request["method"] !== "textDocument/diagnostic") return;
		const body = JSON.stringify({ jsonrpc: "2.0", id: request["id"], error });
		serverOutput.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
	});
}

async function withDiagnosticServer(
	pullError: string | SerializedPullError | undefined,
	assertResult: (client: LspClient, file: string) => Promise<void>,
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "lsp-diagnostic-failure-"));
	const file = join(root, "probe.ts");
	writeFileSync(file, "export const value = 1;\n");
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const spawn = vi.spyOn(processModule, "spawnProcess").mockReturnValue({
		stdin,
		stdout,
		stderr,
		pid: undefined,
		exitCode: null,
		exited: Promise.resolve(0),
		kill: vi.fn(),
		killed: false,
	});
	const server = new JsonRpcConnection(stdin, stdout);
	server.onRequest("shutdown", () => null);
	if (typeof pullError === "object") {
		server.onRequest("textDocument/diagnostic", () => new Promise(() => {}));
		respondToDiagnosticPull(stdin, stdout, pullError);
	} else if (pullError !== undefined) {
		server.onRequest("textDocument/diagnostic", (params) => {
			expect(params).toEqual({ textDocument: { uri: pathToFileURL(file).href } });
			throw new Error(pullError);
		});
	}
	server.listen();
	const client = new LspClient(root, {
		id: "typescript",
		command: ["unused"],
		extensions: [".ts"],
		priority: 0,
	});
	try {
		await client.start();
		await server.sendNotification("textDocument/publishDiagnostics", {
			uri: pathToFileURL(file).href,
			diagnostics: [pushedDiagnostic],
		});
		await assertResult(client, file);
	} finally {
		await client.stop();
		server.dispose();
		stdin.destroy();
		stdout.destroy();
		stderr.destroy();
		spawn.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
}

describe("serialized diagnostic failures", () => {
	it("rejects an unexpected pull error even when push diagnostics are available", async () => {
		await withDiagnosticServer("language server exited", async (client, file) => {
			await expect(client.diagnostics(file)).rejects.toThrow("language server exited");
			expect(client.getDiagnosticPullErrors()).toHaveLength(1);
			expect(client.getDiagnosticPullErrors()[0]?.message).toBe("language server exited");
		});
	});

	it("rejects a serialized internal error with an unrecognized message", async () => {
		await withDiagnosticServer({ code: -32603, message: "No diagnostic handler" }, async (client, file) => {
			await expect(client.diagnostics(file)).rejects.toThrow("No diagnostic handler");
			expect(client.getDiagnosticPullErrors()).toHaveLength(1);
		});
	});

	it.each([
		{ name: "Method not found", pullError: undefined },
		{ name: "serialized -32601 code", pullError: { code: -32601, message: "No diagnostic handler" } },
		{ name: "Unhandled method textDocument/diagnostic", pullError: "Unhandled method textDocument/diagnostic" },
	])("returns pushed diagnostics for $name", async ({ pullError }) => {
		await withDiagnosticServer(pullError, async (client, file) => {
			await expect(client.diagnostics(file)).resolves.toEqual({ items: [pushedDiagnostic] });
			expect(client.getDiagnosticPullErrors()).toEqual([]);
		});
	});
});

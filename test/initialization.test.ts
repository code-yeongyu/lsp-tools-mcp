import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

import { LspClientConnection } from "../src/lsp/connection.js";
import { JsonRpcConnection } from "../src/lsp/json-rpc-connection.js";
import * as processModule from "../src/lsp/process.js";

it("sends initialized with an empty params object over JSON-RPC", async () => {
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
	const received: Array<{ method: string; params: unknown }> = [];
	const server = new JsonRpcConnection(stdin, stdout);
	server.onRequest("initialize", (params) => {
		received.push({ method: "initialize", params });
		return { capabilities: {} };
	});
	server.onNotification("initialized", (params) => {
		received.push({ method: "initialized", params });
	});
	server.onNotification("workspace/didChangeConfiguration", (params) => {
		received.push({ method: "workspace/didChangeConfiguration", params });
	});
	server.onRequest("shutdown", () => null);
	server.listen();
	const client = new LspClientConnection("/unused", {
		id: "typescript",
		command: ["unused"],
		extensions: [".ts"],
		priority: 0,
	});
	try {
		await client.start();
		await client.initialize();
		expect(received.map(({ method }) => method)).toEqual([
			"initialize",
			"initialized",
			"workspace/didChangeConfiguration",
		]);
		expect(received[1]).toEqual({ method: "initialized", params: {} });
		expect(received[2]).toEqual({
			method: "workspace/didChangeConfiguration",
			params: { settings: { json: { validate: { enable: true } } } },
		});
	} finally {
		await client.stop();
		server.dispose();
		stdin.destroy();
		stdout.destroy();
		stderr.destroy();
		spawn.mockRestore();
	}
});

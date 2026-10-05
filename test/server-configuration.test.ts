import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { LspClientConnection } from "../src/lsp/connection.js";
import { JsonRpcConnection } from "../src/lsp/json-rpc-connection.js";
import * as processModule from "../src/lsp/process.js";
import { LspClientTransport } from "../src/lsp/transport.js";

const rustInitialization = {
	checkOnSave: false,
	cargo: { buildScripts: { enable: false } },
	procMacro: { enable: false },
};

async function requestConfiguration(
	id: string,
	initialization: Record<string, unknown> | undefined,
	params: unknown,
): Promise<unknown> {
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
	server.listen();
	const client = new LspClientTransport("/unused", {
		id,
		command: ["unused"],
		extensions: [],
		priority: 0,
		...(initialization === undefined ? {} : { initialization }),
	});
	try {
		await client.start();
		return await server.sendRequest("workspace/configuration", params);
	} finally {
		await client.stop();
		server.dispose();
		stdin.destroy();
		stdout.destroy();
		stderr.destroy();
		spawn.mockRestore();
	}
}

describe("workspace/configuration", () => {
	it("keeps Rust initialization settings in the serialized configuration response", async () => {
		const params = {
			items: [{ section: "rust-analyzer" }, { section: "rust-analyzer", scopeUri: "file:///unused/src/lib.rs" }],
		};
		await expect(requestConfiguration("rust", rustInitialization, params)).resolves.toEqual([
			rustInitialization,
			rustInitialization,
		]);
	});

	it("keeps JSON validation and unrelated sections unchanged", async () => {
		await expect(
			requestConfiguration("rust", rustInitialization, {
				items: [{ section: "json" }, { section: "other" }, {}, { section: "" }],
			}),
		).resolves.toEqual([{ validate: { enable: true } }, {}, {}, {}]);
	});

	it.each(["typescript", "json", "other"])("does not expose %s initialization as Rust settings", async (id) => {
		await expect(
			requestConfiguration(id, rustInitialization, { items: [{ section: "rust-analyzer" }] }),
		).resolves.toEqual([{}]);
	});

	it("returns the existing empty configuration when Rust has no initialization settings", async () => {
		await expect(requestConfiguration("rust", undefined, { items: [{ section: "rust-analyzer" }] })).resolves.toEqual(
			[{}],
		);
	});
});

class RustConfigurationProbe extends LspClientConnection {
	async notify(method: string, params: unknown): Promise<void> {
		await this.sendNotification(method, params);
	}

	async hover(uri: string): Promise<unknown> {
		return this.sendRequest("textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 8 } });
	}

	logs(): string {
		return this.stderrBuffer.join("");
	}
}

const rustAnalyzer = process.env["LSP_TEST_RUST_ANALYZER"];

it.skipIf(!rustAnalyzer)(
	"retains Rust configuration without executing Cargo checks or build scripts after load and save",
	async () => {
		if (!rustAnalyzer) throw new Error("LSP_TEST_RUST_ANALYZER is required");
		const root = mkdtempSync(join(tmpdir(), "lsp-server-configuration-"));
		const binaryDirectory = join(root, "bin");
		const cargoLog = join(root, "cargo-commands.log");
		const toolchainDirectory = dirname(rustAnalyzer);
		mkdirSync(binaryDirectory);
		mkdirSync(join(root, "src"));
		writeFileSync(
			join(root, "Cargo.toml"),
			'[package]\nname = "configuration_probe"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		const text = "pub fn value() -> u32 { 1 }\n";
		const file = join(root, "src/lib.rs");
		writeFileSync(file, text);
		writeFileSync(join(root, "build.rs"), 'fn main() { std::fs::write("build-script-ran", "ran").unwrap(); }\n');
		writeFileSync(
			join(binaryDirectory, "cargo"),
			[
				"#!/bin/sh",
				`printf '%s\\n' "$*" >> '${cargoLog}'`,
				'case "$1" in check|build|test|run|clippy) exit 97 ;; esac',
				'if [ "$1" = rustc ]; then case " $* " in *" --print "*) ;; *) exit 97 ;; esac; fi',
				`exec '${join(toolchainDirectory, "cargo")}' "$@"`,
			].join("\n"),
			{ mode: 0o755 },
		);
		const responses: Array<{ params: unknown; result: unknown }> = [];
		const onRequest = JsonRpcConnection.prototype.onRequest;
		const registration = vi.spyOn(JsonRpcConnection.prototype, "onRequest").mockImplementation(function (
			this: JsonRpcConnection,
			method,
			handler,
		) {
			onRequest.call(
				this,
				method,
				method === "workspace/configuration"
					? async (params) => {
							const result = await handler(params);
							responses.push({ params, result });
							return result;
						}
					: handler,
			);
		});
		const client = new RustConfigurationProbe(root, {
			id: "rust",
			command: [rustAnalyzer],
			extensions: [".rs"],
			priority: 0,
			initialization: rustInitialization,
			env: {
				PATH: `${binaryDirectory}:${toolchainDirectory}:/usr/bin:/bin`,
				CARGO: join(binaryDirectory, "cargo"),
				CARGO_HOME: root,
				RA_LOG: "rust_analyzer=info",
				CARGO_NET_OFFLINE: "true",
			},
		});
		try {
			await client.start();
			await client.initialize();
			await expect.poll(() => client.logs(), { timeout: 20_000 }).toContain("did switch workspaces");
			expect(responses).toContainEqual({
				params: { items: [{ section: "rust-analyzer" }] },
				result: [rustInitialization],
			});
			const uri = pathToFileURL(file).href;
			await client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "rust", version: 1, text } });
			await expect.poll(() => client.hover(uri), { timeout: 20_000 }).not.toBeNull();
			await client.notify("textDocument/didChange", {
				textDocument: { uri, version: 2 },
				contentChanges: [{ text: "pub fn value() -> u32 { 2 }\n" }],
			});
			await client.notify("textDocument/didSave", { textDocument: { uri } });
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			expect(client.isAlive(), client.logs()).toBe(true);
			const updates = [...client.logs().matchAll(/updating config from JSON: (\{[\s\S]*?\n\})/g)];
			expect(updates.length).toBeGreaterThanOrEqual(2);
			for (const update of updates) {
				expect(JSON.parse(update[1] ?? "null")).toEqual(rustInitialization);
			}
			const commands = readFileSync(cargoLog, "utf8");
			expect(commands).toContain("metadata");
			expect(commands).not.toMatch(/^(?:check|build|test|run|clippy)(?:\s|$)/m);
			for (const command of commands.split("\n").filter((command) => command.startsWith("rustc "))) {
				expect(command).toContain(" --print ");
			}
			expect(existsSync(join(root, "build-script-ran"))).toBe(false);
			expect(existsSync(join(root, "target"))).toBe(false);
			console.log("Rust configuration requests:", JSON.stringify(responses));
			console.log(
				"Rust configuration updates:",
				JSON.stringify(updates.map((update) => JSON.parse(update[1] ?? "null"))),
			);
			console.log("Cargo commands (load and didSave):\n", commands);
		} finally {
			await client.stop();
			registration.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);

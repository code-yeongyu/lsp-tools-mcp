# lsp-tools-mcp

[![ci](https://github.com/code-yeongyu/lsp-tools-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/code-yeongyu/lsp-tools-mcp/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Standalone Language Server Protocol tools exposed as a stdio MCP server.

## Quick Start

```bash
npm install
npm run check
npm test
npm run build
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/cli.js mcp
```

## MCP Tools

This server exposes the following tools:

- `lsp.status`
- `lsp.diagnostics`
- `lsp.goto_definition`
- `lsp.find_references`
- `lsp.symbols`
- `lsp.prepare_rename`
- `lsp.rename`

Tool aliases are also available for compatibility:

- `lsp_status`
- `lsp_diagnostics`
- `lsp_goto_definition`
- `lsp_find_references`
- `lsp_symbols`
- `lsp_prepare_rename`
- `lsp_rename`

## Configuration

Default config paths:

- Project: `.codex/lsp-client.json`
- User: `~/.codex/lsp-client.json`

Path overrides via environment variables:

- `LSP_TOOLS_MCP_PROJECT_CONFIG`
- `LSP_TOOLS_MCP_USER_CONFIG`

Examples:

```bash
LSP_TOOLS_MCP_PROJECT_CONFIG=.opencode/lsp.json node dist/cli.js mcp
LSP_TOOLS_MCP_USER_CONFIG=.opencode/lsp.json node dist/cli.js mcp
```

Example config:

```json
{
	"lsp": {
		"typescript": {
			"command": ["typescript-language-server", "--stdio"],
			"extensions": [".ts", ".tsx", ".js", ".jsx"]
		}
	}
}
```

## Architecture

- `src/lsp/*`: standalone LSP runtime (process management, JSON-RPC transport, configuration, diagnostics, workspace edits)
- `src/tools.ts`: MCP tool definitions and handlers
- `src/mcp.ts`: stdio MCP server entry and registration
- `src/cli.ts`: standalone CLI entry (`mcp` subcommand only)

## Consumers

This package is consumed by two projects as a git submodule:

- **[codex-lsp](https://github.com/code-yeongyu/codex-lsp)** - Codex plugin that ships LSP MCP tools plus a Codex-specific PostToolUse diagnostics hook.
- **[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)** - OpenCode plugin that registers this MCP server as a built-in Tier-1 stdio MCP, exposing `lsp_diagnostics`, `lsp_goto_definition`, `lsp_find_references`, `lsp_symbols`, `lsp_prepare_rename`, `lsp_rename`, and `lsp_status` to all agents.

Both consumers point at this repo via `git submodule add` at `packages/lsp-tools-mcp/`.

## Local Development

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

## License

[MIT](LICENSE)

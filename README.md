# Unified MCP Gateway

A guarded, tool-only MCP control plane that gives ChatGPT, Codex, and other MCP clients one stable interface over many providers without exposing thousands of provider schemas directly.

This repository was extracted from the Recepio MCP gateway v0.1 implementation. The initial extraction preserves the tested security model and provider behavior while moving the gateway into a standalone repository.

## Architecture

```text
ChatGPT / Codex / MCP client
        |
        v
Unified MCP Gateway (/mcp, Streamable HTTP)
        |
        +-- OAuth 2.1 resource boundary
        +-- provider catalog + lazy discovery
        +-- policy gate
        +-- audit/redaction
        |
        +-- GitHub REST adapter
        +-- Meta Graph API adapter
        +-- downstream MCP client adapter
        +-- future provider adapters
```

The upstream tool surface stays intentionally small:

- `providers_list`
- `provider_status`
- `tools_search`
- `tool_describe`
- `tool_execute`

## Safety model

Child tools are classified as `READ`, `WRITE`, `HIGH_RISK`, `DESTRUCTIVE`, or `PRODUCTION`. Everything above `READ` is disabled by default and must be explicitly enabled by runtime policy. Provider credentials remain server-side. Downstream MCP URLs are startup configuration and are restricted by an HTTPS host allowlist.

## Initial provider support

- GitHub provider with allowlisted operations.
- Meta Graph API provider with the existing v0.1 read-only operations.
- Generic downstream MCP adapter.

## Local development

```bash
npm ci
cp .env.example .env
npm run check
npm start
```

The default local endpoint is `http://127.0.0.1:8788/mcp`.

## Extraction source

Initial standalone baseline: `Tariq990/recepio-app-v2`, branch `feat/recepio-mcp-deploy-v0-1`, source directory `tools/recepio-mcp/`.

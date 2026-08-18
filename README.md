# Unified MCP Gateway

A guarded, tool-only MCP control plane that gives ChatGPT, Codex, and other MCP clients one stable interface over many providers without exposing thousands of provider schemas directly.

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

Child tools are classified as `READ`, `WRITE`, `HIGH_RISK`, `DESTRUCTIVE`, or `PRODUCTION`. Everything above `READ` is disabled by default and must be explicitly enabled by runtime policy.

For every non-READ child tool, callers must inspect `tool_describe` first and pass the exact returned risk as `expected_risk`. OAuth scope `gateway:write` is also required for non-read actions when OAuth is enabled. Server-side policy remains authoritative.

Provider credentials stay server-side. Audit payloads and provider results redact credential-shaped keys. Generic downstream MCP endpoints must use HTTPS and match the configured host allowlist.

## Current provider support

### GitHub

The native GitHub adapter is read-only by default and exposes:

- `github.repo.get`
- `github.branch.get`
- `github.actions.list_runs`

No repository is allowed implicitly. Set `UNIFIED_MCP_GITHUB_REPOSITORIES` explicitly.

### Meta

The native Meta adapter is read-only and exposes fixed configured assets through:

- `meta.app.get`
- `meta.whatsapp.waba.get`
- `meta.whatsapp.phone_numbers.list`
- `meta.whatsapp.subscribed_apps.list`

### Downstream MCP

Additional MCP servers can be composed at startup through `UNIFIED_MCP_DOWNSTREAM_JSON`. Downstream URLs must use HTTPS and match `UNIFIED_MCP_DOWNSTREAM_ALLOWED_HOSTS`. Unknown downstream tools default to `HIGH_RISK` unless an operator assigns a reviewed risk override.

## OAuth 2.1

For ChatGPT-style authenticated access, set:

- `UNIFIED_MCP_OAUTH_ENABLED=1`
- `UNIFIED_MCP_BASE_URL=https://your-host.example`
- `UNIFIED_MCP_ADMIN_SECRET`
- `UNIFIED_MCP_JWT_SECRET`

The gateway supports Authorization Code + PKCE S256, dynamic client registration, rotating refresh tokens, and protected-resource metadata for `/mcp`.

OAuth scopes are:

- `gateway:read`
- `gateway:write`

## Local development

```bash
npm ci
cp .env.example .env
# For local-only unauthenticated MCP Inspector testing:
# UNIFIED_MCP_DEV_NOAUTH=1
npm run check
npm start
```

The default local endpoint is `http://127.0.0.1:8788/mcp`.

## Deployment

`deploy/bootstrap-env.sh` creates a fail-closed production environment with OAuth enabled and every consequential action class disabled.

`deploy/install.sh` installs immutable SHA-addressed releases under `/opt/unified-mcp-gateway`, runs the full check suite before activation, and keeps the Node service bound to `127.0.0.1:8788`.

Public DNS, TLS, and reverse-proxy activation remain an explicit operator step using `deploy/nginx.conf.example`.

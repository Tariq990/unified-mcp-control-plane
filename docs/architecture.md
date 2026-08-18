# Unified MCP Gateway architecture

## Origin

This standalone repository was extracted from the tested Recepio MCP v0.1 stack in `Tariq990/recepio-app-v2`, culminating in branch `feat/recepio-mcp-deploy-v0-1`.

## Boundary

The gateway exposes a small MCP surface instead of forwarding every provider schema directly:

- `providers_list`
- `provider_status`
- `tools_search`
- `tool_describe`
- `tool_execute`

Provider credentials remain server-side. Provider adapters can be direct REST implementations or downstream MCP clients.

## Authorization model

Every child action is classified as one of:

`READ` → `WRITE` → `HIGH_RISK` → `DESTRUCTIVE` → `PRODUCTION`

Everything above `READ` fails closed unless explicitly enabled. Consequential calls must echo the exact discovered `expected_risk`. OAuth scopes are an additional boundary, not a replacement for policy gates.

## Current adapters

- GitHub REST adapter.
- Meta Graph API adapter (v0.1 read-only operations).
- Generic downstream MCP adapter with HTTPS host allowlisting and conservative risk defaults.

## Extraction compatibility

The first standalone baseline intentionally preserves the proven `RECEPIO_MCP_*` environment variable names and `recepio:read` / `recepio:write` OAuth scope names. They are compatibility identifiers, not a requirement that the gateway remain part of the Recepio application. A future compatibility migration can add neutral aliases without breaking existing clients.

The legacy GitHub fixed smoke write also remains in v0.1 for behavioral parity with the source. All write gates are disabled by default.

## Deployment

The standalone installer keeps Node on `127.0.0.1:8788` and does not activate public ingress automatically. Public DNS/TLS/Nginx activation is intentionally a separate operator step using `deploy/nginx.conf.example`.

# Unified MCP Gateway architecture

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

The public OAuth contract uses `gateway:read` and `gateway:write`. Runtime configuration uses the `UNIFIED_MCP_*` namespace.

## Current adapters

- GitHub REST adapter: read-only baseline with an explicit repository allowlist and no implicit repository defaults.
- Meta Graph API adapter: read-only fixed configured assets.
- Generic downstream MCP adapter: HTTPS host allowlisting, optional per-tool allowlists, and conservative risk defaults.

## Downstream trust model

Downstream MCP annotations are hints, not an authorization boundary. A downstream `destructiveHint` can escalate risk, but a child server cannot downgrade itself to `READ`. Unknown downstream tools therefore default to `HIGH_RISK` unless the operator configures a reviewed risk override.

## Deployment

The standalone installer keeps Node on `127.0.0.1:8788` and does not activate public ingress automatically. Public DNS/TLS/Nginx activation is intentionally a separate operator step using `deploy/nginx.conf.example`.

The production bootstrap enables OAuth while leaving `WRITE`, `HIGH_RISK`, `DESTRUCTIVE`, and `PRODUCTION` disabled. Provider credentials and provider allowlists start empty.

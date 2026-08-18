# Cloudflare deployment

This directory deploys Unified MCP Gateway as an OAuth-protected Cloudflare Worker.

## Runtime posture

The Cloudflare target intentionally starts with all server-side risk gates enabled:

- `UNIFIED_MCP_ALLOW_WRITE=1`
- `UNIFIED_MCP_ALLOW_HIGH_RISK=1`
- `UNIFIED_MCP_ALLOW_DESTRUCTIVE=1`
- `UNIFIED_MCP_ALLOW_PRODUCTION=1`

The OAuth and execution boundaries still apply: non-read tools require the `gateway:write` scope and every non-read execution must echo the exact server-side `expected_risk` returned by `tool_describe`.

## First deploy

```bash
cd cloudflare
npm install
npm run check
npx wrangler secret put UNIFIED_MCP_ADMIN_SECRET
# Add provider secrets as needed, for example:
npx wrangler secret put UNIFIED_MCP_GITHUB_TOKEN
npx wrangler secret put UNIFIED_MCP_META_TOKEN
npm run deploy
```

Wrangler provisions the draft `OAUTH_KV` binding during deployment when automatic resource provisioning is enabled. If your account or Wrangler configuration requires an existing namespace instead, create a Workers KV namespace and add its `id` to the `OAUTH_KV` binding in `wrangler.jsonc`.

The first deployment uses the free `workers.dev` hostname. The MCP endpoint is:

```text
https://<worker-host>/mcp
```

The authorization UI is served at `/authorize`; OAuth token and dynamic client registration endpoints are `/token` and `/register`.

## Provider configuration

Non-secret provider configuration belongs in `wrangler.jsonc` under `vars`. Provider credentials must be Cloudflare secrets, not committed variables.

The native GitHub provider is currently read-only even though all global risk gates are enabled. Write/high-risk/destructive/production actions become available for downstream MCP tools or future native provider tools whose own risk classes require those gates.

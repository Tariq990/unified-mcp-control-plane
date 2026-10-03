# Unified MCP Control Plane

A policy-gated Model Context Protocol control plane that gives AI clients a small, stable tool surface over multiple providers while keeping credentials, authorization, risk classification, and audit behavior server-side.

The runtime implementation is named `unified-mcp-gateway`; the repository presents the broader control-plane architecture built around it.

## What this project demonstrates

- TypeScript backend/system design around the Model Context Protocol.
- OAuth 2.1 Authorization Code + PKCE S256 for authenticated client access.
- A deliberately small upstream MCP surface with lazy provider/tool discovery.
- Server-side policy enforcement for consequential tool execution.
- Risk classification that fails closed by default.
- Credential redaction and bounded trust of downstream MCP metadata.
- Native GitHub and Meta provider adapters plus generic downstream MCP composition.
- Explicit repository/host allowlists instead of implicit access.
- Node.js and Cloudflare Workers deployment paths.
- Deterministic tests for OAuth, policy, provider discovery, redaction, and configuration failure modes.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript |
| Protocol | Model Context Protocol, Streamable HTTP |
| Validation | Zod |
| Authentication | OAuth 2.1, Authorization Code, PKCE S256, JWT-backed sessions |
| Providers | GitHub REST, Meta Graph API, downstream MCP servers |
| Deployment | Linux/systemd + Nginx, Cloudflare Workers |
| Testing | Node.js built-in test runner |

## Why a control plane instead of exposing every provider directly?

A client connected to many tools can otherwise inherit thousands of schemas, credentials, and provider-specific authorization decisions.

This project keeps the upstream contract intentionally small:

- `providers_list`
- `provider_status`
- `tools_search`
- `tool_describe`
- `tool_execute`

Provider-specific capabilities are discovered only when needed. The server remains the authority for whether a child tool is visible and whether a consequential action may execute.

## Architecture

```text
ChatGPT / Codex / MCP client
        |
        |  OAuth 2.1 or private bearer access
        v
Unified MCP Gateway
  /mcp - Streamable HTTP
        |
        +--> provider catalog + lazy discovery
        +--> tool description
        +--> risk classification
        +--> policy gate
        +--> audit/redaction
        |
        +--> GitHub REST adapter
        +--> Meta Graph API adapter
        +--> downstream MCP adapter
                    |
                    +--> HTTPS host allowlist
                    +--> optional tool allowlist
                    +--> conservative risk defaults
```

## Risk model

Every child action is classified into one of these levels:

```text
READ
  -> WRITE
      -> HIGH_RISK
          -> DESTRUCTIVE
              -> PRODUCTION
```

Everything above `READ` is disabled unless explicitly enabled by runtime policy.

For consequential tools, the caller must first inspect the tool description and then echo the exact discovered risk as `expected_risk` when invoking it. This makes the execution step acknowledge the server's classification rather than trusting a client-side assumption.

OAuth scopes are an additional boundary:

- `gateway:read`
- `gateway:write`

OAuth authorization does not bypass server policy gates.

## Fail-closed design

Examples of deliberate failure behavior:

- duplicate provider IDs are rejected;
- malformed downstream configuration is rejected;
- empty GitHub repository allowlists expose no repositories;
- downstream MCP URLs must use HTTPS and match an explicit host allowlist;
- unknown downstream tools default to `HIGH_RISK` unless reviewed and overridden;
- downstream annotations may escalate risk but cannot downgrade the server's classification to `READ`;
- missing provider credentials leave that provider unconfigured rather than fabricating access.

## Provider support

### GitHub

The native GitHub adapter starts read-only and supports an explicit repository allowlist.

Current tools include:

- `github.repo.get`
- `github.branch.get`
- `github.actions.list_runs`

No repository is implicitly accessible. Configure:

```env
UNIFIED_MCP_GITHUB_TOKEN=...
UNIFIED_MCP_GITHUB_REPOSITORIES=owner/repository
```

### Meta

The native Meta Graph API adapter exposes read-only access to explicitly configured assets.

Current tools include:

- `meta.app.get`
- `meta.whatsapp.waba.get`
- `meta.whatsapp.phone_numbers.list`
- `meta.whatsapp.subscribed_apps.list`

Configuration is explicit:

```env
UNIFIED_MCP_META_TOKEN=...
UNIFIED_MCP_META_GRAPH_VERSION=...
UNIFIED_MCP_META_APP_ID=...
UNIFIED_MCP_META_WABA_ID=...
```

### Downstream MCP servers

Additional MCP servers can be composed through `UNIFIED_MCP_DOWNSTREAM_JSON`.

A downstream definition can specify:

- provider ID;
- HTTPS endpoint;
- bearer-token environment variable;
- allowed tools;
- reviewed per-tool risk overrides.

The endpoint host must also appear in `UNIFIED_MCP_DOWNSTREAM_ALLOWED_HOSTS`.

## Authentication modes

### OAuth 2.1

For ChatGPT-style authenticated access:

```env
UNIFIED_MCP_OAUTH_ENABLED=1
UNIFIED_MCP_BASE_URL=https://mcp.example.com
UNIFIED_MCP_ADMIN_SECRET=...
UNIFIED_MCP_JWT_SECRET=...
UNIFIED_MCP_OAUTH_REDIRECT_HOSTS=chatgpt.com
```

The gateway implements Authorization Code + PKCE S256, dynamic client registration, rotating refresh tokens, and protected-resource metadata for `/mcp`.

### Direct/private bearer mode

When OAuth is disabled, a private deployment can use:

```env
UNIFIED_MCP_HTTP_BEARER_TOKEN=...
```

Unauthenticated mode exists only as an explicit local-development option:

```env
UNIFIED_MCP_DEV_NOAUTH=1
```

## Policy configuration

Consequential actions remain disabled unless individually enabled:

```env
UNIFIED_MCP_ALLOW_WRITE=0
UNIFIED_MCP_ALLOW_HIGH_RISK=0
UNIFIED_MCP_ALLOW_DESTRUCTIVE=0
UNIFIED_MCP_ALLOW_PRODUCTION=0
```

The production bootstrap enables OAuth but keeps these gates closed by default.

## Repository map

```text
src/
  server.ts              Node MCP/HTTP server
  auth.ts                OAuth/session implementation
  policy.ts              risk and execution policy
  redact.ts              credential-shaped value redaction
  providers/
    github.ts             GitHub REST adapter
    meta.ts               Meta Graph API adapter
    downstream.ts         generic downstream MCP adapter

test/                    deterministic Node regression tests
docs/architecture.md     trust boundaries and architecture notes
deploy/                   Linux/systemd/Nginx install path
cloudflare/               Cloudflare Workers implementation and config
.github/workflows/        verification/deployment workflow definitions
```

## Getting started

### Prerequisites

- Git
- Node.js 20.11 or newer
- npm

Clone the repository, install the locked dependencies, and create a local environment file:

```bash
git clone https://github.com/Tariq990/unified-mcp-control-plane.git
cd unified-mcp-control-plane
npm ci
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

For the simplest local evaluation, set `UNIFIED_MCP_DEV_NOAUTH=1` in `.env`, then run:

```bash
npm run check
npm start
```

## Local development

For a local MCP Inspector session without OAuth:

```env
UNIFIED_MCP_DEV_NOAUTH=1
```

Default local endpoint:

```text
http://127.0.0.1:8788/mcp
```

## Verification

```bash
npm test
npm audit
```

The current verified local state includes:

- TypeScript build passing;
- 22/22 deterministic tests passing;
- npm audit reporting zero known vulnerabilities at the time of verification.

The tests cover credential-shaped redaction, OAuth defaults and redirect validation, provider collisions/configuration failure, GitHub allowlists, Meta provider validation, risk gates, expected-risk enforcement, and downstream HTTPS/host restrictions.

Hosted GitHub Actions definitions are present, but account-level runner startup availability is external to this codebase; local build/test results are the current implementation verification source.

## Deployment

### Linux / systemd

`deploy/bootstrap-env.sh` creates a fail-closed production environment with OAuth enabled and consequential action classes disabled.

`deploy/install.sh` installs immutable SHA-addressed releases under `/opt/unified-mcp-gateway`, runs the full check suite before activation, and keeps the Node service bound to `127.0.0.1:8788`.

Public DNS, TLS, and reverse-proxy activation remain an explicit operator step using `deploy/nginx.conf.example`.

### Cloudflare Workers

The `cloudflare/` implementation provides a Workers deployment path using the same high-level MCP/provider policy model. Cloudflare configuration and secrets must be supplied through the deployment environment rather than committed credentials.

## Security boundaries

- provider credentials stay server-side;
- audit/provider payloads redact credential-shaped fields;
- repository and downstream-host access is allowlisted;
- provider/tool discovery does not itself grant execution permission;
- consequential actions require both the relevant authorization scope and server-side policy permission;
- unknown downstream tools receive a conservative risk classification;
- public ingress is not automatically enabled by the standalone installer.

## Limitations

- Native provider coverage is intentionally small; this is a control-plane architecture, not a full replacement for each provider API.
- The Meta adapter is currently read-only.
- The GitHub native baseline is intentionally read-only.
- Production security still depends on correct secret management, TLS termination, deployment configuration, and operator policy.
- The project has not been presented as a third-party security audit or formal compliance certification.

See [`docs/architecture.md`](./docs/architecture.md) for the compact architecture/trust model.

## License

This repository is **source-available for personal, non-commercial use only** under the [Personal Non-Commercial Software License 1.0](LICENSE).

You may inspect, clone, run, and privately modify the project for your own personal non-commercial use. Commercial use, client work, paid services, resale, SaaS/hosting, redistribution, sublicensing, or inclusion in a commercial product requires prior written permission from the copyright holder.

This is not an OSI-approved open-source license.

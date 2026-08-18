import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import {
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { providersFromEnv } from "../../src/config.js";
import { UnifiedMcpGateway } from "../../src/gateway.js";
import { policyFromEnv } from "../../src/policy.js";
import type { RiskClass } from "../../src/types.js";

const READ_SCOPE = "gateway:read";
const WRITE_SCOPE = "gateway:write";
const SUPPORTED_SCOPES = [READ_SCOPE, WRITE_SCOPE] as const;
const INTERNAL_SCOPES_HEADER = "x-unified-mcp-auth-scopes";
const RISK = z.enum(["READ", "WRITE", "HIGH_RISK", "DESTRUCTIVE", "PRODUCTION"]);

interface AuthProps {
  userId: string;
  scopes: string[];
}

interface WorkerEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  UNIFIED_MCP_ADMIN_SECRET: string;
}

function result(value: unknown, message: string) {
  return {
    structuredContent: value as Record<string, unknown>,
    content: [{ type: "text" as const, text: message }],
  };
}

function createGateway(): UnifiedMcpGateway {
  return new UnifiedMcpGateway(providersFromEnv(process.env), policyFromEnv(process.env));
}

function createUnifiedServer(scopes: string[]): McpServer {
  const gateway = createGateway();
  const server = new McpServer(
    { name: "unified-mcp-gateway", version: "0.1.0" },
    {
      instructions:
        "Unified MCP Gateway is a guarded control plane. Search and describe tools before execution. For any non-READ tool, call tool_describe first and pass the exact returned risk as expected_risk. Server-side OAuth scopes and policy gates remain authoritative.",
    },
  );

  server.registerTool(
    "providers_list",
    {
      title: "List MCP providers",
      description: "List configured provider integrations and their reachability.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => result(await gateway.providersList(), "Listed MCP providers."),
  );

  server.registerTool(
    "provider_status",
    {
      title: "Check provider status",
      description: "Check configuration and reachability for one provider.",
      inputSchema: { provider_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ provider_id }) => result(await gateway.providerStatus(provider_id), `Checked provider ${provider_id}.`),
  );

  server.registerTool(
    "tools_search",
    {
      title: "Search provider tools",
      description: "Discover the smallest provider action matching the requested goal.",
      inputSchema: {
        query: z.string().default(""),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ query, limit }) => result(await gateway.toolsSearch(query, limit), "Searched provider tools."),
  );

  server.registerTool(
    "tool_describe",
    {
      title: "Describe provider tool",
      description: "Inspect a provider tool schema, risk class, and safety annotations before execution.",
      inputSchema: { tool_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ tool_id }) => result(await gateway.toolDescribe(tool_id), `Described ${tool_id}.`),
  );

  server.registerTool(
    "tool_execute",
    {
      title: "Execute provider tool",
      description:
        "Execute a discovered provider tool. Non-read actions require gateway:write, exact expected_risk, and the matching server-side policy gate.",
      inputSchema: {
        tool_id: z.string().min(1),
        arguments: z.record(z.unknown()).default({}),
        expected_risk: RISK.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ tool_id, arguments: args, expected_risk }) => {
      const child = await gateway.catalog.describe(tool_id);
      if (child.risk !== "READ" && !scopes.includes(WRITE_SCOPE)) {
        throw new Error("OAuth scope gateway:write is required for non-read provider tools");
      }
      return result(
        await gateway.toolExecute(tool_id, args, expected_risk as RiskClass | undefined),
        `Executed ${tool_id}.`,
      );
    },
  );

  return server;
}

const mcpHttpServer = createServer(async (req, res) => {
  if (!req.url) return void res.writeHead(400).end("Missing URL");
  const url = new URL(req.url, `https://${req.headers.host ?? "worker.invalid"}`);
  if (url.pathname !== "/mcp") return void res.writeHead(404).end("Not Found");
  if (!new Set(["POST", "GET", "DELETE"]).has(req.method ?? "")) {
    return void res.writeHead(405).end("Method Not Allowed");
  }

  const scopes = String(req.headers[INTERNAL_SCOPES_HEADER] ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (!scopes.includes(READ_SCOPE)) {
    return void res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "insufficient_scope" }));
  }

  const server = createUnifiedServer(scopes);
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("unified-mcp-gateway worker request failed", error instanceof Error ? error.message : "unknown error");
    if (!res.headersSent) res.writeHead(500).end("Internal server error");
  }
});

const nodeMcpHandler = httpServerHandler(mcpHttpServer);

const protectedMcpHandler = {
  async fetch(request: Request, env: WorkerEnv, ctx: any): Promise<Response> {
    const props = (ctx?.props ?? {}) as Partial<AuthProps>;
    const scopes = Array.isArray(props.scopes) ? props.scopes.filter((scope) => SUPPORTED_SCOPES.includes(scope as any)) : [];
    const headers = new Headers(request.headers);
    headers.delete(INTERNAL_SCOPES_HEADER);
    headers.set(INTERNAL_SCOPES_HEADER, scopes.join(" "));
    return nodeMcpHandler.fetch(new Request(request, { headers }), env as any, ctx);
  },
};

function safeEqual(received: string, expected: string): boolean {
  const actual = Buffer.from(received, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

function authorizationPage(query: string, scopes: string[], error?: string): Response {
  const scopeItems = scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("");
  const errorBlock = error ? `<p style="color:#a21919;font-weight:600">${escapeHtml(error)}</p>` : "";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Unified MCP Gateway</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#f6f8fb;color:#10233a;margin:0;display:grid;place-items:center;min-height:100vh}.card{width:min(520px,calc(100% - 32px));background:#fff;border:1px solid #dde5ee;border-radius:18px;padding:28px;box-shadow:0 16px 48px rgba(16,35,58,.08)}h1{margin:0 0 8px;font-size:24px}p{line-height:1.5}.scopes{background:#f6f8fb;border-radius:12px;padding:14px 18px}label{display:block;font-weight:600;margin:18px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #b7c5d5;border-radius:10px;font:inherit}button{width:100%;margin-top:16px;border:0;border-radius:10px;padding:12px 16px;background:#123d68;color:#fff;font:inherit;font-weight:700;cursor:pointer}.muted{color:#587087;font-size:14px}</style></head><body><main class="card"><h1>Authorize Unified MCP Gateway</h1><p>An MCP client is requesting access to your private gateway.</p>${errorBlock}<ul class="scopes">${scopeItems}</ul><form method="POST" action="/authorize?${escapeHtml(query)}"><label for="password">Gateway passphrase</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Authorize</button></form><p class="muted">Provider credentials stay server-side. Consequential actions remain disabled unless their policy gates are explicitly enabled.</p></main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

const defaultHandler = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json(
        { service: "unified-mcp-gateway", version: "0.1.0", status: "ok", runtime: "cloudflare-workers", oauth: true },
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (url.pathname !== "/authorize") return new Response("Not Found", { status: 404 });

    let oauthRequest: AuthRequest;
    try {
      oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch {
      return new Response("Invalid authorization request", { status: 400 });
    }

    const grantedScopes = [...new Set([READ_SCOPE, ...oauthRequest.scope.filter((scope) => SUPPORTED_SCOPES.includes(scope as any))])];

    if (request.method === "GET") {
      return authorizationPage(url.searchParams.toString(), grantedScopes);
    }

    if (request.method === "POST") {
      if (!env.UNIFIED_MCP_ADMIN_SECRET) return new Response("Server misconfigured: missing admin secret", { status: 500 });
      const form = await request.formData();
      const password = String(form.get("password") ?? "");
      if (!safeEqual(password, env.UNIFIED_MCP_ADMIN_SECRET)) {
        return authorizationPage(url.searchParams.toString(), grantedScopes, "Wrong passphrase.");
      }

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthRequest,
        userId: "owner",
        scope: grantedScopes,
        metadata: { gateway: "unified-mcp-gateway" },
        props: { userId: "owner", scopes: grantedScopes } satisfies AuthProps,
      });
      return Response.redirect(redirectTo, 302);
    }

    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  },
};

export default new OAuthProvider<WorkerEnv>({
  apiRoute: "/mcp",
  apiHandler: protectedMcpHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: [...SUPPORTED_SCOPES],
  allowPlainPKCE: false,
  resourceMetadata: {
    scopes_supported: [...SUPPORTED_SCOPES],
    resource_name: "Unified MCP Gateway",
  },
});

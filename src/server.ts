import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import {
  handleOAuthRoute,
  hasScope,
  oauthChallenge,
  oauthEnabled,
  verifyAccessToken,
  type AccessTokenInfo,
} from "./auth.js";
import { providersFromEnv } from "./config.js";
import { UnifiedMcpGateway } from "./gateway.js";
import { policyFromEnv } from "./policy.js";
import type { RiskClass } from "./types.js";

const RISK = z.enum(["READ", "WRITE", "HIGH_RISK", "DESTRUCTIVE", "PRODUCTION"]);
const gateway = new UnifiedMcpGateway(providersFromEnv(), policyFromEnv());

function result(value: unknown, message: string) {
  return {
    structuredContent: value as Record<string, unknown>,
    content: [{ type: "text" as const, text: message }],
  };
}

function createUnifiedServer(auth: AccessTokenInfo | null, privateClient = false): McpServer {
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
      description: "Use this when the user wants to see which provider integrations are configured and reachable.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => result(await gateway.providersList(), "Listed MCP providers."),
  );

  server.registerTool(
    "provider_status",
    {
      title: "Check provider status",
      description: "Use this when the user wants the current configuration and reachability status of one provider.",
      inputSchema: { provider_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ provider_id }) => result(await gateway.providerStatus(provider_id), `Checked provider ${provider_id}.`),
  );

  server.registerTool(
    "tools_search",
    {
      title: "Search provider tools",
      description: "Use this to discover the smallest provider action that matches the user's goal before execution.",
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
      description: "Use this before executing a provider tool to inspect its schema, risk class, and safety annotations.",
      inputSchema: { tool_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ tool_id }) => result(await gateway.toolDescribe(tool_id), `Described ${tool_id}.`),
  );

  server.registerTool(
    "tool_execute",
    {
      title: "Execute provider tool",
      description: "Use this only after selecting and describing a provider tool. Non-read operations require gateway:write, expected_risk to exactly match the server-side risk class, and the corresponding policy gate to be enabled.",
      inputSchema: {
        tool_id: z.string().min(1),
        arguments: z.record(z.unknown()).default({}),
        expected_risk: RISK.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ tool_id, arguments: args, expected_risk }) => {
      const child = await gateway.catalog.describe(tool_id);
      if (child.risk !== "READ" && !privateClient && !hasScope(auth, "gateway:write")) {
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

function bearerAuthorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function bearerValue(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    return new Set(["localhost", "127.0.0.1", "::1"]).has(parsed.hostname);
  } catch {
    return false;
  }
}

const port = Number(process.env.PORT ?? 8788);
const host = process.env.HOST ?? "127.0.0.1";
const MCP_PATH = "/mcp";
const bearerToken = process.env.UNIFIED_MCP_HTTP_BEARER_TOKEN;
const devNoAuth = process.env.UNIFIED_MCP_DEV_NOAUTH === "1";
const oauthOn = oauthEnabled();

if (!oauthOn && !bearerToken && !devNoAuth) {
  throw new Error(
    "Refusing to start without HTTP auth. Enable OAuth, set UNIFIED_MCP_HTTP_BEARER_TOKEN for direct clients, or use UNIFIED_MCP_DEV_NOAUTH=1 for explicit local development only.",
  );
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) return void res.writeHead(400).end("Missing URL");
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (devNoAuth && !oauthOn && !bearerToken && !isLoopbackHostHeader(req.headers.host)) {
    res.writeHead(403).end("Local development host required");
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(
      JSON.stringify({ service: "unified-mcp-gateway", version: "0.1.0", status: "ok", oauth: oauthOn }),
    );
    return;
  }

  if (oauthOn && (await handleOAuthRoute(req, res, url))) return;

  if (url.pathname !== MCP_PATH) {
    res.writeHead(404).end("Not Found");
    return;
  }

  const corsOrigin = process.env.UNIFIED_MCP_CORS_ORIGIN;
  if (req.method === "OPTIONS") {
    if (!corsOrigin || req.headers.origin !== corsOrigin) {
      res.writeHead(403).end("CORS origin not allowed");
      return;
    }
    res.writeHead(204, {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
      Vary: "Origin",
    });
    res.end();
    return;
  }

  let auth: AccessTokenInfo | null = null;
  let privateClient = false;
  if (oauthOn) {
    auth = verifyAccessToken(bearerValue(req.headers.authorization));
    if (!auth) {
      res.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": oauthChallenge(),
      }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  } else if (bearerToken) {
    if (!bearerAuthorized(req.headers.authorization, bearerToken)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    privateClient = true;
  } else {
    privateClient = true;
  }

  if (!new Set(["POST", "GET", "DELETE"]).has(req.method ?? "")) {
    res.writeHead(405).end("Method Not Allowed");
    return;
  }

  if (corsOrigin && req.headers.origin === corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.setHeader("Vary", "Origin");
  }

  const server = createUnifiedServer(auth, privateClient);
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("unified-mcp-gateway request failed", error instanceof Error ? error.message : "unknown error");
    if (!res.headersSent) res.writeHead(500).end("Internal server error");
  }
});

httpServer.listen(port, host, () => {
  console.log(`Unified MCP Gateway listening on http://${host}:${port}${MCP_PATH}`);
});

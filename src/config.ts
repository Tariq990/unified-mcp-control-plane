import { GitHubProvider, parseRepositoryAllowlist } from "./providers/github.js";
import { MetaProvider } from "./providers/meta.js";
import { DownstreamMcpProvider, type DownstreamMcpConfig } from "./providers/downstreamMcp.js";
import type { Provider, RiskClass } from "./types.js";

interface DownstreamEnvEntry {
  id: string;
  name?: string;
  url: string;
  tokenEnv?: string;
  allowedTools?: string[];
  riskOverrides?: Record<string, RiskClass>;
}

function parseAllowedHosts(env: NodeJS.ProcessEnv): string[] {
  return (env.RECEPIO_MCP_DOWNSTREAM_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDownstreams(env: NodeJS.ProcessEnv): DownstreamEnvEntry[] {
  const raw = env.RECEPIO_MCP_DOWNSTREAM_JSON;
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("RECEPIO_MCP_DOWNSTREAM_JSON must be a JSON array");
  return parsed.map((value) => {
    if (!value || typeof value !== "object") throw new Error("downstream entry must be an object");
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.url !== "string") {
      throw new Error("downstream entry requires string id and url");
    }
    const result: DownstreamEnvEntry = { id: entry.id, url: entry.url };
    if (typeof entry.name === "string") result.name = entry.name;
    if (typeof entry.tokenEnv === "string") result.tokenEnv = entry.tokenEnv;
    if (Array.isArray(entry.allowedTools) && entry.allowedTools.every((item) => typeof item === "string")) {
      result.allowedTools = entry.allowedTools;
    }
    if (entry.riskOverrides !== undefined) {
      if (!entry.riskOverrides || typeof entry.riskOverrides !== "object" || Array.isArray(entry.riskOverrides)) {
        throw new Error("downstream riskOverrides must be an object");
      }
      const allowedRisks = new Set<RiskClass>([
        "READ",
        "WRITE",
        "HIGH_RISK",
        "DESTRUCTIVE",
        "PRODUCTION",
      ]);
      const overrides: Record<string, RiskClass> = Object.fromEntries(
        Object.entries(entry.riskOverrides as Record<string, unknown>).map(([tool, risk]) => {
          if (typeof risk !== "string" || !allowedRisks.has(risk as RiskClass)) {
            throw new Error(`invalid downstream risk override for ${tool}`);
          }
          return [tool, risk as RiskClass];
        }),
      );
      result.riskOverrides = overrides;
    }
    return result;
  });
}

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const repositories = parseRepositoryAllowlist(env.RECEPIO_MCP_GITHUB_REPOSITORIES);
  const controlRepository = env.RECEPIO_MCP_GITHUB_CONTROL_REPOSITORY ?? "Tariq990/recepio-app-v2";
  const githubToken = env.RECEPIO_MCP_GITHUB_TOKEN;
  const providers: Provider[] = [
    new GitHubProvider({
      ...(githubToken ? { token: githubToken } : {}),
      repositories,
      controlRepository,
      controlBranch: env.RECEPIO_MCP_GITHUB_CONTROL_BRANCH ?? "ops/github-control",
      controlPath: env.RECEPIO_MCP_GITHUB_CONTROL_PATH ?? ".recepio/github-control-request.json",
    }),
    new MetaProvider({
      ...(env.RECEPIO_MCP_META_TOKEN ? { token: env.RECEPIO_MCP_META_TOKEN } : {}),
      ...(env.RECEPIO_MCP_META_GRAPH_VERSION ? { graphVersion: env.RECEPIO_MCP_META_GRAPH_VERSION } : {}),
      ...(env.RECEPIO_MCP_META_APP_ID ? { appId: env.RECEPIO_MCP_META_APP_ID } : {}),
      ...(env.RECEPIO_MCP_META_WABA_ID ? { wabaId: env.RECEPIO_MCP_META_WABA_ID } : {}),
    }),
  ];

  const allowedHosts = parseAllowedHosts(env);
  for (const entry of parseDownstreams(env)) {
    const token = entry.tokenEnv ? env[entry.tokenEnv] : undefined;
    const config: DownstreamMcpConfig = {
      id: entry.id,
      name: entry.name ?? entry.id,
      url: entry.url,
      allowedHosts,
      ...(entry.allowedTools ? { allowedTools: entry.allowedTools } : {}),
      ...(entry.riskOverrides ? { riskOverrides: entry.riskOverrides } : {}),
      ...(token ? { token } : {}),
    };
    providers.push(new DownstreamMcpProvider(config));
  }
  return providers;
}

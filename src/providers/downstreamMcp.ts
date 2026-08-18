import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JsonObject, Provider, ProviderStatus, ProviderTool, RiskClass } from "../types.js";

export interface DownstreamMcpConfig {
  id: string;
  name: string;
  url: string;
  token?: string;
  allowedTools?: string[];
  riskOverrides?: Record<string, RiskClass>;
  allowedHosts: string[];
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{1,62}$/;

export function validateDownstreamUrl(raw: string, allowedHosts: string[]): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("downstream MCP URL must use https");
  if (url.username || url.password) throw new Error("credentials in downstream MCP URLs are forbidden");
  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`downstream host is not allowlisted: ${url.hostname}`);
  }
  return url;
}

function riskFromAnnotations(
  toolName: string,
  annotations: Record<string, unknown> | undefined,
  overrides: Record<string, RiskClass> | undefined,
): RiskClass {
  const override = overrides?.[toolName];
  if (override) return override;
  if (annotations?.destructiveHint === true) return "DESTRUCTIVE";
  // MCP annotations are model hints, not an authorization boundary. Unknown
  // downstream tools therefore never become READ solely because a child
  // server claims readOnlyHint=true; operators must explicitly override risk.
  return "HIGH_RISK";
}

export class DownstreamMcpProvider implements Provider {
  readonly kind = "mcp" as const;
  readonly id: string;
  readonly name: string;
  private readonly url: URL;

  constructor(private readonly config: DownstreamMcpConfig) {
    if (!PROVIDER_ID.test(config.id)) throw new Error(`invalid downstream provider id: ${config.id}`);
    this.id = config.id;
    this.name = config.name;
    this.url = validateDownstreamUrl(config.url, config.allowedHosts);
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: `recepio-mcp-${this.id}`, version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      this.url,
      this.config.token
        ? { requestInit: { headers: { Authorization: `Bearer ${this.config.token}` } } }
        : {},
    );
    try {
      // SDK v1.30's concrete StreamableHTTP transport types expose optional
      // callback fields more narrowly than the shared Transport interface when
      // exactOptionalPropertyTypes is enabled. Runtime shapes are compatible.
      await client.connect(transport as Transport);
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  async status(): Promise<ProviderStatus> {
    try {
      await this.withClient(async (client) => client.listTools());
      return {
        providerId: this.id,
        name: this.name,
        kind: this.kind,
        configured: true,
        reachable: true,
      };
    } catch (error) {
      return {
        providerId: this.id,
        name: this.name,
        kind: this.kind,
        configured: true,
        reachable: false,
        detail: error instanceof Error ? error.message : "downstream MCP unavailable",
      };
    }
  }

  async listTools(): Promise<ProviderTool[]> {
    return this.withClient(async (client) => {
      const result = await client.listTools();
      return result.tools
        .filter((tool) => !this.config.allowedTools || this.config.allowedTools.includes(tool.name))
        .map((tool) => {
          const annotations = tool.annotations as Record<string, unknown> | undefined;
          const risk = riskFromAnnotations(
            tool.name,
            annotations,
            this.config.riskOverrides,
          );
          return {
            id: `${this.id}.${tool.name}`,
            providerId: this.id,
            nativeName: tool.name,
            title: tool.title ?? tool.name,
            description: tool.description ?? `Tool ${tool.name} from ${this.name}`,
            inputSchema: tool.inputSchema as JsonObject,
            risk,
            annotations: {
              readOnlyHint: risk === "READ",
              destructiveHint: risk === "DESTRUCTIVE",
              openWorldHint: annotations?.openWorldHint !== false,
            },
          } satisfies ProviderTool;
        });
    });
  }

  async execute(tool: ProviderTool, args: JsonObject): Promise<unknown> {
    if (this.config.allowedTools && !this.config.allowedTools.includes(tool.nativeName)) {
      throw new Error(`downstream tool is not allowlisted: ${tool.nativeName}`);
    }
    return this.withClient(async (client) =>
      client.callTool({ name: tool.nativeName, arguments: args }),
    );
  }
}

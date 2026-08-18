import type { JsonObject, Provider, ProviderStatus, ProviderTool } from "../types.js";

const META_ID = /^\d{5,30}$/;
const GRAPH_VERSION = /^v\d+\.\d+$/;

export interface MetaProviderConfig {
  token?: string;
  graphVersion?: string;
  appId?: string;
  wabaId?: string;
}

export class MetaProvider implements Provider {
  readonly id = "meta";
  readonly name = "Meta Developer";
  readonly kind = "rest" as const;

  constructor(private readonly config: MetaProviderConfig) {
    if (config.graphVersion && !GRAPH_VERSION.test(config.graphVersion)) {
      throw new Error("Meta graphVersion must look like vNN.N");
    }
    if (config.appId && !META_ID.test(config.appId)) {
      throw new Error("Meta appId must be numeric");
    }
    if (config.wabaId && !META_ID.test(config.wabaId)) {
      throw new Error("Meta wabaId must be numeric");
    }
  }

  private requireBaseConfig(): { token: string; graphVersion: string } {
    if (!this.config.token) throw new Error("Meta provider is not configured: token is missing");
    if (!this.config.graphVersion) throw new Error("Meta provider is not configured: graph version is missing");
    return { token: this.config.token, graphVersion: this.config.graphVersion };
  }

  private requireAppId(): string {
    if (!this.config.appId) throw new Error("Meta provider is not configured: app ID is missing");
    return this.config.appId;
  }

  private requireWabaId(): string {
    if (!this.config.wabaId) throw new Error("Meta provider is not configured: WABA ID is missing");
    return this.config.wabaId;
  }

  private async api(path: string): Promise<unknown> {
    const { token, graphVersion } = this.requireBaseConfig();
    const url = `https://graph.facebook.com/${graphVersion}/${path.replace(/^\/+/, "")}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "unified-mcp-gateway/0.1",
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Meta Graph API request failed with status ${response.status}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("Meta Graph API returned invalid JSON");
    }
  }

  async status(): Promise<ProviderStatus> {
    const configured = Boolean(
      this.config.token &&
        this.config.graphVersion &&
        (this.config.wabaId || this.config.appId),
    );
    if (!configured) {
      return {
        providerId: this.id,
        name: this.name,
        kind: this.kind,
        configured: false,
        reachable: false,
        detail: "Meta token, graph version, and at least one configured asset ID are required",
      };
    }

    try {
      if (this.config.wabaId) {
        await this.api(`${this.config.wabaId}?fields=id,name`);
      } else {
        await this.api(`${this.requireAppId()}?fields=id,name`);
      }
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
        detail: error instanceof Error ? error.message : "Meta unavailable",
      };
    }
  }

  async listTools(): Promise<ProviderTool[]> {
    const emptyInput: JsonObject = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
    const readAnnotations = {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    };

    return [
      {
        id: "meta.app.get",
        providerId: this.id,
        nativeName: "app.get",
        title: "Get configured Meta app",
        description: "Read basic metadata for the configured Meta App ID.",
        inputSchema: emptyInput,
        risk: "READ",
        annotations: readAnnotations,
      },
      {
        id: "meta.whatsapp.waba.get",
        providerId: this.id,
        nativeName: "whatsapp.waba.get",
        title: "Get configured WhatsApp Business Account",
        description: "Read the configured WhatsApp Business Account (WABA).",
        inputSchema: emptyInput,
        risk: "READ",
        annotations: readAnnotations,
      },
      {
        id: "meta.whatsapp.phone_numbers.list",
        providerId: this.id,
        nativeName: "whatsapp.phone_numbers.list",
        title: "List WABA phone numbers",
        description: "List phone numbers attached to the configured WhatsApp Business Account.",
        inputSchema: emptyInput,
        risk: "READ",
        annotations: readAnnotations,
      },
      {
        id: "meta.whatsapp.subscribed_apps.list",
        providerId: this.id,
        nativeName: "whatsapp.subscribed_apps.list",
        title: "List WABA subscribed apps",
        description: "Read apps subscribed to webhook events for the configured WhatsApp Business Account.",
        inputSchema: emptyInput,
        risk: "READ",
        annotations: readAnnotations,
      },
    ];
  }

  async execute(tool: ProviderTool, _args: JsonObject): Promise<unknown> {
    if (tool.nativeName === "app.get") {
      return this.api(`${this.requireAppId()}?fields=id,name`);
    }
    if (tool.nativeName === "whatsapp.waba.get") {
      return this.api(`${this.requireWabaId()}?fields=id,name,timezone_id,message_template_namespace`);
    }
    if (tool.nativeName === "whatsapp.phone_numbers.list") {
      return this.api(`${this.requireWabaId()}/phone_numbers`);
    }
    if (tool.nativeName === "whatsapp.subscribed_apps.list") {
      return this.api(`${this.requireWabaId()}/subscribed_apps`);
    }
    throw new Error(`unsupported Meta tool: ${tool.id}`);
  }
}

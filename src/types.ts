export type RiskClass =
  | "READ"
  | "WRITE"
  | "HIGH_RISK"
  | "DESTRUCTIVE"
  | "PRODUCTION";

export type JsonObject = Record<string, unknown>;

export interface ProviderStatus {
  providerId: string;
  name: string;
  kind: "native" | "mcp" | "rest";
  configured: boolean;
  reachable: boolean;
  detail?: string;
}

export interface ProviderTool {
  id: string;
  providerId: string;
  nativeName: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  risk: RiskClass;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderStatus["kind"];
  status(): Promise<ProviderStatus>;
  listTools(): Promise<ProviderTool[]>;
  execute(tool: ProviderTool, args: JsonObject): Promise<unknown>;
}

export interface AuditRecord {
  id: string;
  at: string;
  providerId: string;
  toolId: string;
  risk: RiskClass;
  phase: "started" | "succeeded" | "failed";
  input?: unknown;
  output?: unknown;
  error?: string;
}

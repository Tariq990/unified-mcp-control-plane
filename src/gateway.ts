import { AuditLog, redact } from "./audit.js";
import { ProviderCatalog } from "./catalog.js";
import { assertExpectedRisk, assertRiskAllowed, type PolicyConfig } from "./policy.js";
import type { JsonObject, Provider, RiskClass } from "./types.js";

export class RecepioGateway {
  readonly catalog: ProviderCatalog;
  readonly audit: AuditLog;

  constructor(
    providers: Provider[],
    private readonly policy: PolicyConfig,
    catalogTtlMs = 30_000,
  ) {
    this.catalog = new ProviderCatalog(catalogTtlMs);
    this.audit = new AuditLog();
    for (const provider of providers) this.catalog.register(provider);
  }

  async providersList(): Promise<unknown> {
    return { providers: await this.catalog.listProviders() };
  }

  async providerStatus(providerId: string): Promise<unknown> {
    return { provider: await this.catalog.providerStatus(providerId) };
  }

  async toolsSearch(query: string, limit: number): Promise<unknown> {
    const tools = await this.catalog.search(query, limit);
    return {
      tools: tools.map(({ inputSchema, ...tool }) => ({ ...tool, inputSchema })),
    };
  }

  async toolDescribe(toolId: string): Promise<unknown> {
    return { tool: await this.catalog.describe(toolId) };
  }

  async toolExecute(
    toolId: string,
    args: JsonObject,
    expectedRisk: RiskClass | undefined,
  ): Promise<unknown> {
    const tool = await this.catalog.describe(toolId);
    assertExpectedRisk(tool.risk, expectedRisk);
    assertRiskAllowed(tool.risk, this.policy);
    const provider = this.catalog.providerFor(tool);
    this.audit.started(provider.id, tool.id, tool.risk, args);
    try {
      const output = await provider.execute(tool, args);
      const safeOutput = redact(output);
      this.audit.record({
        providerId: provider.id,
        toolId: tool.id,
        risk: tool.risk,
        phase: "succeeded",
        output: safeOutput,
      });
      return { toolId: tool.id, risk: tool.risk, result: safeOutput };
    } catch (error) {
      this.audit.record({
        providerId: provider.id,
        toolId: tool.id,
        risk: tool.risk,
        phase: "failed",
        error: error instanceof Error ? error.message : "tool execution failed",
      });
      throw error;
    }
  }
}

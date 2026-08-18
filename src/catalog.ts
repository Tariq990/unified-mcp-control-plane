import type { Provider, ProviderStatus, ProviderTool } from "./types.js";

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

export class ProviderCatalog {
  private readonly providers = new Map<string, Provider>();
  private readonly tools = new Map<string, ProviderTool>();
  private readonly statuses = new Map<string, ProviderStatus>();
  private refreshedAt = 0;

  constructor(private readonly ttlMs = 30_000) {}

  register(provider: Provider): void {
    if (this.providers.has(provider.id)) {
      throw new CatalogError(`duplicate provider id: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.refreshedAt < this.ttlMs) return;

    const nextTools = new Map<string, ProviderTool>();
    const nextStatuses = new Map<string, ProviderStatus>();

    for (const provider of this.providers.values()) {
      try {
        const status = await provider.status();
        const providerTools = await provider.listTools();
        const stagedTools = new Map<string, ProviderTool>();

        for (const tool of providerTools) {
          if (tool.providerId !== provider.id) {
            throw new CatalogError(
              `provider ${provider.id} returned foreign tool ${tool.id}`,
            );
          }
          if (stagedTools.has(tool.id) || nextTools.has(tool.id)) {
            throw new CatalogError(`duplicate tool id: ${tool.id}`);
          }
          stagedTools.set(tool.id, tool);
        }

        for (const [id, tool] of stagedTools) nextTools.set(id, tool);
        nextStatuses.set(provider.id, status);
      } catch (error) {
        nextStatuses.set(provider.id, {
          providerId: provider.id,
          name: provider.name,
          kind: provider.kind,
          configured: true,
          reachable: false,
          detail: error instanceof Error ? error.message : "provider refresh failed",
        });
      }
    }

    this.tools.clear();
    for (const [id, tool] of nextTools) this.tools.set(id, tool);
    this.statuses.clear();
    for (const [id, status] of nextStatuses) this.statuses.set(id, status);
    this.refreshedAt = Date.now();
  }

  async listProviders(): Promise<ProviderStatus[]> {
    await this.refresh();
    return [...this.providers.values()].map(
      (provider) =>
        this.statuses.get(provider.id) ?? {
          providerId: provider.id,
          name: provider.name,
          kind: provider.kind,
          configured: false,
          reachable: false,
          detail: "not refreshed",
        },
    );
  }

  async providerStatus(providerId: string): Promise<ProviderStatus> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new CatalogError(`unknown provider: ${providerId}`);
    const status = await provider.status();
    this.statuses.set(providerId, status);
    return status;
  }

  async search(query: string, limit = 20): Promise<ProviderTool[]> {
    await this.refresh();
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const rows = [...this.tools.values()].filter((tool) => {
      if (terms.length === 0) return true;
      const haystack = `${tool.id} ${tool.providerId} ${tool.title} ${tool.description}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    return rows.slice(0, Math.max(1, Math.min(limit, 100)));
  }

  async describe(toolId: string): Promise<ProviderTool> {
    await this.refresh();
    const tool = this.tools.get(toolId);
    if (!tool) throw new CatalogError(`unknown tool: ${toolId}`);
    return tool;
  }

  providerFor(tool: ProviderTool): Provider {
    const provider = this.providers.get(tool.providerId);
    if (!provider) throw new CatalogError(`provider missing for tool: ${tool.id}`);
    return provider;
  }
}

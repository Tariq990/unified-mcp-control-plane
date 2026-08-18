import type { JsonObject, Provider, ProviderStatus, ProviderTool } from "../types.js";

export interface GitHubProviderConfig {
  token?: string;
  repositories: string[];
}

export function parseRepositoryAllowlist(value: string | undefined): string[] {
  const repositories = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(repositories)];
}

export class GitHubProvider implements Provider {
  readonly id = "github";
  readonly name = "GitHub";
  readonly kind = "rest" as const;

  constructor(private readonly config: GitHubProviderConfig) {}

  private assertRepo(repository: string): void {
    if (!this.config.repositories.includes(repository)) {
      throw new Error(`repository is not allowlisted: ${repository}`);
    }
  }

  private async api(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.config.token) throw new Error("GitHub provider is not configured");
    const response = await fetch(`https://api.github.com/${path.replace(/^\/+/, "")}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "unified-mcp-gateway/0.1",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub API request failed with status ${response.status}`);
    }
    if (!text) return null;
    return JSON.parse(text) as unknown;
  }

  async status(): Promise<ProviderStatus> {
    if (!this.config.token || this.config.repositories.length === 0) {
      return {
        providerId: this.id,
        name: this.name,
        kind: this.kind,
        configured: false,
        reachable: false,
        detail: !this.config.token
          ? "UNIFIED_MCP_GITHUB_TOKEN is not set"
          : "UNIFIED_MCP_GITHUB_REPOSITORIES is empty",
      };
    }
    try {
      await this.api("rate_limit");
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
        detail: error instanceof Error ? error.message : "GitHub unavailable",
      };
    }
  }

  async listTools(): Promise<ProviderTool[]> {
    return [
      {
        id: "github.repo.get",
        providerId: this.id,
        nativeName: "repo.get",
        title: "Get GitHub repository",
        description: "Read metadata for one allowlisted GitHub repository.",
        inputSchema: {
          type: "object",
          properties: { repository: { type: "string" } },
          required: ["repository"],
          additionalProperties: false,
        },
        risk: "READ",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      {
        id: "github.branch.get",
        providerId: this.id,
        nativeName: "branch.get",
        title: "Get GitHub branch",
        description: "Read one branch from an allowlisted GitHub repository.",
        inputSchema: {
          type: "object",
          properties: {
            repository: { type: "string" },
            branch: { type: "string", minLength: 1 },
          },
          required: ["repository", "branch"],
          additionalProperties: false,
        },
        risk: "READ",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      {
        id: "github.actions.list_runs",
        providerId: this.id,
        nativeName: "actions.list_runs",
        title: "List GitHub Actions runs",
        description: "Read recent Actions workflow runs from an allowlisted repository.",
        inputSchema: {
          type: "object",
          properties: {
            repository: { type: "string" },
            workflow: { type: "string" },
            branch: { type: "string" },
            per_page: { type: "integer", minimum: 1, maximum: 50 },
          },
          required: ["repository"],
          additionalProperties: false,
        },
        risk: "READ",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
    ];
  }

  async execute(tool: ProviderTool, args: JsonObject): Promise<unknown> {
    if (tool.nativeName === "repo.get") {
      const repository = String(args.repository ?? "");
      this.assertRepo(repository);
      return this.api(`repos/${repository}`);
    }

    if (tool.nativeName === "branch.get") {
      const repository = String(args.repository ?? "");
      const branch = String(args.branch ?? "");
      this.assertRepo(repository);
      if (!branch) throw new Error("branch is required");
      return this.api(`repos/${repository}/branches/${encodeURIComponent(branch)}`);
    }

    if (tool.nativeName === "actions.list_runs") {
      const repository = String(args.repository ?? "");
      this.assertRepo(repository);
      const workflow = args.workflow ? `/workflows/${encodeURIComponent(String(args.workflow))}` : "";
      const perPage = Number(args.per_page ?? 20);
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > 50) {
        throw new Error("per_page must be an integer between 1 and 50");
      }
      const query = new URLSearchParams({ per_page: String(perPage) });
      if (args.branch) query.set("branch", String(args.branch));
      return this.api(`repos/${repository}/actions${workflow}/runs?${query}`);
    }

    throw new Error(`unsupported GitHub tool: ${tool.id}`);
  }
}

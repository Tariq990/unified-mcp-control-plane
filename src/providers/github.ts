import { Buffer } from "node:buffer";
import type { JsonObject, Provider, ProviderStatus, ProviderTool } from "../types.js";

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,120}$/;

export interface GitHubProviderConfig {
  token?: string;
  repositories: string[];
  controlRepository: string;
  controlBranch: string;
  controlPath: string;
}

export function parseRepositoryAllowlist(value: string | undefined): string[] {
  const repositories = (value ?? "Tariq990/recepio-app-v2")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(repositories)];
}

export class GitHubProvider implements Provider {
  readonly id = "github";
  readonly name = "GitHub";
  readonly kind = "rest" as const;

  constructor(private readonly config: GitHubProviderConfig) {
    if (!config.repositories.includes(config.controlRepository)) {
      throw new Error("controlRepository must be present in the GitHub repository allowlist");
    }
  }

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
        "User-Agent": "recepio-mcp/0.1",
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
    if (!this.config.token) {
      return {
        providerId: this.id,
        name: this.name,
        kind: this.kind,
        configured: false,
        reachable: false,
        detail: "RECEPIO_MCP_GITHUB_TOKEN is not set",
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
      {
        id: "github.recepio.dispatch_smoke",
        providerId: this.id,
        nativeName: "recepio.dispatch_smoke",
        title: "Dispatch Recepio MCP smoke",
        description: "Write the fixed Recepio control request that triggers the allowlisted MCP smoke workflow.",
        inputSchema: {
          type: "object",
          properties: { request_id: { type: "string", minLength: 1, maxLength: 120 } },
          required: ["request_id"],
          additionalProperties: false,
        },
        risk: "WRITE",
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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

    if (tool.nativeName === "recepio.dispatch_smoke") {
      const requestId = String(args.request_id ?? "");
      if (!REQUEST_ID.test(requestId)) throw new Error("invalid request_id");
      const repository = this.config.controlRepository;
      this.assertRepo(repository);
      const current = (await this.api(
        `repos/${repository}/contents/${this.config.controlPath}?ref=${encodeURIComponent(this.config.controlBranch)}`,
      )) as { sha?: string };
      if (!current.sha) throw new Error("control request file has no blob SHA");
      const content = Buffer.from(
        `${JSON.stringify({ action: "dispatch_smoke", request_id: requestId }, null, 2)}\n`,
        "utf8",
      ).toString("base64");
      return this.api(`repos/${repository}/contents/${this.config.controlPath}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `ops(mcp): dispatch smoke ${requestId}`,
          branch: this.config.controlBranch,
          sha: current.sha,
          content,
        }),
      });
    }

    throw new Error(`unsupported GitHub tool: ${tool.id}`);
  }
}

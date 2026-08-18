import test from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider, parseRepositoryAllowlist } from "../src/providers/github.js";

test("GitHub repository allowlist is deduplicated and defaults to Recepio", () => {
  assert.deepEqual(parseRepositoryAllowlist(undefined), ["Tariq990/recepio-app-v2"]);
  assert.deepEqual(parseRepositoryAllowlist("a/b,a/b,c/d"), ["a/b", "c/d"]);
});

test("GitHub control repository must be explicitly allowlisted", () => {
  assert.throws(() =>
    new GitHubProvider({
      repositories: ["other/repo"],
      controlRepository: "Tariq990/recepio-app-v2",
      controlBranch: "ops/github-control",
      controlPath: ".recepio/github-control-request.json",
    }),
  );
});

test("GitHub v0.1 exposes only known reads plus fixed smoke write", async () => {
  const provider = new GitHubProvider({
    repositories: ["Tariq990/recepio-app-v2"],
    controlRepository: "Tariq990/recepio-app-v2",
    controlBranch: "ops/github-control",
    controlPath: ".recepio/github-control-request.json",
  });
  const tools = await provider.listTools();
  assert.deepEqual(
    tools.map((tool) => [tool.id, tool.risk]),
    [
      ["github.repo.get", "READ"],
      ["github.branch.get", "READ"],
      ["github.actions.list_runs", "READ"],
      ["github.recepio.dispatch_smoke", "WRITE"],
    ],
  );
});

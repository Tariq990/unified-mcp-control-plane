import test from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider, parseRepositoryAllowlist } from "../src/providers/github.js";

test("GitHub repository allowlist is explicit and deduplicated", () => {
  assert.deepEqual(parseRepositoryAllowlist(undefined), []);
  assert.deepEqual(parseRepositoryAllowlist("a/b,a/b,c/d"), ["a/b", "c/d"]);
});

test("GitHub baseline exposes read-only allowlisted tools", async () => {
  const provider = new GitHubProvider({ repositories: ["a/b"] });
  const tools = await provider.listTools();
  assert.deepEqual(
    tools.map((tool) => [tool.id, tool.risk]),
    [
      ["github.repo.get", "READ"],
      ["github.branch.get", "READ"],
      ["github.actions.list_runs", "READ"],
    ],
  );
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
  assert.ok(tools.every((tool) => !tool.annotations.destructiveHint));
});

test("GitHub provider is unconfigured when repository allowlist is empty", async () => {
  const provider = new GitHubProvider({ token: "runtime-token", repositories: [] });
  const status = await provider.status();
  assert.equal(status.configured, false);
  assert.equal(status.reachable, false);
});

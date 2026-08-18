import test from "node:test";
import assert from "node:assert/strict";
import { ProviderCatalog, CatalogError } from "../src/catalog.js";
import type { Provider, ProviderTool } from "../src/types.js";

function tool(providerId: string, id: string): ProviderTool {
  return {
    id,
    providerId,
    nativeName: id,
    title: id,
    description: id,
    inputSchema: { type: "object" },
    risk: "READ",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
}

function provider(id: string, toolIds: string | string[]): Provider {
  const ids = Array.isArray(toolIds) ? toolIds : [toolIds];
  return {
    id,
    name: id,
    kind: "native",
    status: async () => ({ providerId: id, name: id, kind: "native", configured: true, reachable: true }),
    listTools: async () => ids.map((toolId) => tool(id, toolId)),
    execute: async () => null,
  };
}

test("duplicate provider ids are rejected", () => {
  const catalog = new ProviderCatalog(0);
  catalog.register(provider("one", "one.x"));
  assert.throws(() => catalog.register(provider("one", "one.y")), CatalogError);
});

test("a colliding provider fails closed without publishing partial tools", async () => {
  const catalog = new ProviderCatalog(0);
  catalog.register(provider("one", "shared.tool"));
  catalog.register(provider("two", ["two.unique", "shared.tool"]));
  await catalog.refresh(true);
  const statuses = await catalog.listProviders();
  assert.equal(statuses.find((item) => item.providerId === "two")?.reachable, false);
  const published = await catalog.search("", 20);
  assert.deepEqual(published.map((item) => item.id), ["shared.tool"]);
});

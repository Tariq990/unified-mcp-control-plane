import test from "node:test";
import assert from "node:assert/strict";
import { MetaProvider } from "../src/providers/meta.js";

test("Meta provider rejects malformed configured identifiers and versions", () => {
  assert.throws(() => new MetaProvider({ graphVersion: "latest" }));
  assert.throws(() => new MetaProvider({ appId: "abc" }));
  assert.throws(() => new MetaProvider({ wabaId: "123/456" }));
});

test("Meta v0.1 exposes read-only fixed-asset tools only", async () => {
  const provider = new MetaProvider({
    graphVersion: "v99.0",
    appId: "2209395923179149",
    wabaId: "2274128986689187",
  });
  const tools = await provider.listTools();
  assert.deepEqual(
    tools.map((tool) => [tool.id, tool.risk]),
    [
      ["meta.app.get", "READ"],
      ["meta.whatsapp.waba.get", "READ"],
      ["meta.whatsapp.phone_numbers.list", "READ"],
      ["meta.whatsapp.subscribed_apps.list", "READ"],
    ],
  );
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
  assert.ok(tools.every((tool) => !tool.annotations.destructiveHint));
});

test("Meta provider fails closed when credentials are absent", async () => {
  const provider = new MetaProvider({
    graphVersion: "v99.0",
    appId: "2209395923179149",
  });
  const status = await provider.status();
  assert.equal(status.configured, false);
  assert.equal(status.reachable, false);
});

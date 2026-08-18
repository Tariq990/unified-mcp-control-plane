import test from "node:test";
import assert from "node:assert/strict";
import { providersFromEnv } from "../src/config.js";

test("malformed downstream configuration fails closed", () => {
  assert.throws(() =>
    providersFromEnv({
      UNIFIED_MCP_DOWNSTREAM_JSON: JSON.stringify([{ id: "bad", url: "http://example.com/mcp" }]),
      UNIFIED_MCP_DOWNSTREAM_ALLOWED_HOSTS: "example.com",
    }),
  );
});

test("downstream bearer tokens are resolved from named environment variables", () => {
  assert.doesNotThrow(() =>
    providersFromEnv({
      UNIFIED_MCP_DOWNSTREAM_JSON: JSON.stringify([
        { id: "demo", url: "https://example.com/mcp", tokenEnv: "DEMO_MCP_TOKEN" },
      ]),
      UNIFIED_MCP_DOWNSTREAM_ALLOWED_HOSTS: "example.com",
      DEMO_MCP_TOKEN: "not-committed-runtime-value",
    }),
  );
});

test("invalid downstream risk overrides fail closed", () => {
  assert.throws(() =>
    providersFromEnv({
      UNIFIED_MCP_DOWNSTREAM_JSON: JSON.stringify([
        { id: "demo", url: "https://example.com/mcp", riskOverrides: { search: "SAFE" } },
      ]),
      UNIFIED_MCP_DOWNSTREAM_ALLOWED_HOSTS: "example.com",
    }),
  );
});

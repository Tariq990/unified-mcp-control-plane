import test from "node:test";
import assert from "node:assert/strict";
import { providersFromEnv } from "../src/config.js";

test("malformed downstream configuration fails closed", () => {
  assert.throws(() =>
    providersFromEnv({
      RECEPIO_MCP_DOWNSTREAM_JSON: JSON.stringify([{ id: "bad", url: "http://example.com/mcp" }]),
      RECEPIO_MCP_DOWNSTREAM_ALLOWED_HOSTS: "example.com",
    }),
  );
});

test("downstream bearer tokens are resolved from named environment variables", () => {
  assert.doesNotThrow(() =>
    providersFromEnv({
      RECEPIO_MCP_DOWNSTREAM_JSON: JSON.stringify([
        { id: "demo", url: "https://example.com/mcp", tokenEnv: "DEMO_MCP_TOKEN" },
      ]),
      RECEPIO_MCP_DOWNSTREAM_ALLOWED_HOSTS: "example.com",
      DEMO_MCP_TOKEN: "not-committed-runtime-value",
    }),
  );
});

test("invalid downstream risk overrides fail closed", () => {
  assert.throws(() =>
    providersFromEnv({
      RECEPIO_MCP_DOWNSTREAM_JSON: JSON.stringify([
        { id: "demo", url: "https://example.com/mcp", riskOverrides: { search: "SAFE" } },
      ]),
      RECEPIO_MCP_DOWNSTREAM_ALLOWED_HOSTS: "example.com",
    }),
  );
});

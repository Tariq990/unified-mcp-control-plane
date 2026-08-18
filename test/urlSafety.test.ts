import test from "node:test";
import assert from "node:assert/strict";
import { validateDownstreamUrl } from "../src/providers/downstreamMcp.js";

test("downstream MCP URLs require https and an explicit host allowlist", () => {
  assert.throws(() => validateDownstreamUrl("http://example.com/mcp", ["example.com"]));
  assert.throws(() => validateDownstreamUrl("https://evil.example/mcp", ["example.com"]));
  assert.equal(validateDownstreamUrl("https://example.com/mcp", ["example.com"]).hostname, "example.com");
});

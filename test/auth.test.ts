import test from "node:test";
import assert from "node:assert/strict";
import { oauthChallenge, oauthEnabled, redirectUriAllowed, resourceUrl } from "../src/auth.js";

test("OAuth stays opt-in", () => {
  assert.equal(oauthEnabled({}), false);
  assert.equal(oauthEnabled({ RECEPIO_MCP_OAUTH_ENABLED: "1" }), true);
});

test("current ChatGPT callback shape is accepted and legacy callback is off by default", () => {
  const env = { RECEPIO_MCP_OAUTH_REDIRECT_HOSTS: "chatgpt.com" };
  assert.equal(redirectUriAllowed("https://chatgpt.com/connector/oauth/callback_Abc-123", env), true);
  assert.equal(redirectUriAllowed("https://chatgpt.com/connector_platform_oauth_redirect", env), false);
  assert.equal(
    redirectUriAllowed("https://chatgpt.com/connector_platform_oauth_redirect", {
      ...env,
      RECEPIO_MCP_OAUTH_ALLOW_LEGACY_REDIRECT: "1",
    }),
    true,
  );
});

test("OAuth redirect validation rejects insecure and lookalike hosts", () => {
  assert.equal(redirectUriAllowed("http://chatgpt.com/connector/oauth/demo"), false);
  assert.equal(redirectUriAllowed("https://chatgpt.com.evil.example/connector/oauth/demo"), false);
  assert.equal(redirectUriAllowed("https://evil.example/connector/oauth/demo"), false);
});

test("OAuth resource and challenge bind to the MCP resource", () => {
  const previous = process.env.RECEPIO_MCP_BASE_URL;
  process.env.RECEPIO_MCP_BASE_URL = "https://mcp.recepio.io";
  try {
    assert.equal(resourceUrl(), "https://mcp.recepio.io/mcp");
    assert.match(oauthChallenge(), /resource_metadata="https:\/\/mcp\.recepio\.io\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.match(oauthChallenge(), /scope="recepio:read"/);
  } finally {
    if (previous === undefined) delete process.env.RECEPIO_MCP_BASE_URL;
    else process.env.RECEPIO_MCP_BASE_URL = previous;
  }
});

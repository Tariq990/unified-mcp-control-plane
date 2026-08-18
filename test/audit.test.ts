import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/audit.js";

test("redact removes credential-shaped values recursively", () => {
  const value = redact({
    token: "abc",
    nested: { api_key: "def", request_id: "keep-me" },
    authorization: "Bearer xyz",
  });
  assert.deepEqual(value, {
    token: "[REDACTED]",
    nested: { api_key: "[REDACTED]", request_id: "keep-me" },
    authorization: "[REDACTED]",
  });
});

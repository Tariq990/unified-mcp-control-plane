import test from "node:test";
import assert from "node:assert/strict";
import {
  assertExpectedRisk,
  assertRiskAllowed,
  policyFromEnv,
  PolicyError,
} from "../src/policy.js";

const denyAll = {
  allowWrite: false,
  allowHighRisk: false,
  allowDestructive: false,
  allowProduction: false,
};

test("READ is always allowed", () => {
  assert.doesNotThrow(() => assertRiskAllowed("READ", denyAll));
});

test("WRITE is fail-closed", () => {
  assert.throws(() => assertRiskAllowed("WRITE", denyAll), PolicyError);
});

test("unified policy environment stays fail-closed unless explicitly enabled", () => {
  assert.deepEqual(policyFromEnv({}), denyAll);
  assert.deepEqual(
    policyFromEnv({
      UNIFIED_MCP_ALLOW_WRITE: "1",
      UNIFIED_MCP_ALLOW_HIGH_RISK: "1",
      UNIFIED_MCP_ALLOW_DESTRUCTIVE: "1",
      UNIFIED_MCP_ALLOW_PRODUCTION: "1",
    }),
    {
      allowWrite: true,
      allowHighRisk: true,
      allowDestructive: true,
      allowProduction: true,
    },
  );
});

test("consequential execution requires exact expected risk", () => {
  assert.throws(() => assertExpectedRisk("HIGH_RISK", undefined), PolicyError);
  assert.throws(() => assertExpectedRisk("HIGH_RISK", "WRITE"), PolicyError);
  assert.doesNotThrow(() => assertExpectedRisk("HIGH_RISK", "HIGH_RISK"));
});

test("PRODUCTION requires explicit production gate after write/high-risk gates", () => {
  assert.throws(
    () => assertRiskAllowed("PRODUCTION", { ...denyAll, allowWrite: true, allowHighRisk: true }),
    PolicyError,
  );
  assert.doesNotThrow(() =>
    assertRiskAllowed("PRODUCTION", {
      allowWrite: true,
      allowHighRisk: true,
      allowDestructive: false,
      allowProduction: true,
    }),
  );
});

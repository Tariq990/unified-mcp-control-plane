import test from "node:test";
import assert from "node:assert/strict";
import { assertExpectedRisk, assertRiskAllowed, PolicyError } from "../src/policy.js";

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

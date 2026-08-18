import type { RiskClass } from "./types.js";

export interface PolicyConfig {
  allowWrite: boolean;
  allowHighRisk: boolean;
  allowDestructive: boolean;
  allowProduction: boolean;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyConfig {
  const enabled = (name: string) => env[name] === "1";
  return {
    allowWrite: enabled("UNIFIED_MCP_ALLOW_WRITE"),
    allowHighRisk: enabled("UNIFIED_MCP_ALLOW_HIGH_RISK"),
    allowDestructive: enabled("UNIFIED_MCP_ALLOW_DESTRUCTIVE"),
    allowProduction: enabled("UNIFIED_MCP_ALLOW_PRODUCTION"),
  };
}

export function assertRiskAllowed(risk: RiskClass, policy: PolicyConfig): void {
  if (risk === "READ") return;
  if (!policy.allowWrite) throw new PolicyError("WRITE actions are disabled");
  if (risk === "WRITE") return;
  if (!policy.allowHighRisk) throw new PolicyError("HIGH_RISK actions are disabled");
  if (risk === "HIGH_RISK") return;
  if (risk === "DESTRUCTIVE") {
    if (!policy.allowDestructive) {
      throw new PolicyError("DESTRUCTIVE actions are disabled");
    }
    return;
  }
  if (!policy.allowProduction) {
    throw new PolicyError("PRODUCTION actions are disabled");
  }
}

export function assertExpectedRisk(
  actual: RiskClass,
  expected: RiskClass | undefined,
): void {
  if (actual === "READ") return;
  if (!expected) {
    throw new PolicyError(
      `expected_risk is required for consequential tools; actual risk is ${actual}`,
    );
  }
  if (actual !== expected) {
    throw new PolicyError(
      `expected_risk mismatch: caller supplied ${expected}, tool is ${actual}`,
    );
  }
}

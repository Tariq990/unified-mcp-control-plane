import { randomUUID } from "node:crypto";
import type { AuditRecord, RiskClass } from "./types.js";

const SENSITIVE_KEY = /(?:token|secret|password|authorization|api[_-]?key|private[_-]?key|client[_-]?secret)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(child, depth + 1);
    }
    return output;
  }
  if (typeof value === "string" && value.length > 4096) {
    return `${value.slice(0, 4096)}…[TRUNCATED]`;
  }
  return value;
}

export class AuditLog {
  private readonly records: AuditRecord[] = [];

  record(input: Omit<AuditRecord, "id" | "at">): AuditRecord {
    const record: AuditRecord = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...input,
      ...(input.input === undefined ? {} : { input: redact(input.input) }),
      ...(input.output === undefined ? {} : { output: redact(input.output) }),
    };
    this.records.push(record);
    return record;
  }

  recent(limit = 100): AuditRecord[] {
    return this.records.slice(-Math.max(1, Math.min(limit, 500)));
  }

  started(providerId: string, toolId: string, risk: RiskClass, input: unknown): AuditRecord {
    return this.record({ providerId, toolId, risk, phase: "started", input });
  }
}

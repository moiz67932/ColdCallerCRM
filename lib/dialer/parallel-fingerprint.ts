import { createHash } from "node:crypto";

export function parallelFingerprint(config: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}


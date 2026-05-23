export type CallClientState = {
  attemptId: string;
  role: "agent" | "lead";
};

export function encodeClientState(state: CallClientState) {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

export function decodeClientState(value?: string | null): CallClientState | null {
  if (!value) {
    return null;
  }

  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as CallClientState;

    if (!parsed.attemptId || (parsed.role !== "agent" && parsed.role !== "lead")) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

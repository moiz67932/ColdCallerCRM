export function silenceLocalRingback(root: Pick<Document, "getElementById">, silent: boolean) {
  const element = root.getElementById("_ringback");
  if (element?.tagName === "AUDIO") (element as HTMLAudioElement).muted = silent;
}

export function recordingAllowed(
  enabled: boolean,
  attempt: { recordingConsentAt?: unknown; endedAt?: unknown; wasBridgedToOperator?: boolean },
) {
  return enabled && Boolean(attempt.recordingConsentAt && !attempt.endedAt && attempt.wasBridgedToOperator);
}

export async function sendWebRtcDigit(call: {
  sendDigits?: (digit: string) => Promise<void> | void;
  dtmf?: (digit: string) => Promise<void> | void;
}, digit: string) {
  if (!/^[0-9*#]$/.test(digit)) throw new Error("Invalid keypad digit");
  if (call.sendDigits) await call.sendDigits(digit);
  else if (call.dtmf) await call.dtmf(digit);
  else throw new Error("The Telnyx WebRTC SDK did not expose DTMF on this call.");
}

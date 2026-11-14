import assert from "node:assert/strict";
import test from "node:test";
import { recordingAllowed, sendWebRtcDigit, silenceLocalRingback } from "../../lib/dialer/media";

test("silent local ringback never changes remote conversation or microphone audio", () => {
  const local = { tagName: "AUDIO", muted: false };
  const remote = { muted: false, volume: 1 };
  const mic = { enabled: true };
  const requested: string[] = [];
  const root = { getElementById(id: string) { requested.push(id); return local as unknown as HTMLElement; } };
  silenceLocalRingback(root, true);
  assert.equal(local.muted, true);
  assert.deepEqual(remote, { muted: false, volume: 1 });
  assert.equal(mic.enabled, true);
  silenceLocalRingback(root, false);
  assert.equal(local.muted, false);
  assert.deepEqual(requested, ["_ringback", "_ringback"]);
});
test("missing local tone requires no mutation or remote-media fallback", () => {
  silenceLocalRingback({ getElementById: () => null }, true);
});
test("recording requires settings enabled, consent and an actual live operator bridge", () => {
  assert.equal(recordingAllowed(true, { recordingConsentAt: new Date(), wasBridgedToOperator: true }), true);
  assert.equal(recordingAllowed(false, { recordingConsentAt: new Date(), wasBridgedToOperator: true }), false);
  assert.equal(recordingAllowed(true, { wasBridgedToOperator: true }), false);
  assert.equal(recordingAllowed(true, { recordingConsentAt: new Date() }), false);
  assert.equal(recordingAllowed(true, { recordingConsentAt: new Date(), wasBridgedToOperator: true, endedAt: new Date() }), false);
});
test("all keypad digits reach the existing WebRTC call through sendDigits", async () => {
  const received: string[] = [];
  for (const digit of "123456789*0#") await sendWebRtcDigit({ sendDigits: (value) => { received.push(value); } }, digit);
  assert.equal(received.join(""), "123456789*0#");
});
test("DTMF fallback and SDK errors remain visible to the operator", async () => {
  let received = "";
  await sendWebRtcDigit({ dtmf: (value) => { received = value; } }, "#");
  assert.equal(received, "#");
  await assert.rejects(sendWebRtcDigit({}, "1"), /DTMF/);
  await assert.rejects(sendWebRtcDigit({ dtmf: () => { throw new Error("Disconnected"); } }, "1"), /Disconnected/);
  await assert.rejects(sendWebRtcDigit({}, "invalid"), /Invalid/);
});

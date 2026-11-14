import assert from "node:assert/strict";
import test from "node:test";
import { classifyAnswer, resolveClientStatus } from "../../lib/telnyx/lifecycle";

test("receptionist conversation followed by operator hangup is completed, never canceled", () => {
  assert.equal(resolveClientStatus({ status: "connected", answeredAt: new Date() }, "canceled"), "completed");
  assert.equal(resolveClientStatus({ status: "dialing", answeredAt: new Date() }, "canceled"), "completed");
});
test("a browser failure after answer retains evidence of the conversation", () => {
  assert.equal(resolveClientStatus({ status: "connected" }, "failed"), "completed");
});
test("pre-answer cancellation and failure retain distinct technical statuses", () => {
  assert.equal(resolveClientStatus({ status: "dialing" }, "canceled"), "canceled");
  assert.equal(resolveClientStatus({ status: "dialing" }, "failed"), "failed");
});
test("duplicate or late browser progress cannot reopen a terminal attempt", () => {
  for (const status of ["completed", "failed", "canceled", "voicemail_detected"] as const) {
    assert.equal(resolveClientStatus({ status, endedAt: new Date() }, "connected"), status);
  }
});
test("carrier answer is unknown until explicit classification evidence arrives", () => {
  for (const value of [undefined, null, "", "not_sure", "silence", "fax_detected", "prompt_ended", "ended", "answered"]) {
    assert.equal(classifyAnswer(value), "unknown");
  }
});
test("documented standard and premium human results are supported", () => {
  for (const result of ["human", "human_business", "human_residence"]) assert.equal(classifyAnswer(result), "human");
});
test("machine classification requires positive provider evidence", () => {
  assert.equal(classifyAnswer("machine"), "machine");
  assert.equal(classifyAnswer("beep_detected"), "machine");
});

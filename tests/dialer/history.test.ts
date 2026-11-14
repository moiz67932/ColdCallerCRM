import assert from "node:assert/strict";
import test from "node:test";
import { historyNote, historyOutcomeLabel } from "../../lib/call-history";

test("technical hangup never replaces the saved sales disposition", () => {
  for (const outcome of ["answered","voicemail","no_answer","gatekeeper","callback","interested","not_interested","demo_requested","already_have_system","bad_number"]) {
    assert.equal(historyOutcomeLabel({ status: "completed", outcome }), outcome);
  }
});
test("historical answered evidence is displayed as completed even before backfill", () => {
  assert.equal(historyOutcomeLabel({ status: "canceled", answeredAt: new Date() }), "completed");
  assert.equal(historyOutcomeLabel({ status: "canceled" }), "canceled");
  assert.equal(historyOutcomeLabel({ status: "failed", technicalState: "busy" }), "busy");
});
test("persistent lead notes do not overwrite a previous attempt's notes in history", () => {
  assert.equal(historyNote({ operatorNotes: "Receptionist: manager will call", notes: [], lead: { notes: "A later conversation" } }), "Receptionist: manager will call");
  assert.equal(historyNote({ notes: [{ body: "Attempt note" }], lead: { notes: "Persistent note" } }), "Attempt note");
  assert.equal(historyNote({ lead: { notes: "Legacy note" } }), "Legacy note");
});

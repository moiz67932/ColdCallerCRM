import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAndValidateSmsNumber, renderSmsTemplate } from "../lib/messaging/sms";

test("renders SMS template placeholders", () => {
  const message = renderSmsTemplate("live_demo_number", {
    name: "Sarah",
    clinic_name: "Glow Med Spa",
    demo_number: "+17205551234",
    booking_link: "https://portive.example/demo",
  });

  assert.match(message, /Hi Sarah/);
  assert.match(message, /\+17205551234/);
  assert.match(message, /Reply STOP to opt out\./);
});

test("normalizes US numbers to E.164", () => {
  const result = normalizeAndValidateSmsNumber("(415) 650-1234");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.number, "+14156501234");
  }
});

test("rejects obvious placeholder numbers", () => {
  const result = normalizeAndValidateSmsNumber("+17205550123");

  assert.equal(result.ok, false);
});

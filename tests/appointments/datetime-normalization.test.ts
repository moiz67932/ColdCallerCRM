import test from "node:test";
import assert from "node:assert/strict";

import { normalizeHumanAppointmentDateTime } from "@/lib/appointments/datetime-normalization";

const NOW = new Date("2026-05-28T12:00:00Z");

function normalize(preferredDate: string, preferredTime: string, timezone: string) {
  return normalizeHumanAppointmentDateTime({
    preferredDate,
    preferredTime,
    timezone,
    now: NOW,
  });
}

test("normalizes June first at 3 PM in Los Angeles", () => {
  const result = normalize("June first", "3:00 PM", "America/Los_Angeles");

  assert.equal(result.selectedStartAt, "2026-06-01T22:00:00.000Z");
  assert.equal(result.preferredDateNormalized, "2026-06-01");
  assert.equal(result.preferredTimeNormalized, "15:00");
});

test("normalizes June 1 at 3 PM in Los Angeles", () => {
  const result = normalize("June 1", "3:00 PM", "America/Los_Angeles");

  assert.equal(result.selectedStartAt, "2026-06-01T22:00:00.000Z");
});

test("normalizes May twenty ninth at 11 AM in Los Angeles", () => {
  const result = normalize("May twenty ninth", "11:00 AM", "America/Los_Angeles");

  assert.equal(result.selectedStartAt, "2026-05-29T18:00:00.000Z");
  assert.equal(result.preferredDateNormalized, "2026-05-29");
});

test("normalizes June first at 3 PM in Chicago", () => {
  const result = normalize("June first", "3:00 PM", "America/Chicago");

  assert.equal(result.selectedStartAt, "2026-06-01T20:00:00.000Z");
});

test("falls back to valid future selected_start_at when spoken date fails", () => {
  const result = normalizeHumanAppointmentDateTime({
    preferredDate: "some fuzzy day",
    preferredTime: "3:00 PM",
    selectedStartAt: "2026-06-01T22:00:00Z",
    timezone: "America/Los_Angeles",
    now: NOW,
  });

  assert.equal(result.selectedStartAt, "2026-06-01T22:00:00.000Z");
  assert.equal(result.fallbackUsed, "valid_selected_start_at");
});

import assert from "node:assert/strict";
import test from "node:test";

import { sortLeadsForQueue } from "../lib/lead-queue";

type QueueLead = Parameters<typeof sortLeadsForQueue>[0][number];

function lead(id: string, createdAt: string, callDates: string[] = []): QueueLead {
  return {
    id,
    createdAt: new Date(createdAt),
    website: null,
    derivedStatus: "new",
    callAttempts: callDates.map((date) => ({
      createdAt: new Date(date),
      status: "completed",
    })),
    followUps: [],
  } as QueueLead;
}

test("sorts uncalled leads newest first", () => {
  const sorted = sortLeadsForQueue([
    lead("old", "2026-06-01T00:00:00Z"),
    lead("new", "2026-06-12T00:00:00Z"),
    lead("middle", "2026-06-05T00:00:00Z"),
  ]);

  assert.deepEqual(sorted.map((item) => item.id), ["new", "middle", "old"]);
});

test("puts called leads below every uncalled lead", () => {
  const sorted = sortLeadsForQueue([
    lead("new-called", "2026-06-12T00:00:00Z", ["2026-06-13T09:00:00Z"]),
    lead("old-uncalled", "2026-06-01T00:00:00Z"),
    lead("new-uncalled", "2026-06-11T00:00:00Z"),
  ]);

  assert.deepEqual(sorted.map((item) => item.id), ["new-uncalled", "old-uncalled", "new-called"]);
});

test("moves the most recently called lead to the very bottom", () => {
  const sorted = sortLeadsForQueue([
    lead("called-recently", "2026-06-01T00:00:00Z", ["2026-06-13T10:00:00Z"]),
    lead("called-earlier", "2026-06-12T00:00:00Z", ["2026-06-13T08:00:00Z"]),
    lead("uncalled", "2026-05-01T00:00:00Z"),
  ]);

  assert.deepEqual(sorted.map((item) => item.id), ["uncalled", "called-earlier", "called-recently"]);
});

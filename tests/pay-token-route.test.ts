import assert from "node:assert/strict";
import test from "node:test";

import { normalizePayTokenRouteParam } from "@/lib/payments/pay-token-route";

const validShapeToken = "payload_part.signature_part";

test("normalizePayTokenRouteParam leaves normal pay tokens unchanged", () => {
  assert.deepEqual(normalizePayTokenRouteParam(validShapeToken), {
    token: validShapeToken,
    placeholderPrefixStripped: false,
    prefixVariant: null,
  });
});

test("normalizePayTokenRouteParam strips decoded WhatsApp placeholder prefix", () => {
  assert.deepEqual(normalizePayTokenRouteParam(`{{1}}${validShapeToken}`), {
    token: validShapeToken,
    placeholderPrefixStripped: true,
    prefixVariant: "decoded",
  });
});

test("normalizePayTokenRouteParam strips encoded WhatsApp placeholder prefix", () => {
  assert.deepEqual(normalizePayTokenRouteParam(`%7B%7B1%7D%7D${validShapeToken}`), {
    token: validShapeToken,
    placeholderPrefixStripped: true,
    prefixVariant: "encoded",
  });
});

test("normalizePayTokenRouteParam safely handles malformed percent encoding", () => {
  assert.deepEqual(normalizePayTokenRouteParam("%7B%"), {
    token: "%7B%",
    placeholderPrefixStripped: false,
    prefixVariant: null,
  });
});

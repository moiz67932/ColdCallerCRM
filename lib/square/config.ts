import "server-only";

import { env, requireEnv } from "@/lib/env";

export function getSquareAppointmentConfig() {
  return {
    locationId: requireEnv("SQUARE_LOCATION_ID").trim(),
    teamMemberId: requireEnv("SQUARE_TEAM_MEMBER_ID").trim(),
    botoxServiceVariationId: requireEnv("SQUARE_BOTOX_SERVICE_VARIATION_ID").trim(),
    botoxServiceVariationVersion: requirePositiveIntegerEnv("SQUARE_BOTOX_SERVICE_VARIATION_VERSION"),
    botoxDurationMinutes: requirePositiveIntegerEnv("SQUARE_BOTOX_DURATION_MINUTES"),
    botoxDepositAmountCents: requireNonNegativeIntegerEnv("SQUARE_BOTOX_DEPOSIT_AMOUNT_CENTS"),
    currency: requireEnv("SQUARE_CURRENCY").trim(),
  };
}

function requirePositiveIntegerEnv(name: keyof typeof env) {
  const value = parseIntegerEnv(name);

  if (value <= 0) {
    throw new Error(`Environment variable must be a positive integer: ${name}`);
  }

  return value;
}

function requireNonNegativeIntegerEnv(name: keyof typeof env) {
  const value = parseIntegerEnv(name);

  if (value < 0) {
    throw new Error(`Environment variable must be a non-negative integer: ${name}`);
  }

  return value;
}

function parseIntegerEnv(name: keyof typeof env) {
  const rawValue = requireEnv(name).trim();
  const value = Number(rawValue);

  if (!Number.isInteger(value)) {
    throw new Error(`Environment variable must be an integer: ${name}`);
  }

  return value;
}

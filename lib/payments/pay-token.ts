import "server-only";

import crypto from "crypto";

import { requireEnv } from "@/lib/env";

const PAY_TOKEN_PURPOSE = "square_payment_link";

type PayTokenPayload = {
  appointment_intent_id: string;
  exp: number;
  purpose: typeof PAY_TOKEN_PURPOSE;
};

type CreatePayTokenInput = {
  appointmentIntentId: string;
  expiresInMinutes: number;
};

export function createPayToken(input: CreatePayTokenInput) {
  if (!input.appointmentIntentId.trim()) {
    throw new Error("Missing appointment intent ID for pay token.");
  }

  if (!Number.isInteger(input.expiresInMinutes) || input.expiresInMinutes <= 0) {
    throw new Error("Pay token expiry must be a positive integer number of minutes.");
  }

  const payload: PayTokenPayload = {
    appointment_intent_id: input.appointmentIntentId.trim(),
    exp: Math.floor(Date.now() / 1000) + input.expiresInMinutes * 60,
    purpose: PAY_TOKEN_PURPOSE,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyPayToken(token: string): PayTokenPayload | null {
  const [encodedPayload, signature, extra] = token.split(".");

  if (!encodedPayload || !signature || extra !== undefined) {
    return null;
  }

  const expectedSignature = sign(encodedPayload);

  if (!safeEqual(expectedSignature, signature)) {
    return null;
  }

  const payload = parsePayload(encodedPayload);

  if (!payload || payload.purpose !== PAY_TOKEN_PURPOSE || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

export function getAppointmentIntentIdFromPayToken(token: string) {
  return verifyPayToken(token)?.appointment_intent_id ?? null;
}

function sign(encodedPayload: string) {
  return crypto.createHmac("sha256", requireEnv("PAY_LINK_SECRET")).update(encodedPayload).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parsePayload(encodedPayload: string): PayTokenPayload | null {
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<PayTokenPayload>;

    if (
      typeof payload.appointment_intent_id !== "string" ||
      typeof payload.exp !== "number" ||
      payload.purpose !== PAY_TOKEN_PURPOSE
    ) {
      return null;
    }

    return payload as PayTokenPayload;
  } catch {
    return null;
  }
}

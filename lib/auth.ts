import { createHash, timingSafeEqual } from "node:crypto";

import { EncryptJWT, jwtDecrypt } from "jose";
import { cookies } from "next/headers";

import { env, requireEnv } from "@/lib/env";

const SESSION_COOKIE_NAME = "cc_session";

type SessionPayload = {
  sub: "operator";
  iat?: number;
  exp?: number;
};

function getSessionKey() {
  const password = requireEnv("ADMIN_PASSWORD");
  return createHash("sha256").update(password).digest();
}

export function isPasswordValid(candidatePassword: string) {
  const configuredPassword = requireEnv("ADMIN_PASSWORD");
  const expected = Buffer.from(configuredPassword);
  const received = Buffer.from(candidatePassword);

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}

export async function createEncryptedSessionToken() {
  const key = getSessionKey();

  return new EncryptJWT({ sub: "operator" })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${env.SESSION_TTL_HOURS}h`)
    .encrypt(key);
}

export async function verifyEncryptedSessionToken(token: string) {
  try {
    const key = getSessionKey();
    const decoded = await jwtDecrypt<SessionPayload>(token, key);
    return decoded.payload.sub === "operator";
  } catch {
    return false;
  }
}

export async function isAuthenticated() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    return false;
  }

  return verifyEncryptedSessionToken(token);
}

export async function getSessionCookieValue() {
  const token = await createEncryptedSessionToken();

  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: env.SESSION_TTL_HOURS * 60 * 60,
  };
}

export function getClearedSessionCookieValue() {
  return {
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  };
}

import { createPublicKey, verify } from "node:crypto";

import { env } from "@/lib/env";

type VerifySignatureInput = {
  signatureHeader: string | null;
  timestampHeader: string | null;
  rawBody: string;
};

function buildPublicKeyPem(rawKey: string) {
  if (rawKey.includes("BEGIN PUBLIC KEY")) {
    return rawKey;
  }

  const decoded = Buffer.from(rawKey, "base64");

  if (decoded.length !== 32) {
    throw new Error("TELNYX_PUBLIC_KEY must be PEM or base64-encoded Ed25519 key");
  }

  const derPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const der = Buffer.concat([derPrefix, decoded]);
  const b64 = der.toString("base64");

  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;

  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

function isTimestampFresh(timestamp: string) {
  const parsed = Number(timestamp);

  if (Number.isNaN(parsed)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const age = Math.abs(now - parsed);
  return age <= 5 * 60;
}

export function verifyTelnyxSignature(input: VerifySignatureInput) {
  const skipVerification = env.TELNYX_SKIP_SIGNATURE_VERIFICATION === "true";

  if (skipVerification) {
    return {
      verified: true,
      reason: "Signature verification skipped by config",
    };
  }

  if (!env.TELNYX_PUBLIC_KEY) {
    return {
      verified: false,
      reason: "TELNYX_PUBLIC_KEY is not configured",
    };
  }

  if (!input.signatureHeader || !input.timestampHeader) {
    return {
      verified: false,
      reason: "Missing Telnyx signature headers",
    };
  }

  if (!isTimestampFresh(input.timestampHeader)) {
    return {
      verified: false,
      reason: "Webhook timestamp is stale",
    };
  }

  try {
    const signature = input.signatureHeader.split(",")[0]?.trim();

    if (!signature) {
      return {
        verified: false,
        reason: "Signature header was empty",
      };
    }

    const signedPayload = `${input.timestampHeader}|${input.rawBody}`;
    const keyPem = buildPublicKeyPem(env.TELNYX_PUBLIC_KEY);

    const verified = verify(
      null,
      Buffer.from(signedPayload, "utf8"),
      createPublicKey(keyPem),
      Buffer.from(signature, "base64"),
    );

    return {
      verified,
      reason: verified ? "ok" : "Signature mismatch",
    };
  } catch (error) {
    return {
      verified: false,
      reason: error instanceof Error ? error.message : "Signature check failed",
    };
  }
}

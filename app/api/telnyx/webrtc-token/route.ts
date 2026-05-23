import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { env } from "@/lib/env";
import { formatUnknownError, jsonError } from "@/lib/http";
import { logError, logInfo } from "@/lib/logger";
import { getTelnyxClient } from "@/lib/telnyx/client";
import { getTelnyxTelephonyCredentialId } from "@/lib/telnyx/helpers";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  if (!env.TELNYX_TELEPHONY_CREDENTIAL_ID) {
    return jsonError("TELNYX_TELEPHONY_CREDENTIAL_ID is not configured.", 400);
  }

  try {
    const credentialId = getTelnyxTelephonyCredentialId();
    const client = getTelnyxClient();
    const [loginToken, credential] = await Promise.all([
      client.telephonyCredentials.createToken(credentialId),
      client.telephonyCredentials.retrieve(credentialId),
    ]);
    const sipUsername = credential.data?.sip_username;

    logInfo("Issued Telnyx WebRTC credential token", {
      credentialId,
      sipUsernameConfigured: Boolean(sipUsername),
    });

    return NextResponse.json({
      loginToken,
      credentialId,
      sipUsername,
    });
  } catch (error) {
    logError("Failed to issue Telnyx WebRTC credential token", {
      error: formatUnknownError(error),
    });

    return jsonError(formatUnknownError(error), 400);
  }
}

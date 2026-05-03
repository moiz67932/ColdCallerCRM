import { NextResponse } from "next/server";

import { env, getRequiredEnvStatus } from "@/lib/env";
import { prisma } from "@/lib/workstation-db";
import { isPublicWebhookBaseUrlConfigured } from "@/lib/telnyx/helpers";

export async function GET() {
  let dbConnected = false;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch {
    dbConnected = false;
  }

  const envStatus = getRequiredEnvStatus();

  const payload = {
    ok: dbConnected && envStatus.ADMIN_PASSWORD && envStatus.SUPABASE_URL && envStatus.SUPABASE_SERVICE_ROLE_KEY,
    timestamp: new Date().toISOString(),
    checks: {
      dbConnected,
      requiredEnv: envStatus,
      telnyxCredentialsConfigured:
        Boolean(env.TELNYX_API_KEY) &&
        Boolean(env.TELNYX_CONNECTION_ID) &&
        Boolean(env.TELNYX_FROM_NUMBER),
      webrtcCredentialConfigured: Boolean(env.TELNYX_API_KEY) && Boolean(env.TELNYX_CONNECTION_ID),
      outboundCallerConfigured: Boolean(env.TELNYX_FROM_NUMBER),
      messagingConfigured: Boolean(env.TELNYX_MESSAGING_FROM_NUMBER),
      webhookBaseUrlConfigured: Boolean(env.APP_BASE_URL),
      webhookBaseUrlPublic: isPublicWebhookBaseUrlConfigured(),
      signatureVerificationConfigured:
        Boolean(env.TELNYX_PUBLIC_KEY) || env.TELNYX_SKIP_SIGNATURE_VERIFICATION === "true",
    },
  };

  return NextResponse.json(payload, {
    status: payload.ok ? 200 : 503,
  });
}

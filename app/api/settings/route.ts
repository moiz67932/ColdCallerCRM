import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import { env } from "@/lib/env";
import { formatUnknownError, jsonError } from "@/lib/http";
import { getAppSettings, saveAppSettings } from "@/lib/settings";
import { getTelnyxConnectionWebhookConfig, getVoiceWebhookUrl } from "@/lib/telnyx/helpers";

const updateSettingsSchema = z.object({
  enableRecording: z.boolean().optional(),
  defaultFollowUpSmsTemplate: z.string().optional(),
  scripts: z
    .object({
      opening: z.string().optional(),
      gatekeeper: z.string().optional(),
      voicemail: z.string().optional(),
      callbackConfirmation: z.string().optional(),
      close: z.string().optional(),
    })
    .optional(),
});

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  const settings = await getAppSettings();
  const expectedVoiceWebhookUrl = getVoiceWebhookUrl() ?? null;
  const connectionWebhookConfig = await getTelnyxConnectionWebhookConfig().catch(() => null);
  const configuredTelephonyCredentialId = env.TELNYX_TELEPHONY_CREDENTIAL_ID?.trim();
  const configuredConnectionId = env.TELNYX_CONNECTION_ID?.trim();
  const telephonyCredentialIsConnectionId =
    Boolean(configuredTelephonyCredentialId) &&
    (configuredTelephonyCredentialId === configuredConnectionId ||
      configuredTelephonyCredentialId === `connection:${configuredConnectionId}`);
  const canAutoManageWebRtcCredential = Boolean(env.TELNYX_API_KEY) && Boolean(configuredConnectionId);
  const usesConfiguredWebRtcCredential = Boolean(configuredTelephonyCredentialId) && !telephonyCredentialIsConnectionId;

  return NextResponse.json({
    settings,
    runtimeConfig: {
      telnyxConnectionConfigured: Boolean(env.TELNYX_CONNECTION_ID),
      telnyxTelephonyCredentialConfigured:
        usesConfiguredWebRtcCredential || canAutoManageWebRtcCredential,
      telnyxTelephonyCredentialMode: usesConfiguredWebRtcCredential ? "configured" : "auto-managed",
      telnyxFromNumber: env.TELNYX_FROM_NUMBER ? `${env.TELNYX_FROM_NUMBER.slice(0, 5)}...` : null,
      telnyxMessagingFromConfigured: Boolean(env.TELNYX_MESSAGING_FROM_NUMBER),
      signatureVerificationConfigured:
        Boolean(env.TELNYX_PUBLIC_KEY) || env.TELNYX_SKIP_SIGNATURE_VERIFICATION === "true",
      telnyxVoiceWebhookUrl: connectionWebhookConfig?.webhookEventUrl ?? null,
      telnyxExpectedVoiceWebhookUrl: expectedVoiceWebhookUrl,
      telnyxVoiceWebhookMatchesAppBaseUrl: expectedVoiceWebhookUrl
        ? connectionWebhookConfig?.webhookEventUrl === expectedVoiceWebhookUrl
        : null,
      adminPasswordEnvBased: true,
    },
  });
}

export async function POST(request: NextRequest) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  try {
    const payload = updateSettingsSchema.parse(await request.json());
    const settings = await saveAppSettings(payload);
    return NextResponse.json({ settings });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}

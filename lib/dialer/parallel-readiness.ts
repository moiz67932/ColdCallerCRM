import { env } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getTelnyxClient } from "@/lib/telnyx/client";
import { getVoiceWebhookUrl } from "@/lib/telnyx/helpers";
import { evidenceBlockers } from "./parallel-policy";
import { parallelFingerprint } from "./parallel-fingerprint";

export function parallelConfiguration() {
  return {
    connection: env.TELNYX_PARALLEL_CONNECTION_ID || env.TELNYX_CONNECTION_ID, credential: env.TELNYX_TELEPHONY_CREDENTIAL_ID,
    callerId: env.TELNYX_FROM_NUMBER, webhook: getVoiceWebhookUrl(), amd: "premium", deadlineMs: 1000,
  };
}

export async function parallelReadiness(verifyProvider = false) {
  const blockers: string[] = [];
  const config = parallelConfiguration();
  const fingerprint = parallelFingerprint(config);
  if (env.DIALER_PARALLEL_ENABLED !== "true") blockers.push("Set DIALER_PARALLEL_ENABLED=true after controlled verification.");
  if (!config.connection) blockers.push("Missing TELNYX_PARALLEL_CONNECTION_ID or TELNYX_CONNECTION_ID.");
  for (const key of ["TELNYX_API_KEY", "TELNYX_TELEPHONY_CREDENTIAL_ID", "TELNYX_FROM_NUMBER", "TELNYX_PUBLIC_KEY"] as const) {
    if (!env[key]) blockers.push(`Missing ${key}.`);
  }
  if (!config.webhook?.startsWith("https://")) blockers.push("A public HTTPS voice webhook URL is required.");
  if (env.TELNYX_SKIP_SIGNATURE_VERIFICATION === "true") blockers.push("Webhook signature bypass must be disabled.");
  let verification: { id: string; account_channels: number; rate_ceiling_cents: number; profile_id: string; evidence: Record<string, unknown> } | null = null;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const { data, error } = await getSupabaseAdmin().from("dialer_provider_verifications").select("*")
      .eq("config_fingerprint", fingerprint).gt("expires_at", new Date().toISOString()).order("verified_at", { ascending: false }).limit(1).maybeSingle();
    if (error) blockers.push(`Apply parallel migrations through 202611140001: ${error.message}`);
    else verification = data;
    const transport = await getSupabaseAdmin().rpc("portive_parallel_transport_ready");
    if (transport.error || transport.data !== true) blockers.push("Supabase Realtime publication for sessions and attempts is unavailable.");
  } else blockers.push("Supabase configuration is missing.");
  blockers.push(...evidenceBlockers(verification?.evidence ?? null));
  let sipUri: string | undefined;
  let availableCreditCents = 0;
  let channels = verification?.account_channels ?? 0;
  if (verifyProvider && !blockers.length && verification) {
    try {
      const client = getTelnyxClient();
      const [application, credential, balance] = await Promise.all([
        client.callControlApplications.retrieve(config.connection!),
        client.telephonyCredentials.retrieve(env.TELNYX_TELEPHONY_CREDENTIAL_ID!),
        client.balance.retrieve(),
      ]);
      const available = Number(balance.data?.available_credit);
      if (balance.data?.currency !== "USD" || !Number.isFinite(available) || available <= 0) blockers.push("Provider USD available credit cannot cover a calling session.");
      else availableCreditCents = Math.floor(available * 100);
      const profileId = application.data?.outbound?.outbound_voice_profile_id;
      if (!profileId || profileId !== verification.profile_id) blockers.push("Call Control outbound profile does not match the verified configuration.");
      else {
        const profile = await client.outboundVoiceProfiles.retrieve(profileId);
        const profileLimit = profile.data?.concurrent_call_limit;
        const connectionLimit = application.data?.outbound?.channel_limit;
        if (profileLimit == null || profileLimit <= 0 || !connectionLimit || connectionLimit <= 0) blockers.push("Provider profile/connection channel limits are not explicitly verifiable.");
        else channels = Math.min(channels, profileLimit, connectionLimit);
      }
      if (application.data?.webhook_event_url !== config.webhook) blockers.push("The Call Control application's webhook URL differs from this deployment.");
      if (!credential.data?.sip_username) blockers.push("WebRTC credential has no SIP username.");
      else sipUri = `sip:${credential.data.sip_username}@sip.telnyx.com`;
    } catch (error) { blockers.push(`Provider readiness check failed: ${error instanceof Error ? error.message : "Unknown error"}`); }
  }
  return { enabled: blockers.length === 0, blockers, fingerprint, verification, channels, sipUri, availableCreditCents };
}

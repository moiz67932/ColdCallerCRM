import { env } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getTelnyxClient } from "@/lib/telnyx/client";
import { getVoiceWebhookUrl } from "@/lib/telnyx/helpers";
import { cloudflareRequest, orchestrationBackend } from "./orchestration";
import {usdCentsFloor} from './budget';
import {getBudgetConfiguration} from './budget-settings';
import { parallelFingerprint } from "./parallel-fingerprint";

export function parallelConfiguration() {
  return {
    connection: env.TELNYX_PARALLEL_CONNECTION_ID || env.TELNYX_CONNECTION_ID, credential: env.TELNYX_TELEPHONY_CREDENTIAL_ID,
    callerId: env.TELNYX_FROM_NUMBER, webhook: getVoiceWebhookUrl(), amd: "premium", deadlineMs: 8000, ...(orchestrationBackend() === "cloudflare" ? { orchestrationBackend: "cloudflare" } : {}),
  };
}

export async function parallelReadiness(verifyProvider = false) {
  const blockers: string[] = [];
  const config = parallelConfiguration();
  const fingerprint = parallelFingerprint(config);
  if (env.DIALER_PARALLEL_ENABLED !== "true") blockers.push("Parallel calling is disabled in this runtime.");
  if (!config.connection) blockers.push("Missing TELNYX_PARALLEL_CONNECTION_ID or TELNYX_CONNECTION_ID.");
  for (const key of ["TELNYX_API_KEY", "TELNYX_TELEPHONY_CREDENTIAL_ID", "TELNYX_FROM_NUMBER", "TELNYX_PUBLIC_KEY"] as const) {
    if (!env[key]) blockers.push(`Missing ${key}.`);
  }
  if (!config.webhook?.startsWith("https://")) blockers.push("A public HTTPS voice webhook URL is required.");
  if (env.TELNYX_SKIP_SIGNATURE_VERIFICATION === "true") blockers.push("Webhook signature bypass must be disabled.");
  if (!env.DIALER_CALLER_NAME?.trim()) blockers.push("Configure DIALER_CALLER_NAME with the calling business name for answered-collision identification.");
  const budget = await getBudgetConfiguration();

  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const schema = await getSupabaseAdmin().rpc("portive_regular_parallel_status");
    if (schema.error || schema.data?.schemaVersion !== "202611160001" || schema.data?.reportRequired !== false || schema.data?.hoursPolicyVersion !== "202611160002") blockers.push("Apply database migration 202611160002_default_calling_policy.sql for automatic calling-policy fallback.");
    const transport = await getSupabaseAdmin().rpc("portive_parallel_transport_ready");
    if (transport.error || transport.data !== true) blockers.push("Supabase Realtime publication for sessions and attempts is unavailable.");
  } else blockers.push("Supabase configuration is missing.");
  let sipUri: string | undefined;
  let availableCreditCents = 0;
  let channels = 0;
  let dailyLimitCents: number|null=null;
  if (orchestrationBackend() === "cloudflare") {
    if (env.DIALER_CLOUDFLARE_ENABLED !== "true" || !env.DIALER_CLOUDFLARE_URL || !env.DIALER_CLOUDFLARE_SECRET) blockers.push("Configure and enable Cloudflare orchestration before starting sessions.");
    if (verifyProvider && !blockers.length) {
      try {
        const worker = await cloudflareRequest("/internal/inspect", {});
        if (!worker.parallelEnabled || worker.fingerprint !== fingerprint) blockers.push("Cloudflare dialing flag or configuration differs from the Vercel configuration.");
        if (worker.callerName !== env.DIALER_CALLER_NAME) blockers.push("Configure the same DIALER_CALLER_NAME in Vercel and Cloudflare.");
      } catch { blockers.push("Cloudflare orchestration readiness check failed."); }
    }
  }
  if (verifyProvider && !blockers.length) {
    try {
      const client = getTelnyxClient();
      const [application, credential, balance] = await Promise.all([
        client.callControlApplications.retrieve(config.connection!),
        client.telephonyCredentials.retrieve(env.TELNYX_TELEPHONY_CREDENTIAL_ID!),
        client.balance.retrieve(),
      ]);
      const available = Number(balance.data?.available_credit);
      if (balance.data?.currency !== "USD" || !Number.isFinite(available) || available <= 0) blockers.push("Provider USD available credit cannot cover a calling session.");
      else availableCreditCents = usdCentsFloor(String(balance.data!.available_credit));
      const profileId = application.data?.outbound?.outbound_voice_profile_id;
      if (!profileId) blockers.push("Call Control application has no outbound voice profile.");
      else {
        const profile = await client.outboundVoiceProfiles.retrieve(profileId);
        const recording=profile.data?.call_recording?.call_recording_type;
        if(recording&&recording!=='none'&&budget.profile&&budget.profile.recordingPerMinuteMicros<=0)blockers.push('Outbound profile recording is enabled; include its actual per-minute charge in the account tariff.');
        const profileLimit = profile.data?.concurrent_call_limit;
        const connectionLimit = application.data?.outbound?.channel_limit;
        if (profileLimit == null || profileLimit <= 0 || !connectionLimit || connectionLimit <= 0) blockers.push(`Explicit channel limits are required: Voice API application ${config.connection} outbound.channel_limit=${connectionLimit ?? "unset"}; outbound profile ${profileId} concurrent_call_limit=${profileLimit ?? "unset"}. Each must cover prospect lines plus the operator; the account-wide limit also applies.`);
        else channels = Math.min(profileLimit, connectionLimit,budget.availableChannels);
        if(profile.data?.daily_spend_limit_enabled){ const limit=Number(profile.data.daily_spend_limit);if(!Number.isFinite(limit)||limit<=0)blockers.push("Provider daily spending limit is unavailable");else dailyLimitCents=usdCentsFloor(String(profile.data.daily_spend_limit)); }
        if (!profile.data?.enabled || !application.data?.active) blockers.push("Provider application or outbound profile is disabled.");
      }
      if (application.data?.webhook_event_url !== config.webhook) blockers.push("The Call Control application's webhook URL differs from this deployment.");
      if (!credential.data?.sip_username || credential.data.expired || (credential.data.expires_at && Date.parse(credential.data.expires_at) <= Date.now())) blockers.push("WebRTC credential has no SIP username.");
      else {
        const connectionId = credential.data.resource_id?.replace(/^connection:/, "");
        if (!connectionId) blockers.push("WebRTC credential has no associated SIP connection.");
        else {
          const connection = await client.credentialConnections.retrieve(connectionId);
          if (!connection.data?.active || !["internal", "unrestricted"].includes(connection.data.sip_uri_calling_preference ?? "")) {
            blockers.push("Operator SIP connection must be active and allow Receive SIP URI calls from your own connections. WebRTC registration alone does not enable incoming operator calls.");
          }
        }
        sipUri = `sip:${credential.data.sip_username}@sip.telnyx.com`;
      }
    } catch (error) { blockers.push(`Provider readiness check failed: ${error instanceof Error ? error.message : "Unknown error"}`); }
  }
  blockers.push(...budget.blockers);
  return { enabled: blockers.length === 0, blockers, fingerprint, budget, channels, sipUri, availableCreditCents, dailyLimitCents };
}

import 'server-only';
import { env } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getTelnyxClient } from '@/lib/telnyx/client';
import { parallelConfiguration } from './parallel-readiness';
import { parallelFingerprint } from './parallel-fingerprint';
import { cloudflareRequest, orchestrationBackend } from './orchestration';
import { acceptanceGrantBlockers, type AcceptanceGrant } from './acceptance-policy';

export async function acceptanceStartOptions(grantId: string, controller: string) {
  if (env.DIALER_ACCEPTANCE_ENABLED !== 'true' || orchestrationBackend() !== 'cloudflare') throw new Error('Restricted acceptance is disabled.');
  if (env.DIALER_PARALLEL_ENABLED !== 'false') throw new Error('Keep unrestricted Parallel disabled during acceptance.');
  const config = parallelConfiguration(), fingerprint = parallelFingerprint(config);
  if (!config.connection || !config.credential || !env.TELNYX_API_KEY || !env.TELNYX_PUBLIC_KEY ||
    !/^\+[1-9]\d{7,14}$/.test(config.callerId ?? '') || !config.webhook?.startsWith('https://') || env.TELNYX_SKIP_SIGNATURE_VERIFICATION === 'true') throw new Error('Verified provider/webhook configuration is required.');
  const db = getSupabaseAdmin();
  const { data, error } = await db.from('dialer_acceptance_grants').select('*').eq('id', grantId).single();
  if (error || !data) throw new Error('Acceptance authorization not found.');
  const grant = data as AcceptanceGrant;
  const blockers = acceptanceGrantBlockers(grant, controller, fingerprint);
  if (blockers.length) throw new Error(blockers.join(' '));
  const transport = await db.rpc('portive_parallel_transport_ready');
  if (transport.error || transport.data !== true) throw new Error('Realtime is unavailable.');
  const worker = await cloudflareRequest('/internal/inspect', {});
  if (!worker.acceptanceEnabled || worker.parallelEnabled || worker.fingerprint !== fingerprint) throw new Error('Worker acceptance flag or configuration differs.');
  const client = getTelnyxClient();
  const [app, credential, balance] = await Promise.all([
    client.callControlApplications.retrieve(config.connection), client.telephonyCredentials.retrieve(config.credential), client.balance.retrieve(),
  ]);
  if (!app.data?.active || app.data.webhook_event_url !== config.webhook || app.data.outbound?.outbound_voice_profile_id !== grant.profile_id) throw new Error('Live Voice API application differs from acceptance authorization.');
  const profile = await client.outboundVoiceProfiles.retrieve(grant.profile_id);
  if (!profile.data?.enabled || !Number.isInteger(app.data.outbound.channel_limit) || Number(app.data.outbound.channel_limit) < 5 ||
    !Number.isInteger(profile.data.concurrent_call_limit) || Number(profile.data.concurrent_call_limit) < 5) throw new Error('Live application/profile must explicitly permit five channels.');
  if (!credential.data?.sip_username || credential.data.expired || (credential.data.expires_at && Date.parse(credential.data.expires_at) <= Date.now()) ||
    `sip:${credential.data.sip_username}@sip.telnyx.com` !== grant.operator_sip_uri) throw new Error('Live operator credential differs from acceptance authorization.');
  const credit = Number(balance.data?.available_credit);
  if (balance.data?.currency !== 'USD' || !Number.isFinite(credit) || Math.floor(credit * 100) < grant.max_spend_cents) throw new Error('Insufficient live USD credit for acceptance.');
  if (profile.data.daily_spend_limit_enabled && Number(profile.data.daily_spend_limit) * 100 < grant.max_spend_cents) throw new Error('Provider daily limit is below the approved test budget.');
  return { acceptanceGrantId: grant.id, fingerprint };
}

// Acceptance authorizations are capabilities, never successful verification reports.
export type AcceptanceGrant = {
  id: string; controller_id: string; list_id: string; time_zone: string;
  config_fingerprint: string; profile_id: string; operator_sip_uri: string;
  destinations: Array<{ lead_id: string; phone_number: string; time_zone: string; consent_reference: string }>;
  account_channels: number; rate_ceiling_cents: number; max_spend_cents: number; remaining_daily_cents: number;
  expires_at: string; revoked_at: string | null; consumed_session_id: string | null;
};
export function acceptanceGrantBlockers(g: AcceptanceGrant, controller: string, fingerprint: string, now = Date.now()) {
  const blockers: string[] = [];
  if (g.controller_id !== controller || g.config_fingerprint !== fingerprint) blockers.push("Acceptance authorization does not match this browser/configuration.");
  if (g.revoked_at || g.consumed_session_id || !Number.isFinite(Date.parse(g.expires_at)) || Date.parse(g.expires_at) <= now) blockers.push("Acceptance authorization is expired, revoked or already consumed.");
  if (![1, 4].includes(g.destinations?.length) || g.destinations.some(d => !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(d.phone_number) || !d.consent_reference || !d.time_zone)) blockers.push("Acceptance requires one or four consenting +1 destinations.");
  if (!Number.isInteger(g.account_channels) || g.account_channels < 5) blockers.push("Five account channels must be verified.");
  if (!Number.isInteger(g.rate_ceiling_cents) || g.rate_ceiling_cents < 1 || !Number.isInteger(g.max_spend_cents) || g.max_spend_cents > 200 ||
    g.max_spend_cents < (2 + 4 * g.destinations.length) * g.rate_ceiling_cents || g.remaining_daily_cents < g.max_spend_cents) blockers.push("Acceptance budget or verified all-inclusive rate is insufficient.");
  return blockers;
}

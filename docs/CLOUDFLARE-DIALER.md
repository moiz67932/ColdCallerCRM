# Cloudflare dialer deployment and verification

The implementation is prepared for staging; production calling and latency remain unverified. The existing three-panel UI, lead priorities, notes, callbacks, dispositions, recording consent, WebRTC path and collision policy remain in place. Apply the fourth SQL migration before deploying the updated Vercel backend.

## 1. Fedora prerequisites and local checks

From the existing repository:

```bash
sudo dnf install -y git nodejs npm openssl
node --version
npm --version
# Wrangler requires Node >=22.12.0; use a supported Node release if Fedora has an older one.
npm ci
cd cloudflare/portive-dialer
npm ci
npm run typecheck
npm test
npm run bundle
npm run probe:sdk
npx wrangler login
cp dev-vars.template .dev.vars.staging
# Edit .dev.vars.staging with staging values; this file is ignored by Git.
npm run dev
```

`npm run dev` runs `wrangler dev --env staging`, normally at `http://localhost:8787`. Keep the dialing flag false until performing an authorized controlled test. A local Worker with real secrets can reach its configured database/provider; the automated tests replace external fetch instead.

Root checks:

```bash
npm run test:dialer
npm run test:dialer:db
npm run test:parallel:db
npx tsc --noEmit
npm run build
```

The DB suites expect disposable container `portive-dialer-test-20261113`. They never read production database credentials. A local fixture can be created without publishing a port:

```bash
docker run --name portive-dialer-test-20261113 -e POSTGRES_PASSWORD=local-test-only -d postgres:16-alpine
docker exec portive-dialer-test-20261113 pg_isready -U postgres
# Run after PostgreSQL reports ready:
docker exec portive-dialer-test-20261113 psql -U postgres -c 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;'
# Run the root DB test scripts, then remove only this disposable container:
docker rm -f portive-dialer-test-20261113
```

## 2. Database migration and staging isolation

Use a separate staging Supabase project and controlled test leads. Apply in order after the workstation/location schema:

1. `202611130001_dial_sessions.sql`
2. `202611130002_parallel_engine.sql`
3. `202611140001_single_operator_collisions.sql`
4. `202611140002_cloudflare_orchestration.sql`

Keep the fourth migration last, including after manually rerunning an earlier script. It preserves existing session/attempt/lead/CRM data and defaults the backend to `node`. It grants new RPCs only to the service role. SQL migrations do not enable real Parallel calling.

Finish or Stop all old sessions and obtain provider terminal evidence for every outstanding call. Reconcile pending/uncertain commands from actual provider evidence; do not delete safety rows to force a switch. Stop the old watchdog, then change the database selection:

```sql
select public.portive_set_orchestration_backend('cloudflare', true);
```

The function refuses unsafe cutover. Until Vercel is deployed with the matching backend, calling requests fail closed with a backend mismatch. `enabled=true` authorizes this orchestration service; Parallel dialing still requires both deployment flags and the controlled report. Never edit the configuration table directly to bypass the switch checks.

## 3. Cloudflare secrets and staging deployment

Generate a shared secret privately:

```bash
openssl rand -hex 32
```

Use the same generated value in the matching Vercel environment and Worker. Do not use the template text as a secret. From `cloudflare/portive-dialer`, configure each secret interactively:

```bash
for key in DIALER_CLOUDFLARE_SECRET SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY TELNYX_API_KEY TELNYX_PUBLIC_KEY TELNYX_PARALLEL_CONNECTION_ID TELNYX_TELEPHONY_CREDENTIAL_ID TELNYX_FROM_NUMBER VERCEL_VOICE_WEBHOOK_URL; do
  npx wrangler secret put "$key" --env staging
done
npx wrangler deploy --env staging
npx wrangler tail --env staging --format json
```

Expected values:

| Worker secret | Value |
|---|---|
| `DIALER_CLOUDFLARE_SECRET` | Random shared secret, at least 32 characters |
| `SUPABASE_URL` | `https://<staging-project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | That project's service-role key; never an anon key |
| `TELNYX_API_KEY` | Authorized staging account/API key |
| `TELNYX_PUBLIC_KEY` | Telnyx webhook Ed25519 key, base64 or PEM |
| `TELNYX_PARALLEL_CONNECTION_ID` | Dedicated Parallel Voice API application ID |
| `TELNYX_TELEPHONY_CREDENTIAL_ID` | Existing operator WebRTC credential ID |
| `TELNYX_FROM_NUMBER` | Authorized caller ID in E.164, such as `+12125550100` |
| `VERCEL_VOICE_WEBHOOK_URL` | `https://<staging-vercel-domain>/api/webhooks/telnyx/voice` |

Only the caller ID format is illustrated; use a real number you control for calls. Staging and production secrets/DO namespaces are separate. Both `wrangler.jsonc` environments initially set `DIALER_PARALLEL_ENABLED=false`. The deployed URL is printed by Wrangler and uses `workers.dev`; no paid domain is needed. `/health` returns service/environment information, not secret values. Power-only Cloudflare cleanup can run with the Parallel flag false; Parallel application/credential validation is required when enabling Parallel dispatch.

## 4. Vercel environment

Preserve all existing Supabase, auth, Telnyx, recording and CRM configuration. Set these server-only variables in the matching Vercel environment and redeploy:

```env
DIALER_ORCHESTRATION_BACKEND=cloudflare
DIALER_CLOUDFLARE_ENABLED=true
DIALER_CLOUDFLARE_URL=https://portive-dialer-staging.<account-subdomain>.workers.dev
DIALER_CLOUDFLARE_SECRET=<same-random-secret-as-staging-worker>
DIALER_PARALLEL_ENABLED=false
```

Keep `APP_BASE_URL=https://<staging-vercel-domain>`, the operator WebRTC credential, verified caller ID and public webhook key configured. No variable above belongs under `NEXT_PUBLIC_*`. Retain the old `DIALER_WATCHDOG_SECRET` privately for rollback; `DIALER_INTERNAL_URL` is used only by the Node fallback. Do not run the watchdog with the Cloudflare backend selected. Both its local flag check and the database consumer fence prevent that process from claiming Cloudflare sessions.

The current local build blockers were invalid `SUPABASE_URL` and `SQUARE_WEBHOOK_NOTIFICATION_URL`. Use the exact URL formats in the audit, or omit the optional Square variable if unused. Empty strings are not valid optional URLs. The repository build was validated with temporary valid URL overrides, not by rewriting your secrets.

## 5. Telnyx webhook setup

Keep the existing Manual/Power SIP/WebRTC application and browser credential. For the Parallel Voice API application:

- Use the existing public Vercel voice webhook, exactly matching `APP_BASE_URL + /api/webhooks/telnyx/voice` and `VERCEL_VOICE_WEBHOOK_URL`.
- Keep signature verification enabled (`TELNYX_SKIP_SIGNATURE_VERIFICATION` must not be true).
- Verify the outbound voice profile, permissions, caller ID, balance and explicit capacity for four prospect legs plus one operator leg.
- Do not change the global webhook or replace the operator SIP connection with a Worker URL.

The Worker has no public direct Telnyx ingress in this rollout. Vercel verifies/persists raw deliveries and forwards session events using HMAC. Cloudflare verifies the original signature again. Recording and transcript events retain their current Vercel handlers. Nothing streams microphone audio through Cloudflare.

Live application settings could not be inspected: the current read-only preflight stops at missing `TELNYX_TELEPHONY_CREDENTIAL_ID`. No provider configuration was changed.

## 6. Staging and measured acceptance

Run all local tests first. In the separate authorized telephony test environment use only consenting controlled destination numbers, a real operator browser and the verified caller ID. The report importer does not place calls or create evidence; no synthetic passing live report is supplied.

Verify four simultaneous ringing legs; voicemail exclusion; one atomic human winner and bridge; second-human collision hangup without interrupting the winner; ringing cancellations; canceled-lead recycling in a later session; no same-session redial; disposition hold; notes/callback IDs; consented recording; keypad; media disconnect; Realtime reconnect; Pause/Resume/Stop; delayed/duplicate events; API timeouts; restart/alarm recovery; backend fencing and rollback. Include the additional Cloudflare scenarios in `lib/dialer/parallel-policy.ts`.

Measure both provider/media behavior and orchestration overhead. Correlate provider IDs, attempt IDs and timestamps from Worker logs, `workstation_telnyx_webhook_events.orchestration_timing`, command response records and `dial_audit_events`. Browser `operator_audio_available` telemetry reports a playing-media indicator; actual first-word/audio measurements need a controlled media capture and calibrated clocks. Do not treat a scheduled one-second alarm as proof of a one-second action.

Save actual correlated measurements as JSON and summarize them:

```bash
node cloudflare/portive-dialer/scripts/latency-report.mjs /absolute/path/controlled-latency-samples.json
npm run parallel:check
npm run parallel:check -- --report /absolute/path/controlled-report.json
```

Use the staging Vercel environment in the report command (`DIALER_ORCHESTRATION_BACKEND=cloudflare`). The report must bind to its Cloudflare fingerprint, record real provider call IDs, include all base and Cloudflare scenarios, identify `orchestration_backend: "cloudflare"`, and include `cloudflare_latency` with measured `p50_ms`, `p95_ms`, `max_ms`. The maximum target remains 1500 ms. Capacity/rate/profile/age requirements remain enforced. An older Node report cannot release Cloudflare calling.

After genuine controlled verification is complete, set the staging Worker and Vercel `DIALER_PARALLEL_ENABLED=true` and redeploy. The Worker flag can be supplied explicitly for the release:

```bash
npx wrangler deploy --env staging --var DIALER_PARALLEL_ENABLED:true
```

Keep `wrangler.jsonc` consistent with the approved flag on subsequent deployments. Start/Resume rechecks provider and Worker configuration. Local/mock tests are not evidence for the live report. No measured p50/p95/maximum is available from this implementation session.

## 7. Production release

Production infrastructure changes need explicit approval. Prepare production secrets using the same interactive loop with `--env production`; use production Supabase/provider values and Vercel webhook URL. Initially keep the Parallel flags false.

```bash
npx wrangler deploy --env production --dry-run
# After approval:
npx wrangler deploy --env production
npx wrangler tail --env production --format json
npx wrangler deployments list --env production
```

Apply the fourth migration to production, drain/reconcile the Node sessions, switch the DB backend through the guarded function, then deploy Vercel with:

```env
DIALER_ORCHESTRATION_BACKEND=cloudflare
DIALER_CLOUDFLARE_ENABLED=true
DIALER_CLOUDFLARE_URL=https://portive-dialer-production.<account-subdomain>.workers.dev
DIALER_CLOUDFLARE_SECRET=<matching-production-worker-secret>
DIALER_PARALLEL_ENABLED=false
```

Production-specific provider/media verification and matching current evidence remain required before both production Parallel flags become true. Save the Worker version and Vercel deployment IDs for rollback. Keep account usage below the estimates/limits below and inspect actual CPU, duration, requests and SQLite metrics during staging.

## 8. Complete rollback

1. Stop new session starts. Preserve any established conversation. Use Pause/Stop and save its disposition; wait for actual terminal events for every prospect and the parked operator.
2. If the Worker release is broken, restore a known-good Worker version with the same Durable Object class/migration lineage first:

   ```bash
   npx wrangler deployments list --env production
   npx wrangler rollback <KNOWN_GOOD_VERSION_ID> --env production
   ```

   Do not delete the Worker/namespace or roll back across the initial DO class creation. If infrastructure remains unavailable, reconcile live legs through the provider using real evidence. There is no automatic competing Node takeover of an active Cloudflare session.
3. Once no active session/call or pending/uncertain command remains, run:

   ```sql
   select public.portive_set_orchestration_backend('node', false);
   ```

   A rejection means reconciliation is still required; do not clear ledgers merely to force it.
4. Set Vercel `DIALER_ORCHESTRATION_BACKEND=node`, `DIALER_CLOUDFLARE_ENABLED=false`, and keep Parallel disabled until Node verification matches the Node fingerprint. Redeploy Vercel. Restore the correct old Node environment and run `npm run dialer:watchdog` on the previously supported Node setup if choosing that rollback architecture. This repository migration does not purchase or configure hosting for it.
5. The SQL fence prevents Cloudflare claims after switching. Late operator events on completed sessions are audited without reopening them. The Cloudflare alarm stops when its backend is retired; the Cron scan has no authority to dispatch Node calls. The fourth migration can remain installed; dropping tables or reverting CRM data is unnecessary.

## 9. Cloudflare Free-plan estimate

Official documentation checked 2026-11-14: [Worker limits](https://developers.cloudflare.com/workers/platform/limits/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/). Workers Free permits 100,000 requests/day and 10 ms CPU per ordinary HTTP request. SQLite DO Free includes 100,000 requests/day, 13,000 GB-s/day, 5 million rows read/day, 100,000 rows written/day and 5 GB account storage (1 GB per object). DO invocations have their own CPU limit; the default is 30 seconds. Alarms are at-least-once and may be late; their automatic retries are bounded.

Planning model, not measured billing: one active operator-minute per dial including ring/talk/wrap allocation; at most 80 Worker requests and 96 DO requests per dial (browser heartbeat/media acknowledgements, provider events, control calls and alarms); 288 recovery scans/day, allowing two DO invocations per scan; at most 12 alarms/dial; conservative 160 SQLite writes and 2000 row reads/dial, plus a small daily scan allowance. Duration budgets both session/control objects at 128 MiB plus 25% overhead: 18.75 GB-s/dial. No audio streaming or large logs are stored in DO SQLite. Completed objects clear their storage; active/control metadata should remain below 1 MB in this single-operator model. Actual account metrics must confirm these assumptions.

| Dials/day | Worker requests | DO requests | Alarms | Duration GB-s | SQLite writes | Rows read |
|---:|---:|---:|---:|---:|---:|---:|
| 50 | 4,288 | 5,376 | 600 | 937.5 | 8,576 | 101,000 |
| 100 | 8,288 | 10,176 | 1,200 | 1,875 | 16,576 | 201,000 |
| 250 | 20,288 | 24,576 | 3,000 | 4,687.5 | 40,576 | 501,000 |
| 500 | 40,288 | 48,576 | 6,000 | 9,375 | 80,576 | 1,001,000 |

These scenarios fit the published allowances under this model. At 500 dials, SQLite writes and duration have the least headroom. Longer active sessions, retry storms, additional applications, or simultaneously active staging/production environments can exceed the account-wide allowance. At the modeled 160 writes/dial, the daily write allowance is exhausted around 621 dials before other workloads. At this model's duration, it is exhausted around 693 dials. These are planning thresholds, not supported calling-rate guarantees. No paid plan is selected or automatically activated. Telnyx call/AMD/recording fees and Supabase/Vercel quotas remain separate existing dependencies.

A critical quota/storage/CPU outage fails requests, pauses new scheduling, and retains uncertain commands. After quotas/services recover, alarms/Cron/provider retries resume reconciliation. Outbound provider calls cannot be controlled by an unavailable Worker; provider time limits still apply. This limitation requires controlled outage/media verification before production acceptance.

# Controlled Parallel staging verification

Production Parallel remains disabled. No live or paid call is authorized by this checklist.

## Isolation and non-calling checks

- Identify staging Supabase project ID, Vercel project/deployment and environment, Worker namespace and version, and Telnyx account/subaccount, Voice API application and operator credential. Record masked identifiers privately; compare them with production. Distinct API keys alone do not prove distinct Telnyx accounts or isolated destinations.
- Verify Vercel and Worker point only to staging Supabase, staging Telnyx credentials, and the staging HTTPS webhook. Never invoke a staging Worker while its secrets may point to production. Inspect secret names/environment ownership without exposing values.
- Keep `DIALER_PARALLEL_ENABLED=false` in both staging runtimes and production. Inspect staging migration history and installed RPC definitions before applying only `202611150001_parallel_dispatch_safety.sql` after the existing migration chain. Drain sessions and reconcile uncertain commands first.
- Release the staging application after the migration. No Worker source change is required for the existing authorization RPC contract; verify the deployed Worker already calls `portive_orchestration_authorize` before provider I/O.
- Run authenticated health, configuration/readiness, UI and Realtime checks. Start must remain blocked by the disabled Parallel flag. Do not manufacture a verification report to obtain a positive Start response.
- Run positive synthetic session creation/media acknowledgement/recovery scenarios only in disposable databases or rollback-only SQL transactions with no Worker wake. Use the committed Chromium-to-SQL-to-mock-Worker transition test for initial waiting, playback rejection, DNC denial, reordered heartbeat/acknowledgement, winner cleanup and duplicate events. Confirm no persistent outbox commands or synthetic evidence are installed in connected staging.
- Confirm ordinary positive heartbeats cannot grant readiness; explicit valid acknowledgement can. After media loss, delayed positive requests must leave `browser_media_ready=false`, session unsafe, and exactly one active-winner cleanup command. Canceled reservations must remain protected against same-session redial.
- Record the exact application commit, migration version, Worker version, non-calling results and any remaining blockers. Disabled flags and passing offline tests do not constitute live provider/media acceptance.

## Live test prerequisites — explicit approval required

- One operator and four consenting, controlled test destinations; correct reviewed timezones and current 09:00–20:00 local calling windows. Preserve DNC, suppression, approval, duplicate protection and all authorization checks.
- Verified five-leg capacity (operator plus four prospects), outbound profile/application limits and account availability; verified caller ID, SIP registration, webhook signatures, USD credit and a deliberately bounded test spend/attempt limit.
- A separately authorized controlled verification process and genuine report satisfying every scenario in `lib/dialer/parallel-policy.ts`, including finite integer `peak_concurrent_legs >= 5`. The report importer does not execute or certify these tests. Do not bypass the normal Start evidence gate to bootstrap acceptance.
- Explicit authorization for any staging-only flag enablement and paid calls. Production flags remain unchanged. Agree who will answer each destination and how to stop the run immediately.

## Controlled acceptance run

1. Prove the operator's initial `waiting -> playing -> ready` sequence leaves the session running. Confirm actual microphone/speaker routing and bidirectional audio.
2. Prove four separate prospect legs ring concurrently. Correlate provider identities, session/batch IDs and the measured five-leg peak.
3. Test human, machine and unknown AMD, including the one-second application deadline and delayed/out-of-order delivery. Carrier answer alone must not win; do not extend or bypass safety gates to obtain a passing result.
4. Confirm the first classified human wins exactly one bridge, first words and two-way audio are usable, ringing losers terminate, and a near-simultaneous second human is recorded and ended without interrupting the winner.
5. Exercise browser playback loss, stale positive requests, operator disconnect, transport-only pause/recovery, Stop, disposition holds, refresh and duplicate events. Verify safe terminal evidence and no replacement dial after uncertain provider outcomes.
6. Measure correlated provider answer-to-audible-operator audio timestamps. Report Cloudflare p50, p95 and maximum, with maximum <=1500 ms, plus raw samples, clock correlation and evidence for first-word preservation. A browser playing indicator alone is insufficient.
7. Verify consent-gated recording, DTMF, callbacks/notes attached to the correct winner, and Manual/Power regressions. Reconcile actual provider cost and terminate every test leg.
8. Store reviewed genuine evidence through the supported importer only after acceptance. Keep production Parallel disabled and obtain a separate production release approval.

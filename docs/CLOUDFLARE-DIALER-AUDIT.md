# Cloudflare orchestration audit and design

Audit date: 2026-11-14. Checkpoint branch: `checkpoint/portive-before-cloudflare-20261114`, commit `bc85003`. Implementation branch: `feat/cloudflare-dialer-orchestration`. The working tree became clean at that existing commit during checkpoint creation, so no empty checkpoint commit was added. No changes were stashed, reset, or discarded. The existing audio asset and the three earlier migrations are retained.

## Previous responsibilities

| Responsibility | Existing implementation | Cloudflare replacement |
|---|---|---|
| Command execution | `scripts/dialer-watchdog.ts` POSTs `sweep?commands=1` every 100 ms, maximum 12 in-flight requests; `parallel-worker.ts` claims four commands with SKIP LOCKED | A session wake/provider event calls `portive_orchestration_work`, then dispatches at most four commands concurrently; at most three drain rounds per invocation |
| Parallel scheduling | Independent 250 ms watchdog loop calls `tickParallelSessions` | Event-driven ticks after session commands, provider events, command completions, saved dispositions, and relevant alarms |
| Winner/collision/queue | `portive_parallel_event`, `portive_parallel_command`, `portive_cancel_parallel`; PostgreSQL advisory/session locks | Same functions and invariants; SQLite does not select leads or arbitrate winners |
| Provider uncertainty | Executing commands older than 60 seconds become uncertain; no dial retry | Same durable ledger, plus read-only provider status reconciliation and alarms |
| AMD unknown deadline | Database timestamp at carrier answer plus one second | Immediate event-driven SQL processing; earliest-deadline alarm for missing AMD; alarm timing is not guaranteed |
| Browser lease | Parallel 10 seconds; Power 45 seconds | Database remains authoritative; alarm wakes at the earliest lease boundary, and every request checks current state |
| Worker readiness | Parallel watchdog heartbeat newer than 3 seconds; Power newer than 30 seconds | Node retains those checks. Cloudflare prepares on demand and renews its own readiness marker; no idle heartbeat loop |
| Cleanup | Power `sweepExpiredSessions`/`stopSession`; Parallel command outbox | Same cleanup policy using REST command execution; Power cleanup preserves both original call legs |
| Orphan activation/recovery | Persistent loop rescans sessions | Alarm armed before external effects, control-object rescue after prepare, plus a five-minute Cron safety scan |
| Bounded calls | Provider ring/call timeouts, operator leg 1800 seconds, budgets and reservation limits | Unchanged provider bounds; status reconciliation for missed events and the expired parked operator |

Inspected the watchdog, dispatch/worker/webhook/readiness/policy/service modules, all `lib/telnyx` call-control paths, session APIs/SSE, voice handler/signature/event processor, dialer controls, queue/history integration, environment schema, package scripts, all three dialer migrations and the dialer documentation. The old upgrade document includes historical status; the current runbook supersedes its persistent-hosting instructions.

The third migration `202611140001_single_operator_collisions.sql` is present. The fourth migration is additive, preserves attempt IDs and CRM foreign keys, and leaves the original scheduling/winner function signatures intact. It changes readiness checks through validated function-definition replacements; unexpected source definitions abort the transaction rather than silently removing gates. It adds backend ownership, fencing, execution/recovery RPCs, exact raw webhook storage and timing metadata. Apply it last; rerunning an earlier migration afterward can restore an old function definition, so rerun the fourth migration last in that case.

## Routing decision

Selected B: Telnyx → existing signed Vercel webhook → authenticated Cloudflare session DO → Supabase/Telnyx directly. This keeps the global provider webhook, Manual/Power behavior, recording consent/start/storage and transcripts on the existing Vercel paths. The exact original raw body and provider signature are forwarded. Cloudflare independently verifies Ed25519 after HMAC verification, and SQL processes the same durable event identity. There is no Cloudflare → Vercel → Cloudflare round trip on the bridge-command path. Audio continues between the browser softphone and Telnyx.

Option A, a dedicated Parallel Application webhook directly to Cloudflare, removes Vercel ingress latency but also requires dedicated handling of recording/transcript callbacks and a separate provider rollout. It is not enabled by this implementation. Do not point Telnyx at `/internal/*`; these endpoints require Vercel HMAC authentication. A future direct ingress needs separate verification and fingerprint evidence.

`SessionCoordinator` is a SQLite-backed Durable Object per session, plus a small control object. The ordinary Worker only routes requests. SQL nonce records protect provider/control envelopes; frequent wake messages are idempotent SQL ticks with no browser lease renewal or user command. Their nonce cache is in memory: a replay after eviction can repeat a tick but cannot reclaim an executed dial or extend the browser lease. PostgreSQL event IDs provide durable event deduplication. Closed session objects call `deleteAlarm` and `deleteAll`; the schema is recreated if a fresh authenticated late request reaches the same object.

A single earliest-deadline alarm handles all pending deadlines. Earlier alarms are retained when a newer heartbeat moves a deadline later, allowing an occasional redundant wake rather than losing a deadline during interleaving requests. There are no recurring idle one-second timers. Failed alarms back off to five minutes and continue beyond the platform's six automatic retries; backend retirement removes their alarms. A Cron scan repairs missed activation and exhausted/lost recovery signals. Provider time limits still bound calls during a platform outage. Unknown provider identities and uncertain dials require evidence, not a replacement dial.

## Execution ownership and rollback

`dialer_orchestration_config` is the database authority. Sessions bind immutably to the backend selected at creation. New Vercel code checks that its environment matches the database. Both the Node consumer and Cloudflare RPCs are fenced. Backend changes acquire the existing operator advisory lock and reject active sessions, unended calls, pending/executing/uncertain outbox commands and uncertain legacy provider commands. An execution claim also prevents backend switching while provider HTTP is in flight. The executor performs a final PostgreSQL authorization check immediately before provider dispatch.

A rejected bridge queues cleanup; an uncertain bridge response preserves the possibly connected winner and blocks new dialing. No timeout is treated as evidence that a call did not happen. Completed sessions do not reopen on delayed operator events after cutover/rollback.

## Runtime/SDK findings

Wrangler 4.162.0 and Workers APIs were verified locally. The current Cloudflare test integration is `@cloudflare/vitest-plugin` 1.8.2; the older pool package is deprecated and was removed. The `telnyx@6.41.0` offline probe fails a browser/workerd bundle because `lib/webhooks.mjs` dynamically imports the Node `crypto` builtin. This does not establish incompatibility under every Node compatibility flag. The production Worker imports no Telnyx SDK or Node compatibility layer; the small typed fetch adapter uses the existing dial/bridge/hangup/status payloads. The probe uses a mocked fetch and never calls a number.

## Configuration audit

The current local `SUPABASE_URL` and `SQUARE_WEBHOOK_NOTIFICATION_URL` values fail URL validation. Their values were not printed. Expected formats:

- `SUPABASE_URL=https://<project-ref>.supabase.co` — the project's API URL, not its PostgreSQL connection string or dashboard URL.
- `SQUARE_WEBHOOK_NOTIFICATION_URL=https://<public-app-domain>/api/webhooks/square` — exactly the public notification URL registered in Square. If Square is unused, omit this optional variable instead of assigning an empty string.

The build was checked using valid temporary URL overrides; `.env.local` was not rewritten. Read-only Telnyx preflight stops at missing `TELNYX_TELEPHONY_CREDENTIAL_ID`. Therefore the live application's webhook, profile, channel limits and media route were not verified. No production account settings were changed.

## Latency and location

Instrumentation includes provider `occurred_at`, Vercel receipt/signature completion, Cloudflare ingress and authentication, committed RPC response/winner markers, bridge-command send, provider bridge confirmation, and authenticated browser media-playing telemetry. Raw events/timing are in `workstation_telnyx_webhook_events`; command/audit records remain in Supabase; Worker logs correlate session/attempt/command IDs without API keys or phone numbers.

Browser media-playing is an availability indicator, not proof that human speech is audible. Clock-calibrated controlled media measurements must establish first-word preservation and actual answer-to-audio p50/p95/maximum. `scripts/latency-report.mjs` summarizes supplied correlated measurements; it cannot certify them. The 1500 ms maximum remains an acceptance target and a Cloudflare evidence gate. No live latency was measured here.

No Durable Object location hint is configured: there are no real North American latency measurements yet. Compare east/west North America against the actual Supabase region and Telnyx media/API path in staging before introducing an `enam`/`wnam` hint. Hints apply at object creation, are best-effort, and do not guarantee placement or latency.

## Changed and added files

```text
.env.example
README.md
app/(protected)/queue/page.tsx
app/api/calls/[id]/route.ts
app/api/dial-sessions/[id]/telemetry/route.ts
app/api/leads/[id]/outcome/route.ts
app/api/webhooks/telnyx/voice/route.ts
cloudflare/portive-dialer/.gitignore
cloudflare/portive-dialer/.npmrc
cloudflare/portive-dialer/README.md
cloudflare/portive-dialer/dev-vars.template
cloudflare/portive-dialer/package-lock.json
cloudflare/portive-dialer/package.json
cloudflare/portive-dialer/scripts/latency-report.mjs
cloudflare/portive-dialer/scripts/probe-sdk.mjs
cloudflare/portive-dialer/src/adapters.ts
cloudflare/portive-dialer/src/executor.ts
cloudflare/portive-dialer/src/index.ts
cloudflare/portive-dialer/src/types.ts
cloudflare/portive-dialer/test/runtime.test.ts
cloudflare/portive-dialer/tsconfig.json
cloudflare/portive-dialer/vitest.config.ts
cloudflare/portive-dialer/wrangler.jsonc
docs/CLOUDFLARE-DIALER-AUDIT.md
docs/CLOUDFLARE-DIALER-VERIFICATION.md
docs/CLOUDFLARE-DIALER.md
docs/DIALER-UPGRADE.md
docs/PARALLEL-DIALER.md
docs/READINESS-STATUS.md
lib/dialer/internal-auth.ts
lib/dialer/orchestration.ts
lib/dialer/parallel-policy.ts
lib/dialer/parallel-readiness.ts
lib/dialer/parallel-webhooks.ts
lib/dialer/parallel-worker.ts
lib/dialer/service.ts
lib/env.ts
lib/telnyx/webhook-processor.ts
package.json
scripts/dialer-watchdog.ts
scripts/parallel-provider-check.ts
supabase/migrations/202611140002_cloudflare_orchestration.sql
tests/dialer/cloudflare.test.ts
tests/dialer/database.integration.ts
tests/dialer/parallel.integration.ts
tsconfig.json
```

# Cloudflare migration verification

This report distinguishes local implementation tests from live provider/media verification. No production deployment, provider setting change, or real telephone call was made. Tests use synthetic IDs and controlled external fetch fixtures; SQL tests run real PostgreSQL transactions in a disposable local container.

## Coverage mapping

| Required behavior | Evidence |
|---|---|
| Four simultaneous calls | Workerd adapter concurrency test; PostgreSQL four-command reservation/claim test |
| First human and atomic operator claim | Existing SQL concurrency suite plus Cloudflare event RPC returning one bridge |
| Voicemail exclusion | Existing DB AMD tests; runtime machine hangup adapter test |
| Near-simultaneous answers | Concurrent PostgreSQL event transactions, one bridge and one collision command |
| Cancel other ringing calls | PostgreSQL `canceled_after_winner` assertions, per-attempt hangup commands |
| Recycle canceled leads / priorities | Future-session DB test, same-session target exclusion, existing queue unit tests |
| Duplicate and out-of-order events | Existing and Cloudflare SQL idempotency tests; exact raw/signature runtime tests |
| Worker restart | Actual local DO eviction retaining session and alarm; stale-command SQL recovery |
| Alarms and retries | Workerd alarm invocation, outage backoff, one earliest deadline, closed-object cleanup |
| Missed deadline recovery | DB classification deadline, read-only terminal reconciliation, bounded operator reconciliation |
| Browser disconnect | Existing lease-expiry DB tests with the fourth migration installed |
| Bridge rejection / ambiguous ACK | Runtime rejected API adapter; SQL cleanup on rejection and winner preservation on timeout |
| Provider timeout | Mocked timeout sends one dial and persists failure; no automatic replacement dial |
| Supabase outage | Runtime 503 failure and retained/rearmed alarm |
| Cloudflare quotas | Local quota-like 429 injection; real account quota exhaustion remains untested |
| Realtime recovery | Existing browser fixture checks and durable snapshot recovery; no new SSE transport |
| Notes / callbacks / outcomes | Existing DB lead/attempt consistency and transactional wrap-up tests; browser matching-lead writes |
| Manual / Power | Existing DB regression and workspace browser tests, plus Worker Power two-leg cleanup |
| Production Next.js build | Compiles with valid temporary URL overrides; original local URL values remain invalid |
| Wrangler compatibility | Staging dry-run bundle; Workers typecheck; workerd runtime suite |
| Secret protection | HMAC path/body/time tests, original provider signature validation, server-only Vercel module and client bundle scan |
| Rollback | DB prevents switching with active/uncertain work; Node consumer fence; retired backend alarm cancellation |
| Live answer-to-audio latency | Unverified; stages instrumented, report requires real Cloudflare measurements |
| Direct Cloudflare Telnyx ingress | Not selected; Vercel forwarding preserves existing webhook and recording behavior |

## Results

| Check | Result |
|---|---|
| Dialer/queue/HMAC/evidence unit suite | 30 / 30 passed |
| PostgreSQL integration, existing and Cloudflare cases | 70 / 70 passed |
| Final rollback metadata regression plus migration | 2 / 2 passed in focused rerun |
| Cloudflare workerd/SQLite/alarm/eviction runtime suite | 28 / 28 passed |
| Existing workspace and Parallel browser fixtures | Both passed; zero browser errors and no real telephony |
| Next.js TypeScript and production build | Passed with the documented temporary URL overrides |
| Worker TypeScript | Passed |
| Wrangler staging and production dry-run bundles | Both passed; approximately 20 KiB uncompressed |
| Client bundle secret scan | No orchestration secret identifier or fixture secret values found |
| Full application unit suite | 132 tests: 114 passed, 18 existing unrelated failures |
| Offline Telnyx SDK probe | Incompatible with this no-Node-compatibility bundle; typed REST adapter used |

These checks are local artifacts, not deployed Cloudflare quota/CPU measurements or live provider certification. The root full application suite still has the previously documented 18 failures in demo extraction, ElevenLabs and payment tests. The migration does not change those features. Its additional HMAC/evidence tests pass; the broader suite is not represented as entirely green.

The production build was run with `SUPABASE_URL=https://build-fixture.supabase.co` and `SQUARE_WEBHOOK_NOTIFICATION_URL=https://portive.example/api/webhooks/square` as temporary overrides. This verifies bundling/schema compatibility, not connectivity to those placeholder services.

The Telnyx SDK offline probe fails bundling without Node compatibility because of its dynamic Node `crypto` import. Production uses the typed REST adapter; the SDK is retained only as a development probe dependency in the isolated project. No real outbound request is issued by the probe.

## Outstanding acceptance

Supply working provider/WebRTC credentials, valid deployment URLs, separate staging/prod Supabase and Worker secrets, deploy with approval, and collect real controlled provider/media evidence. Verify Cloudflare account CPU/duration/SQLite usage under the actual workload, callback replay during outages, actual recording delivery, microphone/speaker routing and first-word preservation. The 1500 ms target has no measured live result here. A Free-plan estimate is not a latency or availability guarantee.

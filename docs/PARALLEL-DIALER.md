# Portive Parallel Dialer

## Current delivery

The previous hard-coded rejection has been replaced by a real Telnyx Call Control adapter, durable PostgreSQL batch engine and four-line interface. Parallel eligibility is now determined by provider configuration and controlled verification evidence. The feature flag alone cannot release live dialing.

**This checkout is not live-verified.** It has no `.env.local`, Telnyx credentials, staffed overflow destination, approved failure audio or controlled provider report. No real telephone calls were made. Live Parallel Mode remains unavailable until those specific prerequisites are satisfied. Existing Manual and Power workflows remain in the application.

## Implemented architecture

1. Start/Resume checks the Telnyx Voice API application, its outbound profile and explicit channel limits, WebRTC SIP credential, public webhook URL, USD available credit and a current controlled-verification report.
2. One provider-originated SIP leg reaches the existing browser softphone. Prospect calls cannot launch until provider answer and matching browser remote-audio acknowledgement are both present.
3. PostgreSQL atomically reserves up to four eligible leads and writes separate durable dial commands. The worker invokes independent provider requests concurrently; it does not wait for one dial response before sending the next.
4. Premium AMD results remain separate from carrier answer. Carrier answer alone cannot win. The first confirmed human atomically claims `active_call_id`; exactly one bridge command can be queued for that attempt.
5. The winning prospect is bridged to the parked operator leg. The operator leg is parked after unbridge, so it can serve the next batch without opening four microphone streams. Browser audio is kept separate from prospect selection and ordinary progress PATCHes.
6. Other ringing attempts receive their own hangup commands and retain `canceled_after_winner`. A carrier answer observed before cancellation is routed to live overflow. Confirmed additional humans are recorded as collisions. Late answer evidence on a canceled leg is audited and suspends the session.
7. Unknown classification routes to staffed overflow immediately; missing AMD is subject to a one-second server deadline. This is an explicit fallback, not a promise that AMD is instantaneous or perfect. Controlled evidence must demonstrate answer-to-audio timing within 1500ms.
8. An overflow-transfer failure does not falsely mark the original caller ended. It queues the configured, independently verified short technical-failure explanation, then original-leg cleanup after playback or a bounded cleanup deadline. Such failures are audited and suspend new dialing. No sales message or voicemail drop was added.
9. Normal Pause and Stop cancel the other attempts while preserving the winning human conversation. Media loss routes the conversation to overflow. A Realtime transport failure pauses scheduling while preserving healthy operator audio.
10. A completed primary conversation holds for saved notes/disposition. Callback creation and wrap-up remain transactional. Auto-continue can be disabled; Continue then releases the next batch. Batch delay, attempt limit, bounded call duration and a reserved spend ceiling are enforced on the server.

The worker uses separate scheduler and command-execution loops. Slow provider requests cannot block the classification-deadline scheduler. Commands are claimed with `FOR UPDATE SKIP LOCKED`; an uncertain provider acknowledgement is never treated as permission to redial.

## Workspace and data

- Four individual cards show business, number, list, technical state, classification, elapsed time, outcome and overflow state. Only a confirmed bridge shows CONNECTED.
- Supabase Realtime feeds a server-side SSE endpoint; no service-role credential is exposed to the browser. A reconnect fetches the current durable snapshot.
- The winner opens the existing lead workspace. Notes, callback requests and dispositions use its stable attempt/lead IDs. Manager/owner information remains available through existing free-text notes and the Manager callback pending action.
- Keypad digits travel on the single parked operator call. Ending the prospect does not tear down that operator call.
- Recording is consent/settings gated and targets the winning prospect leg. It does not continue recording the parked operator into the next lead's conversation.
- Non-winners canceled by a winner retain future-session queue priority, and cannot be redialed within the same session. Suppression, future callbacks, invalid destinations, known-business concurrency and local-time eligibility remain enforced.
- Call History keeps independent attempt IDs and existing filters, with parallel session/batch metadata and separate technical/sales labels.
- Metrics distinguish dials, primary human connections, voicemail, no-answer, cancellations, collisions, completed conversations, callbacks and demo requests. Confirmed demo bookings and provider billing remain unavailable rather than inferred. Reserved spend is not presented as an actual provider invoice.

Continuous refill is deliberately not enabled; this delivery implements batch mode. The UI and API explicitly retain `autoRefill=false`.

## Installation

Apply both additive migrations in order:

```text
supabase/migrations/202611130001_dial_sessions.sql
supabase/migrations/202611130002_parallel_engine.sql
```

The second migration adds the provider-verification record, command outbox, operator/batch state, overflow/cleanup state and Realtime publication membership. It extends the existing integrity rules instead of replacing attempt IDs, sales outcomes or related notes/callback records. This workstation still has one authenticated operator identity; it has not been converted into a multi-tenant product.

Configure the existing admin, Supabase and Telnyx variables, plus:

```env
TELNYX_PARALLEL_CONNECTION_ID=<Voice API application ID>
DIALER_PARALLEL_ENABLED=false
DIALER_OVERFLOW_DESTINATION=<separately staffed SIP URI or E.164 number>
DIALER_FAILURE_AUDIO_URL=<HTTPS URL of the approved short technical-failure explanation>
DIALER_WATCHDOG_SECRET=<at least 32 random characters>
DIALER_INTERNAL_URL=http://127.0.0.1:3000
```

An existing Manual SIP/FQDN connection does not need to be replaced. `TELNYX_PARALLEL_CONNECTION_ID` selects the Voice API application independently. Its webhook must match this deployment's voice webhook. Signature bypass must be disabled.

```bash
npm ci
npm run build
npm start
# Separate supervised process, same .env.local:
npm run dialer:watchdog
```

The worker is required for parallel dispatch and deadlines. Use a persistent Node deployment and a proxy that supports SSE without buffering. Enable Supabase Realtime for `dial_sessions` and `call_attempts`; the migration adds them to the standard publication when it exists.

## Provider verification and release

```bash
# Read-only provider configuration inspection. Does not place calls:
npm run parallel:check

# Install evidence collected in the authorized controlled telephony environment:
npm run parallel:check -- --report /absolute/path/controlled-report.json
```

The report must use suite `portive-parallel-v1`, match the printed configuration fingerprint and live profile ID, have been collected within the past 24 hours, and contain real controlled call IDs. It must record every scenario listed in `lib/dialer/parallel-policy.ts`, measured audio latency, nine-leg peak capacity including transfers, three staffed overflow slots, an all-inclusive rate ceiling, and the failure audio's SHA-256 and duration of at most five seconds. The tool verifies current provider limits and audio content before storing a seven-day verification record.

The import tool does **not** execute or certify live tests by itself. A controlled provider/media test run and its evidence are still required; no passing live report was manufactured or installed here. Use a separate authorized test environment and controlled recipient numbers. The automated suites in this repository use mocks and a disposable database; they cannot establish real carrier/media behavior.

After the real controlled run passes and its report is installed, set `DIALER_PARALLEL_ENABLED=true`. Start/Resume checks the actual provider again. The server also binds the report to caller ID, application, SIP credential, webhook, overflow destination and failure audio configuration. Missing/expired evidence, changed configuration, insufficient channels/credit, unavailable Realtime or a failed asset check produces a specific blocker in the UI.

## Verification already completed during implementation

- Parallel PostgreSQL suite: **31 tests passed**. This covers independent reservations, simultaneous human claims, one bridge, voicemail exclusion, unknown deadlines, collisions, failure explanation/cleanup, Stop/Pause semantics, delayed events, media acknowledgement, budgets, callbacks, ownership and Realtime-failure policy.
- Existing Power/manual database suite against both migrations: **25 tests passed**.
- Dialer/queue unit suite: **25 tests passed**, including concurrent invocation of four held provider requests and readiness-report validation.
- Both controlled Chromium UI suites passed. The Parallel UI suite checks four streamed cards, winner selection, correct lead notes/callback IDs and Stop preserving the prospect. These are browser fixtures, not real telephone tests.
- Production build and TypeScript passed during this implementation. Full lint retains the original **1 error and 5 warnings**; changed dialer code has no new lint errors.
- Full suite: **127 tests, 109 passed, 18 failed**. A clean archive of the original commit reproduced **105 tests, 87 passed, the same 18 failures**, in the existing demo-agent/ElevenLabs/payment area.

No further test runs were initiated after the user's request to stop extended testing. Live microphone/speaker routing, first-word preservation, actual concurrent carrier ringing, overflow staffing and provider billing are **not verified**. No production migration or deployment was performed.

## Main files added in this extension

```text
supabase/migrations/202611130002_parallel_engine.sql
lib/dialer/parallel-policy.ts
lib/dialer/parallel-fingerprint.ts
lib/dialer/parallel-readiness.ts
lib/dialer/parallel-dispatch.ts
lib/dialer/parallel-worker.ts
lib/dialer/parallel-webhooks.ts
app/api/dial-sessions/[id]/events/route.ts
components/dialer/parallel-lines.tsx
scripts/parallel-provider-check.ts
tests/dialer/parallel.test.ts
tests/dialer/parallel.integration.ts
tests/dialer/parallel.browser.mjs
```

Existing session APIs/controls, workspace, watchdog, history, queue ordering, call recording and tests were extended to use them. Existing Power delivery details remain in `DIALER-UPGRADE.md`.

Provider references used for the adapter: [AMD](https://developers.telnyx.com/docs/voice/programmable-voice/answering-machine-detection), [channel limits](https://developers.telnyx.com/docs/voice/sip-trunking/configuration/concurrent-limits), and the installed official Telnyx SDK definitions for Dial, Bridge, Transfer, Playback and Balance. No further broad legal research was performed.

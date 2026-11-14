# Portive dialer upgrade — implementation and verification

Current serverless orchestration and deployment instructions: [Cloudflare Dialer](CLOUDFLARE-DIALER.md). The persistent Node watchdog remains available as a fenced rollback backend.

The Parallel implementation has since been extended. See [PARALLEL-DIALER.md](PARALLEL-DIALER.md) for current behavior and readiness gates. The original Parallel status and test counts below describe the earlier delivery.

## 1. Architecture discovered

- Next.js 16.2.3 App Router, React 19.2.4, TypeScript, Tailwind/Radix components; client state uses React hooks.
- The calling workspace is `app/(protected)/queue/page.tsx`. It retains its lead list, central calling panel and right notepad/keypad/recording/callback/SMS panel.
- Supabase Postgres is accessed with the service role through `lib/workstation-db.ts`, a Prisma-shaped adapter. This is not a Prisma deployment.
- Authentication is one shared `operator`, using an encrypted HTTP-only cookie derived from `ADMIN_PASSWORD`, with same-origin checks for mutations. There is no independent user/tenant identity in this workstation. New orchestration is intentionally restricted to that existing single operator, with a browser controller UUID and a global database lock; it must not be presented as multi-tenant software.
- The provider is Telnyx: `@telnyx/webrtc` in the browser, the `telnyx` Node SDK on the server. Default `TELNYX_MANUAL_DIAL_FLOW=browser_first` uses `client.newCall()` directly to the prospect, with one microphone/remote stream. Optional `pstn_first` dials a lead using Call Control, then a browser SIP credential and bridge. The README's old description did not match the default implementation.
- Microphone permission is checked with `getUserMedia`; the SDK manages the actual media. The remote stream is attached to `telnyx-remote-audio`. DTMF uses `sendDigits` with `dtmf` fallback. Page hide/unmount disconnects the client and hangs up its local call.
- The existing queue puts uncalled leads newest first, then previously called leads by oldest last call. The upgrade keeps that settled ordering and holds live/undispositioned conversations in place. Selection uses IDs, not row indexes.
- CSV imports create lists and leads, preserving location/city/state/niche/custom fields. Remove Lead hides a lead in custom fields and preserves history. Notes live on the lead and, when explicitly saved, in `lead_notes`. Sales dispositions and callbacks remain on the original `call_attempts` IDs; scheduled callbacks use `follow_ups`.
- Signed voice webhooks persist in `workstation_telnyx_webhook_events`; recordings/transcripts remain in their existing related tables. The default browser path does not explicitly request AMD. Existing PSTN-first calls request `detect_beep`.
- Deployment is a standard Next.js Node deployment; there is no repository-native CRM Docker/worker deployment. Separate Hetzner demo-agent instructions concern the inbound demo agent, not this browser calling path. That demo/Square/ElevenLabs architecture was not replaced.

## 2. Audit and protected state

The initial `git status --short` was clean at commit `763cad1`. No user edits were stashed, reset or overwritten. Dependencies were absent and installed with `npm ci`. The installed Next.js route-handler and server/client-component guides were read before implementation.

Inspected the full tracked-file inventory and, in detail:

- `AGENTS.md`, `package.json`, lockfile metadata, `tsconfig.json`, `next.config.ts`, `README.md`, `.env.example`, `Hetzner Deploy Commands.md`.
- `app/(protected)/{queue,history}/page.tsx`, `history/[id]/page.tsx`, protected layout, authentication routes and `lib/{auth,api-auth,http,env,settings,phone,db-types,supabase-admin,workstation-db,lead-queue}.ts`.
- Lead list/detail/call/outcome/notes/follow-up/import API routes, call list/detail/PATCH routes, settings, WebRTC-token and voice-webhook routes.
- All `lib/telnyx/` call-flow, client, event, client-state, signature and webhook-processor files.
- Baseline workstation and location migrations; remaining migration inventory and existing test inventory. Queue tests, representative API/domain tests and the six failing test files were examined/run.
- Installed Telnyx SDK definitions and tone-element implementation, plus official provider/regulatory sources below. No provider secrets were printed.

## 3. Fixed canceled-conversation bug

`hangupOutboundCall()` reports `status: canceled` when an operator presses Hang Up. The PATCH route previously wrote that status and an end timestamp even after answer. The hangup webhook then returned early for an already-ended terminal attempt. Thus a real receptionist conversation could remain canceled permanently.

The API now resolves answered hangups to completed. A database trigger protects all writers against the same race, including late answer evidence and stale ringing events. The migration repairs existing canceled records with a non-null `answered_at`; it does not invent answer evidence or change historical notes/outcomes. Technical lifecycle, AMD classification and sales disposition are stored separately.

## 4. Implemented functionality

- Compact Manual/Power/Parallel selector inside the existing workspace. Manual remains on the existing initiation/audio path.
- Power sessions with durable per-attempt queue reservation, one operator-wide active attempt, a 100-attempt default budget (API configurable 1–500), one number/lead per session, browser ownership, start/pause/resume/stop/skip and after-call Save Disposition and Continue.
- PostgreSQL advisory and row locks select the next lead and create its attempt atomically. Only the first dispatch response grants permission to originate that attempt; refresh/repeated requests never re-originate an existing claim. A lost dispatch response requires recovery, not a retry call.
- New dialing requires the connected browser and microphone, a live watchdog, signed webhooks, a reviewed list, a list timezone and eligible numbers. List timezone is an explicit operator choice; an individual `customFieldsJson.timeZone` overrides it. The built-in window is 09:00–20:00 local. Unknown/invalid timezones are excluded. This is not a complete state-law rules engine.
- Suppressed, bad-number, closed-lost and hidden leads, future callbacks, repeated numbers and invalid NANP formats are excluded from Power. The Do Not Call button persists a number-wide suppression across lists/sessions; new manual attempts also check suppression in the database.
- Answered/unknown calls wait for saved disposition or explicit skip; positive provider voicemail evidence permits advancement only when it has not interrupted an established operator conversation. All existing sales outcomes remain supported. Manager callback pending saves `gatekeeper` plus `next_action=manager_callback_pending`; it never creates a demo booking.
- Call polling updates the original attempt in place. Notes survive provider polling and queue refresh, and are saved before a manual lead switch/skip or automated advancement. Notes and follow-up APIs/database triggers reject attempt/lead mismatches. History prefers attempt notes over later persistent lead notes, while retaining a legacy fallback.
- Browser progress writes keep browser/PSTN call-control IDs on the proper leg in each manual flow. New database columns expose technical state, termination reason, answer classification and bridge evidence. History retains date/outcome/list/niche/search filters and adds the existing Already Have System outcome to its filter menu.
- Duplicate webhook processing is claimed durably and serialized per attempt. Unsuccessful processing returns a retryable response. Unsigned payloads cannot occupy a valid event ID. Terminal attempts cannot reopen from delayed ringing/bridge/AMD events; late answer evidence can repair an earlier cancellation.
- A durable Call Control command ledger protects outbound dial, browser dial, bridge and recording commands beyond the provider's finite deduplication window. Uncertain commands are held for reconciliation rather than automatically repeated.
- Recording now requires the existing enable-recording setting, per-attempt operator consent confirmation and an established operator audio bridge. Existing recordings stay accessible. The consent control is an attestation; it does not automatically speak a consent announcement.
- Optional silent **local** ringback changes only the SDK's `_ringback` audio element. Remote audio, microphone gain/tracks, speaker volume and device routing are untouched. Carrier early media remains audible; suppressing it without risking first-word loss was not implemented.

## 5. Migration and deployment

Apply `supabase/migrations/202611130001_dial_sessions.sql` once, after the existing workstation/location migrations, before deploying this code. It adds:

- `dial_sessions`, `dial_session_targets`, `dial_suppressions`, `dial_audit_events`, `dial_provider_commands`.
- Additive attempt fields for session ID, classification, technical state, termination reason, bridge/abandonment evidence, disposition-save and recording-consent timestamps.
- Webhook processing claim fields, the session-command/event-claim/transactional-disposition functions, and integrity/audit/foreign-key-consistency triggers.
- RLS/role restrictions on the new tables/functions and an evidence-based canceled-to-completed backfill.

The migration does not renumber attempts or remove lead lists, notes, callbacks, recordings or sales dispositions. Back up production first as part of the normal database release procedure. No migration was applied to a live database during this task.

Before rollout, reconcile any historical unended dialing/connected attempts with provider evidence. The new single-operator guard deliberately will not dial over a possibly active old call. A lost browser dispatch acknowledgement or provider identity can require manual reconciliation; it is never silently redialed. Callback wrap-up is transactional, including its disposition marker and notes, so a failed callback save cannot release the next lead.

Configure `.env.local` using `.env.example`: existing Supabase, admin, public webhook URL and Telnyx credentials, plus `TELNYX_PUBLIC_KEY`, `TELNYX_MANUAL_DIAL_FLOW=browser_first`, `DIALER_POWER_ENABLED=true`, `DIALER_PARALLEL_ENABLED=false`, and a random `DIALER_WATCHDOG_SECRET` of at least 32 characters. Disable signature bypass. Keep `DIALER_INTERNAL_URL` aligned with the local app port.

```bash
npm ci
npm run dev
# Second supervised terminal/process, using the same .env.local:
npm run dialer:watchdog

# Production:
npm run build
npm start
# Run npm run dialer:watchdog alongside the production server, with automatic restart.
```

The watchdog calls the authenticated internal sweep endpoint every five seconds. Its recent database heartbeat is required before starting/advancing sessions. A browser lease expires after 45 seconds. No webhook/watchdog launches new calls; they can only suspend/resolve activity. Stop waits for terminal provider evidence before releasing the reservation. An uncertain provider identity/hangup leaves the session unsafe and blocks new dialing. Restore provider events and use Stop Session again after confirming termination; do not clear safety rows to force a new call.

## 6. Parallel status and remaining technical work

**Superseded status note:** the next migration, `202611140001_single_operator_collisions.sql`, implements automatic hangup and classification of a second answered call without requiring overflow staffing. Four-line dispatch, atomic winner selection and a single parked operator leg are implemented. Real Telnyx collision timing, media, and carrier behavior still require controlled provider verification before production use.

The user's legal approval was accepted as supplied. The remaining release blockers are technical and campaign operational requirements:

1. Verify this account's Call Control application/connection, SIP credential routing, channel limits, calling permissions, caller ID and AMD support.
2. Implement and prove a persistent, ready operator media leg with server-side bridging and atomic winner selection. The current browser-originated direct call is not such a bridge.
3. Supply and test an approved additional-live-human handling path; one operator cannot personally converse with two simultaneous human answers. No such destination or additional operator exists in this repository.
4. Implement/test true multi-attempt dispatch, atomic human-winner/bridge claims, per-business concurrent reservations, collision/abandonment telemetry and safe suspension. These are unfinished, not hidden behind a claim of readiness.
5. Run controlled provider tests for near-simultaneous answers, uncertain/late AMD, bridge timing, cancellation races, channel failures, disconnects and all legs' accurate terminal evidence. No live credentials or controlled recipient numbers were available here.

## 7. Provider/compliance references checked

- Telnyx explicitly documents duplicate, unordered and simultaneous webhooks, and a 60-second `command_id` deduplication window. This motivated the database claims and durable command ledger. [Receiving webhooks](https://developers.telnyx.com/docs/voice/programmable-voice/receiving-webhooks)
- Carrier answer precedes classification; standard AMD can return `not_sure`, and premium AMD has additional uncertain/silence/fax results. Unknown is preserved; no silent classification wait was added to browser audio. [AMD](https://developers.telnyx.com/docs/voice/programmable-voice/answering-machine-detection)
- DPS and concurrent-channel limits are different; actual account limits must be checked independently. No four-line capacity was inferred from a published default. [DPS](https://developers.telnyx.com/docs/voice/programmable-voice/dials-per-second-limit), [L1 restrictions](https://developers.telnyx.com/docs/voice/programmable-voice/l1-accounts-restirctions)
- Pricing has separate Voice API, SIP, browser and optional AMD/recording components. The attempt budget is not a dollar cap; verify account spend limits and destination rates before use. [Current provider rate card](https://telnyx.com/pricing/voice-api)
- FCC rules include restrictions involving cellular/emergency numbers and dialing technology, multiple lines of one business, minimum unanswered ringing duration, and live-agent connection/abandonment conditions. Applicability to the approved campaign depends on its facts; no blanket B2B exemption or abandonment allowance was used to enable parallel dialing. [47 CFR 64.1200](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200)
- The FTC describes B2B DNC exemptions and entity-specific suppression requirements; its guidance also says state law is not preempted. Campaign review must distinguish verified business landlines from mobile/personal numbers and maintain applicable registry screening, state restrictions and local hours. The app does not download the National DNC Registry or look up line type automatically. [DNC guidance](https://www.ftc.gov/business-guidance/resources/qa-telemarketers-sellers-about-dnc-provisions-tsr-0), [TSR compliance](https://www.ftc.gov/business-guidance/resources/complying-telemarketing-sales-rule)
- Recording consent varies with jurisdiction; the implementation now fails closed without explicit per-attempt confirmation. Florida's statute is one example requiring applicable consent review. No exhaustive 50-state recording/telemarketing analysis is claimed. [Florida 934.03](https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0900-0999/0934/Sections/0934.03.html)

No AI voice, prerecorded sales audio or voicemail-drop functionality was introduced.

## 8. Verification and baseline failures

See the final verification results appended below. Tests never use production credentials or call real leads.

Baseline: `npm test` originally discovered 12 nested test files: 7 passed and 5 failed. `npx tsc --noEmit` passed. `npm run lint` reported one existing error in `components/theme-toggle.tsx` and five existing warnings. The original test glob omitted root tests. After fixing discovery, a clean archive of original commit `763cad1` reproduced 16 files with 10 passing and 6 failing. The sixth pre-existing failure is the root paid-appointment-pricing test. No unrelated demo-agent/payment fixes were mixed into this change.

The six baseline failing files are `tests/demo-agent/profile-pipeline.test.ts`, `tests/elevenlabs/conversation-initiation.test.ts`, `tests/elevenlabs/create-appointment-request.test.ts`, `tests/elevenlabs/post-call-webhook.test.ts`, `tests/elevenlabs/resolve-demo-context.test.ts` and `tests/paid-appointment-pricing.test.ts`. The last also encounters the existing `server-only` import under plain Node. These failures were reproduced from the original commit with the same installed lockfile dependencies.

Repeatable commands:

```bash
npm run test:dialer
npm test
npx tsc --noEmit
npm run lint
npm run build

# Disposable PostgreSQL test environment (requires Docker):
docker run --name portive-dialer-test-20261113 --rm -d -e POSTGRES_PASSWORD=portive-test-only postgres:16-alpine
docker exec portive-dialer-test-20261113 psql -U postgres -c 'create role anon; create role authenticated; create role service_role;'
npm run test:dialer:db
docker stop portive-dialer-test-20261113

# Controlled UI test, against a separate local build with test-only auth:
ADMIN_PASSWORD=portive-local-test-only npm start -- --hostname 127.0.0.1 --port 3210
node tests/dialer/workspace.browser.mjs
```

The browser test fixtures replace CRM AJAX responses and never invoke Telnyx. It does not verify WebRTC media transport or a real outbound conversation.

## 9. Short live verification checklist

Use only controlled, consenting test endpoints after applying the migration/configuration:

1. Connect softphone; confirm mic permission, remote speaker routing, DTMF, hangup and reconnect in Manual Mode. Confirm consent/settings control recording and old recordings still play.
2. On a reviewed timezone-specific test list, start Power. Let a destination ring out; confirm one attempt, its no-answer evidence and automatic next selection. Test busy/failure similarly.
3. Answer the next test call. Confirm first words, correct lead highlight, duration, notes, keypad and callback controls. Hang up and ensure no new call until a disposition is saved or explicitly skipped. Verify receptionist/gatekeeper remains completed/gatekeeper, not canceled/demo booked.
4. Pause/resume during ringing and conversation; Stop Session must prohibit new attempts and retain reservations until provider termination. Refresh/disconnect the browser; check recovery and watchdog audit records, with no repeat dialing.
5. Suppress a number, including a copy under another list; verify it is excluded. Check a future callback, invalid destination and out-of-hours lead. Replay duplicate/late webhooks in a controlled environment.
6. Toggle Silent Ringback; confirm live conversation and microphone audio stay unchanged. Carrier early media may still be heard.
7. On a controlled list, verify Parallel starts four prospect legs plus one operator leg without overflow configuration. Verify second human answers are immediately classified as collisions and disconnected, the first call stays bridged, and canceled leads recycle in a later session.

Live PSTN calling, real recording delivery, carrier early media, real device reconnection and actual human/machine routing remain unverified until these checks run against the configured account.

Final results for this checkout:

| Check | Exact result |
| --- | --- |
| `npm run test:dialer` | 4 test files passed, 0 failed (lifecycle, media, history and existing queue suite) |
| `npm run test:dialer:db` | 25 PostgreSQL integration tests passed, 0 failed; actual migration, concurrent requests, ownership, dispositions/callback rollback, retry claims and release gates tested |
| `node tests/dialer/workspace.browser.mjs` | Passed: real local authentication, unauthorized session/sweep rejection, fixture-backed note refresh/switching, softphone/mic gates, blocked four-line UI, retry availability after mic denial, dark theme, 390px layout, zero outbound requests and zero page errors |
| `npx tsc --noEmit` / build TypeScript | Passed |
| `npm run build` | Passed with Next.js 16.2.3/Turbopack |
| `git diff --check` | Passed |
| `npm test` | 19 files: 13 passed, 6 failed; same six failing baseline files reproduced from the original commit |
| `npm run lint` | Original 1 error and 5 warnings remain; changed-file lint has 0 errors and the 2 pre-existing workspace hook warnings |
| Live Telnyx / real media | Not run; credentials/controlled recipient environment unavailable |

Browser verification found and fixed a stuck softphone loading state after microphone denial and a workspace-header overflow at 390px. The final controlled browser run passed after both fixes. Screenshot: `/tmp/portive-workspace-smoke.png` (local test artifact). No provider/account configuration, live database or deployment was changed. The temporary test server and disposable test database were shut down after verification.

## 10. Changed-file manifest

Existing files modified:

```text
.env.example
README.md
package.json
app/(protected)/queue/page.tsx
app/(protected)/history/page.tsx
app/api/calls/[id]/route.ts
app/api/leads/[id]/outcome/route.ts
app/api/leads/[id]/notes/route.ts
app/api/leads/[id]/followups/route.ts
app/api/webhooks/telnyx/voice/route.ts
lib/env.ts
lib/lead-queue.ts
lib/workstation-db.ts
lib/telnyx/call-flow.ts
lib/telnyx/webhook-processor.ts
tests/lead-queue.test.ts
```

Files added:

```text
app/api/dial-sessions/route.ts
app/api/dial-sessions/sweep/route.ts
app/api/leads/[id]/suppression/route.ts
components/dialer/session-controls.tsx
lib/dialer/types.ts
lib/dialer/service.ts
lib/dialer/media.ts
lib/call-history.ts
lib/telnyx/lifecycle.ts
lib/telnyx/commands.ts
scripts/dialer-watchdog.ts
supabase/migrations/202611130001_dial_sessions.sql
tests/dialer/lifecycle.test.ts
tests/dialer/media.test.ts
tests/dialer/history.test.ts
tests/dialer/database.integration.ts
tests/dialer/workspace.browser.mjs
docs/DIALER-UPGRADE.md
```

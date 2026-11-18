# Parallel queue and daily reservation correction

Production session `948b6c8c-3a2f-4748-ba06-560f3c3f3937` established two real bridges, to Laser Remedy Skin Solutions and Facet Esthetics. The user heard both voicemail greetings and saved dispositions, after which the same parked operator was reused for later batches. Provider answer-to-bridge intervals were approximately 2.16 and 2.30 seconds. Browser telemetry recorded sent and received audio RTP. This proves the previously rejected bridge path is working; an actual human conversation and preservation of opening words remain live validation items.

The session made nine prospect attempts, in batches of four, three and two. It then stopped through the normal funded scheduler; it did not encounter another bridge error. Its 76-cent authorization could not cover another full prospect reservation. The previous message mixed budget exhaustion with eligibility and hid the specific reason.

The account also retained 191 cents of exposure across multiple sessions. The quote subtracted every hold from both available credit and the current day's remaining spending limit. Most of those holds related to calls terminal on the previous UTC day. They must still reserve credit until billing is settled, but they cannot incur new calling usage today. Applying yesterday's entire terminal exposure against today's limit incorrectly reduced authorization to six cents.

Migration `202611180002_parallel_queue_and_daily_exposure.sql` and the matching application changes:

- Report and authorize global credit exposure and UTC daily exposure separately. Open or overlapping calls remain daily exposure. Incomplete billing holds remain held.
- Exclude AMD from the reserve of first-answer requests, which do not request AMD. Legacy policies retain their existing AMD allowance.
- Retain potential collision speech at dispatch. After signed terminal evidence and settled commands, remove that allowance only when no speech command or collision occurred. All per-minute minimums, fixed allowances and observed charges remain reserved. No partial billing scan is declared final.
- Rebound a session's terminal reservations during scheduling, rather than depending on browser quote polling.
- Attempt untouched eligible leads first. An unanswered line canceled because another line won may receive one retry after 60 seconds, only with terminal/provider-command evidence. Retry batches begin after the first pass. Answered calls, no answers, machine classifications, uncertain sends and dispatch denials do not become automatic retries. DNC, callbacks, calling hours and final dispatch checks still apply.
- Preserve all call attempts and outcomes. The unique session target points to the current attempt; a retry audit links to the previous attempt. Attempt limits count every reservation, including retries.
- Keep the parked operator through a retry cooldown. Empty scheduler checks do not inflate the batch counter.
- Explain budget exhaustion, duration exhaustion, retry waiting and queue completion distinctly.
- Resolve late Stop/heartbeat requests by their actual terminal session instead of routing them to the Power handler. Terminal Continue remains rejected and cannot start another call.
- Default new list sessions to 900 seconds while retaining the one-minute per-call maximum and $1 approved ceiling. Conversation presets preserve the session duration; every quote includes its operator reserve. Existing session limits are not changed.
- Display credit reservations and today's reservations independently so a reserve is not mistaken for an actual charge.

Read-only/partial billing synchronization observed records for 31 holds. Complete invoice references were not available, so no hold was finalized or released to zero. No prospect calls were initiated during implementation.

Validation includes migration reruns; the previous-day/credit authorization regression; real 60-second cooldown; one retry maximum; an 18-lead simulation with first-pass priority and bounded retries; and a separate 18-lead pass under $1 using the padded rate fixture, a 60-second call maximum and 900-second session. The latter checks every intermediate reservation against the approved ceiling and leaves all bills incomplete. Browser fixtures verify Stop, Continue, Skip, terminal controls, preserved session duration, separate reservation display, notes and Manual/Power readiness controls. These simulations are not a real telephone conversation.

No implementation can guarantee every number will be reached within any arbitrary spending limit, session deadline, closed local-hours window, callback restriction or DNC suppression. The queue now continues through all currently eligible numbers while those approved resources permit it, and tells the operator which limit stops further dispatch. An actual conversation, outbound microphone audibility and repeated production batches still require user-controlled verification.

## Final validation and production observation

- All 98 PostgreSQL integration tests passed in one final run (426.8 seconds), including the real cooldown and a queued manual Continue that is consumed only when its batch is reserved.
- All 75 focused application tests and 52 Worker tests passed. Typecheck, changed-file lint and production build passed.
- Chromium Parallel, budget and workspace fixtures passed. They verify Stop/Continue/Skip, terminal controls, preset duration retention, separate daily reserves, notes, microphone denial, and Manual/Power readiness without calling a telephone number.
- The user applied the migration. A production RPC read verified `queueVersion=202611180002`. Terminal evidence bounded 24 holds; total retained credit exposure decreased from 191 to 126 cents. Today's retained exposure is 40 cents. No hold was declared invoice-complete. Partial observed records total $0.0998 across all held sessions; the successful nine-prospect session contributes $0.0319 of that observed amount.
- A local production build, using the verified production webhook/credential identity as process overrides, performed authenticated read-only readiness and quote requests against actual Supabase/Telnyx and signed Worker inspection. The saved local environment was not modified. It returned Parallel enabled, 10 channels, the expected Worker fingerprint, zero technical blockers, 390 cents available credit, 197 cents daily headroom, 100 cents authorized and 56 cents required initial exposure for four lines / 60-second calls / 900-second session. No Start or provider call mutation was invoked.
- At this observation, all 18 otherwise eligible Colorado leads were outside their configured calling window. The next window was 2026-11-18 15:00 UTC (08:00 Denver / 20:00 Pakistan). Calling-hours and the existing four-hour account capacity confirmation remain enforced.

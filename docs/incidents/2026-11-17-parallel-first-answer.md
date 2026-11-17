# Parallel production incident and first-answer delivery

## Agreed behavior

New Parallel sessions use `answerPolicy=first_answer`: the first authenticated carrier-answer event claims the operator and queues the existing bridge immediately. IVR and voicemail are eligible. Other ringing legs are canceled; a sibling that has already answered receives the existing collision explanation and cleanup. A carrier answer remains classification `unknown`; it is not reported as a confirmed human.

The existing AMD engine is retained for sessions with `confirmed_human` or no policy. Its configuration is unchanged. New first-answer prospect dials omit AMD parameters. Late classifier events cannot select a different winner or terminate a first-answer winner.

The session row lock and unique command key enforce one winner/bridge. Provider bridge requests retain `prevent_double_bridge=true` and `park_after_unbridge=self`. Stop preserves the selected conversation; no new winner is selected after Stop. Next batch waits for the existing disposition/explicit skip requirement. Funding, recipient-local hours, suppression, final dispatch authorization and provider hard caps remain enforced.

## Production evidence

### f0d458db-fb3c-453f-bcef-fbdb42e27ba2

Four prospects were dispatched. Attempt `6d4fd274-47a5-4204-a491-26e77afd360f` answered at 15:14:40.724875 UTC. The former one-second classification deadline was 15:14:41.724875; processing occurred at 15:14:41.978608, already past that deadline. The application queued cleanup before receiving AMD. The answered leg ended at 15:14:42.404885. No winner or bridge was established. Siblings were canceled by the application's cleanup, rather than by a reputation rejection. That deadline defect was fixed in the earlier deployed AMD migration.

### ad81fac8-ae11-4942-ba7d-4644f491223a

Four targets were reserved, but only three prospects were sent. Attempt `9155c292-c26c-4636-9e78-48e2e1339eae` was denied before send by the funded-deadline check. Its proven-unsent hold was canceled.

Attempt `7af8e802-9932-4ba4-9f46-3c6d1282f6b0` answered at 15:52:15.851998. Premium AMD returned `not_sure` at 15:52:20.911994; the application processed it at 15:52:22.306023 and deliberately queued hangup. The leg ended at 15:52:22.831995. This was the unknown-classification path, not the former one-second cutoff: the installed SQL deadline was eight seconds. There was no winner, bridge command, or confirmed bridge. The siblings were subsequently cleaned up by the application.

A paused session stopped browser lease/media heartbeats. Lease expiry made it unsafe. Separately, the provider-status reconciliation function incorrectly treated an observed live operator as a reason to hang it up. Its 15:52:32.113 observation preceded the application's operator hangup at 15:52:32.955862. The later explicit Stop audit at 15:56:47.178 did not cause the earlier prospect cleanup.

The fixes retain heartbeats/media observation while paused, preserve a healthy parked operator on status observation, and complete terminal recovery only when provider calls and commands are settled and any winner disposition is resolved.

### Audio and recordings

An established ICE/DTLS connection and resolved `audio.play()` prove transport/playback readiness, not a bridged conversation. A muted remote track is expected on the silent parked operator. Neither incident established a bridge, so no prospect conversation was delivered to the operator.

Authorized recordings were downloaded and inspected locally with signal measurements and automated speech transcription. Transcription is an inference, not human listening or authoritative classification.

- Latest prospect recording `97bcfc7c-328c-4d50-aa4f-b0c0051aaf70`: 7.140 seconds, completed, leg `d144d464-e29e-11f1-8950-02420aef8f1f`, session `d140fe3e-e29e-11f1-bdd6-02420aef8f1f`. Contains speech; automated transcription suggests a business greeting. It does not establish human versus IVR. It does not establish that the operator microphone reached that leg.
- Latest operator recordings `103941bd-46c8-40cc-8045-c58a85118c28` and `dee47ea6-b80a-427e-815f-d62fd2132704`: approximately 69 seconds, separate Call Control and browser/SIP sides. Low signal energy and no detected speech. Duplicate recording sides are not extra prospect calls.
- Earlier answered prospect recording `07393e91-50ee-4b01-add9-c4787999b22f`: 1.780 seconds, essentially silent. Its existence does not prove a conversation.

No available evidence supports SIP 603/608 reputation blocking. Canceled siblings had cancellation evidence (including SIP 487); the answered prospect ended through application cleanup with normal clearing. No number/caller-ID configuration was changed.

An optional local dialing tone is explicitly labeled simulated, is off by default, and stops when a winner is selected. It does not route PSTN early media or change the microphone/remote stream.

## Usage, holds and recovery verification

Quote refresh previously made five provider usage-report requests per refresh. Repeated browser refreshes and multiple instances produced Telnyx HTTP 429/code 10011, surfaced as quote 503. The new account/day database cache provides shared refresh leases and cooldowns; process requests coalesce, SDK retries are disabled for usage reads, Retry-After/backoff with jitter is honored, and UI polling is reduced. Start requires a fresh observation. Missing spending evidence never becomes zero usage.

CDR matching now uses exact provider control, leg, session and browser identifiers, rejecting ambiguity. Observed records were imported as partial evidence, not finalized invoices. Observed November 17 product charges were approximately $0.0445; the ledger including an earlier record contained $0.0452. This does not substantiate a complete $0.50 invoice for the nine attempts.

After the user applied migrations 0004 and 0005, the production policy readiness RPC returned true. Signed terminal durations bounded 11 retained holds using the existing conservative tariff. Total retained exposure decreased from 167 cents to 62 cents; holds remain unsettled and billing incomplete. The incident sessions retain 31 cents and 25 cents respectively. No uncertain invoice was declared complete or released to zero.

Both incident sessions are stopped with `ended_at` populated. Read-only Telnyx status requests on November 17 at approximately 18:31–18:32 UTC confirmed `is_alive=false` for both operator calls and all seven dispatched prospect calls. No nonterminal application sessions remained. No calls were initiated during this work.

Colorado recipient hours resolve to America/Denver even when session fallback was New York. Under the installed 08:00–21:00 policy, the earlier 08:14 Denver call was within configured hours. Address/override and daylight-saving regressions remain covered.

## Validation

- 91 PostgreSQL integration tests passed against a disposable database, including migration reruns, first-answer selection, concurrent answers, exactly one bridge, duplicate/delayed events, Stop, disposition/next batch, operator recovery, final dispatch restrictions, hours/DST, billing and shared usage leases.
- Two additional database regressions passed: first-answer automatic continuation and Continue-button continuation each create four fresh leads in batch two, with one persistent operator and no duplicate leads.
- 71 focused application tests passed.
- 52 Cloudflare Worker tests passed, including four concurrent requests, first-answer dials without AMD, bridge protection and failures, recovery, idempotency and funded hard caps.
- Application and Worker typechecks passed.
- Production build passed. The local build required a valid Square webhook URL override because the unrelated local environment value was malformed; no Square code or saved configuration changed.
- Changed-file lint: no errors; two existing queue hook-dependency warnings.
- Browser UI simulation passed winner focus, notes, callback, Stop and history checks.
- Local browser peers established DTLS, transmitted audio RTP in both directions and played generated audio. Media tests verified playback failure/pause/ended-track handling. These are not Telnyx/PSTN audibility tests.

## Required controlled real validation

Reload the deployed app, connect the browser softphone, and use a list containing only owned/consenting test destinations. Start one controlled Parallel batch. Verify first answer is bridged without an AMD wait, both people can hear each other, and browser inbound/outbound RTP counters advance. Exercise IVR digits if applicable. End the conversation, save its real disposition, then verify the same operator remains connected and the next eligible batch starts. Verify Stop and provider terminal state afterward.

Actual Telnyx two-way audibility, answer-to-audio latency/opening words, and repeated real four-line batches remain unverified until that workflow passes. The implementation must not be represented as 100% end-to-end validated before then.

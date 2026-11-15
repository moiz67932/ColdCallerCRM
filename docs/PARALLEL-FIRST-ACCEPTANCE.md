# Restricted first production acceptance run

This change is local and undeployed. No live run, grant issuance, flag enablement,
production migration or deployment is authorized by the implementation itself.
Keep `DIALER_PARALLEL_ENABLED=false` in Vercel and Cloudflare throughout acceptance.

## Remaining provider inputs

- Telnyx operator telephony credential UUID, associated SIP connection, and caller
  ID must match the deployed environment. A connection ID is not a credential ID.
  A currently available candidate credential is
  `150cfc2f-201d-4916-b18d-4d5fef831840`, associated with connection
  `2965849264032319022`. Confirm the operator device before changing shared settings.
  In the authenticated production browser, this non-calling console command
  prints only the deployed credential ID, never the returned login token:

  ```js
  const response = await fetch('/api/telnyx/webrtc-token', {method:'POST'});
  const {credentialId} = await response.json();
  console.log({status:response.status, credentialId});
  ```

- Telnyx > Voice > Programmable Voice > Voice API Applications >
  `2965539799684875446` > Outbound: explicit channel limit >=5.
- Telnyx > Voice > Outbound Voice Profiles > `2935505565696132788`:
  explicit concurrent-call limit >=5. Read **Account Level Outbound Concurrent
  Call Limit** at the top right of that page; obtain Telnyx approval if <5.
  Five must remain available during the run, including the operator. An unset
  application/profile limit does not establish account capacity and is rejected.
- Telnyx account menu > Pricing > Voice: download the actual outbound rate deck;
  match each consenting destination prefix. Include Voice API, premium AMD,
  SIP/WebRTC operator leg, billing minimums, and any recording/other fees. Obtain
  account-specific pricing/support confirmation where a component is missing.
  Store references to those records; advertised minimum rates are insufficient.
- Review current USD credit and today's profile usage/daily headroom. The last
  read-only observation was $4.02 credit and a $2 daily profile limit. These are
  observations, not reservations. Pause other calling during issuance/run.

## Boundaries of this mechanism

`dialer_acceptance_grants` is separate from `dialer_provider_verifications`. A
grant is not a passed report and cannot unlock ordinary Start/Resume. Browser
roles cannot issue/edit grants. The administrative issuance RPC requires no
active/uncertain work, distinct consenting +1 leads, current provider review,
approval/capacity/rate references, an approved browser controller, and budget.

Each grant expires in 15 minutes and is consumed by exactly one session. It
allows either one recipient or four recipients, one attempt each, one batch,
no resume/continue/retry/refill. The one-recipient run has a two-line UI/schema
ceiling but a one-attempt allowlist: only one prospect can be reserved or dialed.
The operator is provider-limited to 120 seconds; prospect ringing is 15 seconds
and connected time is at most 60 seconds. SQL additionally expires the session
after 120 seconds and enqueues cleanup. The authorization limits are independent
of the controls in the browser.

The normal SQL scheduler/media acknowledgement, Cloudflare Durable Object,
command claims, final suppression/hour authorization, provider adapter, AMD,
winner bridge, loser cleanup, and uncertainty ledger are used. Exact approved
lead ID + normalized number + effective timezone are checked both at selection
and final authorization. Remote playback/track loss still latches unsafe; stale
heartbeats cannot restore readiness. Revocation/expiry stops dispatch and forces
winner cleanup; it never invents terminal evidence or recycles reservations.
The Worker independently requires `DIALER_ACCEPTANCE_ENABLED=true`, unrestricted
Parallel disabled, matching fingerprint, current SQL authorization, and approved
destination/time limits. Turning on the acceptance flag without a grant permits
no calls. Grants do not authorize calls after revocation, but an already submitted
provider request still requires genuine hangup/terminal reconciliation.

## Budget

Use an externally verified all-inclusive ceiling `R` in integer cents/minute,
rounded up to cover all fees/minimum charges. The conservative reservation is
`(2 + 4*N) * R` cents for N prospects. The hard grant ceiling is 200 cents;
budget must also fit current credit and documented remaining daily allowance.
For example, **only if the actual all-inclusive ceiling is <=2 cents**, a
50-cent authorization covers one prospect (12-cent reservation) or four
prospects (36-cent reservation). This is conditional arithmetic, not a verified
Telnyx rate or recommendation to issue a grant now. If actual rates do not fit,
stop and revise the proposed bounded test; never understate the ceiling.

## Deployment plan (requires separate approval)

1. Correct any pending Vercel Production `DIALER_PARALLEL_ENABLED=true` setting
   to `false` before a redeploy. Confirm the current credential/application,
   signature checks, webhook, database ownership and matching configuration.
2. With all calling drained and uncertain commands reconciled, apply only new
   migration `202611150002_parallel_acceptance.sql` after the installed safety
   migration. Its guarded scheduler clone fails atomically on unexpected drift.
   It creates no grants or verification records. Do not edit old migrations.
3. Deploy matching app and Worker changes with both acceptance and unrestricted
   Parallel disabled. An app/Worker change is required; the existing Worker
   deliberately rejects this new restricted path. Preserve bindings/secrets/Cron.
4. Run non-calling checks: private scheduler permissions, no grants/evidence,
   ordinary Parallel still unavailable, authenticated `/internal/inspect` parity,
   existing Manual/Power configuration and no unexpected work. Do not issue a
   synthetic production session to test these gates.
5. Only after explicit bounded-run approval, set `DIALER_ACCEPTANCE_ENABLED=true`
   in both runtimes, keeping unrestricted Parallel false. Do not configure it in
   repository production vars as an always-on default. Approval for deployment
   alone is not approval for flag enablement, grant issuance or a call.

## Authorize one batch (requires separate live-run approval)

Use a private, excluded production env file with accurate provider settings and
`DIALER_PARALLEL_ENABLED=false`, `DIALER_ORCHESTRATION_BACKEND=cloudflare`.
Never copy the local development env wholesale or print its contents.

1. Operator opens `/queue`, connects the softphone and permits microphone/speaker
   access. Read `sessionStorage.getItem('portive-controller')` in that browser's
   developer console. Do not share the credential between active devices.
2. Review an exact list of one consenting test lead first. Preserve actual local
   timezone, DNC/suppression/duplicate protections and 09:00–20:00 calling window.
   Prepare a private JSON manifest containing:
   `controller_id`, `list_id`, `time_zone`, `destinations` (each with `lead_id`,
   normalized `phone_number`, `time_zone`, `consent_reference`), `account_channels`,
   `rate_ceiling_cents`, `max_spend_cents`, `remaining_daily_cents`,
   `approval_reference`, `capacity_reference`, `rate_reference`, `reviewed_at`.
   The CLI obtains the fingerprint, profile and operator SIP target from actual
   provider reads; the browser cannot supply or alter them. Consent/review
   references must identify genuine reviewed records, not placeholders.
3. After final approval, issue the grant (this writes a production authorization):

   ```bash
   node --env-file=/secure/path/parallel-production.env --import tsx \
     scripts/parallel-acceptance.ts issue /secure/path/approved-one.json --authorize
   ```

4. Open the printed `/queue?parallelAcceptance=GRANT_ID` in the same browser.
   Verify displayed destinations/budget and review checkbox. **Clicking Start
   approved acceptance batch places the operator call**; no call is initiated
   merely by issuance or page load. Actual remote playback and live tracks must
   be acknowledged before any prospect command is reserved.
5. Prove operator two-way audio, human AMD/one-second classification deadline,
   first-human bridge, preserved first words, Stop and terminal reconciliation.
   Save disposition, Stop, and reconcile all provider commands/costs. The next
   grant requires the previous grant to be revoked or expired as well as all
   previous work to be terminal. Do not delete ledger rows to force progress.
6. Review results and get approval for the four-recipient manifest. Issue a new
   grant with exactly four consenting leads. Verify five simultaneous actual
   provider legs, first-human bridge, ringing-loser termination and near-
   simultaneous-human collision hangup. Use further separately approved grants
   for the remaining failure/recovery scenarios; never turn on general Parallel
   to gather first-run evidence.

Emergency revocation is an explicit database write, followed by normal Worker
recovery and provider terminal reconciliation; it does not erase calls:

```bash
node --env-file=/secure/path/parallel-production.env --import tsx \
  scripts/parallel-acceptance.ts revoke GRANT_ID --authorize
```

## Genuine evidence, not certification by script

Export each real session to a new private file:

```bash
node --env-file=/secure/path/parallel-production.env --import tsx \
  scripts/parallel-acceptance.ts export SESSION_ID /secure/path/session-evidence.json
node cloudflare/portive-dialer/scripts/latency-report.mjs /secure/path/correlated-samples.json
```

The export contains actual attempts, command results, audit events and signed
provider receipts; it always has `passed:false` and no passing scenarios. It is
intentionally rejected by the normal evidence importer. It does not create a
verification row. Supply browser audio capture/observer notes with consent,
operator microphone/speaker routing, and synchronized clock/correlation records.
Measure provider answer to actual audible operator audio, including AMD and
bridge latency; the browser `playing` indicator alone is not proof. Preserve
Worker event timestamps for webhook arrival, authorization and bridge stages.

Across approved runs, review every base and Cloudflare scenario named in
`lib/dialer/parallel-policy.ts`. Do not introduce real production quota failures
or backend switches to gather evidence: leave unsafe/unexecuted scenarios
unverified until an approved fault exercise can be performed safely. Collect
genuine call identities and a measured integer five-leg peak. Only a genuinely
complete reviewed report may claim `portive-parallel-v1`, `passed:true`, matching
fingerprint/profile, five account channels, all-inclusive rate, every scenario,
maximum answer-to-audio <=1500ms and correlated Cloudflare p50/p95/maximum. Import
within 24 hours through `scripts/parallel-provider-check.ts --report` only after
separate approval. Unrestricted Parallel enablement remains a later decision.

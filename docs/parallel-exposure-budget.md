# Owner-approved provisional mode (202611160004)

Normal operation can use `pricingMode: "owner-provisional"`. This is explicitly an estimate, not verified account pricing. The owner authorized this risk-buffer mode in the development session. Migration 202611160004 installs it once; no rate CSV or support ticket is required per session. Verified mode remains available separately. The older verified-tariff instructions below describe that optional workflow.

Initial destination scope is Colorado +1303/+1720, covering Greenwood Village; this does not authorize other NANP destinations. All existing DNC, recipient timezone/hours, suppression and consent checks remain authoritative. Other destination coverage can be added to the account configuration with appropriately assessed allowances; no campaign policy row is required.

Allowances in USD: SIP .010/min (2x public starting .005); Voice API, WebRTC, operator SIP and automatic recording .003/min each (1.5x public .002); bridge .002/min; other/taxes/surcharges .003/min on each leg; AMD .010/call versus published .0065; TTS .000048/character up to 400 characters (an allowance benchmarked to published HD TTS, not a claim that the female voice uses that engine); operator fixed .010/session and prospect fixed .010/attempt. Bridge/other/fixed components are explicit uncertain-cost allowances, not assertions of actual provider fees. Minimum/increment 60/60 follows public billing guidance and observed outbound records. Unusual routing or unmodeled charges can exceed these assumptions; no estimator guarantees an invoice cap.

Four-line maximum initial reserves (15-second ringing, session duration conversation+75 seconds): 60 seconds 42 cents, 120 seconds 51 cents, 300 seconds 80 cents. Estimates assuming prompt loser cleanup are 36/39/50 cents. The default 180-second session with a 60-second conversation also reserves 42 cents. The $1 default session ceiling covers these examples, subject to fresh provider funds, daily headroom and unsettled prior exposure. No provider spending limit is changed.

The user must explicitly accept the numeric session spending ceiling before Start; API and SQL enforce this for provisional mode. Increasing the spend field clears that approval. This approves estimated exposure, not an assurance that actual Telnyx charges cannot differ. SQL/Worker hard-duration caps, atomic reservations, held uncertain commands, reconciliation and Stop remain unchanged.

Provisional assumptions expire into a visible warning after seven days; they do not disable Start, Resume or later batches. Verified-mode expiration remains strict. A stale warning is not an acceptance report or a manual grant.

Account-wide capacity retains the existing manual four-hour confirmation. Application/profile values do not prove the account limit or free channels. Record the real available count and a dated screenshot/support reference in the existing CRM. A missing screenshot is never reported as inspected evidence. No capacity value is seeded by this migration.

---

# Parallel exposure budget

Normal Parallel has no acceptance-report/grant dependency. The old `DIALER_RATE_CEILING_CENTS` is ignored for ordinary component-priced sessions. Manual and Power retain their existing behavior.

## What this call flow actually uses

Telnyx SDK 6.41.0 / Voice API: one outbound SIP URI call to the operator's WebRTC credential, up to four outbound US PSTN prospect calls with premium AMD, direct `bridge` with `park_after_unbridge=self`, and `speak` for answered collisions. No conference, transfer, noise suppression or media streaming is requested by this executor. Collision text is capped at 400 characters. The existing outbound profile **also has automatic recording set to `all`**; recording must be priced even though the executor does not explicitly request it. Provider configuration is preserved.

Official references:

- https://telnyx.com/pricing/voice-api — Voice API $0.002/min plus destination SIP; WebRTC $0.002/min; SIP interface $0.002/min; premium AMD $0.0065/call; recording $0.002/min; standard Polly TTS $0.000009/character. These are public prices, not proof of an account's complete destination tariff. The generic `female` speech voice must not be priced as Telnyx TTS without confirming its actual engine/tariff.
- https://support.telnyx.com/en/articles/4320411-more-about-outbound-voice-profiles — download the account's current prefix rate deck from Mission Control **Voice Pricing**. Account Level Outbound Concurrent Call Limit is shown at the top right of Outbound Voice Profiles. Profile daily spend resets at UTC midnight.
- https://support-v2.telnyx.com/en/articles/1130659-billing-increments — published 60/60 billing. Historical account records may show different increments; configure an upper bound covering every enabled component's minimum/increment, never round below actual terms.
- The installed SDK's `calls.dial.time_limit_secs` limits duration from answer. It is a relative provider hard cap, not an extendable winner-only lease.

Read-only account evidence on 2026-11-16: historical billable SIP outbound rows had rate $0.005/min; WebRTC rows $0.002/min. No billable Call Control/AMD/TTS rows were found in that month's scans. This does not prove all Greenwood destination prefixes or all feature fees. Application/profile channels were both 10, profile daily ceiling $2, balance $4.02. Account-wide capacity was not API-verified. No supported account pricing API was found; the public page's advertised public-pricing URL returned 404. Never synthesize a tariff from those partial observations.

## Reservation and enforceable limits

Money is integer millionths USD in the tariff; each leg's reserved cap rounds **up** to cents. `minimumSeconds` and `incrementSeconds` must conservatively cover every billed component. Separate component fields cover operator SIP interface, WebRTC, Voice API, prospect destination SIP, recording, bridge/media/other recurring charges, premium AMD, bounded collision TTS and other fixed charges. Include applicable taxes/surcharges in the ceiling rather than assuming they are absent. `destinationPrefixes` covers only destinations for which the configured SIP ceiling is valid; it is not proof of country, consent or business classification.

Let `U(t)` round duration up to the configured minimum/increment. Session duration `S` is explicit, at most 3600 seconds and at least conversation `C` + ring timeout + 60 seconds. A prospect's provider cap is `C + 15` seconds. Operator cap is remaining session time minus 28 seconds for the 8-second provider request timeout and 20-second ring allowance. SQL/Worker reject dispatch unless another prospect's ring, full cap and request allowance fit before the session deadline.

```
operator = ceil_cent(U(S) / 60 * (CC + WebRTC + operator_SIP + recording + other) + operator_fixed)
prospect = ceil_cent(U(C + 15) / 60 * (SIP + CC + recording + bridge + other)
                     + AMD + prospect_fixed + 400 * TTS_character)
maximum_initial_exposure = operator + lines * prospect
normal_batch_estimate = operator + prospect + (lines - 1) * similarly_priced_30_second_loser
```

The normal estimate is not a guaranteed bill. Every prospect remains funded through its provider hard cap, because multiple answered losers can outlive a failed hangup. Funding only one full-length winner would be unsafe without a provider-supported way to extend only that winner's initially short cap. Do not add a transfer/conference solely to evade this constraint.

The original `$9.36` was `(30 + 4*(2*5+2))*12¢`, an internal worst-case hold. It reserved a 30-minute operator and two full-duration units per prospect at an unverified blended tariff. That is excessive relative to a short bounded session and duplicates exposure already covered by the separately funded operator. It was never a verified provider charge.

**Illustration only, not installed as an authorization tariff:** SIP 5000, CC 2000, WebRTC 2000, operator SIP 2000, recording 2000 micros/min; AMD 6500 micros/call; Polly TTS 9 micros/character; 60/60 minimum/increment; bridge/other/fixed zero **only if confirmed**. With 15s ringing and `S=C+75`, four-line maximums are **15¢ / 20¢ / 34¢** for 60s / 120s / 300s conversations. Normal estimates are 12¢ / 14¢ / 19¢. A $4.02 balance and unused $2 daily allowance would cover those examples, but calling cannot be authorized at those amounts until the missing tariff terms and prefix coverage are confirmed. Production UI computes the actual quote from the sourced tariff; it never substitutes these illustration numbers.

SQL serializes starts and batches under the existing operator advisory/session locks. Each attempt obtains its own hold atomically with the attempt and command; cumulative holds plus finalized spend cannot exceed the session's authorized budget. Provider balance and conservative account-wide voice usage determine a smaller effective ceiling at Start. Prior unsettled holds reduce new funding. No new batch is launched when it cannot fit the remaining amount/time. SQL alarms force cleanup at the conversation/session deadlines; provider hard caps bound billable duration during Worker/DB failure. Unknown provider command outcomes retain their holds and prevent unsafe retries. Provider relative caps still apply if submission acknowledgement is lost; exact absolute terminal timing depends on provider event/status reconciliation.

Terminal evidence alone does not prove a complete bill. Only proven-unsent canceled prospects release immediately. Late terminal events update holds through triggers even after session Stop. Partial CDR ingestion shows observed charges and releases **nothing**. A complete invoice reconciliation requires terminal evidence, settled commands, matching provider call-leg IDs, unique billing record IDs and a complete invoice reference. It replaces a hold with rounded actual spend; duplicate records cannot double count or cross legs. A bill above the configured ceiling stops dispatch. Incomplete monthly scans or empty usage reports are never treated as zero final bills. Uncertain commands require provider reconciliation first.

## Install and configure without placing calls

1. While idle, run **all** of `supabase/migrations/202611160003_parallel_exposure_budget.sql` in Supabase SQL Editor. This is a forward-only migration; it creates no session, call, grant, report or fake pricing. It refuses to change an active legacy Parallel session. No production DDL access was available to the deployment agent.
2. Obtain the actual current rate deck and account feature terms from Mission Control Voice Pricing / Telnyx support. Build a private JSON profile with **every** schema field below. Use the maximum applicable SIP rate for the included prefixes and conservatively include applicable additional fees. A source reference and actual review time are required, with at most seven-day validity. Do not copy the illustration into production without confirming its terms.
3. Validate/quote without modifying production, then configure the sourced tariff:

```bash
node --import tsx scripts/parallel-billing.ts quote /tmp/portive-verified-pricing.json
node --env-file=.env.local --import tsx scripts/parallel-billing.ts configure /tmp/portive-verified-pricing.json
```

Required JSON fields: `version:"exposure-v1"`, `currency:"USD"`, `source`, ISO `reviewedAt` / `expiresAt`, `destinationPrefixes`; integer nonnegative `sipPerMinuteMicros`, `operatorSipPerMinuteMicros`, `callControlPerMinuteMicros`, `webrtcPerMinuteMicros`, `recordingPerMinuteMicros`, `bridgePerMinuteMicros`, `otherPerMinuteMicros`, `amdPerCallMicros`, `ttsPerCharacterMicros`, `operatorFixedMicros`, `prospectFixedMicros`; positive `minimumSeconds` (≤300), `incrementSeconds` (≤60). One dollar is 1,000,000 micros. A zero means verified no charge for that component, not missing information.

4. In the CRM's Parallel preflight, enter the actual account ceiling, currently free channels and dated portal/support evidence reference. The server timestamps the **manual** confirmation; it expires after four hours. It is never presented as API verification. Four prospects require at least five free account channels as well as sufficient application/profile limits. Other account traffic can consume headroom after confirmation; provider enforcement still applies.
5. Reload Parallel, select Greenwood, keep its verified recipient timezone. The cost panel shows estimates, maximum exposure, authorized ceiling, available credit/daily headroom, currently eligible leads, and the next permitted recipient-local window. It polls every 15 seconds and refreshes at the predicted opening. It rechecks actual eligibility at dispatch; DNC, suppression, revocation and timezone/DST protections are unchanged. An optional campaign policy/individual lawful invitation may refine actual eligibility; list membership never grants consent.
6. Connect the operator softphone and microphone. Choose the 1/2/5-minute preset and funded session/spend limits whose quote fits. Review list eligibility, then personally press **Start Session**. No deployment/check command presses it.

## Billing operation

Run after provider records become available, or from your existing server scheduler with private environment credentials:

```bash
node --env-file=.env.local --import tsx scripts/parallel-billing.ts sync
```

This reads current-month SIP/Voice API/WebRTC/AMD/TTS/recording CDR pages, matches actual call-leg IDs, and idempotently records partial costs. It never finalizes a partial scan. Previous-month or late records still require complete invoice reconciliation. For final reconciliation, supply a private JSON array of `{holdId,records:[{id,product,callLegId,currency:"USD",costMicros,providerRecordId}]}` covering **all** billed products for each included leg, then:

```bash
node --env-file=.env.local --import tsx scripts/parallel-billing.ts finalize /tmp/complete-provider-invoice.json ACTUAL_INVOICE_REFERENCE
```

Invoice completeness is a billing reconciliation responsibility, not a test/acceptance gate. Unused exposure stays held until complete evidence is supplied; neither browser assertions nor a successful hangup HTTP response can release it. Protect CDR/invoice files as account data and keep them out of Git.

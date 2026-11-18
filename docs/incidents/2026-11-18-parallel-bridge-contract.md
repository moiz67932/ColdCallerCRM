# First-answer bridge rejection: production correction

## Cause and evidence

Session `6f7488cf-9e96-4011-b526-0e22c20f308e` selected Beauty Refined attempt `29a0c830-6c5e-422d-bad3-1994c90f6f15` after its carrier answer at 2026-11-17 18:50:14.018956 UTC. The winner and bridge command were claimed at 18:50:15.515936. Telnyx rejected the bridge with HTTP 422 at 18:50:16.118343. No `call.bridged` was established. The application's bridge-failure cleanup terminated the prospect at 18:50:17.418944 and the operator at 18:50:18.155750. The later explicit Stop did not cause this failure.

The Worker uses raw REST fetch and sent `call_control_id_to_bridge_with`, an SDK argument alias. The installed official Telnyx SDK translates that argument to REST body field `call_control_id`. The Worker adapter did not perform that translation. Manual/Power SDK callers use the alias correctly and were left intact. Historical evidence contains HTTP 422 but not the exact provider validation message; no specific historical error code is invented.

The corrected Worker sends `call_control_id`, retains duplicate-bridge protection and parks the operator after unbridge. The new regression compares the actual Worker's HTTP body against the installed Telnyx SDK's captured wire body. The previous mock accepted the same incorrect alias and missed this defect.

This session requested first-answer policy without AMD. Its AMD result and classification deadline are null. Its classification remains unknown. No voicemail/AMD rule cut this greeting. The prospect's recorded greeting establishes answered media at the provider; it does not establish a bridge or a two-way conversation. Provider statistics showed inbound prospect RTP but no outbound prospect RTP. Operator inbound RTP alone does not prove prospect delivery.

## Recovery and costs

The two first-answer failures (`6f7488cf-9e96-4011-b526-0e22c20f308e` and `8c9127ff-aed9-4508-8f46-784e2a4bbaa8`) are stopped with terminal timestamps and no active winner. Historical HTTP 422 bridge commands were settled as canceled only after all five provider calls in each session were verified not alive. They were never replayed. Retained exposure is now 31 cents per session; billing remains incomplete and the holds remain held.

Latest-session observed billing totals 11,400 microdollars ($0.0114): prospect SIP $0.005, prospect Call Control $0.002, prospect recording $0.002, operator SIP/Call Control/WebRTC/recording $0.0006 each. The three unanswered prospect CDRs currently show zero cost. These partial records do not substantiate a complete $0.20 charge or guarantee there will be no later charges. The answered prospect has a 60-second billing minimum in these records. The operator is already answered while prospects ring.

Migration `202611180001_rejected_provider_commands.sql`, applied by the user, records explicit HTTP 4xx rejections (except 408) as settled rejected requests and stores sanitized diagnostics. Network/408/server uncertainty remains uncertain. A rejected request never counts as terminal call evidence or releases incomplete billing.

## Validation and deployment

- 94 PostgreSQL integration tests passed against the disposable database, including first answer, collision, rejected bridge, Stop/recovery, same-operator continuation, four fresh leads in the next automatic/manual batch, billing, shared usage cache, suppression and recipient hours.
- 72 focused application tests and 52 Worker tests passed.
- Application and Worker TypeScript checks, changed-file lint and production build passed.
- Chromium UI fixtures passed actual Continue, Skip Lead and Stop clicks, the owning session/controller payload, no direct prospect hangup from Stop during a connected conversation, and disabled terminal-session controls. This is simulated provider coverage, not a live telephone call.
- Local build used a valid Square webhook URL override for an unrelated malformed local environment value; no Square code/configuration changed.
- Cloudflare production Worker deployed as version `0df7661a-a51e-4f7f-9250-c212ec72dabf`.
- Vercel and Worker health checks passed. Signed Worker inspection returned the expected configuration fingerprint `9bb97e982889c2e092c2a86a34961c19171b7581bd100fdeb2b9aa013bedfe51`.
- GitHub's Vercel status for `7c96956` reports deployment completed successfully. Direct Vercel API inspection with the local CLI credential returned HTTP 403; deployment success is attributed to the GitHub check and public health response.
- A final production read found no nonterminal sessions. The manual capacity confirmation expired at 2026-11-17 19:14:12.586 UTC. Refresh it through the existing capacity form using actual current account headroom before a new controlled test. No unverified capacity was installed.

No prospect calls were initiated. Real Telnyx bridge acceptance, browser two-way audibility, opening-word latency and a repeated live batch still require an owned/consenting controlled destination. After the first conversation, save its disposition or explicitly Skip; automatic continuation or Continue then starts the next eligible funded batch with the same operator. Start also rechecks current funding, capacity and recipient-local hours. Expired capacity confirmation must be refreshed from actual account evidence, never assumed. These checks passing must not be described as 100% live audio validation.

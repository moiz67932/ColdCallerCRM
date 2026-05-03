# Better Plan

## What is actually failing

The CRM call endpoint is returning `400` because `APP_BASE_URL=http://localhost:3000`. That is expected in this codebase: Telnyx must send call-control webhooks to:

```text
{APP_BASE_URL}/api/webhooks/telnyx/voice
```

Telnyx cannot reach `localhost` on your laptop, so the CRM blocks the call before creating a broken call attempt. Deploying to Vercel fixes this specific issue only if `APP_BASE_URL` is set to the public Vercel URL and the same URL is configured on the Telnyx connection webhook.

## Current architecture in this CRM

This repo uses Telnyx WebRTC plus Call Control:

1. Browser gets a Telnyx WebRTC token from `POST /api/telnyx/webrtc-token`.
2. Browser starts the agent WebRTC leg.
3. Telnyx posts `call.initiated`, AMD, answer, bridge, hangup, recording, and transcript events to the voice webhook.
4. The backend uses those webhook events to update the call attempt and bridge/control call legs.

Important files:

- `app/api/leads/[id]/call/route.ts`
- `app/api/telnyx/webrtc-token/route.ts`
- `app/api/webhooks/telnyx/voice/route.ts`
- `lib/telnyx/helpers.ts`
- `lib/telnyx/call-flow.ts`
- `lib/telnyx/webhook-processor.ts`

## Telnyx facts from current docs

- Telnyx WebRTC with credential-based SIP connections requires a credential-based SIP connection.
- For outbound dialer flows, Telnyx says the SIP connection should have Park Outbound Calls enabled and webhook events configured.
- The backend dial command uses a `connection_id`, `from`, `to`, and public `webhook_url`.
- A telephone number can route voice to one selected SIP Connection/Application at a time in the Telnyx number voice routing UI.
- Telephony credentials belong under a connection and can be used for WebRTC/JWT login. Telnyx documents no hard aggregate limit on telephony credentials per connection.

Official references:

- https://developers.telnyx.com/docs/voice/webrtc/use-cases/outbound-dialer/index
- https://developers.telnyx.com/docs/voice/webrtc/auth/credential-connections
- https://developers.telnyx.com/docs/voice/webrtc/auth/telephony-credentials
- https://support.telnyx.com/en/articles/4351104-sip-connection-settings

## Recommendation

Do not make the Telnyx phone number bounce between `portive-ai` and `agent-871128214661-voice` for this demo.

Use one stable routing owner for the phone number:

- If inbound calls must reach the demo AI agent, keep the number routed to `agent-871128214661-voice`.
- If CRM click-to-call must own the WebRTC/call-control flow, set `TELNYX_CONNECTION_ID` in this CRM to the same connection that the CRM WebRTC credential and webhook should use.
- If both systems need the same number, the better long-term design is one orchestrator. The number points to the orchestrator, and the orchestrator decides whether to hand the call to the AI agent, the CRM browser operator, or a bridge between them.

For per-agent systems, prefer one SIP connection per agent only when the external agent provider requires that model. For a CRM with many browser users, prefer one shared credential-based SIP connection plus one telephony credential per browser user/session. That avoids moving phone-number routing every time the active agent changes.

## Vercel answer

Yes, deploying this CRM on Vercel should solve the `APP_BASE_URL=localhost` blocker, provided these are true:

1. Vercel environment variables include:

```env
APP_BASE_URL=https://your-vercel-domain.vercel.app
TELNYX_API_KEY=...
TELNYX_CONNECTION_ID=...
TELNYX_FROM_NUMBER=...
TELNYX_PUBLIC_KEY=...
```

2. The Telnyx SIP connection webhook is:

```text
https://your-vercel-domain.vercel.app/api/webhooks/telnyx/voice
```

3. The Telnyx webhook API version is `2`.
4. The number used as `TELNYX_FROM_NUMBER` is allowed/assigned for that Telnyx connection.
5. The WebRTC telephony credential belongs to that same connection, or `TELNYX_TELEPHONY_CREDENTIAL_ID` is left blank so this CRM can create/reuse one.

For local testing, use a public tunnel instead:

```bash
ngrok http 3000
```

Then set:

```env
APP_BASE_URL=https://your-ngrok-host.ngrok-free.app
```

Restart `npm run dev` after changing `.env`.

## Plan for the agent codebase

Execute this in the agent codebase, because the `agent-871128214661-voice` behavior is owned there, not in this CRM.

1. Inventory agent connection ownership.
   - Find where agent creation creates Telnyx SIP connections.
   - Confirm whether every agent gets a dedicated connection like `agent-{id}-voice`.
   - Confirm whether the demo agent ID `87112821-4661-4dd9-a22e-ba57b48feb17` maps to `agent-871128214661-voice`.

2. Add or verify a stable phone-number assignment model.
   - Store the Telnyx phone number, assigned connection ID, and assigned agent ID in the agent database.
   - Do not infer the active agent only from the current Telnyx portal dropdown.
   - Add a check that warns when the Telnyx number is routed to a different connection than the agent expects.

3. Decide the ownership boundary.
   - Option A: AI agent owns inbound. Keep the number routed to `agent-871128214661-voice`; CRM outbound must use its own Telnyx number/connection or call the agent platform through an API.
   - Option B: CRM owns call control. Point the number/SIP connection/webhooks at this CRM and have this CRM bridge to the AI agent only when needed.
   - Option C: Shared orchestrator. Build one public webhook owner that receives all Telnyx call events and dispatches to CRM or AI agent.

4. Prevent silent misrouting.
   - On agent startup, fetch the Telnyx number voice settings.
   - If the number is not routed to the expected agent connection, mark the agent unhealthy and show the exact expected connection.
   - Log the actual connection/application currently assigned to the number.

5. Keep WebRTC credentials separate from agent identity.
   - Browser users should receive short-lived telephony credentials or JWT tokens.
   - AI agents can keep dedicated SIP connections if the provider needs a direct SIP target.
   - Do not rotate the phone number assignment just to let the CRM browser dial.

## What to do next

1. For the fastest CRM test, deploy this repo to Vercel or start `ngrok http 3000`.
2. Set `APP_BASE_URL` to that public URL and restart/redeploy.
3. In Telnyx, verify the CRM connection webhook points to `{APP_BASE_URL}/api/webhooks/telnyx/voice`.
4. Leave the demo inbound number on `agent-871128214661-voice` if the demo agent must answer inbound calls.
5. Use a separate Telnyx number/connection for CRM outbound testing unless you intentionally build the shared orchestrator.

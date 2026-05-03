# Telnyx WebRTC Migration Guide

## Goal

Move from:

- operator callback PSTN leg
- lead PSTN leg
- manual dual-leg bridge tracking

to:

- browser WebRTC agent session
- one outbound PSTN lead leg
- webhook-driven call lifecycle

## 1. Prepare Telnyx

Create or update a credential-based SIP connection with:

- Park Outbound Calls enabled
- outbound calling enabled
- your desired outbound caller ID number assigned
- voice webhook URL set to `https://YOUR_DOMAIN/api/webhooks/telnyx/voice`
- messaging webhook URL set to `https://YOUR_DOMAIN/api/webhooks/telnyx/messaging`

Create a telephony credential under that SIP connection and keep its ID.

## 2. Update Environment Variables

Remove:

- `MY_PHONE_NUMBER`

Add:

- `TELNYX_TELEPHONY_CREDENTIAL_ID`

Required final voice env:

```env
TELNYX_API_KEY=
TELNYX_CONNECTION_ID=
TELNYX_TELEPHONY_CREDENTIAL_ID=
TELNYX_FROM_NUMBER=
APP_BASE_URL=https://YOUR_DOMAIN
```

## 3. Apply the Database Change

Run the Supabase workstation migration in the Supabase SQL editor:

```bash
supabase/migrations/202604260001_colcaller_workstation.sql
```

The migration:

- renames the old session/leg columns into agent/lead identifiers
- adds `telnyxConnectionId`
- replaces the old call statuses with:
  - `dialing`
  - `connected`
  - `voicemail_detected`
  - `completed`
  - `failed`
  - `canceled`

## 4. Deploy the App

Deploy the updated app code together with the migration.

Important routes:

- `POST /api/telnyx/webrtc-token`
- `POST /api/leads/:id/call`
- `POST /api/webhooks/telnyx/voice`

## 5. Verify Browser Calling

In the calling workspace:

1. Open `/queue`.
2. Click `Call`.
3. Confirm the browser asks for microphone access.
4. Confirm the browser phone reaches `ready`.
5. Confirm the lead attempt enters `dialing`.

Expected behavior:

- no call is placed to the operator’s real phone
- the browser handles the agent audio
- the lead leg is created from the webhook-driven backend flow

## 6. Verify Voicemail Auto-Skip

Call a known voicemail target.

Expected result:

- Telnyx emits `call.machine.detection.ended` and/or `call.machine.greeting.ended`
- the app marks the attempt `voicemail_detected`
- outcome is set to `voicemail`
- the call is hung up immediately

## 7. Verify Human Answer Flow

Call a human-answered target.

Expected result:

- status moves from `dialing` to `connected`
- recording is created natively in Telnyx
- transcript appears later if Telnyx returns transcription webhooks
- call detail shows recording link and transcript text/status

## 8. Verify History and Debug Data

Open the call detail page and confirm these fields are populated:

- `telnyxConnectionId`
- `telnyxCallControlId`
- `telnyxCallLegId`
- `telnyxAgentCallControlId`
- `telnyxAgentCallLegId`
- `telnyxCallSessionId`

These are the only remaining orchestration identifiers. The old operator/prospect leg naming is removed from the app.

## 9. Rollout Notes

- Browser calling requires microphone permission and HTTPS outside localhost.
- Webhooks must be reachable publicly for status, recordings, and transcripts to update.
- If the browser fails before a call is fully established, the app now marks the attempt via `PATCH /api/calls/:id` so failed attempts do not get stuck in `dialing`.

## 10. Safe Cutover Checklist

- Deploy code
- Run migration
- Update env vars
- Remove `MY_PHONE_NUMBER` from secrets management
- Repoint Telnyx webhooks
- Verify one voicemail call
- Verify one human-answered call
- Verify recording link
- Verify transcript webhook handling

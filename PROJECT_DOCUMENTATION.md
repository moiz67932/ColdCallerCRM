# Project Documentation

This project is a single-operator outbound CRM with backend-initiated outbound calling over Telnyx Call Control.

## Current Telephony Architecture

- The browser calls the backend API; it does not register a SIP softphone.
- The backend dials the lead through the configured Telnyx connection.
- Telnyx voice webhooks drive status, duration, recording, and transcript persistence.
- Voicemail detection uses `answering_machine_detection: "detect_beep"` and hangs up immediately on machine detection.

## Core Runtime Pieces

- [lib/telnyx/call-flow.ts](/mnt/c/Users/Moiz/Desktop/ColCaller/lib/telnyx/call-flow.ts)
- [lib/telnyx/webhook-processor.ts](/mnt/c/Users/Moiz/Desktop/ColCaller/lib/telnyx/webhook-processor.ts)
- [app/api/leads/[id]/call/route.ts](/mnt/c/Users/Moiz/Desktop/ColCaller/app/api/leads/[id]/call/route.ts)
- [app/api/webhooks/telnyx/voice/route.ts](/mnt/c/Users/Moiz/Desktop/ColCaller/app/api/webhooks/telnyx/voice/route.ts)
- [app/(protected)/queue/page.tsx](/mnt/c/Users/Moiz/Desktop/ColCaller/app/(protected)/queue/page.tsx)

## Database Model

`CallAttempt` now stores:

- `telnyxConnectionId`
- `telnyxCallSessionId`
- `telnyxCallControlId`
- `telnyxCallLegId`
- legacy browser-leg fields from the previous softphone flow

Call statuses are now:

- `dialing`
- `connected`
- `voicemail_detected`
- `completed`
- `failed`
- `canceled`

## Operational Docs

- Setup and environment: [README.md](/mnt/c/Users/Moiz/Desktop/ColCaller/README.md)

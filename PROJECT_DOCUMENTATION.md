# Project Documentation

This project is a single-operator outbound CRM with browser-based calling over Telnyx WebRTC.

## Current Telephony Architecture

- The operator side lives in the browser as a Telnyx WebRTC session.
- The backend never calls the operator’s real phone.
- The backend dials only the lead PSTN leg.
- Telnyx voice webhooks drive status, duration, recording, and transcript persistence.
- Voicemail detection uses `answering_machine_detection: "detect_beep"` and hangs up immediately on machine detection.

## Core Runtime Pieces

- [lib/telnyx/call-flow.ts](/mnt/c/Users/Moiz/Desktop/ColCaller/lib/telnyx/call-flow.ts)
- [lib/telnyx/webhook-processor.ts](/mnt/c/Users/Moiz/Desktop/ColCaller/lib/telnyx/webhook-processor.ts)
- [app/api/telnyx/webrtc-token/route.ts](/mnt/c/Users/Moiz/Desktop/ColCaller/app/api/telnyx/webrtc-token/route.ts)
- [app/api/leads/[id]/call/route.ts](/mnt/c/Users/Moiz/Desktop/ColCaller/app/api/leads/[id]/call/route.ts)
- [app/api/webhooks/telnyx/voice/route.ts](/mnt/c/Users/Moiz/Desktop/ColCaller/app/api/webhooks/telnyx/voice/route.ts)
- [app/(protected)/queue/page.tsx](/mnt/c/Users/Moiz/Desktop/ColCaller/app/(protected)/queue/page.tsx)

## Database Model

`CallAttempt` now stores:

- `telnyxConnectionId`
- `telnyxCallSessionId`
- `telnyxCallControlId`
- `telnyxCallLegId`
- `telnyxAgentCallControlId`
- `telnyxAgentCallLegId`

Call statuses are now:

- `dialing`
- `connected`
- `voicemail_detected`
- `completed`
- `failed`
- `canceled`

## Operational Docs

- Setup and environment: [README.md](/mnt/c/Users/Moiz/Desktop/ColCaller/README.md)
- Cutover checklist: [docs/webrtc-telnyx-migration.md](/mnt/c/Users/Moiz/Desktop/ColCaller/docs/webrtc-telnyx-migration.md)

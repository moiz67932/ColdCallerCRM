# ColdCaller CRM

Browser-first cold-calling CRM built with Next.js, Supabase, and Telnyx.

## What Changed

The calling stack now uses:

- Telnyx WebRTC in the browser for the agent side
- one outbound PSTN leg for the lead
- Telnyx voice webhooks as the source of truth for status, duration, recordings, and transcripts
- Telnyx answering machine detection with `detect_beep` and immediate voicemail auto-skip

The legacy operator callback flow is gone:

- no `MY_PHONE_NUMBER`
- no dial-the-operator-first flow
- no operator/prospect leg A/B state machine in the UI

## Current Call Flow

1. The browser fetches a Telnyx WebRTC JWT from `POST /api/telnyx/webrtc-token`.
2. The calling workspace registers a WebRTC softphone session with Telnyx.
3. Clicking `Call` creates a `CallAttempt` row and starts a parked WebRTC call from the browser.
4. The backend receives the parked WebRTC webhook, dials the lead leg, and enables AMD with `detect_beep`.
5. If Telnyx detects a machine, the app marks the attempt as `voicemail_detected`, stores outcome `voicemail`, and hangs up immediately.
6. If Telnyx detects a human, the backend bridges the parked browser leg to the lead leg.
7. On bridge, the app starts native Telnyx recording with transcription enabled.
8. Recordings and transcripts are stored only from Telnyx webhook payloads.

This matches the practical billing model of the Telnyx Web Dialer: one PSTN billable leg plus the browser WebRTC session.

## Stack

- Next.js App Router
- React
- Supabase Postgres via `@supabase/supabase-js`
- Telnyx Node SDK
- Telnyx WebRTC JS SDK
- Tailwind CSS + shadcn-style UI

## Required Environment Variables

```env
ADMIN_PASSWORD=change-this-password
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TELNYX_API_KEY=
TELNYX_CONNECTION_ID=
TELNYX_TELEPHONY_CREDENTIAL_ID=
TELNYX_FROM_NUMBER=
TELNYX_PUBLIC_KEY=
TELNYX_MESSAGING_FROM_NUMBER=
NEXT_PUBLIC_APP_NAME=ColdCaller CRM
APP_BASE_URL=http://localhost:3000
TELNYX_SKIP_SIGNATURE_VERIFICATION=false
SESSION_TTL_HOURS=24
```

Core voice requirements:

- `TELNYX_API_KEY`
- `TELNYX_CONNECTION_ID`
- `TELNYX_TELEPHONY_CREDENTIAL_ID`
- `TELNYX_FROM_NUMBER`
- `APP_BASE_URL` for real webhook delivery

Optional:

- `TELNYX_PUBLIC_KEY` for signature verification
- `TELNYX_MESSAGING_FROM_NUMBER` for manual follow-up SMS

## Telnyx Configuration

Use a credential-based SIP connection with:

- Park Outbound Calls enabled
- voice webhooks pointed at `/api/webhooks/telnyx/voice`
- a telephony credential under that connection for browser JWT generation

Set:

- voice webhook URL: `https://your-domain/api/webhooks/telnyx/voice`
- messaging webhook URL: `https://your-domain/api/webhooks/telnyx/messaging`

## Local Setup

```bash
npm install
# Run supabase/migrations/202604260001_colcaller_workstation.sql once in the Supabase SQL editor.
npm run dev
```

Open `http://localhost:3000` and log in with `ADMIN_PASSWORD`.

## API Surface

- `POST /api/telnyx/webrtc-token`
- `POST /api/leads/:id/call`
- `GET /api/leads`
- `GET /api/leads/:id`
- `POST /api/leads/:id/outcome`
- `POST /api/leads/:id/notes`
- `POST /api/leads/:id/followups`
- `GET /api/calls`
- `GET /api/calls/:id`
- `PATCH /api/calls/:id`
- `POST /api/calls/:id/send-sms`
- `POST /api/webhooks/telnyx/voice`
- `POST /api/webhooks/telnyx/messaging`
- `GET /api/settings`
- `POST /api/settings`
- `GET /api/health`

## Verification

The refactor has been validated with:

- `npm run lint`
- `npx tsc --noEmit`
- `npm run build`

`npm run build` completed successfully in this workspace, but the build log still showed expected Prisma connection errors while no local PostgreSQL server was running at `localhost:5432`.

## Migration Guide

See [docs/webrtc-telnyx-migration.md](/mnt/c/Users/Moiz/Desktop/ColCaller/docs/webrtc-telnyx-migration.md) for the full cutover checklist.

# ColdCaller CRM

Cold-calling CRM built with Next.js, Supabase, and Telnyx.

## What Changed

The calling stack now uses:

- the CRM frontend calling a backend API
- Telnyx Call Control API with the configured FQDN SIP connection
- Telnyx voice webhooks as the source of truth for status, duration, recordings, and transcripts
- Telnyx answering machine detection with `detect_beep` and immediate voicemail auto-skip

The legacy operator callback flow is gone:

- no `MY_PHONE_NUMBER`
- no dial-the-operator-first flow
- no operator/prospect leg A/B state machine in the UI

## Current Call Flow

1. Clicking `Call` posts to `POST /api/leads/:id/call`.
2. The backend creates a `CallAttempt` row.
3. The backend starts an outbound Telnyx Call Control dial using `TELNYX_CONNECTION_ID`.
4. Telnyx sends call-control events to `/api/webhooks/telnyx/voice`.
5. If Telnyx detects a machine, the app marks the attempt as `voicemail_detected`, stores outcome `voicemail`, and hangs up immediately.
6. If Telnyx detects a human or answer event, the app marks the attempt connected.
7. Recordings and transcripts are stored only from Telnyx webhook payloads.

## Stack

- Next.js App Router
- React
- Supabase Postgres via `@supabase/supabase-js`
- Telnyx Node SDK
- Tailwind CSS + shadcn-style UI

## CRM Functionality

- Lead list import from CSV with column mapping, previews, and duplicate detection.
- Calling workspace with backend Telnyx Call Control initiation, live status, and AMD voicemail handling.
- After-call outcomes, callback scheduling, and follow-up tracking tied to call attempts.
- Operator scripts with template variables and inline preview.
- Operator notes with autosave and explicit save.
- Call history filtering by search, outcome, date range, lead list, and niche.
- Call detail view with recordings, transcripts, webhook timeline, notes, and SMS follow-up.
- Automations to pre-prepare demo agent profiles from lead websites.
- Settings for recordings, SMS templates, scripts, and integration health checks.

## Workspace Workflow (Lead Queue + Calling)

1. Import leads in the CSV importer to create a lead list.
2. Open the Calling Workspace (Lead Queue) to see prioritized leads and select the next lead.
3. Click Call to create a `CallAttempt`.
4. The backend dials the lead through the configured Telnyx connection and enables AMD.
6. On voicemail detection, the attempt is marked `voicemail_detected` and the call ends automatically.
7. During or after the call, update outcomes, add notes, and schedule callbacks or follow-ups.
8. Use the Script panel to customize talk tracks and preview template variable substitutions.
9. Review recordings and transcripts after the call as Telnyx webhooks finalize them.

## Automations Workflow (Demo Prep)

The Automations page prepares website-derived demo profiles for review and future use while the inbound demo number stays connected to the shared Portive Clinic agent.

1. Open Automations and review the summary metrics (total website leads, prepared, running, failed).
2. Configure a batch:
	- Number of leads to prepare (count).
	- Max concurrency (1 to 5).
	- Skip already prepared leads (default).
	- Force re-scrape prepared leads or rescrape stale leads by age.
3. Start the batch. The system:
	- Selects eligible leads with a website and no active automation job.
	- Creates a batch and per-lead jobs in Supabase.
	- Runs jobs concurrently up to the max concurrency.
	- Marks each job `completed`, `failed`, or `skipped_existing`.
4. Monitor batches in real time; cancel a running batch if needed.
5. Review Prepared Leads:
	- Re-scrape a lead when data is stale or incomplete.
6. Review Failed Jobs and retry individual jobs.
7. The backend automatically resumes any pending or running batches when the summary is requested.

## Required Environment Variables

```env
ADMIN_PASSWORD=change-this-password
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TELNYX_API_KEY=
TELNYX_CONNECTION_ID=
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
- `TELNYX_FROM_NUMBER`
- `APP_BASE_URL` for real webhook delivery

Optional:

- `TELNYX_PUBLIC_KEY` for signature verification
- `TELNYX_MESSAGING_FROM_NUMBER` for manual follow-up SMS

## Telnyx Configuration

Use the existing FQDN SIP connection for outbound Call Control with:

- voice webhooks pointed at `/api/webhooks/telnyx/voice`

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

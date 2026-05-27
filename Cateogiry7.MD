# Cateogiry 7 - Paid Appointment Booking Backend Implementation

## 1. Current implementation status summary

| Point | Component | Expected purpose | Actual file/path found | Status | Notes |
|---:|---|---|---|---|---|
| 1 | Square SDK or REST | Talk to Square APIs | `lib/square/client.ts`, `package.json` | Done | No Square SDK dependency is installed. The implementation uses direct `fetch` REST calls. |
| 2 | Square client | Central Square config/request helper | `lib/square/client.ts` | Done | Loads env, sets headers, logs, retries temporary failures. |
| 3 | Square payments | Create payment links and read payment status | `lib/square/payments.ts` | Done | Uses `POST /v2/online-checkout/payment-links` and `GET /v2/payments/{id}`. |
| 4 | Square bookings | Availability search and booking creation | `lib/square/bookings.ts` | Done | Uses `POST /v2/bookings/availability/search`, `POST /v2/bookings`, and `GET /v2/bookings/{id}`. |
| 5 | Square customers | Find or create Square customer | `lib/square/customers.ts` | Done | Searches by phone first, creates customer if no match. |
| 6 | Square catalog | Service lookup/mapping | `lib/square/catalog.ts` | Done | Catalog search exists, but booking flow is mapping-first and requires the applied `clinic_services_square_map` table. |
| 7 | Square webhooks | Verify and normalize Square webhooks | `lib/square/webhooks.ts`, `app/api/webhooks/square/route.ts` | Done | Requires raw body, Square signature header, signature key, and notification URL. |
| 8 | WhatsApp sender | Send WhatsApp through Telnyx, not Twilio | `lib/messaging/send-whatsapp.ts` | Done | Uses `POST https://api.telnyx.com/v2/messages/whatsapp`. |
| 9 | Status machine | Central appointment/payment statuses | `lib/appointments/status-machine.ts` | Done | Defines statuses and allowed transitions, but route code mostly applies patch helpers rather than enforcing transitions everywhere. |
| 10 | ElevenLabs paid intent route | Voice tool creates paid appointment intent | `app/api/elevenlabs/tools/create-paid-appointment-intent/route.ts` | Done | Bearer-authenticated with `ELEVENLABS_TOOL_SECRET`. |
| 11 | Create payment link route | Manual/dashboard payment link creation | `app/api/square/create-payment-link/route.ts` | Done | Requires CRM session auth and same-origin for mutation. |
| 12 | Square webhook route | Payment completion and booking creation | `app/api/webhooks/square/route.ts` | Done | Handles `payment.updated`; other Square events are acknowledged and ignored. |
| 13 | Appointment debug route | Fetch status/debug state | `app/api/appointments/[id]/route.ts` | Done | Reads intent, payments, messages, workflow events, linked request/appointment. |
| 14 | Manual confirm route | Recovery/manual confirmation | `app/api/appointments/[id]/manual-confirm/route.ts` | Done | Can optionally create Square booking and send confirmation. |
| 15 | Send-link-again route | Recovery payment link resend | `app/api/appointments/[id]/send-link-again/route.ts` | Done | Blocks resend if payment is completed. |
| 16 | Secure pay token and page | Branded `/pay/[token]` page for dynamic WhatsApp URL button | `lib/payments/pay-token.ts`, `app/pay/[token]/page.tsx` | Done | Signed token wraps `appointment_intent_id`; page shows details and links to Square checkout. |
| 17 | Dynamic URL button | Send secure token as WhatsApp button URL variable | `lib/messaging/send-whatsapp.ts` | Done | Body params are caller/service/clinic; button param is token only. Raw Square URL is not sent in body. |
| 18 | Centralized logging | Square/Telnyx/payment workflow logs | `lib/logging/workflow-logger.ts` plus routes | Done | Logs redact tokens/API keys and mask phone numbers. |
| 19 | Idempotency keys | Avoid duplicate payment links/bookings/messages | `lib/appointments/idempotency.ts` | Partial | Square payment links and bookings use stable idempotency keys. Telnyx key helper exists but is not passed to Telnyx or stored as an idempotency guard. |
| 20 | Retry handling | Retry temporary Square/Telnyx failures | `lib/square/client.ts`, `lib/messaging/send-whatsapp.ts` | Done | Retries 429/5xx/network errors up to 2 times with short backoff. |
| 21 | Zod validation | Server-side request validation | `lib/validation/paid-appointment.ts` | Done | Covers tool input, manual routes, pay token params, and webhook shape checks. |
| 22 | Clear JSON responses | Debuggable JSON for voice/Codex/Vercel | `lib/api/paid-appointment-response.ts` | Done | Paid routes return `success`, `step`, `message`, `debug_id`, `appointment_intent_id`, `data`, and optional `say`. |

## 2. High-level system flow

Current implemented flow:

1. ElevenLabs calls `POST /api/elevenlabs/tools/create-paid-appointment-intent` with caller, phone, service, and selected time.
2. The backend validates the bearer token from `Authorization: Bearer <ELEVENLABS_TOOL_SECRET>`.
3. Zod validates and normalizes request fields.
4. Organization/clinic context is resolved directly from `organization_id` or from `lead_demo_profile_id`.
5. Service mapping is resolved from `clinic_services_square_map`.
6. Square availability is checked for the selected start time.
7. `appointment_intents` is inserted with `appointment_status=details_collected` and `payment_status=pending`.
8. Square payment link is created with direct REST.
9. A signed secure pay token is created.
10. `appointment_intents` is updated with Square payment link/order IDs and `payment_link_created`.
11. Telnyx sends WhatsApp template `appointment_deposit_link_v1` with body params and a dynamic URL button param containing only the pay token.
12. `message_events` and `appointment_workflow_events` are inserted.
13. Caller taps the WhatsApp button and opens `/pay/[token]`.
14. `/pay/[token]` verifies the signed token, loads the appointment intent, shows branded payment details, and links to the Square hosted checkout URL.
15. Square sends `payment.updated` to `POST /api/webhooks/square`.
16. The webhook verifies the Square signature using raw body plus `SQUARE_WEBHOOK_NOTIFICATION_URL`.
17. The backend finds the intent by `square_order_id`, updates payment status, and on completed payment marks `payment_completed`.
18. The backend re-checks availability, gets/creates a Square customer, creates a Square booking, marks `square_booking_created`, then marks `confirmed`.
19. Telnyx sends the confirmation WhatsApp template.
20. Debug/status can be read through `GET /api/appointments/[id]`.
21. Recovery is supported through `POST /api/appointments/[id]/send-link-again` and `POST /api/appointments/[id]/manual-confirm`.

```mermaid
sequenceDiagram
  participant Caller
  participant ElevenLabs
  participant Backend
  participant Supabase
  participant Square
  participant Telnyx
  participant PayPage as /pay/[token]

  Caller->>ElevenLabs: Provides name, phone, service, selected time
  ElevenLabs->>Backend: POST /api/elevenlabs/tools/create-paid-appointment-intent
  Backend->>Backend: Validate auth/body with Zod
  Backend->>Supabase: Resolve organization/service mapping
  Backend->>Square: Search availability
  Backend->>Supabase: Insert appointment_intents
  Backend->>Square: Create payment link
  Backend->>Backend: Create signed pay token
  Backend->>Supabase: Store Square link/order/status
  Backend->>Telnyx: Send WhatsApp template with dynamic token button
  Caller->>PayPage: Taps Pay Deposit
  PayPage->>Supabase: Verify token and load appointment
  Caller->>Square: Continue to hosted checkout
  Square->>Backend: POST /api/webhooks/square payment.updated
  Backend->>Supabase: Mark payment_completed
  Backend->>Square: Search availability and create booking
  Backend->>Supabase: Mark confirmed
  Backend->>Telnyx: Send confirmation WhatsApp
```

## 3. Endpoint inventory

| Route | Actual file path | Method | Who calls it | Auth/header/secret | Request body/query/params | Success response shape | Error response shape | Supabase tables read/written | External APIs called | Status transitions | Idempotency behavior | Logging behavior | Manual test method |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/api/elevenlabs/tools/create-paid-appointment-intent` | `app/api/elevenlabs/tools/create-paid-appointment-intent/route.ts` | POST | ElevenLabs server tool | `Authorization: Bearer ELEVENLABS_TOOL_SECRET` | JSON matching `CreatePaidAppointmentIntentSchema` | `okJson` with `payment_link_sent`, masked phone, `payment_status`, `appointment_status`, `brandedPayUrl`, `say` | `failJson`, `validationFailJson`, or `squareFailJson` with `error_code`, `step`, `debug_id`, `say` | Reads `lead_demo_profiles`, `clinic_services_square_map`; writes `appointment_intents`, `appointment_workflow_events`, `message_events` | Square availability, Square payment link, Telnyx WhatsApp | `details_collected -> payment_link_created -> payment_link_sent` | Stable Square payment-link key from appointment intent ID after insert | Workflow logs for request, auth, insert, Square, Telnyx, failures | Use an ElevenLabs tool call or a manual POST with a test secret; do not include secrets in shared logs. |
| `/api/square/create-payment-link` | `app/api/square/create-payment-link/route.ts` | POST | CRM operator/dashboard/manual test | CRM session via `requireApiAuth`; same-origin required for mutation | `{ "appointment_intent_id": "<uuid>", "send_message": false }` | `okJson` with link action, statuses, `checkout_url`, `brandedPayUrl`, optional send result | `failJson`/`validationFailJson` | Reads/writes `appointment_intents`; upserts `appointment_payments`; optionally writes `message_events`, `appointment_workflow_events` | Square payment link; optional Telnyx WhatsApp | May set `payment_link_created`; with send sets `payment_link_sent` | Reuses existing checkout URL unless missing; Square idempotency key is stable | Logs request, auth, Square result, message result, workflow events | Log into CRM, then POST from same origin or use browser dev tools/session-aware request. |
| `/api/webhooks/square` | `app/api/webhooks/square/route.ts` | POST | Square webhook service | `x-square-hmacsha256-signature`; requires `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_NOTIFICATION_URL` | Raw Square webhook body | `okJson` with received/ignored/status/booking info | `failJson`, `validationFailJson`, or `manualReviewJson` | Reads/writes `appointment_intents`, `appointment_payments`, `appointment_workflow_events`, `message_events` | Square retrieve payment, availability, customers, bookings; Telnyx confirmation/manual-review WhatsApp | non-completed payment updates `payment_status`; completed payment sets `payment_completed -> square_booking_created -> confirmed`, or `manual_review_needed` | Duplicate completed webhook with existing booking is ignored; booking creation uses stable idempotency key | Logs signature checks, ignored events, payment updates, booking/confirmation failures | Configure Square sandbox webhook and pay a sandbox checkout. |
| `/api/webhooks/telnyx/whatsapp` | Missing | POST | Intended Telnyx WhatsApp webhook | Intended `TELNYX_PUBLIC_KEY` signature verification | Telnyx delivery/inbound event payload | Not implemented | Not implemented | Not implemented | None | None | None | None | Current env points here, but no route exists. Either create this alias route or point Telnyx/env to `/api/webhooks/telnyx/messaging`. |
| `/api/webhooks/telnyx/messaging` | `app/api/webhooks/telnyx/messaging/route.ts` | POST | Telnyx messaging webhooks | `telnyx-signature-ed25519`, `telnyx-timestamp`, verified by `TELNYX_PUBLIC_KEY` unless skipped | Raw Telnyx webhook body | `okJson` accepted or duplicate ignored | `failJson` for malformed payload, invalid signature, store failure | Writes Prisma/workstation `telnyxWebhookEvent`; async processor handles messaging events | None directly in route | No Category 7 appointment status changes observed in this route | Duplicate event IDs are ignored through DB uniqueness/error handling | Stores signature result and processing error; async `processMessagingWebhookEvent` | Configure Telnyx webhook to this actual path, or add `/whatsapp` route. |
| `/api/appointments/[id]` | `app/api/appointments/[id]/route.ts` | GET | CRM/debug tool | CRM session via `requireApiAuth` | URL param `id` UUID | `okJson` with sanitized intent, payments, messages, workflow events, linked request/appointment | `failJson`/`validationFailJson` | Reads `appointment_intents`, `appointment_payments`, `message_events`, `appointment_workflow_events`, `appointment_requests`, `appointments` | None | None | None | Sanitizes token/secret-like fields in response | Log into CRM and GET the route for an intent ID. |
| `/api/appointments/[id]/manual-confirm` | `app/api/appointments/[id]/manual-confirm/route.ts` | POST | CRM operator/recovery | CRM session and same-origin | Params `id`; body `{ create_square_booking?, send_confirmation?, override_slot_unavailable?, note? }` | `okJson` with status, booking action, confirmation sent | `failJson`, `validationFailJson`, `manualReviewJson` | Reads/writes `appointment_intents`, `appointment_workflow_events`, `message_events` | Optional Square availability/customers/bookings; optional Telnyx confirmation | Existing confirmed is idempotent. Otherwise can set `square_booking_created`, `confirmed`, or `manual_review_needed` | Reuses existing booking; Square booking key is stable | Logs request, auth, payment guard, booking, confirmation, failures | Use after a paid/manual-review intent; include `override_slot_unavailable` only for demo/admin recovery. |
| `/api/appointments/[id]/send-link-again` | `app/api/appointments/[id]/send-link-again/route.ts` | POST | CRM operator/recovery | CRM session and same-origin | Params `id`; body `{ to_phone_e164?, force_new_link? }` | `okJson` with resend status, link action, `checkout_url`, `brandedPayUrl` | `failJson`, `validationFailJson`, `telnyxFailJson` | Reads/writes `appointment_intents`, `appointment_workflow_events`, `message_events` | Square payment link if missing; Telnyx WhatsApp | Creates link if missing, then sets `payment_link_sent`; blocked when `payment_status=completed` | Reuses existing link. `force_new_link` is currently ignored when a link exists. | Logs request, auth, recipient, resend, Telnyx errors | Use pending intent, approved template, and reachable WhatsApp recipient. |
| `/pay/[token]` | `app/pay/[token]/page.tsx` | GET/page | Caller from WhatsApp dynamic button | Signed token in path; no login | URL token must match `PayTokenRouteParamSchema` and HMAC verification | Server-rendered branded payment page with details and Square checkout link | Server-rendered error pages for invalid/expired token, not found, completed, missing checkout | Reads `appointment_intents` with service role | None during render; user clicks through to Square | None | Token expires; no DB token row exists | Logs invalid token, missing intent, already completed, render checkout | Open the generated `brandedPayUrl`; test invalid/expired/completed cases. |

## 4. Square implementation

- The code uses direct REST calls through `fetch`, not the Square SDK.
- `package.json` has no Square SDK dependency.
- Main request helper: `lib/square/client.ts`.
- Paid appointment checkout amount is the deposit amount only. Service mappings store the total service price in `service_price_cents`, the policy in `deposit_percent_bps` (`2000` = 20%), and the charged deposit in `deposit_amount_cents`.
- Demo Botox Consultation pricing should be `service_price_cents = 25000`, `deposit_percent_bps = 2000`, `deposit_amount_cents = 5000`, `currency = 'USD'`.
- Default sandbox base URL: `https://connect.squareupsandbox.com`.
- Default Square API version: `2026-05-20`.
- Headers sent on Square requests:
  - `Authorization: Bearer <SQUARE_ACCESS_TOKEN>`
  - `Square-Version: <SQUARE_API_VERSION>`
  - `Content-Type: application/json`
- Payment link endpoint: `POST /v2/online-checkout/payment-links`.
- Payment retrieval endpoint: `GET /v2/payments/{paymentId}`.
- Availability endpoint: `POST /v2/bookings/availability/search`.
- Booking endpoint: `POST /v2/bookings`.
- Customer search endpoint: `POST /v2/customers/search`.
- Customer creation endpoint: `POST /v2/customers`.
- Catalog search endpoint: `POST /v2/catalog/search-catalog-items`.
- Webhook verification: `lib/square/webhooks.ts` computes HMAC-SHA256 over `SQUARE_WEBHOOK_NOTIFICATION_URL + rawBody` and compares to `x-square-hmacsha256-signature`.
- Retry policy: retry 429, 500, 502, 503, 504, network `TypeError`, and `AbortError` up to 2 times.
- Idempotency policy:
  - Payment links: `appointment_intent:<id>:payment_link:v1`.
  - Bookings: `appointment_intent:<id>:square_booking:v1`.
  - Keys are truncated with a SHA-256 suffix if needed.
- Square IDs stored in Supabase:
  - `appointment_intents.square_payment_link_id`
  - `appointment_intents.square_order_id`
  - `appointment_intents.square_payment_link_url`
  - `appointment_intents.square_payment_id`
  - `appointment_intents.square_booking_id`
  - `appointment_intents.square_customer_id`
  - `appointment_payments.square_payment_id`
  - `appointment_payments.square_order_id`
  - `appointment_payments.square_payment_link_id`
  - `appointment_payments.square_checkout_url`

Current known sandbox/demo values to use in env/table mappings:

| Value | Current sandbox/demo value |
|---|---|
| `SQUARE_LOCATION_ID` | `L43CNC7VJFKGD` |
| `SQUARE_TEAM_MEMBER_ID` | `TMgkdyIbsbfT92me` |
| `SQUARE_BOTOX_SERVICE_VARIATION_ID` | `AMVXOV43BHNMI4QH6C4GTHTK` |
| `SQUARE_BOTOX_SERVICE_VARIATION_VERSION` | `1779597480505` |
| `SQUARE_BOTOX_DURATION_MINUTES` | `30` |
| `SQUARE_BOTOX_DEPOSIT_AMOUNT_CENTS` | `5000` |
| `SQUARE_CURRENCY` | `USD` |

These are sandbox/demo values. The implemented booking flow does not currently read the Botox env values directly for service resolution; it reads `clinic_services_square_map`. Keep the env values available for setup/docs, but do not rely on hardcoding them forever.

## 5. Telnyx WhatsApp implementation

- Provider: Telnyx WhatsApp.
- Not used: Twilio.
- Not used for WhatsApp: ElevenLabs.
- From number expected by env: `TELNYX_WHATSAPP_FROM_NUMBER=+13103318914`.
- Telnyx API endpoint used: `POST https://api.telnyx.com/v2/messages/whatsapp`.
- WABA/number operational state is not queried by code. Manual check is required for current approval/connection status. Based on setup context, the number was `CONNECTED` and `enabled=true`.
- `webhook_url` is included in the Telnyx payload when `TELNYX_WHATSAPP_WEBHOOK_URL` is configured.
- Current env example points `TELNYX_WHATSAPP_WEBHOOK_URL` to `https://cold-caller-crm.vercel.app/api/webhooks/telnyx/whatsapp`, but the actual implemented route is `/api/webhooks/telnyx/messaging`.

Templates:

| Template | Code env | Status in code | Params |
|---|---|---|---|
| `appointment_deposit_link_v1` | `TELNYX_WHATSAPP_PAYMENT_LINK_TEMPLATE` | Used | Body: caller name, service name, clinic name. Button URL param: secure pay token only. |
| `appointment_confirmed_v1` | `TELNYX_WHATSAPP_CONFIRMATION_TEMPLATE` | Used | Body: caller name, service name, clinic name, appointment date/time. |
| `appointment_reminder_v1` | `TELNYX_WHATSAPP_REMINDER_TEMPLATE` | Helper exists | Body: caller name, service name, clinic name, appointment date/time. No scheduled reminder route found. |

Approval status for these templates is not knowable from the code. Manual Telnyx/WABA check required.

Payment template details:

- Template name: `appointment_deposit_link_v1`.
- Body parameters, in order:
  1. Caller name.
  2. Service name.
  3. Clinic name.
- Button:
  - Type: URL button.
  - `sub_type`: `url`.
  - `index`: `0`.
  - Dynamic button parameter: signed secure pay token only.
- The template should render the final user-facing URL:
  - `https://cold-caller-crm.vercel.app/pay/<token>`
- The implementation intentionally does not send the raw Square checkout URL in the WhatsApp body.

Confirmation template details:

- Template name: `appointment_confirmed_v1`.
- Body params:
  1. Caller name.
  2. Service name.
  3. Clinic name.
  4. Appointment date/time.

Reminder template details:

- Template name: `appointment_reminder_v1`.
- Body params:
  1. Caller name.
  2. Service name.
  3. Clinic name.
  4. Appointment date/time.
- A send helper exists, but no scheduler/reminder route was found in Category 7.

Delivery/inbound events:

- Actual route implemented: `POST /api/webhooks/telnyx/messaging`.
- Intended env route: `POST /api/webhooks/telnyx/whatsapp`.
- The implemented messaging route verifies Telnyx signature headers and stores the event via Prisma/workstation DB, then calls `processMessagingWebhookEvent` asynchronously.
- I did not find Category 7-specific logic that updates `message_events` delivery status from Telnyx delivery callbacks.

## 6. Secure pay token and `/pay/[token]`

This exists so WhatsApp shows a branded Portive payment button instead of a raw Square checkout URL. Raw payment URLs in the message body look less trustworthy, and the current WhatsApp template uses a dynamic website button:

`https://cold-caller-crm.vercel.app/pay/{{1}}`

The backend supplies only `{{1}} = <secure pay token>`.

Implementation:

- Token file: `lib/payments/pay-token.ts`.
- Page file: `app/pay/[token]/page.tsx`.
- Required env: `PAY_LINK_SECRET`.
- Token format: `<base64url-json-payload>.<base64url-hmac-signature>`.
- HMAC: SHA-256 over the encoded payload with `PAY_LINK_SECRET`.
- Token contents:
  - `appointment_intent_id`
  - `exp`
  - `purpose: "square_payment_link"`
- Token expiry:
  - Created with `expiresInMinutes: 60 * 24 * 14`.
  - Current expiry is 14 days.
- The appointment intent ID is not exposed as the URL path. It is inside a signed payload, but the payload is base64url encoded, not encrypted. Anyone with the token can decode the appointment intent ID but cannot tamper with it without `PAY_LINK_SECRET`.

Page behavior:

- Invalid token format: shows "This payment link is invalid".
- Invalid signature or expired token: shows "This payment link has expired".
- Missing appointment intent: shows "Payment details not found".
- `payment_status=completed`: shows "Payment already completed".
- Missing `square_payment_link_url`: shows "Checkout is not ready".
- Valid pending token: shows clinic, service, appointment time, deposit amount, and a "Continue to secure checkout" link to Square.

Security assumptions:

- `PAY_LINK_SECRET` is long, random, and server-only.
- The page uses the Supabase service role server-side only.
- The page does not collect card data. Square hosted checkout handles payment.
- Tokens are signed and expiring, but not stored/revocable in DB.

Production improvements:

- Store token issuance/revocation state if links must be invalidated before expiry.
- Consider a shorter expiry for high-risk flows.
- Add a `payment_link_viewed` workflow event.
- Add `rel="noopener noreferrer"` if the Square link ever opens a new tab.

## 7. Supabase tables touched

The applied database source of truth is `supabase/migrations/square_migration_already_applied.sql`.

| Table | What it stores | Routes/files | Key columns used | Index/constraint assumptions | RLS/service role |
|---|---|---|---|---|---|
| `appointment_intents` | Main paid appointment workflow record | All Category 7 routes and `/pay/[token]` | IDs, organization/clinic, caller, service, Square IDs, statuses, selected time, deposit, error timestamps | Indexed by `id`; lookup by `square_order_id` should be indexed | Server uses service role. |
| `appointment_payments` | Square payment/payment-link records | `create-payment-link`, Square webhook, debug route | `appointment_intent_id`, `square_payment_id`, `square_order_id`, `square_payment_link_id`, `status`, `square_checkout_url`, `raw_square_payment` | Applied migration has unique indexes on `square_payment_id` and `square_webhook_event_id`; payment-link rows are found by intent/link ID before update/insert | Server uses service role. |
| `appointment_workflow_events` | Auditable workflow timeline | Most Category 7 routes | `organization_id`, `appointment_intent_id`, `event_type`, `event_source`, `event_status`, `payload` | `created_at` used by debug route ordering | Server uses service role. |
| `message_events` | Outbound WhatsApp send records | paid intent, create-payment-link, resend, webhook/manual confirmation | `provider`, `channel`, `message_type`, `to_phone_e164`, `provider_message_id`, `provider_status`, `status`, `payload` | `created_at` used by debug route ordering | Server uses service role. |
| `clinic_services_square_map` | Internal service to Square booking/payment settings | `lib/square/catalog.ts` | `organization_id`, `internal_service_name`, Square location/team/service/version/duration/deposit/currency | Needs lookup by organization and service name | Server uses service role. |
| `lead_demo_profiles` | Demo clinic context fallback | paid intent route | `id`, `organization_id`, `clinic_id`, `clinic_name`/`business_name` | Existing migration creates this table | Server uses service role. |
| `appointment_requests` | Older/non-paid appointment request records | debug route only as linked row | `id` from `appointment_intents.appointment_request_id` | Migration exists | Server uses service role. |
| `appointments` | Final/linked appointment record if present | debug route only as linked row | `id` from `appointment_intents.appointment_id` | No local migration found | Server uses service role. |
| `lead_clinic_services` | Extracted service information | Not directly used by Category 7 routes | Existing extraction table | Migration exists | Not in current paid flow. |
| `organizations` | Organization tenant record | Not directly queried in Category 7 code | IDs referenced on rows | No local migration found | Assumed existing platform table. |
| `clinics` | Clinic record | Not directly queried in Category 7 code | IDs referenced on rows | Seed references it, but create-table migration was not found | Assumed existing platform table. |
| `square_integrations` | Square seller/location integration storage | Not used by current API flow | Applied table exists for organization/clinic Square location metadata | Indexed by organization, clinic, location, merchant | Not used in current paid flow. |
| `square_staff_mappings` | Square staff/team member mapping storage | Not used by current API flow | Applied table exists for team member metadata | Unique by organization/environment/team member | Not used in current paid flow. |

## 8. Status machine and state transitions

Implemented in `lib/appointments/status-machine.ts`.

Appointment statuses:

- `details_collected`
- `payment_link_created`
- `payment_link_sent`
- `payment_pending`
- `payment_completed`
- `square_booking_created`
- `confirmed`
- `failed`
- `manual_review_needed`
- `cancelled`

Payment statuses:

- `not_required`
- `pending`
- `completed`
- `failed`
- `expired`
- `refunded`

Allowed appointment transitions in the status machine:

| From | To |
|---|---|
| `details_collected` | `payment_link_created`, `failed`, `cancelled` |
| `payment_link_created` | `payment_link_sent`, `failed`, `cancelled` |
| `payment_link_sent` | `payment_pending`, `failed`, `cancelled` |
| `payment_pending` | `payment_completed`, `failed`, `cancelled` |
| `payment_completed` | `square_booking_created`, `manual_review_needed`, `failed`, `cancelled` |
| `square_booking_created` | `confirmed`, `cancelled` |
| `manual_review_needed` | `confirmed`, `cancelled` |
| `confirmed` | none |
| `cancelled` | none |
| `failed` | none |

Actual route behavior:

- Paid intent route inserts `details_collected`, then sets `payment_link_created`, then `payment_link_sent`.
- Create-payment-link route sets `payment_link_created`; with message send it sets `payment_link_sent`.
- Send-link-again route creates a link if missing and sets `payment_link_sent`.
- Square webhook maps Square payment statuses to internal payment statuses.
- On completed payment, Square webhook sets `payment_completed`, then attempts Square booking.
- If booking succeeds, Square webhook sets `square_booking_created`, then `confirmed`.
- If booking fails or slot is unavailable after payment, Square webhook sets `manual_review_needed`.
- Manual confirm route can set `square_booking_created` and `confirmed`, or directly `confirmed`.
- Resend is blocked if `payment_status=completed`.
- Duplicate webhook with completed payment and existing `square_booking_id` is acknowledged and ignored.

## 9. Environment variables

| Env var | Required now or later | Used by file/route | Example value | How to get it | Sensitive? | Notes |
|---|---|---|---|---|---|---|
| `SUPABASE_URL` | Required now | `lib/supabase-admin.ts` | Supabase project URL | Supabase project settings | No | Actual code uses this, not `NEXT_PUBLIC_SUPABASE_URL`. |
| `NEXT_PUBLIC_SUPABASE_URL` | Later/not used by this code | None found | Supabase project URL | Supabase project settings | No | Include only if frontend Supabase client is added later. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Later/not used by this code | None found | anon key | Supabase API settings | Yes-ish | Not used in current Category 7 implementation. |
| `SUPABASE_SERVICE_ROLE_KEY` | Required now | `lib/supabase-admin.ts` | service role key | Supabase API settings | Yes | Server-only. |
| `SQUARE_ENV` | Required/defaulted | `lib/env.ts`, `lib/square/client.ts` | `sandbox` | Square app environment | No | Defaults to sandbox. |
| `SQUARE_BASE_URL` | Required/defaulted | `lib/square/client.ts` | `https://connect.squareupsandbox.com` | Square docs | No | Defaults to sandbox URL. |
| `SQUARE_API_VERSION` | Required/defaulted | `lib/square/client.ts` | `2026-05-20` | Square docs/dashboard | No | Defaults to `2026-05-20`. |
| `SQUARE_ACCESS_TOKEN` | Required now | `lib/square/client.ts` | sandbox token | Square developer dashboard/OAuth | Yes | Never log. |
| `SQUARE_APPLICATION_ID` | Later/not used | Not found | app id | Square dashboard | No | Requested for setup; current code does not read it. |
| `SQUARE_LOCATION_ID` | Required for env fallback/config | `lib/square/config.ts` | `L43CNC7VJFKGD` | Square location dashboard/API | No | Current paid route uses DB mapping, not this config helper. |
| `SQUARE_TEAM_MEMBER_ID` | Required for env fallback/config | `lib/square/config.ts` | `TMgkdyIbsbfT92me` | Square team API/dashboard | No | Current paid route uses DB mapping. |
| `SQUARE_BOTOX_SERVICE_VARIATION_ID` | Required for env fallback/config | `lib/square/config.ts` | `AMVXOV43BHNMI4QH6C4GTHTK` | Square catalog API | No | Current paid route uses DB mapping. |
| `SQUARE_BOTOX_SERVICE_VARIATION_VERSION` | Required for env fallback/config | `lib/square/config.ts` | `1779597480505` | Square catalog API | No | Current paid route uses DB mapping. |
| `SQUARE_BOTOX_DURATION_MINUTES` | Required for env fallback/config | `lib/square/config.ts` | `30` | Square service setup | No | Current paid route uses DB mapping. |
| `SQUARE_BOTOX_DEPOSIT_AMOUNT_CENTS` | Required for env fallback/config | `lib/square/config.ts` | `5000` | Business decision | No | Current paid route uses DB mapping. |
| `SQUARE_CURRENCY` | Required/defaulted | `lib/env.ts`, `lib/square/config.ts` | `USD` | Business/Square setup | No | Defaults to USD. |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Required for webhook | `lib/square/webhooks.ts` | webhook signature key | Square webhook subscription | Yes | Required to verify webhook. |
| `SQUARE_WEBHOOK_NOTIFICATION_URL` | Required for webhook | `lib/square/webhooks.ts` | `https://cold-caller-crm.vercel.app/api/webhooks/square` | Must exactly match Square subscription URL | No | Required for signature verification. |
| `TELNYX_API_KEY` | Required now | `lib/messaging/send-whatsapp.ts` | Telnyx API key | Telnyx portal | Yes | Used for WhatsApp sends. |
| `TELNYX_PUBLIC_KEY` | Required for webhook verification unless skipped | `lib/telnyx/signature.ts` | public Ed25519 key | Telnyx portal | No | Used by messaging/voice webhook routes. |
| `TELNYX_WHATSAPP_FROM_NUMBER` | Required now | `lib/messaging/send-whatsapp.ts` | `+13103318914` | Telnyx WhatsApp number | No | WhatsApp sender. |
| `TELNYX_WHATSAPP_PAYMENT_LINK_TEMPLATE` | Required now | `send-whatsapp.ts` | `appointment_deposit_link_v1` | Telnyx/WABA templates | No | Preferred env name. |
| `TELNYX_WHATSAPP_CONFIRMATION_TEMPLATE` | Required for confirmations | `send-whatsapp.ts` | `appointment_confirmed_v1` | Telnyx/WABA templates | No | Confirmation sends fail if missing. |
| `TELNYX_WHATSAPP_REMINDER_TEMPLATE` | Later/helper only | `send-whatsapp.ts` | `appointment_reminder_v1` | Telnyx/WABA templates | No | No reminder scheduler found. |
| `TELNYX_WHATSAPP_WEBHOOK_URL` | Required for delivery webhooks | `send-whatsapp.ts` | `https://cold-caller-crm.vercel.app/api/webhooks/telnyx/whatsapp` | Deployed app URL | No | Current value mismatches actual implemented `/messaging` route. |
| `PUBLIC_APP_URL` | Required now | paid intent, create link, resend | `https://cold-caller-crm.vercel.app` | Vercel production URL | No | Used to build `/pay/<token>`. |
| `APP_BASE_URL` | Fallback/voice webhooks | helpers and pay URL fallback | `http://localhost:3000` | Local/deployed URL | No | Category 7 uses it as fallback when `PUBLIC_APP_URL` missing. |
| `PAY_LINK_SECRET` | Required now | `lib/payments/pay-token.ts` | long random secret | Generate securely | Yes | Needed for token signing/verification. |
| `ELEVENLABS_TOOL_SECRET` | Required for tool route | paid intent route | long shared secret | Choose and configure in ElevenLabs | Yes | Bearer token. |
| `ELEVENLABS_WEBHOOK_SECRET` | Later/other ElevenLabs route | env only/other code | secret | ElevenLabs | Yes | Not used by paid intent route. |
| `DEMO_ORGANIZATION_ID` | Not used | Not found | UUID | N/A | No | Current env uses `DEMO_RUNTIME_ORGANIZATION_ID`, not this name. |
| `DEMO_RUNTIME_ORGANIZATION_ID` | Existing demo context | ElevenLabs demo helpers | UUID | Supabase org | No | Not directly used by paid intent route. |
| `NODE_ENV` | Runtime | `lib/env.ts` | `production` | Vercel/runtime | No | Defaults to development. |
| `ADMIN_PASSWORD` | Required for CRM session | auth routes | password | Choose manually | Yes | Needed for authenticated manual endpoints. |
| `TELNYX_SKIP_SIGNATURE_VERIFICATION` | Local/dev only | `lib/telnyx/signature.ts` | `false` | Manual | No | Do not enable in production. |

## 10. Manual setup checklist from our side

Square:

- [ ] Ensure Square sandbox app exists.
- [ ] Ensure the custom sandbox test account is selected.
- [ ] Ensure the OAuth/access token has scopes for online checkout, payments, bookings, customers, and catalog as needed.
- [ ] Ensure `SQUARE_LOCATION_ID=L43CNC7VJFKGD` is correct for the sandbox account.
- [ ] Ensure `SQUARE_TEAM_MEMBER_ID=TMgkdyIbsbfT92me` is correct and bookable.
- [ ] Ensure service variation `AMVXOV43BHNMI4QH6C4GTHTK` and version `1779597480505` are correct.
- [ ] Insert/verify `clinic_services_square_map` row for the organization and service name the ElevenLabs tool will send.
- [ ] Ensure availability search returns slots for the chosen time/provider/service.
- [ ] Configure Square webhook after the route is deployed.
- [ ] Webhook URL: `https://cold-caller-crm.vercel.app/api/webhooks/square`.
- [ ] Webhook events: at minimum `payment.updated`; add `payment.created` only if later code needs it.
- [ ] Copy Square webhook signature key to `SQUARE_WEBHOOK_SIGNATURE_KEY`.
- [ ] Set `SQUARE_WEBHOOK_NOTIFICATION_URL` to the exact webhook URL registered in Square.

Telnyx/WhatsApp:

- [ ] Ensure WABA/number is connected.
- [ ] Confirm `+13103318914` is `CONNECTED` and enabled.
- [ ] Ensure templates are approved.
- [ ] Confirm exact template names match env.
- [ ] Fix webhook path mismatch: either create `/api/webhooks/telnyx/whatsapp` or set `TELNYX_WHATSAPP_WEBHOOK_URL=https://cold-caller-crm.vercel.app/api/webhooks/telnyx/messaging`.
- [ ] Replace any temporary webhook.site URL with the final deployed route.
- [ ] Copy Telnyx public key if webhook verification is enabled.
- [ ] Run one test WhatsApp template send.

ElevenLabs:

- [ ] Add/update server tool pointing to `POST https://cold-caller-crm.vercel.app/api/elevenlabs/tools/create-paid-appointment-intent`.
- [ ] Configure `Authorization: Bearer <ELEVENLABS_TOOL_SECRET>`.
- [ ] Ensure tool schema fields match `CreatePaidAppointmentIntentSchema`.
- [ ] Update agent prompt: collect caller name, phone, service, date/time, confirmation channel, then call the tool.
- [ ] Tell the caller to tap the Pay Deposit button in WhatsApp.

Vercel:

- [ ] Add all required env vars.
- [ ] Redeploy after env changes.
- [ ] Ensure routes are deployed under production domain.
- [ ] Check Vercel logs for structured workflow logs.

Supabase:

- [ ] Confirm the applied `square_migration_already_applied.sql` tables exist in the target Supabase project.
- [ ] Confirm RLS/service role behavior.
- [ ] Confirm `appointment_intents` rows are created.
- [ ] Confirm `appointment_payments`, `message_events`, and `appointment_workflow_events` rows are logged.
- [ ] Confirm unique constraints needed by payment upserts exist.

## 11. Manual test plan

Manual commands/checks only; none were executed while writing this document.

Test 1: Square payment link only

1. Create or use an existing pending `appointment_intents` row.
2. From an authenticated CRM session, call `POST /api/square/create-payment-link`.
3. Confirm `appointment_intents.square_payment_link_url`, `square_order_id`, `square_payment_link_id`, `payment_status`, and `appointment_status` update.
4. Confirm `appointment_payments` row is upserted.
5. Open the returned Square checkout link manually.
6. Confirm the Square checkout amount equals `deposit_amount_cents`, not `service_price_cents`.
7. Confirm the response data includes `service_price_text`, `deposit_amount_text`, `deposit_percent_bps`, and `human_deposit_sentence`.

Test 2: `/pay/[token]`

1. Generate a token by creating an intent or using send-link-again/create-payment-link response.
2. Open `/pay/[token]`.
3. Confirm branded Portive page shows clinic, service, time, and deposit.
4. Click Continue to secure checkout.
5. Confirm Square hosted checkout opens.
6. Test an invalid token.
7. Test an expired token by creating a short-lived token in a local/debug-only context.
8. Test an appointment with `payment_status=completed`.

Test 3: Telnyx WhatsApp payment button

1. Ensure `appointment_deposit_link_v1` is approved.
2. Trigger paid intent or send-link-again.
3. Confirm WhatsApp arrives.
4. Confirm Pay Deposit button opens `https://cold-caller-crm.vercel.app/pay/<token>`.
5. Confirm the button parameter is only the token, not the full Square URL.

Test 4: Full ElevenLabs tool

1. Call the voice agent.
2. Provide caller name, phone, service, and date/time.
3. Confirm tool creates the intent.
4. Confirm WhatsApp button arrives.
5. Confirm the tool response `say` is suitable for the caller.

Test 5: Square webhook

1. Pay the sandbox checkout.
2. Confirm Square webhook reaches Vercel.
3. Confirm `payment_status=completed`.
4. Confirm Square booking is created.
5. Confirm `appointment_payments.amount_cents` equals the deposit amount and `appointment_intents.deposit_amount_cents` remains the charged deposit.
6. Confirm `appointment_status=confirmed`.
7. Confirm confirmation WhatsApp is sent.

Test 6: failure/recovery

1. Make booking fail after payment, for example by selecting a slot that becomes unavailable.
2. Confirm `manual_review_needed`.
3. Use manual-confirm route with/without Square booking as appropriate.
4. Resend link while payment is pending.
5. Confirm resend is blocked when payment is completed.

Example safe curl shapes with placeholders:

```bash
curl -X POST https://cold-caller-crm.vercel.app/api/elevenlabs/tools/create-paid-appointment-intent \
  -H "Authorization: Bearer $ELEVENLABS_TOOL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"caller_name":"Test Caller","caller_phone":"+13105550123","service_name":"Botox Consultation","selected_start_at":"2026-05-25T17:00:00Z","organization_id":"replace-with-org-uuid"}'
```

```bash
curl -X POST https://cold-caller-crm.vercel.app/api/square/create-payment-link \
  -H "Content-Type: application/json" \
  -d '{"appointment_intent_id":"replace-with-intent-uuid","send_message":false}'
```

The second curl requires an authenticated CRM session/same-origin context in the current code, so plain terminal curl will return unauthorized unless auth is adapted for manual testing.

## 12. Assumptions and current limitations

- Square sandbox, not production.
- One demo organization/location for now.
- One provider/team member for now.
- Botox Consultation is the first mapped service assumption, but current code requires a `clinic_services_square_map` row for whatever service name is submitted.
- Telnyx WhatsApp templates must be approved before sends work.
- WhatsApp recipient must be reachable on WhatsApp.
- `/pay/[token]` requires deployed `PUBLIC_APP_URL` for the button template.
- Square webhook will not work until the endpoint is deployed and the Square webhook subscription exists.
- Telnyx delivery webhook will not work until the configured webhook URL matches a real route.
- Service role key is used only server-side.
- No raw card data is stored.
- This remains demo/sandbox until production OAuth and client onboarding exist.
- The applied Category 7 database shape is captured in `supabase/migrations/square_migration_already_applied.sql`; API code should continue to follow those table and column names.

## 13. Security and privacy notes

- Never log Square access tokens.
- Never expose Supabase service role to frontend code.
- Never store raw card details.
- Do not put Square access tokens in Supabase plain text.
- Verify Square webhooks with raw body and signature.
- Verify Telnyx webhooks with `TELNYX_PUBLIC_KEY` unless intentionally disabled in local development.
- Use signed/expiring pay tokens.
- Use Square idempotency keys for payment links and bookings.
- Mask phone numbers in logs.
- Store only non-sensitive Square IDs/statuses.
- Treat the pay token payload as signed, not encrypted.

## 14. What to do next

Priority fixes/checks based on the current repo:

1. Create or confirm migrations/table definitions for `appointment_intents`, `appointment_payments`, `appointment_workflow_events`, `message_events`, and `clinic_services_square_map`.
2. Fix the Telnyx WhatsApp webhook path mismatch: add `/api/webhooks/telnyx/whatsapp` as an alias or change `TELNYX_WHATSAPP_WEBHOOK_URL` to `/api/webhooks/telnyx/messaging`.
3. Insert/verify the `clinic_services_square_map` row for the Portive demo Botox service using the sandbox Square IDs.
4. Add env vars to Vercel.
5. Confirm WhatsApp templates are approved.
6. Deploy.
7. Configure Square webhook.
8. Configure Telnyx webhook.
9. Run the full manual test plan.
10. Fix issues from Vercel/Supabase/Square/Telnyx logs.

## 15. Appendix: route map

- `POST /api/elevenlabs/tools/create-paid-appointment-intent` - ElevenLabs voice tool creates intent, payment link, pay token, and WhatsApp payment button.
- `POST /api/square/create-payment-link` - Authenticated manual route to create/reuse a Square payment link and optionally send WhatsApp.
- `POST /api/webhooks/square` - Square webhook handler for `payment.updated`, payment status, booking creation, and confirmation message.
- `POST /api/webhooks/telnyx/whatsapp` - Intended WhatsApp webhook route, but missing in current repo.
- `POST /api/webhooks/telnyx/messaging` - Actual implemented Telnyx messaging webhook route.
- `GET /api/appointments/[id]` - Authenticated debug/status view for paid appointment state.
- `POST /api/appointments/[id]/manual-confirm` - Authenticated recovery route to manually confirm and optionally create booking/send confirmation.
- `POST /api/appointments/[id]/send-link-again` - Authenticated recovery route to resend the dynamic payment button.
- `GET /pay/[token]` - Branded Portive payment page that verifies token and links to Square checkout.

## 16. Appendix: final env block

```env
# App
PUBLIC_APP_URL=https://cold-caller-crm.vercel.app
APP_BASE_URL=https://cold-caller-crm.vercel.app
PAY_LINK_SECRET=replace_with_long_random_secret
ADMIN_PASSWORD=replace_with_admin_password
NODE_ENV=production

# Supabase
SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Square Sandbox
SQUARE_ENV=sandbox
SQUARE_BASE_URL=https://connect.squareupsandbox.com
SQUARE_API_VERSION=2026-05-20
SQUARE_ACCESS_TOKEN=
SQUARE_APPLICATION_ID=
SQUARE_LOCATION_ID=L43CNC7VJFKGD
SQUARE_TEAM_MEMBER_ID=TMgkdyIbsbfT92me
SQUARE_BOTOX_SERVICE_VARIATION_ID=AMVXOV43BHNMI4QH6C4GTHTK
SQUARE_BOTOX_SERVICE_VARIATION_VERSION=1779597480505
SQUARE_BOTOX_DURATION_MINUTES=30
SQUARE_BOTOX_DEPOSIT_AMOUNT_CENTS=5000
SQUARE_CURRENCY=USD
SQUARE_WEBHOOK_SIGNATURE_KEY=
SQUARE_WEBHOOK_NOTIFICATION_URL=https://cold-caller-crm.vercel.app/api/webhooks/square

# Telnyx WhatsApp
TELNYX_API_KEY=
TELNYX_PUBLIC_KEY=
TELNYX_WHATSAPP_FROM_NUMBER=+13103318914
TELNYX_WHATSAPP_PAYMENT_LINK_TEMPLATE=appointment_deposit_link_v1
TELNYX_WHATSAPP_CONFIRMATION_TEMPLATE=appointment_confirmed_v1
TELNYX_WHATSAPP_REMINDER_TEMPLATE=appointment_reminder_v1
TELNYX_WHATSAPP_WEBHOOK_URL=https://cold-caller-crm.vercel.app/api/webhooks/telnyx/whatsapp

# ElevenLabs
ELEVENLABS_TOOL_SECRET=
ELEVENLABS_WEBHOOK_SECRET=

# Existing Telnyx voice/SMS settings if still used elsewhere in the CRM
TELNYX_CONNECTION_ID=
TELNYX_TELEPHONY_CREDENTIAL_ID=
TELNYX_FROM_NUMBER=+13103318914
TELNYX_MESSAGING_FROM_NUMBER=+13103318914
TELNYX_MANUAL_DIAL_FLOW=browser_first
TELNYX_SKIP_SIGNATURE_VERIFICATION=false
```

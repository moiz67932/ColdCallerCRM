-- Targeted demo cleanup for one paid appointment attempt.
--
-- Affected tables and why they are safe to delete from:
-- - message_events: outbound Telnyx WhatsApp payment/confirmation/manual-review logs for the matched appointment intent.
-- - appointment_workflow_events: backend audit trail for the matched appointment intent.
-- - appointment_payments: Square payment-link/payment state for the matched appointment intent. This does not delete Square itself.
-- - square_webhook_events: Square webhook idempotency/debug records for the matched appointment intent.
-- - appointment_requests: legacy/manual appointment request rows only when linked to the matched paid appointment intent.
-- - appointments: local appointment rows only when linked to the matched paid appointment intent. The paid Square flow usually does not create these.
-- - appointment_intents: source-of-truth paid appointment intent row for the exact org/caller/service/time below.
--
-- Not deleted:
-- - clinic_services_square_map, square_integrations, square_staff_mappings: service catalog and Square config.
-- - organizations, clinics, users, phone numbers, leads, lead_demo_profiles: tenant/config/lead data.
-- - Square payments/bookings in Square: this only cleans local database rows.

begin;

-- Show what will be removed before the deletes run in this transaction.
select 'appointment_intents' as table_name, count(*) as rows_to_delete
from public.appointment_intents
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
  and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
  and service_name = 'Hydrafacial'
  and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
union all
select 'appointment_payments', count(*)
from public.appointment_payments
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
)
union all
select 'appointment_workflow_events', count(*)
from public.appointment_workflow_events
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
)
union all
select 'square_webhook_events', count(*)
from public.square_webhook_events
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
)
union all
select 'message_events', count(*)
from public.message_events
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
)
union all
select 'appointment_requests', count(*)
from public.appointment_requests
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
)
union all
select 'appointments', count(*)
from public.appointments
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
);

delete from public.message_events
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
);

delete from public.appointment_workflow_events
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
);

delete from public.appointment_payments
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
);

delete from public.square_webhook_events
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
);

delete from public.appointment_requests
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
);

delete from public.appointments
where appointment_intent_id in (
  select id
  from public.appointment_intents
  where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
    and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
    and service_name = 'Hydrafacial'
    and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz
);

delete from public.appointment_intents
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
  and coalesce(caller_phone_e164, caller_phone) = '+923205031232'
  and service_name = 'Hydrafacial'
  and selected_start_at = '2026-06-01T20:00:00Z'::timestamptz;

commit;

-- Full appointment-data reset for one demo organization.
--
-- Affected tables and why they are safe to delete from:
-- - message_events: outbound/inbound appointment communication logs, including WhatsApp payment links and confirmations.
-- - appointment_workflow_events: appointment workflow audit/debug events.
-- - appointment_payments: local Square payment-link/payment status rows. This does not delete anything in Square.
-- - square_webhook_events: Square webhook idempotency/debug records for local appointment processing.
-- - appointment_requests: legacy/manual appointment request rows for this organization.
-- - appointments: local scheduled appointment rows for this organization.
-- - appointment_intents: paid appointment source-of-truth rows for this organization.
--
-- Deliberately not deleted:
-- - clinic_services_square_map: service catalog and backend pricing/deposit config.
-- - square_integrations, square_staff_mappings: Square integration/provider config.
-- - organizations, organization_members, users/auth data.
-- - clinics and clinic config.
-- - leads, lead_demo_profiles, phone numbers, ElevenLabs bindings/conversations.
-- - Square-side customers, orders, payments, payment links, or bookings.

begin;

-- Show what will be removed before the deletes run in this transaction.
select 'message_events' as table_name, count(*) as rows_to_delete
from public.message_events
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
union all
select 'appointment_workflow_events', count(*)
from public.appointment_workflow_events
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
union all
select 'appointment_payments', count(*)
from public.appointment_payments
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
union all
select 'square_webhook_events', count(*)
from public.square_webhook_events
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
   or appointment_intent_id in (
     select id
     from public.appointment_intents
     where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
   )
union all
select 'appointment_requests', count(*)
from public.appointment_requests
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
union all
select 'appointments', count(*)
from public.appointments
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
union all
select 'appointment_intents', count(*)
from public.appointment_intents
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid;

delete from public.message_events
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid;

delete from public.appointment_workflow_events
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid;

delete from public.appointment_payments
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid;

delete from public.square_webhook_events
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
   or appointment_intent_id in (
     select id
     from public.appointment_intents
     where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
   );

delete from public.appointment_requests
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid;

delete from public.appointments
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid;

delete from public.appointment_intents
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid;

commit;

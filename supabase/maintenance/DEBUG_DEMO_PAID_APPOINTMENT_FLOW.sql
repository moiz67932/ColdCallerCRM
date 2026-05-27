-- Debug paid appointment rows for the demo org/caller/payment.
-- Safe read-only script.

select
  id,
  organization_id,
  caller_name,
  caller_phone,
  caller_phone_e164,
  service_name,
  selected_start_at,
  selected_timezone,
  selected_time_display,
  payment_status,
  appointment_status,
  booking_status,
  square_booking_id,
  square_payment_id,
  square_order_id,
  square_payment_link_id,
  idempotency_key,
  last_error,
  created_at,
  updated_at,
  metadata
from public.appointment_intents
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
  and (
    caller_phone_e164 = '+923205031232'
    or caller_phone = '+923205031232'
    or id = 'f5c7ce16-c3ae-4668-92e8-8523e4e85706'::uuid
    or square_payment_id = 'LBmK3K1KDJbzJP2nsweyYTxQ0jFZY'
    or square_order_id = 'bI9gNG4gHdjs1Sf34spzLfkYUxbZY'
  )
order by created_at desc
limit 25;

select
  id,
  organization_id,
  appointment_intent_id,
  provider,
  payment_mode,
  amount_cents,
  currency,
  status,
  square_order_id,
  square_payment_id,
  square_payment_link_id,
  square_webhook_event_id,
  paid_at,
  failed_at,
  created_at,
  updated_at,
  metadata,
  raw_square_payment
from public.appointment_payments
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
  and (
    appointment_intent_id = 'f5c7ce16-c3ae-4668-92e8-8523e4e85706'::uuid
    or square_payment_id = 'LBmK3K1KDJbzJP2nsweyYTxQ0jFZY'
    or square_order_id = 'bI9gNG4gHdjs1Sf34spzLfkYUxbZY'
  )
order by created_at desc;

select
  id,
  organization_id,
  appointment_intent_id,
  channel,
  message_type,
  provider,
  direction,
  to_phone,
  to_phone_e164,
  provider_message_id,
  provider_status,
  status,
  sent_at,
  failed_at,
  error_message,
  created_at,
  updated_at,
  payload
from public.message_events
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
  and (
    appointment_intent_id = 'f5c7ce16-c3ae-4668-92e8-8523e4e85706'::uuid
    or to_phone_e164 = '+923205031232'
    or to_phone = '+923205031232'
    or payload::text ilike '%LBmK3K1KDJbzJP2nsweyYTxQ0jFZY%'
    or payload::text ilike '%bI9gNG4gHdjs1Sf34spzLfkYUxbZY%'
  )
order by created_at desc
limit 50;

select
  id,
  organization_id,
  appointment_intent_id,
  event_type,
  event_source,
  event_status,
  message,
  error_message,
  created_at,
  payload
from public.appointment_workflow_events
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
  and (
    appointment_intent_id = 'f5c7ce16-c3ae-4668-92e8-8523e4e85706'::uuid
    or payload::text ilike '%LBmK3K1KDJbzJP2nsweyYTxQ0jFZY%'
    or payload::text ilike '%bI9gNG4gHdjs1Sf34spzLfkYUxbZY%'
  )
order by created_at desc
limit 100;

select
  id,
  organization_id,
  square_event_id,
  event_type,
  square_payment_id,
  square_order_id,
  appointment_intent_id,
  status,
  error_message,
  processed_at,
  created_at,
  payload
from public.square_webhook_events
where organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
   or square_payment_id = 'LBmK3K1KDJbzJP2nsweyYTxQ0jFZY'
   or square_order_id = 'bI9gNG4gHdjs1Sf34spzLfkYUxbZY'
   or appointment_intent_id = 'f5c7ce16-c3ae-4668-92e8-8523e4e85706'::uuid
order by created_at desc
limit 50;

-- Find completed deposits that did not finish Square calendar booking.
select
  id,
  organization_id,
  caller_phone_e164,
  service_name,
  selected_start_at,
  selected_timezone,
  selected_time_display,
  payment_status,
  appointment_status,
  booking_status,
  booking_attempt_count,
  last_booking_attempt_at,
  square_payment_id,
  square_order_id,
  square_booking_id,
  last_error,
  last_error_code,
  created_at,
  updated_at
from public.appointment_intents
where payment_status = 'completed'
  and square_booking_id is null
order by updated_at desc;

-- Reset only the known stuck Hydrafacial test row so the admin retry endpoint can reprocess it.
-- This does not delete the payment, Square order, Square payment link, messages, service catalog, or integration config.
update public.appointment_intents
set
  booking_status = 'booking_failed',
  appointment_status = 'manual_review_needed',
  last_error = 'Reset from stale creating_booking state for retry.',
  last_error_code = 'MANUAL_RETRY_RESET',
  updated_at = now()
where id = '2d37ffa7-eac6-440a-bd0c-9ae7f28167fa'::uuid
  and organization_id = '54673cc5-1b6d-4b53-af05-e1d792c466fd'::uuid
  and caller_phone_e164 = '+923205031232'
  and service_name = 'Hydrafacial'
  and payment_status = 'completed'
  and square_booking_id is null;

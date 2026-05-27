alter table public.appointment_intents
  add column if not exists booking_status text,
  add column if not exists last_error text,
  add column if not exists last_error_code text,
  add column if not exists booking_attempt_count integer not null default 0,
  add column if not exists last_booking_attempt_at timestamp with time zone,
  add column if not exists selected_timezone text,
  add column if not exists selected_time_display text;

update public.appointment_intents
set booking_status = 'not_started'
where booking_status is null;

alter table public.appointment_intents
  alter column booking_status set default 'not_started',
  alter column booking_status set not null;

alter table public.appointment_intents
  drop constraint if exists appointment_intents_booking_status_check;

alter table public.appointment_intents
  add constraint appointment_intents_booking_status_check
  check (booking_status in ('not_started', 'creating_booking', 'created', 'booking_failed', 'failed')) not valid;

create index if not exists idx_appointment_intents_booking_retry
on public.appointment_intents (payment_status, booking_status, updated_at)
where square_booking_id is null;

create table if not exists public.appointment_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  lead_id text,
  lead_demo_profile_id uuid,
  binding_id uuid,
  conversation_id text not null,
  agent_id text,
  caller_e164 text,
  called_e164 text,
  client_name text not null,
  phone_e164 text,
  email text,
  service_requested text,
  preferred_date_time_text text,
  preferred_date_time_start timestamptz,
  timezone text,
  new_or_existing text,
  special_requests text,
  status text not null default 'pending',
  source text not null default 'elevenlabs_voice',
  provider text not null default 'manual',
  provider_booking_id text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists appointment_requests_conversation_id_idx
  on public.appointment_requests(conversation_id);

create index if not exists appointment_requests_binding_id_idx
  on public.appointment_requests(binding_id);

create index if not exists appointment_requests_lead_id_idx
  on public.appointment_requests(lead_id);

create index if not exists appointment_requests_status_idx
  on public.appointment_requests(status);

create index if not exists appointment_requests_created_at_idx
  on public.appointment_requests(created_at desc);

create unique index if not exists appointment_requests_voice_idempotency_idx
  on public.appointment_requests(conversation_id, client_name, service_requested, preferred_date_time_text);

drop trigger if exists appointment_requests_touch_updated_at on public.appointment_requests;

create trigger appointment_requests_touch_updated_at
  before update on public.appointment_requests
  for each row execute function public.touch_updated_at();

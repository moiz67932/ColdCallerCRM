create extension if not exists pgcrypto;

create table if not exists public.lead_lists (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  source_file_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.leads (
  id text primary key default gen_random_uuid()::text,
  lead_list_id text not null references public.lead_lists(id) on delete cascade,
  business_name text,
  contact_name text,
  phone_number text not null,
  city text,
  state text,
  niche text,
  website text,
  notes text,
  custom_fields_json jsonb,
  derived_status text not null default 'new',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lead_list_id, phone_number)
);

create table if not exists public.call_attempts (
  id text primary key default gen_random_uuid()::text,
  lead_id text not null references public.leads(id) on delete cascade,
  direction text not null default 'outbound',
  status text not null default 'dialing',
  outcome text,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  operator_notes text,
  callback_at timestamptz,
  next_action text,
  telnyx_connection_id text,
  telnyx_call_session_id text,
  telnyx_call_control_id text,
  telnyx_call_leg_id text,
  telnyx_agent_call_control_id text,
  telnyx_agent_call_leg_id text,
  amd_result text,
  recording_id text,
  transcript_id text,
  raw_summary_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.call_recordings (
  id text primary key default gen_random_uuid()::text,
  call_attempt_id text not null unique references public.call_attempts(id) on delete cascade,
  telnyx_recording_id text not null,
  download_url text,
  file_name text,
  duration_millis integer,
  channels text,
  created_at timestamptz not null default now(),
  raw_payload_json jsonb not null
);

create table if not exists public.workstation_call_transcripts (
  id text primary key default gen_random_uuid()::text,
  call_attempt_id text not null unique references public.call_attempts(id) on delete cascade,
  telnyx_transcript_id text not null,
  text text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  raw_payload_json jsonb not null
);

create table if not exists public.lead_notes (
  id text primary key default gen_random_uuid()::text,
  lead_id text not null references public.leads(id) on delete cascade,
  call_attempt_id text references public.call_attempts(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.follow_ups (
  id text primary key default gen_random_uuid()::text,
  lead_id text not null references public.leads(id) on delete cascade,
  call_attempt_id text references public.call_attempts(id) on delete set null,
  due_at timestamptz not null,
  status text not null default 'open',
  channel text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sms_messages (
  id text primary key default gen_random_uuid()::text,
  lead_id text not null references public.leads(id) on delete cascade,
  call_attempt_id text references public.call_attempts(id) on delete set null,
  telnyx_message_id text unique,
  direction text not null default 'outbound',
  from_number text not null,
  to_number text not null,
  text text not null,
  status text not null default 'queued',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  raw_payload_json jsonb
);

create table if not exists public.workstation_telnyx_webhook_events (
  id text primary key default gen_random_uuid()::text,
  event_id text not null unique,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  call_control_id text,
  payload_json jsonb not null,
  signature_verified boolean not null default false,
  processing_error text
);

create table if not exists public.app_settings (
  id text primary key default gen_random_uuid()::text,
  key text not null unique,
  value_json jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.lead_demo_profiles (
  id uuid primary key default gen_random_uuid(),
  lead_id text not null unique references public.leads(id) on delete cascade,
  organization_id uuid not null,
  clinic_id uuid,
  agent_id uuid not null,
  source_website_url text not null,
  business_name text,
  status text not null default 'draft',
  extraction_confidence numeric(5,2),
  extracted_profile_json jsonb not null default '{}',
  last_scraped_at timestamptz,
  last_activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lead_website_scrape_jobs (
  id uuid primary key default gen_random_uuid(),
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid references public.lead_demo_profiles(id) on delete cascade,
  organization_id uuid not null,
  root_url text not null,
  status text not null default 'pending',
  pages_discovered integer not null default 0,
  pages_scraped integer not null default 0,
  pages_failed integer not null default 0,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lead_website_pages (
  id uuid primary key default gen_random_uuid(),
  scrape_job_id uuid not null references public.lead_website_scrape_jobs(id) on delete cascade,
  lead_id text not null references public.leads(id) on delete cascade,
  organization_id uuid not null,
  url text not null,
  canonical_url text,
  page_type text,
  http_status integer,
  title text,
  meta_description text,
  cleaned_text text,
  json_ld jsonb not null default '[]',
  extracted_json jsonb not null default '{}',
  content_hash text not null,
  scraped_at timestamptz not null default now(),
  unique (scrape_job_id, url)
);

create table if not exists public.lead_demo_activations (
  id uuid primary key default gen_random_uuid(),
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid references public.lead_demo_profiles(id) on delete set null,
  organization_id uuid not null,
  clinic_id uuid not null,
  agent_id uuid not null,
  phone_e164 text not null,
  activated_by uuid,
  previous_clinic_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists lead_lists_created_at_idx on public.lead_lists(created_at);
create index if not exists leads_lead_list_created_at_idx on public.leads(lead_list_id, created_at);
create index if not exists leads_derived_status_idx on public.leads(derived_status);
create index if not exists call_attempts_lead_created_at_idx on public.call_attempts(lead_id, created_at);
create index if not exists call_attempts_status_idx on public.call_attempts(status);
create index if not exists call_attempts_outcome_idx on public.call_attempts(outcome);
create index if not exists call_attempts_telnyx_control_idx on public.call_attempts(telnyx_call_control_id);
create index if not exists call_attempts_telnyx_agent_control_idx on public.call_attempts(telnyx_agent_call_control_id);
create index if not exists call_attempts_telnyx_session_idx on public.call_attempts(telnyx_call_session_id);
create index if not exists follow_ups_lead_due_idx on public.follow_ups(lead_id, due_at);
create index if not exists follow_ups_status_due_idx on public.follow_ups(status, due_at);
create index if not exists sms_messages_lead_created_at_idx on public.sms_messages(lead_id, created_at);
create index if not exists webhook_events_type_received_idx on public.workstation_telnyx_webhook_events(event_type, received_at);
create index if not exists webhook_events_call_control_idx on public.workstation_telnyx_webhook_events(call_control_id);
create index if not exists lead_demo_profiles_agent_idx on public.lead_demo_profiles(agent_id);
create index if not exists scrape_jobs_lead_created_idx on public.lead_website_scrape_jobs(lead_id, created_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'leads',
    'call_attempts',
    'follow_ups',
    'sms_messages',
    'app_settings',
    'lead_demo_profiles',
    'lead_website_scrape_jobs'
  ]
  loop
    execute format('drop trigger if exists %I_touch_updated_at on public.%I', table_name, table_name);
    execute format(
      'create trigger %I_touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()',
      table_name,
      table_name
    );
  end loop;
end $$;

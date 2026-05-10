create table if not exists public.elevenlabs_demo_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  elevenlabs_agent_id text not null,
  phone_e164 text not null,
  caller_e164 text,
  status text not null default 'active',
  activated_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata_json jsonb not null default '{}'::jsonb,
  constraint elevenlabs_demo_bindings_status_check
    check (status in ('active', 'inactive', 'expired', 'replaced', 'failed'))
);

comment on table public.elevenlabs_demo_bindings is
  'Active routing bindings for ElevenLabs demo callbacks. Maps caller/called phone numbers to prepared lead demo profiles.';

comment on column public.elevenlabs_demo_bindings.lead_demo_profile_id is
  'Prepared CRM lead demo profile used as the active demo context for the ElevenLabs callback.';

comment on column public.elevenlabs_demo_bindings.elevenlabs_agent_id is
  'Shared ElevenLabs agent identifier connected to the demo callback phone number.';

comment on column public.elevenlabs_demo_bindings.phone_e164 is
  'Called Telnyx phone number, in E.164 format, already connected to the ElevenLabs agent.';

comment on column public.elevenlabs_demo_bindings.caller_e164 is
  'Optional caller phone number used with phone_e164 by future ElevenLabs server tools to resolve call context.';

comment on column public.elevenlabs_demo_bindings.status is
  'Current routing lifecycle state. lead_demo_activations remains the historical audit table; this table stores current routing state.';

create index if not exists elevenlabs_demo_bindings_lookup_idx
  on public.elevenlabs_demo_bindings(caller_e164, phone_e164, status);

create index if not exists elevenlabs_demo_bindings_lead_status_idx
  on public.elevenlabs_demo_bindings(lead_id, status);

create index if not exists elevenlabs_demo_bindings_profile_status_idx
  on public.elevenlabs_demo_bindings(lead_demo_profile_id, status);

create index if not exists elevenlabs_demo_bindings_agent_phone_status_idx
  on public.elevenlabs_demo_bindings(elevenlabs_agent_id, phone_e164, status);

create index if not exists elevenlabs_demo_bindings_created_at_idx
  on public.elevenlabs_demo_bindings(created_at desc);

create unique index if not exists elevenlabs_demo_bindings_one_active_per_lead_phone_idx
  on public.elevenlabs_demo_bindings(lead_id, elevenlabs_agent_id, phone_e164)
  where status = 'active';

create unique index if not exists elevenlabs_demo_bindings_one_active_per_caller_phone_idx
  on public.elevenlabs_demo_bindings(caller_e164, phone_e164)
  where status = 'active' and caller_e164 is not null;

drop trigger if exists elevenlabs_demo_bindings_touch_updated_at on public.elevenlabs_demo_bindings;

create trigger elevenlabs_demo_bindings_touch_updated_at
  before update on public.elevenlabs_demo_bindings
  for each row execute function public.touch_updated_at();

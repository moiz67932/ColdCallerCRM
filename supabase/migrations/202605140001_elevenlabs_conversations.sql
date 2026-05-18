create table if not exists public.elevenlabs_conversations (
  id uuid primary key default gen_random_uuid(),
  conversation_id text unique,
  organization_id uuid,
  lead_id text references public.leads(id) on delete set null,
  lead_demo_profile_id uuid references public.lead_demo_profiles(id) on delete set null,
  elevenlabs_agent_id text,
  caller_e164 text,
  called_e164 text,
  status text not null default 'received',
  transcript text,
  summary_text text,
  summary_json jsonb not null default '{}'::jsonb,
  analysis_json jsonb not null default '{}'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  raw_payload_json jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint elevenlabs_conversations_status_check
    check (status in ('received', 'started', 'completed', 'failed', 'unknown'))
);

comment on table public.elevenlabs_conversations is
  'Stores ElevenLabs post-call webhook data for transcripts, summaries, metadata, and raw payload audit.';

comment on column public.elevenlabs_conversations.raw_payload_json is
  'Full raw ElevenLabs webhook payload retained for audit and parser backfills.';

comment on column public.elevenlabs_conversations.metadata_json is
  'Normalized extraction metadata and notes from tolerant post-call webhook parsing.';

comment on column public.elevenlabs_conversations.conversation_id is
  'ElevenLabs conversation identifier when supplied by the webhook; separate from elevenlabs_demo_bindings active call routing.';

create unique index if not exists elevenlabs_conversations_conversation_id_idx
  on public.elevenlabs_conversations(conversation_id)
  where conversation_id is not null;

create index if not exists elevenlabs_conversations_lead_id_idx
  on public.elevenlabs_conversations(lead_id);

create index if not exists elevenlabs_conversations_profile_id_idx
  on public.elevenlabs_conversations(lead_demo_profile_id);

create index if not exists elevenlabs_conversations_agent_id_idx
  on public.elevenlabs_conversations(elevenlabs_agent_id);

create index if not exists elevenlabs_conversations_phone_lookup_idx
  on public.elevenlabs_conversations(caller_e164, called_e164);

create index if not exists elevenlabs_conversations_received_at_idx
  on public.elevenlabs_conversations(received_at desc);

drop trigger if exists elevenlabs_conversations_touch_updated_at on public.elevenlabs_conversations;

create trigger elevenlabs_conversations_touch_updated_at
  before update on public.elevenlabs_conversations
  for each row execute function public.touch_updated_at();

-- Voice-safe service extraction metadata.
-- After applying this migration in Supabase, if REST still cannot see new columns, run:
-- select pg_notification_queue_usage();
-- notify pgrst, 'reload schema';

alter table public.lead_clinic_services
  add column if not exists service_kind text not null default 'service',
  add column if not exists rejected boolean not null default false,
  add column if not exists rejection_reason text,
  add column if not exists price_details jsonb not null default '[]'::jsonb,
  add column if not exists voice_label text,
  add column if not exists voice_category text;

alter table public.lead_clinic_services
  drop constraint if exists lead_clinic_services_service_kind_check;

alter table public.lead_clinic_services
  add constraint lead_clinic_services_service_kind_check
  check (
    service_kind in (
      'service',
      'category',
      'add_on',
      'package',
      'membership',
      'consultation',
      'product',
      'staff',
      'navigation',
      'unknown'
    )
  );

update public.lead_clinic_services
set
  service_kind = coalesce(service_kind, 'service'),
  rejected = coalesce(rejected, false),
  price_details = coalesce(price_details, '[]'::jsonb),
  voice_label = coalesce(voice_label, display_name),
  voice_category = coalesce(voice_category, category)
where true;

create index if not exists idx_lead_clinic_services_profile_kind
  on public.lead_clinic_services (lead_demo_profile_id, service_kind);

create index if not exists idx_lead_clinic_services_profile_rejected
  on public.lead_clinic_services (lead_demo_profile_id, rejected);

create table if not exists public.lead_clinic_rejected_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null,
  lead_demo_profile_id uuid not null,
  extraction_run_id uuid not null,
  source_page_id uuid null,
  raw_name text not null,
  normalized_name text null,
  candidate_kind text null,
  rejection_reason text not null,
  source_url text null,
  source_quote text null,
  extraction_method text null,
  confidence numeric null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_rejected_candidates_profile
  on public.lead_clinic_rejected_candidates (lead_demo_profile_id);

create index if not exists idx_rejected_candidates_run
  on public.lead_clinic_rejected_candidates (extraction_run_id);

create index if not exists idx_rejected_candidates_reason
  on public.lead_clinic_rejected_candidates (rejection_reason);

notify pgrst, 'reload schema';

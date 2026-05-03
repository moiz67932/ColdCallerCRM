create table if not exists public.lead_demo_automation_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  created_by uuid,
  name text,
  status text not null check (status in ('pending', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  requested_count integer not null,
  selected_count integer not null default 0,
  completed_count integer not null default 0,
  failed_count integer not null default 0,
  skipped_count integer not null default 0,
  max_concurrency integer not null default 2,
  filters jsonb not null default '{}',
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lead_demo_automation_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  batch_id uuid not null references public.lead_demo_automation_batches(id) on delete cascade,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid references public.lead_demo_profiles(id) on delete set null,
  scrape_job_id uuid references public.lead_website_scrape_jobs(id) on delete set null,
  status text not null check (status in ('pending', 'running', 'completed', 'skipped_existing', 'failed', 'cancelled')),
  stage text,
  website_url text,
  business_name text,
  error text,
  retry_count integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(batch_id, lead_id)
);

alter table public.lead_demo_profiles
  add column if not exists extraction_status text,
  add column if not exists extraction_run_id uuid,
  add column if not exists extraction_quality_score numeric,
  add column if not exists extraction_quality_status text,
  add column if not exists is_demo_ready boolean not null default false,
  add column if not exists demo_ready_blockers jsonb not null default '[]'::jsonb,
  add column if not exists demo_readiness_status text,
  add column if not exists scrape_job_id uuid references public.lead_website_scrape_jobs(id) on delete set null;

create index if not exists idx_automation_batches_org_status on public.lead_demo_automation_batches(organization_id, status, created_at);
create index if not exists idx_automation_jobs_org_batch on public.lead_demo_automation_jobs(organization_id, batch_id);
create index if not exists idx_automation_jobs_org_lead_status on public.lead_demo_automation_jobs(organization_id, lead_id, status);
create unique index if not exists idx_automation_jobs_one_active_per_lead
  on public.lead_demo_automation_jobs(organization_id, lead_id)
  where status in ('pending', 'running');
create index if not exists idx_lead_demo_profiles_org_lead_status on public.lead_demo_profiles(organization_id, lead_id, status);
create index if not exists idx_lead_website_scrape_jobs_org_lead_status on public.lead_website_scrape_jobs(organization_id, lead_id, status, completed_at);

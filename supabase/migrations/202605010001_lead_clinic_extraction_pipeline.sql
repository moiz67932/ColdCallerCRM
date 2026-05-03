create extension if not exists pgcrypto;

alter table public.lead_website_pages
  add column if not exists normalized_text text,
  add column if not exists page_type_confidence numeric,
  add column if not exists page_type_evidence text;

alter table public.lead_demo_profiles
  add column if not exists extraction_status text,
  add column if not exists extraction_run_id uuid,
  add column if not exists extraction_quality_score numeric,
  add column if not exists extraction_quality_status text,
  add column if not exists is_demo_ready boolean not null default false,
  add column if not exists demo_ready_blockers jsonb not null default '[]'::jsonb;

create table if not exists public.lead_profile_extraction_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  scrape_job_id uuid references public.lead_website_scrape_jobs(id) on delete set null,
  root_url text not null,
  status text not null check (status in ('pending', 'running', 'completed', 'failed', 'completed_with_warnings')),
  extractor_version text not null,
  model_used text,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  warnings jsonb not null default '[]'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lead_clinic_facts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  clinic_id uuid,
  fact_type text not null check (fact_type in ('business_name', 'legal_name', 'phone', 'email', 'address', 'city', 'state', 'postal_code', 'country', 'timezone', 'website', 'instagram', 'facebook', 'booking_url', 'owner_name', 'medical_director', 'description', 'hours_summary', 'parking', 'location_note', 'cancellation_policy', 'booking_policy', 'insurance_policy', 'payment_policy', 'unknown')),
  fact_key text not null,
  fact_value text not null,
  normalized_value text,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  source_url text,
  source_page_id uuid references public.lead_website_pages(id) on delete set null,
  source_quote text,
  extraction_method text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lead_clinic_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  clinic_id uuid,
  location_name text,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  postal_code text,
  country text,
  phone_e164 text,
  phone_display text,
  email text,
  timezone text,
  latitude numeric,
  longitude numeric,
  source_url text,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.lead_clinic_hours (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  clinic_id uuid,
  day_of_week integer not null check (day_of_week >= 0 and day_of_week <= 6),
  opens_at time,
  closes_at time,
  is_closed boolean not null default false,
  by_appointment_only boolean not null default false,
  raw_text text,
  timezone text,
  source_url text,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.lead_clinic_services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  clinic_id uuid,
  canonical_name text not null,
  display_name text not null,
  service_slug text not null,
  category text,
  subcategory text,
  description_short text,
  description_long text,
  is_bookable boolean not null default true,
  is_product boolean not null default false,
  is_membership boolean not null default false,
  is_consultation boolean not null default false,
  duration_min_minutes integer,
  duration_max_minutes integer,
  starting_price_cents integer,
  price_summary text,
  price_available boolean not null default false,
  currency text not null default 'USD',
  source_url text,
  source_page_id uuid references public.lead_website_pages(id) on delete set null,
  source_quote text,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  sort_order integer,
  synthetic_key text,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.lead_clinic_service_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  service_id uuid not null references public.lead_clinic_services(id) on delete cascade,
  alias text not null,
  alias_type text not null check (alias_type in ('website', 'generated', 'stt_phonetic', 'abbreviation', 'brand', 'common')),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  created_at timestamptz default now()
);

create table if not exists public.lead_clinic_service_prices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  clinic_id uuid,
  service_id uuid not null references public.lead_clinic_services(id) on delete cascade,
  price_label text,
  price_type text not null check (price_type in ('fixed', 'starting_at', 'range', 'series', 'package', 'add_on', 'per_unit', 'consultation', 'unknown')),
  amount_min_cents integer,
  amount_max_cents integer,
  amount_cents integer,
  currency text not null default 'USD',
  unit text,
  package_quantity integer,
  raw_price_text text not null,
  duration_min_minutes integer,
  duration_max_minutes integer,
  source_url text,
  source_page_id uuid references public.lead_website_pages(id) on delete set null,
  source_quote text,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.lead_clinic_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  clinic_id uuid,
  title text not null,
  description text,
  offer_type text check (offer_type in ('special', 'discount', 'first_time_client', 'seasonal', 'package', 'membership', 'unknown')),
  related_service_id uuid references public.lead_clinic_services(id) on delete set null,
  price_cents integer,
  discount_text text,
  valid_from date,
  valid_until date,
  raw_text text,
  metadata jsonb not null default '{}'::jsonb,
  source_url text,
  source_page_id uuid references public.lead_website_pages(id) on delete set null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.lead_clinic_faqs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  clinic_id uuid,
  service_id uuid references public.lead_clinic_services(id) on delete set null,
  question text not null,
  answer text not null,
  category text,
  source_url text,
  source_page_id uuid references public.lead_website_pages(id) on delete set null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  is_medical_disclaimer_needed boolean default false,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.lead_clinic_staff (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  clinic_id uuid,
  full_name text not null,
  role_title text,
  bio_short text,
  credentials text,
  specialties text[],
  source_url text,
  source_page_id uuid references public.lead_website_pages(id) on delete set null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.lead_clinic_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  clinic_id uuid,
  product_name text not null,
  brand text,
  category text,
  description text,
  price_cents integer,
  raw_price_text text,
  source_url text,
  source_page_id uuid references public.lead_website_pages(id) on delete set null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.lead_clinic_voice_answers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  clinic_id uuid,
  answer_type text not null check (answer_type in ('services_list', 'hours', 'address', 'phone', 'booking', 'cancellation', 'pricing_summary', 'service_description', 'service_price', 'provider_summary', 'fallback')),
  service_id uuid references public.lead_clinic_services(id) on delete cascade,
  question_pattern text,
  answer_text text not null check (position('Source:' in answer_text) = 0),
  source_urls text[],
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  max_age_days integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.lead_profile_quality_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  check_name text not null,
  status text not null check (status in ('pass', 'warn', 'fail')),
  score numeric,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists public.lead_clinic_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id text not null references public.leads(id) on delete cascade,
  lead_demo_profile_id uuid not null references public.lead_demo_profiles(id) on delete cascade,
  extraction_run_id uuid not null references public.lead_profile_extraction_runs(id) on delete cascade,
  clinic_id uuid,
  service_id uuid references public.lead_clinic_services(id) on delete cascade,
  subtype text not null,
  topic text not null,
  chunk_text text not null,
  source_url text,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  price_available boolean not null default false,
  has_structured_service boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  content_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists lead_clinic_facts_active_unique
  on public.lead_clinic_facts(lead_demo_profile_id, fact_type, fact_key, coalesce(normalized_value, '')) where is_active;
create unique index if not exists lead_clinic_services_active_slug_unique
  on public.lead_clinic_services(lead_demo_profile_id, service_slug) where is_active;
create unique index if not exists lead_clinic_service_alias_unique
  on public.lead_clinic_service_aliases(lead_demo_profile_id, service_id, lower(alias));
create unique index if not exists lead_clinic_service_prices_active_unique
  on public.lead_clinic_service_prices(lead_demo_profile_id, service_id, raw_price_text, price_type, coalesce(price_label, '')) where is_active;
create unique index if not exists lead_clinic_voice_answer_unique
  on public.lead_clinic_voice_answers(lead_demo_profile_id, answer_type, coalesce(service_id, '00000000-0000-0000-0000-000000000000'::uuid));
create unique index if not exists lead_clinic_knowledge_chunks_unique
  on public.lead_clinic_knowledge_chunks(lead_demo_profile_id, content_hash) where is_active;

create index if not exists lead_profile_extraction_runs_profile_idx on public.lead_profile_extraction_runs(lead_demo_profile_id, created_at desc);
create index if not exists lead_clinic_facts_profile_idx on public.lead_clinic_facts(lead_demo_profile_id, fact_type);
create index if not exists lead_clinic_locations_profile_idx on public.lead_clinic_locations(lead_demo_profile_id);
create index if not exists lead_clinic_hours_profile_idx on public.lead_clinic_hours(lead_demo_profile_id, day_of_week);
create index if not exists lead_clinic_services_profile_idx on public.lead_clinic_services(lead_demo_profile_id, is_active);
create index if not exists lead_clinic_services_clinic_idx on public.lead_clinic_services(clinic_id);
create index if not exists lead_clinic_services_slug_idx on public.lead_clinic_services(service_slug);
create index if not exists lead_clinic_service_alias_alias_idx on public.lead_clinic_service_aliases(lower(alias));
create index if not exists lead_clinic_service_prices_service_idx on public.lead_clinic_service_prices(service_id, is_active);
create index if not exists lead_clinic_voice_answers_profile_idx on public.lead_clinic_voice_answers(lead_demo_profile_id, answer_type);
create index if not exists lead_clinic_knowledge_chunks_profile_idx on public.lead_clinic_knowledge_chunks(lead_demo_profile_id, subtype);
create index if not exists lead_profile_quality_checks_profile_idx on public.lead_profile_quality_checks(lead_demo_profile_id, extraction_run_id);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'lead_profile_extraction_runs',
    'lead_clinic_facts',
    'lead_clinic_locations',
    'lead_clinic_hours',
    'lead_clinic_services',
    'lead_clinic_service_prices',
    'lead_clinic_offers',
    'lead_clinic_faqs',
    'lead_clinic_staff',
    'lead_clinic_products',
    'lead_clinic_voice_answers',
    'lead_clinic_knowledge_chunks'
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

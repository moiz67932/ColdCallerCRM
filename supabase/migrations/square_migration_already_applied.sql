begin;

-- ============================================================
-- PORTIVE / COLD CALLER CRM
-- Square paid booking workflow schema
-- Covers Category 4, Category 5, Category 6
--
-- Flow:
-- ElevenLabs collects details
-- -> appointment_intents
-- -> Square payment link
-- -> Square payment webhook
-- -> appointment_payments
-- -> Square booking
-- -> message_events confirmation/reminder
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- 0. Helpers
-- ============================================================

create schema if not exists private;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Helper used by RLS policies.
-- It allows organization owners or organization_members to read/write their own org data.
create or replace function private.user_has_org_access(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(
    (
      auth.uid() is not null
      and (
        exists (
          select 1
          from public.organization_members om
          where om.organization_id = target_organization_id
            and om.user_id = auth.uid()
        )
        or exists (
          select 1
          from public.organizations o
          where o.id = target_organization_id
            and o.owner_id = auth.uid()
        )
      )
    ),
    false
  );
$$;

grant usage on schema private to authenticated;
grant execute on function private.user_has_org_access(uuid) to authenticated;

-- ============================================================
-- 1. Square integration table
-- Stores Square seller/location integration per organization/clinic.
-- Do NOT store raw card data here.
-- For now keep access tokens in env. Later, store encrypted token refs only.
-- ============================================================

create table if not exists public.square_integrations (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references public.organizations(id) on delete cascade,
  clinic_id uuid references public.clinics(id) on delete set null,

  lead_id text,
  lead_demo_profile_id uuid references public.lead_demo_profiles(id) on delete set null,

  square_environment text not null default 'sandbox',
  square_base_url text not null default 'https://connect.squareupsandbox.com',
  square_api_version text not null default '2026-05-20',

  square_application_id text,
  square_merchant_id text,

  square_location_id text not null,
  square_location_name text,
  square_timezone text,
  square_currency text not null default 'USD',
  square_country text not null default 'US',

  -- Never put a plain access token here.
  -- Keep it in env for demo, then use encrypted secret storage later.
  square_access_token_secret_ref text,
  square_refresh_token_secret_ref text,
  square_webhook_signature_key_secret_ref text,
  token_expires_at timestamptz,
  oauth_scopes text[],

  credit_card_processing_enabled boolean not null default false,
  online_booking_enabled boolean not null default false,
  appointments_plus_or_premium_enabled boolean not null default false,

  is_active boolean not null default true,

  raw_square_location jsonb not null default '{}'::jsonb,
  raw_square_booking_profile jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.square_integrations
  add column if not exists organization_id uuid;

alter table public.square_integrations
  add column if not exists clinic_id uuid;

alter table public.square_integrations
  add column if not exists lead_id text;

alter table public.square_integrations
  add column if not exists lead_demo_profile_id uuid;

alter table public.square_integrations
  add column if not exists square_environment text default 'sandbox';

alter table public.square_integrations
  add column if not exists square_base_url text default 'https://connect.squareupsandbox.com';

alter table public.square_integrations
  add column if not exists square_api_version text default '2026-05-20';

alter table public.square_integrations
  add column if not exists square_application_id text;

alter table public.square_integrations
  add column if not exists square_merchant_id text;

alter table public.square_integrations
  add column if not exists square_location_id text;

alter table public.square_integrations
  add column if not exists square_location_name text;

alter table public.square_integrations
  add column if not exists square_timezone text;

alter table public.square_integrations
  add column if not exists square_currency text default 'USD';

alter table public.square_integrations
  add column if not exists square_country text default 'US';

alter table public.square_integrations
  add column if not exists square_access_token_secret_ref text;

alter table public.square_integrations
  add column if not exists square_refresh_token_secret_ref text;

alter table public.square_integrations
  add column if not exists square_webhook_signature_key_secret_ref text;

alter table public.square_integrations
  add column if not exists token_expires_at timestamptz;

alter table public.square_integrations
  add column if not exists oauth_scopes text[];

alter table public.square_integrations
  add column if not exists credit_card_processing_enabled boolean default false;

alter table public.square_integrations
  add column if not exists online_booking_enabled boolean default false;

alter table public.square_integrations
  add column if not exists appointments_plus_or_premium_enabled boolean default false;

alter table public.square_integrations
  add column if not exists is_active boolean default true;

alter table public.square_integrations
  add column if not exists raw_square_location jsonb default '{}'::jsonb;

alter table public.square_integrations
  add column if not exists raw_square_booking_profile jsonb default '{}'::jsonb;

alter table public.square_integrations
  add column if not exists metadata jsonb default '{}'::jsonb;

alter table public.square_integrations
  add column if not exists created_at timestamptz default now();

alter table public.square_integrations
  add column if not exists updated_at timestamptz default now();

create unique index if not exists ux_square_integrations_org_env_location
on public.square_integrations (organization_id, square_environment, square_location_id);

create index if not exists idx_square_integrations_org
on public.square_integrations (organization_id);

create index if not exists idx_square_integrations_clinic
on public.square_integrations (clinic_id);

create index if not exists idx_square_integrations_location
on public.square_integrations (square_location_id);

drop trigger if exists trg_square_integrations_updated_at on public.square_integrations;
create trigger trg_square_integrations_updated_at
before update on public.square_integrations
for each row
execute function public.set_updated_at();

-- ============================================================
-- 2. Square staff/provider mapping
-- Category 4: store square_team_member_id.
-- ============================================================

create table if not exists public.square_staff_mappings (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references public.organizations(id) on delete cascade,
  clinic_id uuid references public.clinics(id) on delete set null,
  square_integration_id uuid references public.square_integrations(id) on delete cascade,

  square_environment text not null default 'sandbox',
  square_location_id text not null,

  square_team_member_id text not null,
  display_name text,
  role_title text,

  is_bookable boolean not null default true,
  is_active boolean not null default true,

  raw_square_profile jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.square_staff_mappings
  add column if not exists organization_id uuid;

alter table public.square_staff_mappings
  add column if not exists clinic_id uuid;

alter table public.square_staff_mappings
  add column if not exists square_integration_id uuid;

alter table public.square_staff_mappings
  add column if not exists square_environment text default 'sandbox';

alter table public.square_staff_mappings
  add column if not exists square_location_id text;

alter table public.square_staff_mappings
  add column if not exists square_team_member_id text;

alter table public.square_staff_mappings
  add column if not exists display_name text;

alter table public.square_staff_mappings
  add column if not exists role_title text;

alter table public.square_staff_mappings
  add column if not exists is_bookable boolean default true;

alter table public.square_staff_mappings
  add column if not exists is_active boolean default true;

alter table public.square_staff_mappings
  add column if not exists raw_square_profile jsonb default '{}'::jsonb;

alter table public.square_staff_mappings
  add column if not exists metadata jsonb default '{}'::jsonb;

alter table public.square_staff_mappings
  add column if not exists created_at timestamptz default now();

alter table public.square_staff_mappings
  add column if not exists updated_at timestamptz default now();

create unique index if not exists ux_square_staff_org_env_team
on public.square_staff_mappings (organization_id, square_environment, square_team_member_id);

create index if not exists idx_square_staff_org
on public.square_staff_mappings (organization_id);

create index if not exists idx_square_staff_clinic
on public.square_staff_mappings (clinic_id);

create index if not exists idx_square_staff_location
on public.square_staff_mappings (square_location_id);

drop trigger if exists trg_square_staff_mappings_updated_at on public.square_staff_mappings;
create trigger trg_square_staff_mappings_updated_at
before update on public.square_staff_mappings
for each row
execute function public.set_updated_at();

-- ============================================================
-- 3. Clinic service -> Square service mapping
-- Category 4 + 5 + 6:
-- map internal service to Square service_variation_id/version,
-- store duration, price, deposit amount.
-- ============================================================

create table if not exists public.clinic_services_square_map (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references public.organizations(id) on delete cascade,
  clinic_id uuid references public.clinics(id) on delete set null,

  lead_id text,
  lead_demo_profile_id uuid references public.lead_demo_profiles(id) on delete set null,
  lead_clinic_service_id uuid references public.lead_clinic_services(id) on delete set null,

  service_id uuid references public.services(id) on delete set null,
  appointment_type_id uuid references public.appointment_types(id) on delete set null,

  square_integration_id uuid references public.square_integrations(id) on delete cascade,
  square_environment text not null default 'sandbox',
  square_location_id text not null,
  square_team_member_id text,

  internal_service_name text not null,
  normalized_service_name text,
  display_service_name text,

  square_item_id text,
  square_item_name text,
  square_variation_name text,
  square_service_variation_id text not null,
  square_service_variation_version bigint not null,

  duration_minutes int not null,
  service_price_cents int,
  deposit_percent_bps int not null default 2000,
  deposit_amount_cents int not null default 0,
  currency text not null default 'USD',

  last_verified_available_start_at timestamptz,
  last_square_availability_checked_at timestamptz,

  is_active boolean not null default true,
  raw_square_catalog jsonb not null default '{}'::jsonb,
  raw_square_availability_sample jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.clinic_services_square_map
  add column if not exists organization_id uuid;

alter table public.clinic_services_square_map
  add column if not exists clinic_id uuid;

alter table public.clinic_services_square_map
  add column if not exists lead_id text;

alter table public.clinic_services_square_map
  add column if not exists lead_demo_profile_id uuid;

alter table public.clinic_services_square_map
  add column if not exists lead_clinic_service_id uuid;

alter table public.clinic_services_square_map
  add column if not exists service_id uuid;

alter table public.clinic_services_square_map
  add column if not exists appointment_type_id uuid;

alter table public.clinic_services_square_map
  add column if not exists square_integration_id uuid;

alter table public.clinic_services_square_map
  add column if not exists square_environment text default 'sandbox';

alter table public.clinic_services_square_map
  add column if not exists square_location_id text;

alter table public.clinic_services_square_map
  add column if not exists square_team_member_id text;

alter table public.clinic_services_square_map
  add column if not exists internal_service_name text;

alter table public.clinic_services_square_map
  add column if not exists normalized_service_name text;

alter table public.clinic_services_square_map
  add column if not exists display_service_name text;

alter table public.clinic_services_square_map
  add column if not exists square_item_id text;

alter table public.clinic_services_square_map
  add column if not exists square_item_name text;

alter table public.clinic_services_square_map
  add column if not exists square_variation_name text;

alter table public.clinic_services_square_map
  add column if not exists square_service_variation_id text;

alter table public.clinic_services_square_map
  add column if not exists square_service_variation_version bigint;

alter table public.clinic_services_square_map
  add column if not exists duration_minutes int;

alter table public.clinic_services_square_map
  add column if not exists service_price_cents int;

alter table public.clinic_services_square_map
  add column if not exists deposit_percent_bps int default 2000;

alter table public.clinic_services_square_map
  add column if not exists deposit_amount_cents int default 0;

alter table public.clinic_services_square_map
  add column if not exists currency text default 'USD';

alter table public.clinic_services_square_map
  add column if not exists last_verified_available_start_at timestamptz;

alter table public.clinic_services_square_map
  add column if not exists last_square_availability_checked_at timestamptz;

alter table public.clinic_services_square_map
  add column if not exists is_active boolean default true;

alter table public.clinic_services_square_map
  add column if not exists raw_square_catalog jsonb default '{}'::jsonb;

alter table public.clinic_services_square_map
  add column if not exists raw_square_availability_sample jsonb default '{}'::jsonb;

alter table public.clinic_services_square_map
  add column if not exists metadata jsonb default '{}'::jsonb;

alter table public.clinic_services_square_map
  add column if not exists created_at timestamptz default now();

alter table public.clinic_services_square_map
  add column if not exists updated_at timestamptz default now();

create unique index if not exists ux_clinic_services_square_map_org_env_service
on public.clinic_services_square_map (organization_id, square_environment, internal_service_name);

create index if not exists idx_clinic_services_square_map_org
on public.clinic_services_square_map (organization_id);

create index if not exists idx_clinic_services_square_map_clinic
on public.clinic_services_square_map (clinic_id);

create index if not exists idx_clinic_services_square_map_lead_demo
on public.clinic_services_square_map (lead_demo_profile_id);

create index if not exists idx_clinic_services_square_map_square_variation
on public.clinic_services_square_map (square_service_variation_id);

drop trigger if exists trg_clinic_services_square_map_updated_at on public.clinic_services_square_map;
create trigger trg_clinic_services_square_map_updated_at
before update on public.clinic_services_square_map
for each row
execute function public.set_updated_at();

-- ============================================================
-- 4. Appointment intents
-- Category 5 + 6 core table.
-- One row represents the AI-collected appointment request
-- before/while payment and booking finalization happens.
-- ============================================================

create table if not exists public.appointment_intents (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null references public.organizations(id) on delete cascade,
  clinic_id uuid references public.clinics(id) on delete set null,

  lead_id text,
  lead_demo_profile_id uuid references public.lead_demo_profiles(id) on delete set null,
  binding_id uuid references public.elevenlabs_demo_bindings(id) on delete set null,

  appointment_request_id uuid references public.appointment_requests(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,

  source text not null default 'elevenlabs_call',
  provider text not null default 'square',

  conversation_id text,
  call_session_id uuid,
  call_log_id uuid,
  call_attempt_id text,

  agent_id text,
  elevenlabs_agent_id text,

  caller_name text,
  caller_phone text,
  caller_phone_e164 text,
  called_phone_e164 text,
  caller_email text,

  service_name text not null,
  service_id uuid references public.services(id) on delete set null,
  lead_clinic_service_id uuid references public.lead_clinic_services(id) on delete set null,
  appointment_type_id uuid references public.appointment_types(id) on delete set null,

  square_integration_id uuid references public.square_integrations(id) on delete set null,
  square_location_id text,
  square_team_member_id text,
  square_service_variation_id text,
  square_service_variation_version bigint,

  selected_start_at timestamptz,
  selected_end_at timestamptz,
  selected_timezone text,
  selected_time_display text,
  preferred_date_time_text text,

  duration_minutes int,
  deposit_amount_cents int,
  service_price_cents int,
  deposit_percent_bps int not null default 2000,
  currency text not null default 'USD',

  payment_provider text not null default 'square',
  booking_provider text not null default 'square',

  payment_status text not null default 'not_required',
  appointment_status text not null default 'details_collected',

  square_customer_id text,
  square_order_id text,
  square_payment_link_id text,
  square_payment_link_url text,
  square_payment_id text,
  square_booking_id text,

  payment_link_sent_at timestamptz,
  payment_link_expires_at timestamptz,
  paid_at timestamptz,
  square_booking_created_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,

  notes text,
  internal_notes text,
  last_error text,
  last_error_at timestamptz,

  idempotency_key text,
  pricing_source text,

  raw_booking_details jsonb not null default '{}'::jsonb,
  square_payload jsonb not null default '{}'::jsonb,
  raw_square_availability jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.appointment_intents
  add column if not exists organization_id uuid;

alter table public.appointment_intents
  add column if not exists clinic_id uuid;

alter table public.appointment_intents
  add column if not exists lead_id text;

alter table public.appointment_intents
  add column if not exists lead_demo_profile_id uuid;

alter table public.appointment_intents
  add column if not exists binding_id uuid;

alter table public.appointment_intents
  add column if not exists appointment_request_id uuid;

alter table public.appointment_intents
  add column if not exists appointment_id uuid;

alter table public.appointment_intents
  add column if not exists source text default 'elevenlabs_call';

alter table public.appointment_intents
  add column if not exists provider text default 'square';

alter table public.appointment_intents
  add column if not exists conversation_id text;

alter table public.appointment_intents
  add column if not exists call_session_id uuid;

alter table public.appointment_intents
  add column if not exists call_log_id uuid;

alter table public.appointment_intents
  add column if not exists call_attempt_id text;

alter table public.appointment_intents
  add column if not exists agent_id text;

alter table public.appointment_intents
  add column if not exists elevenlabs_agent_id text;

alter table public.appointment_intents
  add column if not exists caller_name text;

alter table public.appointment_intents
  add column if not exists caller_phone text;

alter table public.appointment_intents
  add column if not exists caller_phone_e164 text;

alter table public.appointment_intents
  add column if not exists called_phone_e164 text;

alter table public.appointment_intents
  add column if not exists caller_email text;

alter table public.appointment_intents
  add column if not exists service_name text;

alter table public.appointment_intents
  add column if not exists service_id uuid;

alter table public.appointment_intents
  add column if not exists lead_clinic_service_id uuid;

alter table public.appointment_intents
  add column if not exists appointment_type_id uuid;

alter table public.appointment_intents
  add column if not exists square_integration_id uuid;

alter table public.appointment_intents
  add column if not exists square_location_id text;

alter table public.appointment_intents
  add column if not exists square_team_member_id text;

alter table public.appointment_intents
  add column if not exists square_service_variation_id text;

alter table public.appointment_intents
  add column if not exists square_service_variation_version bigint;

alter table public.appointment_intents
  add column if not exists selected_start_at timestamptz;

alter table public.appointment_intents
  add column if not exists selected_end_at timestamptz;

alter table public.appointment_intents
  add column if not exists selected_timezone text;

alter table public.appointment_intents
  add column if not exists selected_time_display text;

alter table public.appointment_intents
  add column if not exists preferred_date_time_text text;

alter table public.appointment_intents
  add column if not exists duration_minutes int;

alter table public.appointment_intents
  add column if not exists deposit_amount_cents int;

alter table public.appointment_intents
  add column if not exists service_price_cents int;

alter table public.appointment_intents
  add column if not exists deposit_percent_bps int default 2000;

alter table public.appointment_intents
  add column if not exists currency text default 'USD';

alter table public.appointment_intents
  add column if not exists payment_provider text default 'square';

alter table public.appointment_intents
  add column if not exists booking_provider text default 'square';

alter table public.appointment_intents
  add column if not exists payment_status text default 'not_required';

alter table public.appointment_intents
  add column if not exists appointment_status text default 'details_collected';

alter table public.appointment_intents
  add column if not exists square_customer_id text;

alter table public.appointment_intents
  add column if not exists square_order_id text;

alter table public.appointment_intents
  add column if not exists square_payment_link_id text;

alter table public.appointment_intents
  add column if not exists square_payment_link_url text;

alter table public.appointment_intents
  add column if not exists square_payment_id text;

alter table public.appointment_intents
  add column if not exists square_booking_id text;

alter table public.appointment_intents
  add column if not exists payment_link_sent_at timestamptz;

alter table public.appointment_intents
  add column if not exists payment_link_expires_at timestamptz;

alter table public.appointment_intents
  add column if not exists paid_at timestamptz;

alter table public.appointment_intents
  add column if not exists square_booking_created_at timestamptz;

alter table public.appointment_intents
  add column if not exists confirmed_at timestamptz;

alter table public.appointment_intents
  add column if not exists cancelled_at timestamptz;

alter table public.appointment_intents
  add column if not exists notes text;

alter table public.appointment_intents
  add column if not exists internal_notes text;

alter table public.appointment_intents
  add column if not exists last_error text;

alter table public.appointment_intents
  add column if not exists last_error_at timestamptz;

alter table public.appointment_intents
  add column if not exists idempotency_key text;

alter table public.appointment_intents
  add column if not exists pricing_source text;

alter table public.appointment_intents
  add column if not exists raw_booking_details jsonb default '{}'::jsonb;

alter table public.appointment_intents
  add column if not exists square_payload jsonb default '{}'::jsonb;

alter table public.appointment_intents
  add column if not exists raw_square_availability jsonb default '{}'::jsonb;

alter table public.appointment_intents
  add column if not exists metadata jsonb default '{}'::jsonb;

alter table public.appointment_intents
  add column if not exists created_at timestamptz default now();

alter table public.appointment_intents
  add column if not exists updated_at timestamptz default now();

create unique index if not exists ux_appointment_intents_idempotency_key
on public.appointment_intents (idempotency_key)
where idempotency_key is not null;

create index if not exists idx_appointment_intents_org_created
on public.appointment_intents (organization_id, created_at desc);

create index if not exists idx_appointment_intents_clinic_created
on public.appointment_intents (clinic_id, created_at desc);

create index if not exists idx_appointment_intents_lead
on public.appointment_intents (lead_id);

create index if not exists idx_appointment_intents_lead_demo
on public.appointment_intents (lead_demo_profile_id);

create index if not exists idx_appointment_intents_conversation_id
on public.appointment_intents (conversation_id);

create index if not exists idx_appointment_intents_caller_phone_e164
on public.appointment_intents (caller_phone_e164);

create index if not exists idx_appointment_intents_caller_phone
on public.appointment_intents (caller_phone);

create index if not exists idx_appointment_intents_payment_status
on public.appointment_intents (payment_status);

create index if not exists idx_appointment_intents_appointment_status
on public.appointment_intents (appointment_status);

create index if not exists idx_appointment_intents_square_order_id
on public.appointment_intents (square_order_id);

create index if not exists idx_appointment_intents_square_payment_id
on public.appointment_intents (square_payment_id);

create index if not exists idx_appointment_intents_square_booking_id
on public.appointment_intents (square_booking_id);

create index if not exists idx_appointment_intents_selected_start_at
on public.appointment_intents (selected_start_at);

drop trigger if exists trg_appointment_intents_updated_at on public.appointment_intents;
create trigger trg_appointment_intents_updated_at
before update on public.appointment_intents
for each row
execute function public.set_updated_at();

-- ============================================================
-- 5. Appointment payments
-- Stores Square payment-link/payment/webhook state.
-- No raw card numbers.
-- ============================================================

create table if not exists public.appointment_payments (
  id uuid primary key default gen_random_uuid(),

  appointment_intent_id uuid references public.appointment_intents(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  clinic_id uuid references public.clinics(id) on delete set null,

  provider text not null default 'square',
  payment_mode text not null default 'deposit',

  amount_cents int not null,
  currency text not null default 'USD',
  status text not null default 'pending',

  square_customer_id text,
  square_order_id text,
  square_payment_id text,
  square_payment_link_id text,
  square_checkout_url text,
  square_receipt_url text,

  square_webhook_event_id text,
  square_webhook_event_type text,
  square_webhook_received_at timestamptz,

  paid_at timestamptz,
  failed_at timestamptz,
  refunded_at timestamptz,

  raw_square_payment jsonb not null default '{}'::jsonb,
  raw_square_webhook jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.appointment_payments
  add column if not exists appointment_intent_id uuid;

alter table public.appointment_payments
  add column if not exists organization_id uuid;

alter table public.appointment_payments
  add column if not exists clinic_id uuid;

alter table public.appointment_payments
  add column if not exists provider text default 'square';

alter table public.appointment_payments
  add column if not exists payment_mode text default 'deposit';

alter table public.appointment_payments
  add column if not exists amount_cents int;

alter table public.appointment_payments
  add column if not exists currency text default 'USD';

alter table public.appointment_payments
  add column if not exists status text default 'pending';

alter table public.appointment_payments
  add column if not exists square_customer_id text;

alter table public.appointment_payments
  add column if not exists square_order_id text;

alter table public.appointment_payments
  add column if not exists square_payment_id text;

alter table public.appointment_payments
  add column if not exists square_payment_link_id text;

alter table public.appointment_payments
  add column if not exists square_checkout_url text;

alter table public.appointment_payments
  add column if not exists square_receipt_url text;

alter table public.appointment_payments
  add column if not exists square_webhook_event_id text;

alter table public.appointment_payments
  add column if not exists square_webhook_event_type text;

alter table public.appointment_payments
  add column if not exists square_webhook_received_at timestamptz;

alter table public.appointment_payments
  add column if not exists paid_at timestamptz;

alter table public.appointment_payments
  add column if not exists failed_at timestamptz;

alter table public.appointment_payments
  add column if not exists refunded_at timestamptz;

alter table public.appointment_payments
  add column if not exists raw_square_payment jsonb default '{}'::jsonb;

alter table public.appointment_payments
  add column if not exists raw_square_webhook jsonb default '{}'::jsonb;

alter table public.appointment_payments
  add column if not exists metadata jsonb default '{}'::jsonb;

alter table public.appointment_payments
  add column if not exists created_at timestamptz default now();

alter table public.appointment_payments
  add column if not exists updated_at timestamptz default now();

create index if not exists idx_appointment_payments_intent
on public.appointment_payments (appointment_intent_id);

create index if not exists idx_appointment_payments_org_created
on public.appointment_payments (organization_id, created_at desc);

create index if not exists idx_appointment_payments_status
on public.appointment_payments (status);

create index if not exists idx_appointment_payments_square_order_id
on public.appointment_payments (square_order_id);

create unique index if not exists ux_appointment_payments_square_payment_id
on public.appointment_payments (square_payment_id)
where square_payment_id is not null;

create unique index if not exists ux_appointment_payments_square_webhook_event_id
on public.appointment_payments (square_webhook_event_id)
where square_webhook_event_id is not null;

drop trigger if exists trg_appointment_payments_updated_at on public.appointment_payments;
create trigger trg_appointment_payments_updated_at
before update on public.appointment_payments
for each row
execute function public.set_updated_at();

-- ============================================================
-- 6. Workflow event log
-- Every step: details_collected, payment_link_created, sms_sent,
-- webhook_received, booking_created, confirmation_sent, etc.
-- ============================================================

create table if not exists public.appointment_workflow_events (
  id uuid primary key default gen_random_uuid(),

  appointment_intent_id uuid references public.appointment_intents(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  clinic_id uuid references public.clinics(id) on delete set null,

  event_type text not null,
  event_source text not null default 'backend',
  event_status text not null default 'success',

  message text,
  error_message text,
  payload jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

alter table public.appointment_workflow_events
  add column if not exists appointment_intent_id uuid;

alter table public.appointment_workflow_events
  add column if not exists organization_id uuid;

alter table public.appointment_workflow_events
  add column if not exists clinic_id uuid;

alter table public.appointment_workflow_events
  add column if not exists event_type text;

alter table public.appointment_workflow_events
  add column if not exists event_source text default 'backend';

alter table public.appointment_workflow_events
  add column if not exists event_status text default 'success';

alter table public.appointment_workflow_events
  add column if not exists message text;

alter table public.appointment_workflow_events
  add column if not exists error_message text;

alter table public.appointment_workflow_events
  add column if not exists payload jsonb default '{}'::jsonb;

alter table public.appointment_workflow_events
  add column if not exists created_at timestamptz default now();

create index if not exists idx_appointment_workflow_events_intent_created
on public.appointment_workflow_events (appointment_intent_id, created_at desc);

create index if not exists idx_appointment_workflow_events_org_created
on public.appointment_workflow_events (organization_id, created_at desc);

create index if not exists idx_appointment_workflow_events_type
on public.appointment_workflow_events (event_type);

-- ============================================================
-- 7. Message events
-- SMS/WhatsApp/email logs for payment link, confirmation, reminders.
-- ============================================================

create table if not exists public.message_events (
  id uuid primary key default gen_random_uuid(),

  appointment_intent_id uuid references public.appointment_intents(id) on delete set null,
  appointment_request_id uuid references public.appointment_requests(id) on delete set null,

  organization_id uuid not null references public.organizations(id) on delete cascade,
  clinic_id uuid references public.clinics(id) on delete set null,

  lead_id text,
  lead_demo_profile_id uuid references public.lead_demo_profiles(id) on delete set null,

  conversation_id text,

  channel text not null,
  message_type text not null default 'general',
  provider text,
  direction text not null default 'outbound',

  to_phone text,
  to_phone_e164 text,
  from_phone text,
  from_phone_e164 text,
  to_email text,
  from_email text,

  subject text,
  message_body text,

  provider_message_id text,
  provider_status text,
  status text not null default 'queued',

  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,

  error_message text,
  payload jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.message_events
  add column if not exists appointment_intent_id uuid;

alter table public.message_events
  add column if not exists appointment_request_id uuid;

alter table public.message_events
  add column if not exists organization_id uuid;

alter table public.message_events
  add column if not exists clinic_id uuid;

alter table public.message_events
  add column if not exists lead_id text;

alter table public.message_events
  add column if not exists lead_demo_profile_id uuid;

alter table public.message_events
  add column if not exists conversation_id text;

alter table public.message_events
  add column if not exists channel text;

alter table public.message_events
  add column if not exists message_type text default 'general';

alter table public.message_events
  add column if not exists provider text;

alter table public.message_events
  add column if not exists direction text default 'outbound';

alter table public.message_events
  add column if not exists to_phone text;

alter table public.message_events
  add column if not exists to_phone_e164 text;

alter table public.message_events
  add column if not exists from_phone text;

alter table public.message_events
  add column if not exists from_phone_e164 text;

alter table public.message_events
  add column if not exists to_email text;

alter table public.message_events
  add column if not exists from_email text;

alter table public.message_events
  add column if not exists subject text;

alter table public.message_events
  add column if not exists message_body text;

alter table public.message_events
  add column if not exists provider_message_id text;

alter table public.message_events
  add column if not exists provider_status text;

alter table public.message_events
  add column if not exists status text default 'queued';

alter table public.message_events
  add column if not exists sent_at timestamptz;

alter table public.message_events
  add column if not exists delivered_at timestamptz;

alter table public.message_events
  add column if not exists failed_at timestamptz;

alter table public.message_events
  add column if not exists error_message text;

alter table public.message_events
  add column if not exists payload jsonb default '{}'::jsonb;

alter table public.message_events
  add column if not exists created_at timestamptz default now();

alter table public.message_events
  add column if not exists updated_at timestamptz default now();

create index if not exists idx_message_events_intent_created
on public.message_events (appointment_intent_id, created_at desc);

create index if not exists idx_message_events_request_created
on public.message_events (appointment_request_id, created_at desc);

create index if not exists idx_message_events_org_created
on public.message_events (organization_id, created_at desc);

create index if not exists idx_message_events_lead
on public.message_events (lead_id);

create index if not exists idx_message_events_to_phone_e164
on public.message_events (to_phone_e164);

create index if not exists idx_message_events_conversation_id
on public.message_events (conversation_id);

create index if not exists idx_message_events_status
on public.message_events (status);

drop trigger if exists trg_message_events_updated_at on public.message_events;
create trigger trg_message_events_updated_at
before update on public.message_events
for each row
execute function public.set_updated_at();

-- ============================================================
-- 8. Non-breaking extension columns on existing appointment_requests
-- This lets your existing request/dashboard flow link to the new paid workflow.
-- ============================================================

alter table public.appointment_requests
  add column if not exists appointment_intent_id uuid references public.appointment_intents(id) on delete set null;

alter table public.appointment_requests
  add column if not exists payment_provider text;

alter table public.appointment_requests
  add column if not exists payment_status text default 'not_required';

alter table public.appointment_requests
  add column if not exists appointment_status text;

alter table public.appointment_requests
  add column if not exists deposit_amount_cents int;

alter table public.appointment_requests
  add column if not exists currency text default 'USD';

alter table public.appointment_requests
  add column if not exists square_location_id text;

alter table public.appointment_requests
  add column if not exists square_team_member_id text;

alter table public.appointment_requests
  add column if not exists square_service_variation_id text;

alter table public.appointment_requests
  add column if not exists square_service_variation_version bigint;

alter table public.appointment_requests
  add column if not exists square_customer_id text;

alter table public.appointment_requests
  add column if not exists square_order_id text;

alter table public.appointment_requests
  add column if not exists square_payment_link_id text;

alter table public.appointment_requests
  add column if not exists square_payment_link_url text;

alter table public.appointment_requests
  add column if not exists square_payment_id text;

alter table public.appointment_requests
  add column if not exists square_booking_id text;

alter table public.appointment_requests
  add column if not exists paid_at timestamptz;

alter table public.appointment_requests
  add column if not exists confirmed_at timestamptz;

alter table public.appointment_requests
  add column if not exists last_payment_error text;

create index if not exists idx_appointment_requests_appointment_intent_id
on public.appointment_requests (appointment_intent_id);

create index if not exists idx_appointment_requests_payment_status
on public.appointment_requests (payment_status);

create index if not exists idx_appointment_requests_square_order_id
on public.appointment_requests (square_order_id);

create index if not exists idx_appointment_requests_square_payment_id
on public.appointment_requests (square_payment_id);

create index if not exists idx_appointment_requests_square_booking_id
on public.appointment_requests (square_booking_id);

-- ============================================================
-- 9. Non-breaking extension columns on existing appointments
-- This lets final confirmed appointments retain Square/payment IDs.
-- ============================================================

alter table public.appointments
  add column if not exists appointment_intent_id uuid references public.appointment_intents(id) on delete set null;

alter table public.appointments
  add column if not exists payment_provider text;

alter table public.appointments
  add column if not exists payment_status text;

alter table public.appointments
  add column if not exists deposit_amount_cents int;

alter table public.appointments
  add column if not exists currency text default 'USD';

alter table public.appointments
  add column if not exists square_location_id text;

alter table public.appointments
  add column if not exists square_team_member_id text;

alter table public.appointments
  add column if not exists square_service_variation_id text;

alter table public.appointments
  add column if not exists square_service_variation_version bigint;

alter table public.appointments
  add column if not exists square_customer_id text;

alter table public.appointments
  add column if not exists square_order_id text;

alter table public.appointments
  add column if not exists square_payment_link_id text;

alter table public.appointments
  add column if not exists square_payment_link_url text;

alter table public.appointments
  add column if not exists square_payment_id text;

alter table public.appointments
  add column if not exists square_booking_id text;

alter table public.appointments
  add column if not exists paid_at timestamptz;

alter table public.appointments
  add column if not exists payment_confirmed_at timestamptz;

create index if not exists idx_appointments_appointment_intent_id
on public.appointments (appointment_intent_id);

create index if not exists idx_appointments_payment_status
on public.appointments (payment_status);

create index if not exists idx_appointments_square_order_id
on public.appointments (square_order_id);

create index if not exists idx_appointments_square_payment_id
on public.appointments (square_payment_id);

create index if not exists idx_appointments_square_booking_id
on public.appointments (square_booking_id);

-- ============================================================
-- 10. Check constraints
-- Added NOT VALID so old rows do not break migration.
-- New/updated rows will still be checked.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'square_integrations_environment_check'
  ) then
    alter table public.square_integrations
      add constraint square_integrations_environment_check
      check (square_environment in ('sandbox', 'production')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appointment_intents_payment_status_check'
  ) then
    alter table public.appointment_intents
      add constraint appointment_intents_payment_status_check
      check (payment_status in ('not_required', 'pending', 'completed', 'failed', 'expired', 'refunded')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appointment_intents_appointment_status_check'
  ) then
    alter table public.appointment_intents
      add constraint appointment_intents_appointment_status_check
      check (appointment_status in (
        'details_collected',
        'payment_link_created',
        'payment_link_sent',
        'payment_pending',
        'payment_completed',
        'square_booking_created',
        'confirmed',
        'failed',
        'manual_review_needed',
        'cancelled'
      )) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appointment_payments_status_check'
  ) then
    alter table public.appointment_payments
      add constraint appointment_payments_status_check
      check (status in ('pending', 'completed', 'failed', 'expired', 'refunded')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appointment_payments_payment_mode_check'
  ) then
    alter table public.appointment_payments
      add constraint appointment_payments_payment_mode_check
      check (payment_mode in ('deposit', 'full_payment', 'card_on_file', 'setup_only')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'message_events_channel_check'
  ) then
    alter table public.message_events
      add constraint message_events_channel_check
      check (channel in ('sms', 'whatsapp', 'email', 'voice', 'dashboard')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'message_events_direction_check'
  ) then
    alter table public.message_events
      add constraint message_events_direction_check
      check (direction in ('inbound', 'outbound')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'message_events_status_check'
  ) then
    alter table public.message_events
      add constraint message_events_status_check
      check (status in ('queued', 'sent', 'delivered', 'failed', 'cancelled')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'clinic_services_square_map_duration_check'
  ) then
    alter table public.clinic_services_square_map
      add constraint clinic_services_square_map_duration_check
      check (duration_minutes is null or duration_minutes > 0) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'clinic_services_square_map_deposit_check'
  ) then
    alter table public.clinic_services_square_map
      add constraint clinic_services_square_map_deposit_check
      check (deposit_amount_cents is null or deposit_amount_cents >= 0) not valid;
  end if;
end $$;

-- ============================================================
-- 11. RLS
-- Backend/service role bypasses RLS.
-- Authenticated dashboard users can only see orgs where they are owner/member.
-- ============================================================

alter table public.square_integrations enable row level security;
alter table public.square_staff_mappings enable row level security;
alter table public.clinic_services_square_map enable row level security;
alter table public.appointment_intents enable row level security;
alter table public.appointment_payments enable row level security;
alter table public.appointment_workflow_events enable row level security;
alter table public.message_events enable row level security;

grant select, insert, update, delete on public.square_integrations to authenticated;
grant select, insert, update, delete on public.square_staff_mappings to authenticated;
grant select, insert, update, delete on public.clinic_services_square_map to authenticated;
grant select, insert, update, delete on public.appointment_intents to authenticated;
grant select, insert, update, delete on public.appointment_payments to authenticated;
grant select, insert, update, delete on public.appointment_workflow_events to authenticated;
grant select, insert, update, delete on public.message_events to authenticated;

drop policy if exists "square_integrations_org_select" on public.square_integrations;
create policy "square_integrations_org_select"
on public.square_integrations
for select
to authenticated
using (private.user_has_org_access(organization_id));

drop policy if exists "square_integrations_org_insert" on public.square_integrations;
create policy "square_integrations_org_insert"
on public.square_integrations
for insert
to authenticated
with check (private.user_has_org_access(organization_id));

drop policy if exists "square_integrations_org_update" on public.square_integrations;
create policy "square_integrations_org_update"
on public.square_integrations
for update
to authenticated
using (private.user_has_org_access(organization_id))
with check (private.user_has_org_access(organization_id));

drop policy if exists "square_staff_mappings_org_select" on public.square_staff_mappings;
create policy "square_staff_mappings_org_select"
on public.square_staff_mappings
for select
to authenticated
using (private.user_has_org_access(organization_id));

drop policy if exists "square_staff_mappings_org_insert" on public.square_staff_mappings;
create policy "square_staff_mappings_org_insert"
on public.square_staff_mappings
for insert
to authenticated
with check (private.user_has_org_access(organization_id));

drop policy if exists "square_staff_mappings_org_update" on public.square_staff_mappings;
create policy "square_staff_mappings_org_update"
on public.square_staff_mappings
for update
to authenticated
using (private.user_has_org_access(organization_id))
with check (private.user_has_org_access(organization_id));

drop policy if exists "clinic_services_square_map_org_select" on public.clinic_services_square_map;
create policy "clinic_services_square_map_org_select"
on public.clinic_services_square_map
for select
to authenticated
using (private.user_has_org_access(organization_id));

drop policy if exists "clinic_services_square_map_org_insert" on public.clinic_services_square_map;
create policy "clinic_services_square_map_org_insert"
on public.clinic_services_square_map
for insert
to authenticated
with check (private.user_has_org_access(organization_id));

drop policy if exists "clinic_services_square_map_org_update" on public.clinic_services_square_map;
create policy "clinic_services_square_map_org_update"
on public.clinic_services_square_map
for update
to authenticated
using (private.user_has_org_access(organization_id))
with check (private.user_has_org_access(organization_id));

drop policy if exists "appointment_intents_org_select" on public.appointment_intents;
create policy "appointment_intents_org_select"
on public.appointment_intents
for select
to authenticated
using (private.user_has_org_access(organization_id));

drop policy if exists "appointment_intents_org_insert" on public.appointment_intents;
create policy "appointment_intents_org_insert"
on public.appointment_intents
for insert
to authenticated
with check (private.user_has_org_access(organization_id));

drop policy if exists "appointment_intents_org_update" on public.appointment_intents;
create policy "appointment_intents_org_update"
on public.appointment_intents
for update
to authenticated
using (private.user_has_org_access(organization_id))
with check (private.user_has_org_access(organization_id));

drop policy if exists "appointment_payments_org_select" on public.appointment_payments;
create policy "appointment_payments_org_select"
on public.appointment_payments
for select
to authenticated
using (private.user_has_org_access(organization_id));

drop policy if exists "appointment_payments_org_insert" on public.appointment_payments;
create policy "appointment_payments_org_insert"
on public.appointment_payments
for insert
to authenticated
with check (private.user_has_org_access(organization_id));

drop policy if exists "appointment_payments_org_update" on public.appointment_payments;
create policy "appointment_payments_org_update"
on public.appointment_payments
for update
to authenticated
using (private.user_has_org_access(organization_id))
with check (private.user_has_org_access(organization_id));

drop policy if exists "appointment_workflow_events_org_select" on public.appointment_workflow_events;
create policy "appointment_workflow_events_org_select"
on public.appointment_workflow_events
for select
to authenticated
using (private.user_has_org_access(organization_id));

drop policy if exists "appointment_workflow_events_org_insert" on public.appointment_workflow_events;
create policy "appointment_workflow_events_org_insert"
on public.appointment_workflow_events
for insert
to authenticated
with check (private.user_has_org_access(organization_id));

drop policy if exists "message_events_org_select" on public.message_events;
create policy "message_events_org_select"
on public.message_events
for select
to authenticated
using (private.user_has_org_access(organization_id));

drop policy if exists "message_events_org_insert" on public.message_events;
create policy "message_events_org_insert"
on public.message_events
for insert
to authenticated
with check (private.user_has_org_access(organization_id));

drop policy if exists "message_events_org_update" on public.message_events;
create policy "message_events_org_update"
on public.message_events
for update
to authenticated
using (private.user_has_org_access(organization_id))
with check (private.user_has_org_access(organization_id));

-- ============================================================
-- 12. Demo data insert / upsert
-- Uses your real Square Sandbox IDs:
-- location_id: L43CNC7VJFKGD
-- team_member_id: TMgkdyIbsbfT92me
-- Botox service variation: AMVXOV43BHNMI4QH6C4GTHTK
-- service variation version: 1779597480505
-- duration: 30 minutes
-- demo available slot: 2026-05-25T14:00:00Z
--
-- It attaches to your first existing organization/clinic if available.
-- If no organization/clinic exists, it creates a demo one.
-- ============================================================

do $$
declare
  v_org_id uuid;
  v_clinic_id uuid;
  v_square_integration_id uuid;
begin
  select o.id
  into v_org_id
  from public.organizations o
  order by o.created_at asc nulls last
  limit 1;

  if v_org_id is null then
    v_org_id := '00000000-0000-0000-0000-000000000001'::uuid;

    insert into public.organizations (
      id,
      name,
      primary_timezone,
      created_at,
      updated_at
    )
    values (
      v_org_id,
      'Portive Demo Organization',
      'America/New_York',
      now(),
      now()
    )
    on conflict (id) do nothing;
  end if;

  select c.id
  into v_clinic_id
  from public.clinics c
  where c.organization_id = v_org_id
  order by c.created_at asc nulls last
  limit 1;

  if v_clinic_id is null then
    v_clinic_id := '00000000-0000-0000-0000-000000000002'::uuid;

    insert into public.clinics (
      id,
      organization_id,
      name,
      country,
      timezone,
      industry,
      working_hours,
      created_at,
      updated_at
    )
    values (
      v_clinic_id,
      v_org_id,
      'Portive Medspa Demo',
      'US',
      'America/New_York',
      'medspa',
      '{"monday":{"open":"09:00","close":"17:00"},"tuesday":{"open":"09:00","close":"17:00"},"wednesday":{"open":"09:00","close":"17:00"},"thursday":{"open":"09:00","close":"17:00"},"friday":{"open":"09:00","close":"17:00"}}'::jsonb,
      now(),
      now()
    )
    on conflict (id) do nothing;
  end if;

  insert into public.square_integrations (
    organization_id,
    clinic_id,
    square_environment,
    square_base_url,
    square_api_version,
    square_location_id,
    square_location_name,
    square_timezone,
    square_currency,
    square_country,
    credit_card_processing_enabled,
    online_booking_enabled,
    appointments_plus_or_premium_enabled,
    is_active,
    metadata
  )
  values (
    v_org_id,
    v_clinic_id,
    'sandbox',
    'https://connect.squareupsandbox.com',
    '2026-05-20',
    'L43CNC7VJFKGD',
    'Portive Medspa Demo',
    'America/New_York',
    'USD',
    'US',
    true,
    true,
    true,
    true,
    jsonb_build_object(
      'created_for', 'square_paid_booking_demo',
      'note', 'Access token should stay in env, not in this table'
    )
  )
  on conflict (organization_id, square_environment, square_location_id)
  do update set
    clinic_id = excluded.clinic_id,
    square_base_url = excluded.square_base_url,
    square_api_version = excluded.square_api_version,
    square_location_name = excluded.square_location_name,
    square_timezone = excluded.square_timezone,
    square_currency = excluded.square_currency,
    square_country = excluded.square_country,
    credit_card_processing_enabled = excluded.credit_card_processing_enabled,
    online_booking_enabled = excluded.online_booking_enabled,
    appointments_plus_or_premium_enabled = excluded.appointments_plus_or_premium_enabled,
    is_active = excluded.is_active,
    metadata = public.square_integrations.metadata || excluded.metadata,
    updated_at = now()
  returning id into v_square_integration_id;

  insert into public.square_staff_mappings (
    organization_id,
    clinic_id,
    square_integration_id,
    square_environment,
    square_location_id,
    square_team_member_id,
    display_name,
    role_title,
    is_bookable,
    is_active,
    metadata
  )
  values (
    v_org_id,
    v_clinic_id,
    v_square_integration_id,
    'sandbox',
    'L43CNC7VJFKGD',
    'TMgkdyIbsbfT92me',
    'Sandbox Seller',
    'Aesthetic Provider',
    true,
    true,
    jsonb_build_object('created_for', 'square_paid_booking_demo')
  )
  on conflict (organization_id, square_environment, square_team_member_id)
  do update set
    clinic_id = excluded.clinic_id,
    square_integration_id = excluded.square_integration_id,
    square_location_id = excluded.square_location_id,
    display_name = excluded.display_name,
    role_title = excluded.role_title,
    is_bookable = excluded.is_bookable,
    is_active = excluded.is_active,
    metadata = public.square_staff_mappings.metadata || excluded.metadata,
    updated_at = now();

  insert into public.clinic_services_square_map (
    organization_id,
    clinic_id,
    square_integration_id,
    square_environment,
    square_location_id,
    square_team_member_id,
    internal_service_name,
    normalized_service_name,
    display_service_name,
    square_item_name,
    square_variation_name,
    square_service_variation_id,
    square_service_variation_version,
    duration_minutes,
    service_price_cents,
    deposit_percent_bps,
    deposit_amount_cents,
    currency,
    last_verified_available_start_at,
    last_square_availability_checked_at,
    is_active,
    raw_square_availability_sample,
    metadata
  )
  values (
    v_org_id,
    v_clinic_id,
    v_square_integration_id,
    'sandbox',
    'L43CNC7VJFKGD',
    'TMgkdyIbsbfT92me',
    'Botox Consultation',
    'botox consultation',
    'Botox Consultation',
    'Botox Consultation',
    'Regular',
    'AMVXOV43BHNMI4QH6C4GTHTK',
    1779597480505,
    30,
    25000,
    2000,
    5000,
    'USD',
    '2026-05-25T14:00:00Z'::timestamptz,
    now(),
    true,
    jsonb_build_object(
      'start_at', '2026-05-25T14:00:00Z',
      'location_id', 'L43CNC7VJFKGD',
      'team_member_id', 'TMgkdyIbsbfT92me',
      'service_variation_id', 'AMVXOV43BHNMI4QH6C4GTHTK',
      'service_variation_version', 1779597480505,
      'duration_minutes', 30
    ),
    jsonb_build_object(
      'created_for', 'square_paid_booking_demo',
      'deposit_policy', jsonb_build_object(
        'deposit_percent_bps', 2000,
        'pricing_source', 'clinic_services_square_map'
      )
    )
  )
  on conflict (organization_id, square_environment, internal_service_name)
  do update set
    clinic_id = excluded.clinic_id,
    square_integration_id = excluded.square_integration_id,
    square_location_id = excluded.square_location_id,
    square_team_member_id = excluded.square_team_member_id,
    normalized_service_name = excluded.normalized_service_name,
    display_service_name = excluded.display_service_name,
    square_item_name = excluded.square_item_name,
    square_variation_name = excluded.square_variation_name,
    square_service_variation_id = excluded.square_service_variation_id,
    square_service_variation_version = excluded.square_service_variation_version,
    duration_minutes = excluded.duration_minutes,
    service_price_cents = excluded.service_price_cents,
    deposit_percent_bps = excluded.deposit_percent_bps,
    deposit_amount_cents = excluded.deposit_amount_cents,
    currency = excluded.currency,
    last_verified_available_start_at = excluded.last_verified_available_start_at,
    last_square_availability_checked_at = excluded.last_square_availability_checked_at,
    is_active = excluded.is_active,
    raw_square_availability_sample = excluded.raw_square_availability_sample,
    metadata = public.clinic_services_square_map.metadata || excluded.metadata,
    updated_at = now();

  insert into public.appointment_workflow_events (
    appointment_intent_id,
    organization_id,
    clinic_id,
    event_type,
    event_source,
    event_status,
    message,
    payload
  )
  values (
    null,
    v_org_id,
    v_clinic_id,
    'square_schema_seeded',
    'sql_migration',
    'success',
    'Square Category 4/5/6 schema and demo mapping seeded successfully.',
    jsonb_build_object(
      'square_location_id', 'L43CNC7VJFKGD',
      'square_team_member_id', 'TMgkdyIbsbfT92me',
      'square_service_variation_id', 'AMVXOV43BHNMI4QH6C4GTHTK',
      'square_service_variation_version', 1779597480505,
      'duration_minutes', 30,
      'deposit_amount_cents', 5000
    )
  );
end $$;

-- ============================================================
-- 13. Final verification output
-- ============================================================

commit;

select
  'square_paid_booking_schema_ready' as status,
  si.organization_id,
  si.clinic_id,
  si.square_environment,
  si.square_location_id,
  ssm.square_team_member_id,
  csm.internal_service_name,
  csm.square_service_variation_id,
  csm.square_service_variation_version,
  csm.duration_minutes,
  csm.deposit_amount_cents,
  csm.last_verified_available_start_at
from public.square_integrations si
left join public.square_staff_mappings ssm
  on ssm.organization_id = si.organization_id
 and ssm.square_location_id = si.square_location_id
left join public.clinic_services_square_map csm
  on csm.organization_id = si.organization_id
 and csm.square_location_id = si.square_location_id
where si.square_location_id = 'L43CNC7VJFKGD'
  and csm.internal_service_name = 'Botox Consultation';

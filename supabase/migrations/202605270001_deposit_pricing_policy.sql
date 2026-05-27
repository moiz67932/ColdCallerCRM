-- Add an explicit source-of-truth deposit policy for paid appointment services.
-- deposit_percent_bps uses basis points: 2000 = 20.00%.

alter table public.clinic_services_square_map
  add column if not exists deposit_percent_bps int default 2000;

update public.clinic_services_square_map
set deposit_percent_bps = 2000
where deposit_percent_bps is null;

alter table public.clinic_services_square_map
  alter column deposit_percent_bps set default 2000;

alter table public.clinic_services_square_map
  alter column deposit_percent_bps set not null;

alter table public.appointment_intents
  add column if not exists deposit_percent_bps int default 2000;

update public.appointment_intents
set deposit_percent_bps = 2000
where deposit_percent_bps is null;

alter table public.appointment_intents
  alter column deposit_percent_bps set default 2000;

alter table public.appointment_intents
  alter column deposit_percent_bps set not null;

alter table public.appointment_intents
  add column if not exists pricing_source text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clinic_services_square_map_deposit_percent_bps_check'
  ) then
    alter table public.clinic_services_square_map
      add constraint clinic_services_square_map_deposit_percent_bps_check
      check (deposit_percent_bps > 0 and deposit_percent_bps <= 10000) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'appointment_intents_deposit_percent_bps_check'
  ) then
    alter table public.appointment_intents
      add constraint appointment_intents_deposit_percent_bps_check
      check (deposit_percent_bps > 0 and deposit_percent_bps <= 10000) not valid;
  end if;
end $$;

-- For rows with a known total service price, keep deposit_amount_cents aligned
-- to the configured deposit policy. Rows with missing/zero service price keep
-- their existing deposit_amount_cents and are treated as pricing-incomplete by
-- application context builders.
update public.clinic_services_square_map
set deposit_amount_cents = round(service_price_cents * deposit_percent_bps / 10000.0)::int,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'deposit_policy', jsonb_build_object(
        'deposit_percent_bps', deposit_percent_bps,
        'pricing_source', 'clinic_services_square_map'
      )
    ),
    updated_at = now()
where service_price_cents is not null
  and service_price_cents > 0;

-- Demo Botox Consultation: total price is $250, and the 20% deposit is $50.
update public.clinic_services_square_map
set service_price_cents = 25000,
    deposit_percent_bps = 2000,
    deposit_amount_cents = 5000,
    currency = 'USD',
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'deposit_policy', jsonb_build_object(
        'deposit_percent_bps', 2000,
        'pricing_source', 'clinic_services_square_map'
      ),
      'pricing_note', 'Demo Botox Consultation total price is $250; 20% deposit is $50.'
    ),
    updated_at = now()
where internal_service_name ilike 'Botox Consultation';

alter table public.lead_clinic_services
  add column if not exists extraction_method text;

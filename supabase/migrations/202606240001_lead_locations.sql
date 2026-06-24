alter table public.leads
  add column if not exists location text;

create index if not exists leads_location_created_at_idx on public.leads(location, created_at desc);

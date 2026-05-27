create table if not exists public.square_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  square_event_id text not null unique,
  event_type text,
  square_payment_id text,
  square_order_id text,
  appointment_intent_id uuid references public.appointment_intents(id) on delete set null,
  status text not null default 'received',
  error_message text,
  processed_at timestamptz,
  payload jsonb,
  created_at timestamptz not null default now()
);

alter table public.appointment_intents
  add column if not exists booking_status text not null default 'not_started';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'square_webhook_events_status_check'
  ) then
    alter table public.square_webhook_events
      add constraint square_webhook_events_status_check
      check (status in ('received', 'processed', 'ignored', 'failed')) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'appointment_intents_booking_status_check'
  ) then
    alter table public.appointment_intents
      add constraint appointment_intents_booking_status_check
      check (booking_status in ('not_started', 'creating_booking', 'created', 'failed')) not valid;
  end if;
end $$;

create index if not exists idx_square_webhook_events_intent_created
on public.square_webhook_events (appointment_intent_id, created_at desc);

create index if not exists idx_square_webhook_events_org_created
on public.square_webhook_events (organization_id, created_at desc);

create index if not exists idx_square_webhook_events_square_payment_id
on public.square_webhook_events (square_payment_id);

create index if not exists idx_square_webhook_events_square_order_id
on public.square_webhook_events (square_order_id);

create index if not exists idx_appointment_intents_booking_status
on public.appointment_intents (booking_status);

alter table public.square_webhook_events enable row level security;

grant select, insert, update, delete on public.square_webhook_events to authenticated;

drop policy if exists "square_webhook_events_org_select" on public.square_webhook_events;
create policy "square_webhook_events_org_select"
on public.square_webhook_events
for select
using (organization_id is null or private.user_has_org_access(organization_id));

drop policy if exists "square_webhook_events_org_insert" on public.square_webhook_events;
create policy "square_webhook_events_org_insert"
on public.square_webhook_events
for insert
with check (organization_id is null or private.user_has_org_access(organization_id));

drop policy if exists "square_webhook_events_org_update" on public.square_webhook_events;
create policy "square_webhook_events_org_update"
on public.square_webhook_events
for update
using (organization_id is null or private.user_has_org_access(organization_id))
with check (organization_id is null or private.user_has_org_access(organization_id));

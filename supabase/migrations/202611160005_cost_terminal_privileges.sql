-- Terminal events run as service_role, which intentionally cannot write ledgers.
-- Only these fixed, trigger-only functions may update their private hold rows.
begin;
alter function public.portive_cost_terminal() security definer;
alter function public.portive_cost_terminal() set search_path = public;
alter function public.portive_create_cost_hold() security definer;
alter function public.portive_create_cost_hold() set search_path = public;
revoke all on function public.portive_cost_terminal(), public.portive_create_cost_hold() from public, anon, authenticated;
commit;

begin;
create table if not exists public.dialer_usage_cache (
 key text primary key, observed_cents integer check(observed_cents>=0),observed_at timestamptz,
 owner uuid,lease_until timestamptz,retry_at timestamptz,failures integer not null default 0
);
alter table public.dialer_usage_cache enable row level security;
revoke all on public.dialer_usage_cache from public,anon,authenticated;
grant select on public.dialer_usage_cache to service_role;
create or replace function public.portive_usage_claim(p_key text,p_owner uuid,p_max_age integer default 60)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.dialer_usage_cache;
begin
 if p_key !~ '^voice-usage:[a-f0-9]{16}:[0-9-]{10}$' or p_max_age not between 0 and 60 then raise exception 'Invalid usage cache scope';end if;
 insert into public.dialer_usage_cache(key) values(p_key) on conflict do nothing;
 select * into r from public.dialer_usage_cache where key=p_key for update;
 if r.observed_at>=clock_timestamp()-make_interval(secs=>p_max_age) then return jsonb_build_object('cached',true,'observedCents',r.observed_cents,'observedAt',r.observed_at);end if;
 if r.retry_at>clock_timestamp() then return jsonb_build_object('retryAfterSeconds',ceil(extract(epoch from r.retry_at-clock_timestamp())));end if;
 if r.lease_until>clock_timestamp() then return jsonb_build_object('busy',true);end if;
 update public.dialer_usage_cache set owner=p_owner,lease_until=clock_timestamp()+interval '35 seconds' where key=p_key;
 return jsonb_build_object('claimed',true,'failures',r.failures);
end $$;
create or replace function public.portive_usage_finish(p_key text,p_owner uuid,p_observed integer default null,p_retry integer default 0)
returns void language plpgsql security definer set search_path=public as $$
begin
 if p_observed is not null and p_observed<0 or p_retry not between 0 and 86400 then raise exception 'Invalid usage observation';end if;
 update public.dialer_usage_cache set observed_cents=coalesce(p_observed,observed_cents),
 observed_at=case when p_observed is not null then clock_timestamp() else observed_at end,
 lease_until=null,owner=null,retry_at=case when p_observed is null then clock_timestamp()+make_interval(secs=>greatest(2,p_retry)) else null end,
 failures=case when p_observed is null then failures+1 else 0 end where key=p_key and owner=p_owner;
 if not found then raise exception 'Usage observation lease lost';end if;
end $$;
revoke all on function public.portive_usage_claim(text,uuid,integer),public.portive_usage_finish(text,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.portive_usage_claim(text,uuid,integer),public.portive_usage_finish(text,uuid,integer,integer) to service_role;
-- A provider status GET is an observation, not a request to terminate a healthy
-- parked operator. Preserve a live conversation during Stop until it ends.
create or replace function public.portive_orchestration_operator(p_session text,p_control text,p_alive boolean)
returns void language plpgsql set search_path=public as $$
declare s public.dial_sessions; winner_live boolean; expired boolean;
begin
 perform public.portive_orchestration_guard('cloudflare',p_session);
 select * into s from public.dial_sessions where id=p_session and operator_call_control_id=p_control for update;
 if s.id is null then raise exception 'Operator reconciliation identity mismatch';end if;
 update public.dial_sessions set operator_checked_at=clock_timestamp() where id=s.id;
 winner_live:=exists(select 1 from public.call_attempts where id=s.active_call_id and ended_at is null);
 expired:=case when s.parallel_options->>'budgetVersion'='exposure-v1' then (s.parallel_options->>'deadlineAt')::timestamptz<=clock_timestamp() else s.started_at+interval '1820 seconds'<=clock_timestamp() end;
 if p_alive then
  if expired or s.status='unsafe' or s.status='stopping' and not winner_live then
   if expired then update public.dial_sessions set status='stopping',browser_media_ready=false,reason='Funded operator duration reached' where id=s.id;end if;
   perform public.portive_enqueue(s.id,null,'hangup_operator',s.id||':expired-operator');
  end if;
 else
  update public.dial_sessions set operator_terminal_at=coalesce(operator_terminal_at,clock_timestamp()),operator_leg_state='disconnected',browser_media_ready=false,
  status=case when exists(select 1 from public.call_attempts where dial_session_id=s.id and (ended_at is null or (id=s.active_call_id and disposition_saved_at is null))) then 'unsafe' else 'stopped' end,
  ended_at=case when not exists(select 1 from public.call_attempts where dial_session_id=s.id and (ended_at is null or (id=s.active_call_id and disposition_saved_at is null))) then coalesce(ended_at,clock_timestamp()) else ended_at end where id=s.id;
 end if;
 insert into public.dial_audit_events(session_id,event_type,details) values(s.id,'operator_reconciliation',jsonb_build_object('alive',p_alive,'status',s.status,'expired',expired,'winnerLive',winner_live));
end $$;
-- Finish a session after proven terminal legs instead of latching unsafe forever.
do $patch$
declare src text; patched text;
begin
 src:=pg_get_functiondef('public.portive_orchestration_work(text)'::regprocedure);
 if position('terminal_recovery_complete' in src)=0 then
  patched:=replace(src,'select * into s from public.dial_sessions where id=p_session;'||chr(10)||'  with selected as (',
   $q$select * into s from public.dial_sessions where id=p_session;
  if s.operator_terminal_at is not null and s.status in ('unsafe','stopping','paused')
   and not exists(select 1 from public.call_attempts where dial_session_id=s.id and (ended_at is null or (id=s.active_call_id and disposition_saved_at is null)))
   and not exists(select 1 from public.dial_commands where session_id=s.id and state in ('pending','executing','uncertain')) then
    update public.dial_sessions set status='stopped',ended_at=coalesce(ended_at,clock_timestamp()) where id=s.id returning * into s;
    insert into public.dial_audit_events(session_id,event_type) values(s.id,'terminal_recovery_complete');
  end if;
  with selected as ($q$);
  if patched=src then raise exception 'Terminal recovery body drift';end if;execute patched;
 end if;
end $patch$;
-- Final SQL authorization and provider cap calculation share the same minimum
-- remaining window. No call may outlive the funded session deadline.
do $patch$
declare src text; patched text;
begin
 src:=pg_get_functiondef('public.portive_orchestration_authorize(uuid)'::regprocedure);
 patched:=replace(src,$s$(s.parallel_options->>'maxCallSeconds')::integer+(s.parallel_options->>'ringTimeout')::integer+23$s$,$s$30+(s.parallel_options->>'ringTimeout')::integer+8$s$);
 if patched=src and position($s$30+(s.parallel_options->>'ringTimeout')::integer+8$s$ in src)=0 then raise exception 'Funded authorization body drift';end if;if patched<>src then execute patched;end if;
 src:=pg_get_functiondef('public.portive_parallel_command_base(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)'::regprocedure);
 patched:=replace(src,$s$make_interval(secs=>(s.parallel_options->>'maxCallSeconds')::integer+(s.parallel_options->>'ringTimeout')::integer+23)$s$,$s$make_interval(secs=>30+(s.parallel_options->>'ringTimeout')::integer+8)$s$);
 if patched=src and position($s$make_interval(secs=>30+$s$ in src)=0 then raise exception 'Funded scheduler body drift';end if;if patched<>src then execute patched;end if;
end $patch$;
-- Rebound held exposure using signed terminal duration, preserving every tariff
-- component/rounding allowance. This is not final billing or a zero-cost release.
create or replace function public.portive_bound_terminal_costs()
returns integer language plpgsql security definer set search_path=public as $$
declare item record; h public.dialer_cost_holds; s public.dial_sessions; ev public.workstation_telnyx_webhook_events;
 control text; start_at timestamptz; end_at timestamptz; opts jsonb; bound integer; n integer:=0;
begin
 for item in select id,session_id from public.dialer_cost_holds where state='held' and terminal_at is not null order by session_id,id loop
  select * into s from public.dial_sessions where id=item.session_id for update;
  select * into h from public.dialer_cost_holds where id=item.id for update;
  if h.state<>'held' or s.parallel_options->>'budgetVersion' is distinct from 'exposure-v1'
   or exists(select 1 from public.dial_commands where session_id=s.id and state in ('pending','executing','uncertain')) then continue;end if;
  if h.role='operator' then control:=s.operator_call_control_id;
  else select telnyx_call_control_id into control from public.call_attempts where id=h.attempt_id;end if;
  select * into ev from public.workstation_telnyx_webhook_events where call_control_id=control and event_type='call.hangup' and signature_verified and processed_at is not null order by received_at limit 1;
  if ev.id is null then continue;end if;
  begin
   start_at:=(ev.payload_json->'data'->'payload'->>'start_time')::timestamptz;
   end_at:=(ev.payload_json->'data'->'payload'->>'end_time')::timestamptz;
  exception when others then continue;end;
  if start_at is null or end_at is null or start_at>end_at or end_at>h.terminal_at+interval '2 seconds' then continue;end if;
  opts:=s.parallel_options||jsonb_build_object(case when h.role='operator' then 'sessionSeconds' else 'maxCallSeconds' end,greatest(1,ceil(extract(epoch from end_at-start_at))::integer));
  bound:=greatest(public.portive_leg_cap(opts,case when h.role='operator' then 'operator' else 'prospect' end),ceil(coalesce(h.billed_micros,0)::numeric/10000)::integer);
  if bound<h.cap_cents then
   insert into public.dial_audit_events(session_id,attempt_id,event_type,details) values(s.id,h.attempt_id,'terminal_exposure_bounded',jsonb_build_object('oldCapCents',h.cap_cents,'newCapCents',bound,'verifiedEventId',ev.event_id,'startAt',start_at,'endAt',end_at,'billingComplete',false));
   update public.dialer_cost_holds set cap_cents=bound where id=h.id; n:=n+1;
   update public.dial_sessions set reserved_cost_cents=(select coalesce(sum(case when state='held' then cap_cents when state='reconciled' then ceil(billed_micros::numeric/10000) else 0 end),0) from public.dialer_cost_holds where session_id=s.id) where id=s.id;
  end if;
 end loop;
 return n;
end $$;
revoke all on function public.portive_bound_terminal_costs() from public,anon,authenticated;
grant execute on function public.portive_bound_terminal_costs() to service_role;
commit;

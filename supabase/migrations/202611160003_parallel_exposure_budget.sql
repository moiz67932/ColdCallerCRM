-- Component-priced, provider-capped exposure. No call/report/grant is created.
begin;
-- An already running legacy session has no component-funded cap. Drain it first.
do $$begin
 if exists(select 1 from public.dial_sessions where mode='parallel' and status in ('running','paused','stopping','unsafe') and parallel_options->>'budgetVersion' is distinct from 'exposure-v1') then
  raise exception 'Drain existing Parallel sessions before installing component budgeting';end if;
end $$;
create table if not exists public.dialer_cost_holds (
 id text primary key, session_id text not null references public.dial_sessions(id),
 attempt_id text references public.call_attempts(id), role text not null check(role in ('operator','prospect')),
 cap_cents integer not null check(cap_cents>=0), billed_micros bigint, terminal_at timestamptz,
 state text not null default 'held' check(state in ('held','reconciled','canceled')),
 billing_reference text, created_at timestamptz not null default now(),
 check(billed_micros is null or billed_micros>=0)
);
create table if not exists public.dialer_billing_records (
 id text primary key, hold_id text not null references public.dialer_cost_holds(id),
 product text not null, cost_micros bigint not null check(cost_micros>=0),
 source jsonb not null, received_at timestamptz not null default now()
);
alter table public.dialer_cost_holds enable row level security;
alter table public.dialer_billing_records enable row level security;
revoke all on public.dialer_cost_holds,public.dialer_billing_records from public,anon,authenticated,service_role;
grant select on public.dialer_cost_holds,public.dialer_billing_records to service_role;

create or replace function public.portive_leg_cap(p_options jsonb,p_role text,p_seconds integer default null)
returns integer language plpgsql immutable set search_path=public as $$
declare p jsonb:=p_options->'costProfile'; secs integer; units integer; rate numeric; fixed numeric;
begin
 if p_role='operator' then
  secs:=coalesce(p_seconds,(p_options->>'sessionSeconds')::integer);
  rate:=(p->>'callControlPerMinuteMicros')::numeric+(p->>'webrtcPerMinuteMicros')::numeric+(p->>'operatorSipPerMinuteMicros')::numeric+(p->>'recordingPerMinuteMicros')::numeric+(p->>'otherPerMinuteMicros')::numeric;
  fixed:=(p->>'operatorFixedMicros')::numeric;
 elsif p_role='prospect' then
  secs:=coalesce(p_seconds,(p_options->>'maxCallSeconds')::integer+15);
  rate:=(p->>'sipPerMinuteMicros')::numeric+(p->>'callControlPerMinuteMicros')::numeric+(p->>'bridgePerMinuteMicros')::numeric+(p->>'recordingPerMinuteMicros')::numeric+(p->>'otherPerMinuteMicros')::numeric;
  fixed:=(p->>'amdPerCallMicros')::numeric+(p->>'prospectFixedMicros')::numeric+400*(p->>'ttsPerCharacterMicros')::numeric;
 else raise exception 'Invalid priced leg role'; end if;
 units:=greatest((p->>'minimumSeconds')::integer,ceil(secs::numeric/(p->>'incrementSeconds')::integer)::integer*(p->>'incrementSeconds')::integer);
 if units is null or rate is null or fixed is null or secs<1 or rate<0 or fixed<0 then raise exception 'Complete component tariff required'; end if;
 return ceil((units*rate/60+fixed)/10000)::integer;
end $$;

create or replace function public.portive_validate_cost(p_options jsonb,p_lines integer)
returns void language plpgsql set search_path=public as $$
declare p jsonb:=p_options->'costProfile'; configured jsonb; k text; held integer; required integer;
begin
 select value_json into configured from public.app_settings where key='dialer_cost_profile';
 if p is null or p is distinct from configured or p->>'version' is distinct from 'exposure-v1' or p->>'currency' is distinct from 'USD' or p->>'reviewedAt' is null or p->>'expiresAt' is null
  or length(coalesce(p->>'source',''))<8 or (p->>'reviewedAt')::timestamptz>clock_timestamp()
  or (p->>'expiresAt')::timestamptz<=clock_timestamp()+make_interval(secs=>(p_options->>'sessionSeconds')::integer)
  or (p->>'expiresAt')::timestamptz>(p->>'reviewedAt')::timestamptz+interval '7 days'
  then raise exception 'Configure current account tariff components; illustrative rates cannot authorize calls'; end if;
 foreach k in array array['sipPerMinuteMicros','operatorSipPerMinuteMicros','callControlPerMinuteMicros','webrtcPerMinuteMicros','bridgePerMinuteMicros','recordingPerMinuteMicros','otherPerMinuteMicros','amdPerCallMicros','ttsPerCharacterMicros','operatorFixedMicros','prospectFixedMicros'] loop
  if p->>k is null or (p->>k)::numeric<0 or (p->>k)::numeric<>trunc((p->>k)::numeric) then raise exception 'Invalid tariff component: %',k; end if;
 end loop;
 if coalesce((p_options->>'sessionSeconds')::integer,0)<(p_options->>'maxCallSeconds')::integer+(p_options->>'ringTimeout')::integer+60
   or p_options->>'maxCallSeconds' is null or p_options->>'ringTimeout' is null or p->>'minimumSeconds' is null or p->>'incrementSeconds' is null or p->'destinationPrefixes' is null or (p_options->>'sessionSeconds')::integer>3600 or (p->>'minimumSeconds')::integer not between 1 and 300
   or (p->>'incrementSeconds')::integer not between 1 and 60 or jsonb_array_length(p->'destinationPrefixes')<1 then raise exception 'Invalid funded duration or tariff scope'; end if;
 required:=public.portive_leg_cap(p_options,'operator')+p_lines*public.portive_leg_cap(p_options,'prospect');
 if required>(p_options->>'maxSpendCents')::integer then raise exception 'First batch requires % cents; maximum spend is % cents',required,p_options->>'maxSpendCents'; end if;
 select coalesce(sum(case when state='reconciled' then 0 else cap_cents end),0) into held from public.dialer_cost_holds where state<>'canceled';
 if required+held>coalesce((p_options->>'availableCreditCents')::integer,0) then raise exception 'Available credit must cover % cents plus % cents of unsettled prior exposure',required,held; end if;
 if required+held>coalesce((p_options->>'dailyHeadroomCents')::integer,0) then raise exception 'Remaining provider daily headroom cannot cover funded exposure'; end if;
end $$;

create or replace function public.portive_create_cost_hold()
returns trigger language plpgsql set search_path=public as $$
declare s public.dial_sessions; h text; role_name text;
begin
 if tg_table_name='dial_sessions' then s:=new;h:=s.id||':operator';role_name:='operator';
 else select * into s from public.dial_sessions where id=new.dial_session_id;h:=new.id;role_name:='prospect';end if;
 if s.parallel_options->>'budgetVersion'='exposure-v1' and s.acceptance_grant_id is null then
  insert into public.dialer_cost_holds(id,session_id,attempt_id,role,cap_cents)
   values(h,s.id,case when role_name='prospect' then new.id else null end,role_name,public.portive_leg_cap(s.parallel_options,role_name));
 end if;
 return new;
end $$;
drop trigger if exists portive_session_cost_hold on public.dial_sessions;
create trigger portive_session_cost_hold after insert on public.dial_sessions for each row execute function public.portive_create_cost_hold();
drop trigger if exists portive_attempt_cost_hold on public.call_attempts;
create trigger portive_attempt_cost_hold after insert on public.call_attempts for each row execute function public.portive_create_cost_hold();

create or replace function public.portive_budget_tick(p_session text)
returns public.dial_sessions language plpgsql set search_path=public as $$
declare s public.dial_sessions; a public.call_attempts;
begin
 select * into s from public.dial_sessions where id=p_session for update;
 if s.parallel_options->>'budgetVersion' is distinct from 'exposure-v1' then return s;end if;
 if clock_timestamp()>=(s.parallel_options->>'deadlineAt')::timestamptz and s.status not in ('stopped','completed') then
  update public.dial_sessions set status='stopping',browser_media_ready=false,reason='Funded session duration reached' where id=s.id returning * into s;
  perform public.portive_enqueue(s.id,null,'hangup_operator',s.id||':budget-expiry');
 end if;
 for a in select * from public.call_attempts where dial_session_id=s.id and ended_at is null and
  (clock_timestamp()>=(s.parallel_options->>'deadlineAt')::timestamptz or answered_at+make_interval(secs=>(s.parallel_options->>'maxCallSeconds')::integer)<=clock_timestamp()) loop
  perform public.portive_enqueue(s.id,a.id,'hangup',a.id||':funded-deadline','{"force":"true"}');
 end loop;
 -- Terminal evidence can reduce exposure to a proven-unsent zero, never infer
 -- a provider hangup or finalize a partial bill from an acknowledgement.
 update public.dialer_cost_holds h set state='canceled',cap_cents=0 where h.session_id=s.id and h.state='held' and h.role='prospect'
  and exists(select 1 from public.call_attempts x where x.id=h.attempt_id and x.ended_at is not null and x.telnyx_call_control_id is null and x.answered_at is null)
  and exists(select 1 from public.dial_commands c where c.attempt_id=h.attempt_id and c.action='dial_lead' and c.state='canceled')
  and not exists(select 1 from public.dial_commands c where c.attempt_id=h.attempt_id and c.state in ('executing','uncertain'));
 update public.dialer_cost_holds h set terminal_at=coalesce(h.terminal_at,s.operator_terminal_at) where h.session_id=s.id and h.role='operator';
 update public.dialer_cost_holds h set terminal_at=coalesce(h.terminal_at,ended.ended_at) from public.call_attempts ended where h.attempt_id=ended.id and h.session_id=s.id;
 update public.dial_sessions set reserved_cost_cents=(select coalesce(sum(case when state='reconciled' then ceil(billed_micros::numeric/10000) when state='held' then cap_cents else 0 end),0) from public.dialer_cost_holds where session_id=s.id) where id=s.id returning * into s;
 return s;
end $$;

create or replace function public.portive_cost_terminal()
returns trigger language plpgsql set search_path=public as $$
begin
 if tg_table_name='dial_sessions' then
  update public.dialer_cost_holds set terminal_at=coalesce(terminal_at,new.operator_terminal_at) where id=new.id||':operator';
 else update public.dialer_cost_holds set terminal_at=coalesce(terminal_at,new.ended_at) where attempt_id=new.id;end if;
 return new;
end $$;
drop trigger if exists portive_operator_cost_terminal on public.dial_sessions;
create trigger portive_operator_cost_terminal after update of operator_terminal_at on public.dial_sessions for each row execute function public.portive_cost_terminal();
drop trigger if exists portive_prospect_cost_terminal on public.call_attempts;
create trigger portive_prospect_cost_terminal after update of ended_at on public.call_attempts for each row execute function public.portive_cost_terminal();

-- An invoice-complete reconciliation is administrative billing work, never a
-- browser assertion. Incomplete scans may add observed costs but release nothing.
create or replace function public.portive_reconcile_cost(p_hold text,p_records jsonb,p_complete boolean default false,p_reference text default null)
returns void language plpgsql security definer set search_path=public as $$
declare h public.dialer_cost_holds; r jsonb; total bigint; leg text;
begin
 select * into h from public.dialer_cost_holds where id=p_hold;
 if h.id is null then raise exception 'Unknown cost hold';end if;
 perform 1 from public.dial_sessions where id=h.session_id for update;
 select * into h from public.dialer_cost_holds where id=p_hold for update;
 if h.state='canceled' then raise exception 'No provider charge may be assigned to a proven-unsent leg';end if;
 if h.role='prospect' then select telnyx_call_leg_id into leg from public.call_attempts where id=h.attempt_id;
 else select details->>'call_leg_id' into leg from public.dial_audit_events where session_id=h.session_id and attempt_id is null and details->>'call_leg_id' is not null order by created_at limit 1;end if;
 for r in select value from jsonb_array_elements(p_records) loop
  if leg is null or r->>'callLegId' is distinct from leg or r->>'currency' is distinct from 'USD' or r->>'costMicros' is null or (r->>'costMicros')::bigint<0 or nullif(r->>'id','') is null or nullif(r->>'product','') is null then raise exception 'Invalid provider billing record';end if;
  insert into public.dialer_billing_records(id,hold_id,product,cost_micros,source)
   values(r->>'id',h.id,r->>'product',(r->>'costMicros')::bigint,r) on conflict(id) do nothing;
  if not exists(select 1 from public.dialer_billing_records where id=r->>'id' and hold_id=h.id and cost_micros=(r->>'costMicros')::bigint) then raise exception 'Billing identity conflict';end if;
 end loop;
 select coalesce(sum(cost_micros),0) into total from public.dialer_billing_records where hold_id=h.id;
 if p_complete then
  if h.terminal_at is null or coalesce(length(p_reference),0)<8 or not exists(select 1 from public.dialer_billing_records where hold_id=h.id)
   or exists(select 1 from public.dial_commands where session_id=h.session_id and state in ('pending','executing','uncertain')) then raise exception 'Terminal evidence, complete billing reference and settled commands required';end if;
  update public.dialer_cost_holds set billed_micros=total,state='reconciled',billing_reference=p_reference where id=h.id;
  if total>h.cap_cents::bigint*10000 then
   update public.dial_sessions set status='unsafe',reason='Provider bill exceeded configured component ceiling; reconcile pricing before more dispatch' where id=h.session_id;
  end if;
 else
  if h.state='reconciled' and total is distinct from h.billed_micros then raise exception 'Final invoice changed; administrative reconciliation required';end if;
  update public.dialer_cost_holds set billed_micros=total where id=h.id;
 end if;
 if total>h.cap_cents::bigint*10000 then update public.dial_sessions set status='unsafe',reason='Observed provider charges exceed the configured ceiling; dispatch stopped' where id=h.session_id;end if;
 update public.dial_sessions set reserved_cost_cents=(select coalesce(sum(case when state='reconciled' then ceil(billed_micros::numeric/10000) when state='held' then cap_cents else 0 end),0) from public.dialer_cost_holds where session_id=h.session_id) where id=h.session_id;
end $$;

-- Expiry, Stop and provider reconciliation must share a single operator hangup.
-- Preserve legacy/Power/diagnostic command keys.
create or replace function public.portive_enqueue(p_session text,p_attempt text,p_action text,p_key text,p_parameters jsonb default '{}')
returns void language sql set search_path=public as $$
 insert into public.dial_commands(session_id,attempt_id,action,command_key,parameters)
 values(p_session,p_attempt,p_action,case when p_action='hangup_operator' and exists(select 1 from public.dial_sessions where id=p_session and parallel_options->>'budgetVersion'='exposure-v1') then p_session||':funded-operator-hangup' else p_key end,p_parameters)
 on conflict(command_key) do nothing
$$;

do $patch$
declare src text; changed text;
begin
 src:=pg_get_functiondef('public.portive_parallel_command_base(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)'::regprocedure);
 if position('portive_validate_cost' in src)=0 then
  changed:=replace(src,$q$v.rate_ceiling_cents:=(p_options->>'rateCeilingCents')::integer;$q$,$s$perform public.portive_validate_cost(p_options,p_lines);
    p_options:=p_options||jsonb_build_object('budgetVersion','exposure-v1','deadlineAt',clock_timestamp()+make_interval(secs=>(p_options->>'sessionSeconds')::integer));$s$);
  changed:=replace(changed,'or coalesce(v.rate_ceiling_cents,0)<1 or v.rate_ceiling_cents>10000','');
  changed:=replace(changed,'ceil(30*v.rate_ceiling_cents)::integer',$q$public.portive_leg_cap(p_options,'operator')$q$);
  changed:=replace(changed,$q$s.reserved_cost_cents + 2*(ceil((p_options->>'maxCallSeconds')::numeric/60)+1)*v.rate_ceiling_cents$q$, $q$s.reserved_cost_cents + public.portive_leg_cap(p_options,'prospect')$q$);
  changed:=replace(changed,$s$v.rate_ceiling_cents:=(s.parallel_options->>'rateCeilingCents')::integer;
  if coalesce(v.rate_ceiling_cents,0)<1 then update public.dial_sessions set status='paused',reason='Session cost ceiling is missing; stop and start a new session' where id=s.id returning * into s; return to_jsonb(s); end if;$s$,$s$if (s.parallel_options->'costProfile'->>'expiresAt')::timestamptz<=clock_timestamp() then update public.dial_sessions set status='stopping',reason='Tariff expired; no new dispatch' where id=s.id returning * into s;return to_jsonb(s);end if;$s$);
  changed:=replace(changed,$q$per_attempt:=2*ceil((s.parallel_options->>'maxCallSeconds')::numeric/60)*v.rate_ceiling_cents+2*v.rate_ceiling_cents;$q$, $q$per_attempt:=public.portive_leg_cap(s.parallel_options,'prospect');$q$);
  changed:=replace(changed,$q$interval '1800 seconds'$q$, $q$make_interval(secs=>(s.parallel_options->>'sessionSeconds')::integer)$q$);
  changed:=replace(changed,$q$(s.parallel_options->>'ringTimeout')::integer)$q$,$q$(s.parallel_options->>'ringTimeout')::integer+23)$q$);
  changed:=replace(changed,$q$if p_action <> 'tick' then return to_jsonb(s); end if;$q$, $q$if p_action <> 'tick' then return to_jsonb(s); end if; s:=public.portive_budget_tick(s.id);$q$);
  changed:=replace(changed,'phone:=public.portive_phone(l.phone_number);',$s$phone:=public.portive_phone(l.phone_number);
    if not exists(select 1 from jsonb_array_elements_text(s.parallel_options->'costProfile'->'destinationPrefixes') prefix where phone like prefix||'%') then continue;end if;$s$);
  if position('v.rate_ceiling_cents' in changed)>0 or changed=src then raise exception 'Budget scheduler body drift';end if;
  execute changed;
 end if;
 src:=pg_get_functiondef('public.portive_orchestration_authorize(uuid)'::regprocedure);
 if position('funded_deadline' in src)=0 then
  changed:=replace(src,$q$if c.action='dial_lead' and deny_reason is null then$q$,$s$if s.parallel_options->>'budgetVersion'='exposure-v1' and c.action in ('dial_operator','dial_lead') and deny_reason is null then
    if (s.parallel_options->>'deadlineAt')::timestamptz<=clock_timestamp()+make_interval(secs=>case when c.action='dial_operator' then 28 else (s.parallel_options->>'maxCallSeconds')::integer+(s.parallel_options->>'ringTimeout')::integer+23 end) then deny_reason:='funded_deadline';
    elsif not exists(select 1 from public.dialer_cost_holds h where h.session_id=s.id and h.state='held'
      and h.id=case when c.action='dial_operator' then s.id||':operator' else c.attempt_id end) then deny_reason:='unfunded_leg';
    elsif c.action='dial_lead' and not exists(select 1 from jsonb_array_elements_text(s.parallel_options->'costProfile'->'destinationPrefixes') p where c.parameters->>'to' like p||'%') then deny_reason:='destination_tariff_missing';end if;
  end if;
  if c.action='dial_lead' and deny_reason is null then$s$);
  if changed=src then raise exception 'Budget authorization body drift';end if;execute changed;
 end if;
 src:=pg_get_functiondef('public.portive_orchestration_work(text)'::regprocedure);
 if position('budgetVersion' in src)=0 then
  changed:=replace(src,'union all select classification_deadline_at', $s$union all select (s.parallel_options->>'deadlineAt')::timestamptz where s.parallel_options->>'budgetVersion'='exposure-v1'
    union all select answered_at+make_interval(secs=>(s.parallel_options->>'maxCallSeconds')::integer) from public.call_attempts where dial_session_id=s.id and ended_at is null and answered_at is not null and s.parallel_options->>'budgetVersion'='exposure-v1'
    union all select classification_deadline_at$s$);
  changed:=replace(changed,$q$greatest(s.started_at+interval '1820 seconds',coalesce(s.operator_checked_at+interval '60 seconds',s.started_at))$q$,$s$case when s.parallel_options->>'budgetVersion'='exposure-v1' then coalesce(s.operator_checked_at+interval '60 seconds',case when s.status in ('stopping','unsafe') then s.started_at else (s.parallel_options->>'deadlineAt')::timestamptz+interval '20 seconds' end) else greatest(s.started_at+interval '1820 seconds',coalesce(s.operator_checked_at+interval '60 seconds',s.started_at)) end$s$);execute changed;
 end if;
src:=pg_get_functiondef('public.portive_parallel_eligibility(text,text,text)'::regprocedure);
 if position('destination_tariff_missing' in src)=0 then
  changed:=replace(src,'select case',$s$select case
  when exists(select 1 from public.app_settings where key='dialer_cost_profile') and not exists(
   select 1 from public.app_settings tariff,jsonb_array_elements_text(tariff.value_json->'destinationPrefixes') prefix where tariff.key='dialer_cost_profile' and public.portive_phone(l.phone_number) like prefix||'%') then 'destination_tariff_missing'$s$);
  if changed=src then raise exception 'Tariff eligibility body drift';end if;execute changed;
 end if;
end $patch$;

create or replace function public.portive_budget_status(p_session text default null)
returns jsonb language sql security definer set search_path=public as $$
select jsonb_build_object('budgetVersion','exposure-v1',
 'heldCents',coalesce(sum(case when state='held' then cap_cents else 0 end),0),
 'actualObservedMicros',coalesce(sum(billed_micros),0),'billingComplete',coalesce(bool_and(state in ('reconciled','canceled')),false),
 'reconciledCents',coalesce(sum(case when state='reconciled' then ceil(billed_micros::numeric/10000) else 0 end),0))
 from public.dialer_cost_holds where p_session is null or session_id=p_session
$$;
create or replace function public.portive_next_calling_time(p_lead text,p_timezone text,p_after timestamptz default clock_timestamp())
returns timestamptz language plpgsql security definer set search_path=public as $$
declare t timestamptz:=p_after; reason text; n integer;
begin
 reason:=public.portive_calling_hours(p_lead,p_timezone,t);
 if reason is null then return t;end if;
 if reason not in ('outside_calling_window','outside_default_calling_days','outside_campaign_calling_days') then return null;end if;
 t:=date_trunc('minute',t)+interval '1 minute';
 for n in 1..11520 loop
  if public.portive_calling_hours(p_lead,p_timezone,t) is null then return t;end if;
  t:=t+interval '1 minute';
 end loop;
 return null;
end $$;
create or replace function public.portive_next_calling_window(p_list text,p_timezone text)
returns jsonb language sql security definer set search_path=public as $$
with candidates as (
 select l.id,coalesce(nullif(l.custom_fields_json->>'timeZone',''),case when public.portive_us_state(coalesce(nullif(l.state,''),l.custom_fields_json->>'state',l.custom_fields_json->>'stateCode'))='CO' then 'America/Denver' else p_timezone end) tz
 from public.leads l where l.lead_list_id=p_list
 and public.portive_phone(l.phone_number) ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'
 and l.derived_status not in ('bad_number','closed_lost')
 and coalesce(l.custom_fields_json->>'workspaceHidden','false')<>'true'
 and coalesce(l.custom_fields_json->>'doNotCall','false')<>'true' and coalesce(l.custom_fields_json->>'suppressed','false')<>'true'
 and coalesce(l.custom_fields_json->>'automatedCallingApproved','true')<>'false'
 and not exists(select 1 from public.dial_suppressions where phone_number=public.portive_phone(l.phone_number))
 and not exists(select 1 from public.follow_ups where lead_id=l.id and status='open' and due_at>now())
 and not exists(select 1 from public.call_attempts where lead_id=l.id and (ended_at is null and status in ('dialing','connected') or callback_at>now()))
), windows as (select public.portive_next_calling_time(id,tz) at,tz from candidates)
select coalesce((select jsonb_build_object('at',at,'timeZone',tz) from windows where at is not null order by at limit 1),jsonb_build_object('at',null,'timeZone',p_timezone))
$$;
do $$declare f regprocedure;begin
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in
 ('portive_leg_cap','portive_validate_cost','portive_create_cost_hold','portive_budget_tick','portive_reconcile_cost','portive_budget_status','portive_cost_terminal','portive_next_calling_time','portive_next_calling_window') loop
 execute format('revoke all on function %s from public,anon,authenticated',f);execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
commit;

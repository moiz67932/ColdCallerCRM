-- Apply after all three dialer migrations. PostgreSQL remains the call-state authority.
begin;
create table if not exists public.dialer_orchestration_config (
  id boolean primary key default true check(id),
  backend text not null default 'node' check(backend in ('node','cloudflare')),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.dialer_orchestration_config(id) values(true) on conflict do nothing;
alter table public.dialer_orchestration_config enable row level security;
revoke all on public.dialer_orchestration_config from public,anon,authenticated;
grant all on public.dialer_orchestration_config to service_role;
alter table public.dial_sessions add column if not exists orchestration_backend text not null default 'node' check(orchestration_backend in ('node','cloudflare'));
alter table public.dial_sessions add column if not exists operator_checked_at timestamptz;
alter table public.call_attempts add column if not exists orchestration_checked_at timestamptz;
alter table public.workstation_telnyx_webhook_events add column if not exists raw_body text;
alter table public.workstation_telnyx_webhook_events add column if not exists orchestration_timing jsonb;

create or replace function public.portive_orchestration_guard(p_backend text,p_session text default null)
returns void language plpgsql set search_path=public as $$
declare cfg public.dialer_orchestration_config;
begin
  perform pg_advisory_xact_lock(hashtextextended('portive-single-operator',0));
  select * into cfg from public.dialer_orchestration_config where id;
  if cfg.backend is distinct from p_backend then raise exception 'Orchestration backend mismatch; drain and reconcile before switching'; end if;
  if p_backend='cloudflare' and not cfg.enabled then raise exception 'Cloudflare orchestration is disabled in database'; end if;
  if p_session is not null and not exists(select 1 from public.dial_sessions where id=p_session and orchestration_backend=p_backend) then
    raise exception 'Session belongs to a different orchestration backend'; end if;
end $$;

create or replace function public.portive_set_orchestration_backend(p_backend text,p_enabled boolean default false)
returns void language plpgsql set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('portive-single-operator',0));
  if p_backend not in ('node','cloudflare') then raise exception 'Invalid backend'; end if;
  if exists(select 1 from public.dial_sessions where status in ('running','paused','stopping','unsafe'))
    or exists(select 1 from public.call_attempts where ended_at is null and status in ('dialing','connected','voicemail_detected'))
    or exists(select 1 from public.dial_commands where state in ('pending','executing','uncertain'))
    or exists(select 1 from public.dial_provider_commands where state in ('executing','uncertain')) then
    raise exception 'Finish sessions and reconcile pending or uncertain provider commands before switching'; end if;
  update public.dialer_orchestration_config set backend=p_backend,enabled=p_enabled,updated_at=now() where id;
  delete from public.app_settings where key in ('dialer_watchdog_heartbeat','dialer_cloudflare_heartbeat');
end $$;

create or replace function public.portive_bind_orchestrator() returns trigger language plpgsql set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('portive-single-operator',0));
  select backend into new.orchestration_backend from public.dialer_orchestration_config where id;
  return new;
end $$;
drop trigger if exists portive_bind_orchestrator on public.dial_sessions;
create trigger portive_bind_orchestrator before insert on public.dial_sessions for each row execute function public.portive_bind_orchestrator();

create or replace function public.portive_orchestrator_ready(p_node_seconds integer) returns boolean language sql set search_path=public as $$
select exists(select 1 from public.dialer_orchestration_config c join public.app_settings a on a.key=
 case when c.backend='node' then 'dialer_watchdog_heartbeat' else 'dialer_cloudflare_heartbeat' end
 where c.id and (c.backend='node' or c.enabled) and (a.value_json->>'at')::timestamptz > now()-make_interval(secs=>case when c.backend='node' then p_node_seconds else 30 end))
$$;
-- Preserve the existing transactional dialer functions. Change only their readiness dependency.
do $patch$
declare src text; patched text;
begin
  src:=pg_get_functiondef('public.portive_parallel_command(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)'::regprocedure);
  patched:=replace(src, $$not exists(select 1 from public.app_settings where key='dialer_watchdog_heartbeat' and (value_json->>'at')::timestamptz>now()-interval '3 seconds')$$, 'not public.portive_orchestrator_ready(3)');
  if patched=src and position('portive_orchestrator_ready(3)' in src)=0 then raise exception 'Unexpected parallel function: readiness patch not applied'; end if;
  execute patched;
  src:=pg_get_functiondef('public.portive_session_command(text,uuid,text,boolean,text,text,integer,text,integer,text,boolean)'::regprocedure);
  patched:=regexp_replace(src, 'not exists\s*\(\s*select 1 from public.app_settings where key=''dialer_watchdog_heartbeat''\s*and \(value_json->>''at''\)::timestamptz > now\(\) - interval ''30 seconds''\s*\)', 'not public.portive_orchestrator_ready(30)');
  if patched=src and position('portive_orchestrator_ready(30)' in src)=0 then raise exception 'Unexpected Power function: readiness patch not applied'; end if;
  execute patched;
end $patch$;

create or replace function public.portive_orchestration_prepare(p_backend text) returns void language plpgsql set search_path=public as $$
begin
  perform public.portive_orchestration_guard(p_backend);
  insert into public.app_settings(key,value_json) values(case when p_backend='node' then 'dialer_watchdog_heartbeat' else 'dialer_cloudflare_heartbeat' end,jsonb_build_object('at',now()))
  on conflict(key) do update set value_json=excluded.value_json;
end $$;

-- Fences the old Node consumer too. A stale Node process cannot claim Cloudflare commands.
create or replace function public.portive_claim_parallel_commands(p_limit integer default 12)
returns setof public.dial_commands language plpgsql set search_path=public as $$
begin
  perform public.portive_orchestration_guard('node');
  return query update public.dial_commands set state='executing',claimed_at=now() where id in (
    select c.id from public.dial_commands c join public.dial_sessions s on s.id=c.session_id
    where c.state='pending' and s.orchestration_backend='node' order by c.created_at for update of c skip locked limit least(p_limit,12)
  ) returning *;
end $$;

create or replace function public.portive_orchestration_work(p_session text)
returns jsonb language plpgsql set search_path=public as $$
declare s public.dial_sessions; active_attempt public.call_attempts; cmds jsonb; deadlines jsonb;
begin
  perform public.portive_orchestration_guard('cloudflare',p_session);
  select * into s from public.dial_sessions where id=p_session for update;
  perform public.portive_orchestration_prepare('cloudflare');
  -- Never reclaim a possibly sent dial. Terminal evidence / manual reconciliation is required.
  with stale as (update public.dial_commands set state='uncertain',error='Executor acknowledgement lost' where session_id=s.id and state='executing' and claimed_at<now()-interval '60 seconds' returning id)
  update public.dial_sessions set status='unsafe',reason='Provider command acknowledgement missing' where id=s.id and exists(select 1 from stale);
  -- Reserved calls which were never submitted can be closed without inventing provider evidence.
  with canceled as (update public.dial_commands c set state='canceled',completed_at=now() from public.call_attempts a
    where c.attempt_id=a.id and c.session_id=s.id and c.action='dial_lead' and c.state='pending'
      and (a.termination_reason is not null or s.status<>'running' or s.active_call_id is not null or not s.browser_media_ready)
    returning c.attempt_id)
  update public.call_attempts set status='canceled',ended_at=now(),technical_state=case when s.active_call_id is not null then 'canceled_after_winner' else 'canceled_before_answer' end
  where id in (select attempt_id from canceled) and telnyx_call_control_id is null;
  if s.mode='parallel' then
    perform public.portive_parallel_command(s.id,s.controller_id,'tick');
  elsif s.status not in ('completed','stopped') then
    select * into active_attempt from public.call_attempts where id=s.active_call_id;
    if s.heartbeat_at<now()-interval '45 seconds' or s.status in ('stopping','unsafe') then
      update public.dial_sessions set status='stopping',reason=case when s.heartbeat_at<now()-interval '45 seconds' then 'Browser lease expired' else s.reason end where id=s.id;
      if active_attempt.id is null or active_attempt.ended_at is not null then
        update public.dial_sessions set status='stopped',ended_at=now() where id=s.id;
      elsif active_attempt.answered_at is null or s.heartbeat_at<now()-interval '45 seconds' or s.status='unsafe' then
        if active_attempt.telnyx_call_control_id is null and active_attempt.telnyx_agent_call_control_id is null then
          update public.dial_sessions set status='unsafe',reason='Provider call identity missing; reconciliation required' where id=s.id;
        else
          perform public.portive_enqueue(s.id,active_attempt.id,'hangup',active_attempt.id||':power-cleanup','{"force":"true"}');
        end if;
      end if;
    end if;
  end if;
  select * into s from public.dial_sessions where id=p_session;
  with selected as (
    select c.id from public.dial_commands c where c.session_id=s.id and c.state='pending'
    order by case c.action when 'bridge' then 0 when 'hangup' then 1 when 'hangup_operator' then 1 else 2 end,c.created_at
    for update skip locked limit 4
  ), claimed as (
    update public.dial_commands set state='executing',claimed_at=now() where id in (select id from selected) returning *
  ) select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('session',to_jsonb(s),'attempt',to_jsonb(a))),'[]') into cmds
    from claimed c left join public.call_attempts a on a.id=c.attempt_id;
  select coalesce(jsonb_agg(due),'[]') into deadlines from (
    select s.heartbeat_at+case when s.mode='parallel' then interval '10.001 seconds' else interval '45.001 seconds' end as due
      where s.status='running' or exists(select 1 from public.call_attempts where dial_session_id=s.id and ended_at is null)
    union all select s.next_batch_at where s.mode='parallel' and s.status='running' and s.active_call_id is null and s.operator_leg_state='ready' and not exists(select 1 from public.call_attempts where dial_session_id=s.id and ended_at is null)
    union all select classification_deadline_at from public.call_attempts where dial_session_id=s.id and ended_at is null and termination_reason is null
    union all select claimed_at+interval '60 seconds' from public.dial_commands where session_id=s.id and state='executing'
    union all select now()+interval '2 seconds' where exists(select 1 from public.dial_commands where session_id=s.id and state='pending')
    union all select greatest(coalesce(orchestration_checked_at,started_at),started_at)+make_interval(secs=>case when orchestration_checked_at is not null then 60 when answered_at is null then coalesce((s.parallel_options->>'ringTimeout')::integer,120)+20 else coalesce((s.parallel_options->>'maxCallSeconds')::integer,300)+20 end)
      from public.call_attempts where dial_session_id=s.id and ended_at is null
    union all select greatest(s.started_at+interval '1820 seconds',coalesce(s.operator_checked_at+interval '60 seconds',s.started_at)) where s.mode='parallel' and s.operator_terminal_at is null
  ) d where due is not null and due>now() and (s.status not in ('completed','stopped') or exists(select 1 from public.call_attempts where dial_session_id=s.id and ended_at is null));
  return jsonb_build_object('session',to_jsonb(s),'commands',cmds,'deadlines',deadlines,'operator_reconcile',(s.mode='parallel' and s.operator_call_control_id is not null and s.operator_terminal_at is null and greatest(s.started_at+interval '1820 seconds',coalesce(s.operator_checked_at+interval '60 seconds',s.started_at))<=now()),'reconcile',coalesce((
    select jsonb_agg(to_jsonb(a)) from public.call_attempts a where a.dial_session_id=s.id and a.ended_at is null
    and a.telnyx_call_control_id is not null
    and greatest(coalesce(a.orchestration_checked_at,a.started_at),a.started_at)+make_interval(secs=>case when a.orchestration_checked_at is not null then 60 when a.answered_at is null then coalesce((s.parallel_options->>'ringTimeout')::integer,120)+20 else coalesce((s.parallel_options->>'maxCallSeconds')::integer,300)+20 end)<=now()
  ),'[]'));

end $$;

-- Last state check before sending HTTP. No database lock is held across provider I/O.
create or replace function public.portive_orchestration_authorize(p_command uuid)
returns jsonb language plpgsql set search_path=public as $$
declare c public.dial_commands; s public.dial_sessions; a public.call_attempts;
begin
  select * into c from public.dial_commands where id=p_command;
  perform public.portive_orchestration_guard('cloudflare',c.session_id);
  select * into s from public.dial_sessions where id=c.session_id for update;
  select * into c from public.dial_commands where id=p_command for update;
  select * into a from public.call_attempts where id=c.attempt_id;
  if c.state<>'executing' then return jsonb_build_object('allowed',false); end if;
  if (c.action='dial_lead' and (s.status<>'running' or s.active_call_id is not null or not s.browser_media_ready or a.termination_reason is not null))
    or (c.action='dial_operator' and s.status<>'running')
    or (c.action='bridge' and (s.active_call_id is distinct from a.id or a.ended_at is not null)) then
    update public.dial_commands set state='canceled',completed_at=now() where id=c.id;
    if c.action='dial_lead' and a.telnyx_call_control_id is null then
      update public.call_attempts set status='canceled',ended_at=now(),technical_state=case when s.active_call_id is not null then 'canceled_after_winner' else 'canceled_before_answer' end where id=a.id;
    end if;
    return jsonb_build_object('allowed',false);
  end if;
  return jsonb_build_object('allowed',true,'session',to_jsonb(s),'attempt',to_jsonb(a));
end $$;

create or replace function public.portive_orchestration_complete(p_command uuid,p_ok boolean,p_response jsonb default '{}',p_status integer default 0,p_defer boolean default false)
returns void language plpgsql set search_path=public as $$
declare c public.dial_commands; ids jsonb;
begin
  select * into c from public.dial_commands where id=p_command;
  perform public.portive_orchestration_guard('cloudflare',c.session_id);
  select * into c from public.dial_commands where id=p_command for update;
  if c.state<>'executing' then return; end if;
  if p_defer and c.created_at>now()-interval '60 seconds' then
    update public.dial_commands set state='pending',claimed_at=null where id=c.id; return;
  end if;
  if p_ok then
    ids:=p_response->'data';
    if c.action='dial_operator' then update public.dial_sessions set operator_call_control_id=coalesce(operator_call_control_id,ids->>'call_control_id') where id=c.session_id;
    elsif c.action='dial_lead' then update public.call_attempts set telnyx_call_control_id=coalesce(telnyx_call_control_id,ids->>'call_control_id'),telnyx_call_leg_id=coalesce(telnyx_call_leg_id,ids->>'call_leg_id'),telnyx_call_session_id=coalesce(telnyx_call_session_id,ids->>'call_session_id') where id=c.attempt_id; end if;
    update public.dial_commands set state='confirmed',response_json=p_response,completed_at=now() where id=c.id;
  else
    update public.dial_commands set state='uncertain',error='Provider request failed or acknowledgement uncertain (HTTP '||p_status||')' where id=c.id;
    update public.dial_sessions set status='unsafe',reason='Cloudflare provider command failed; inspect command '||c.id where id=c.session_id;
    if c.action='dial_lead' and p_status between 400 and 499 and p_status<>408 then
      update public.call_attempts set status='failed',technical_state='failed',ended_at=now(),termination_reason='provider_'||p_status where id=c.attempt_id;
    elsif c.action='bridge' and p_status between 400 and 499 and p_status<>408 then
      perform public.portive_enqueue(c.session_id,c.attempt_id,'hangup',c.attempt_id||':bridge-failure','{"force":"true"}');
    end if;
    insert into public.dial_audit_events(session_id,attempt_id,event_type,details) values(c.session_id,c.attempt_id,'provider_command_failed',jsonb_build_object('commandId',c.id,'status',p_status));
  end if;
end $$;

create or replace function public.portive_cloudflare_event(p_session text,p_attempt text,p_role text,p_event jsonb,p_raw text,p_timing jsonb)
returns jsonb language plpgsql set search_path=public as $$
begin
  perform public.portive_orchestration_guard('cloudflare',p_session);
  insert into public.workstation_telnyx_webhook_events(event_id,event_type,payload_json,signature_verified,raw_body,orchestration_timing)
    values(p_event->'data'->>'id',p_event->'data'->>'event_type',p_event,true,p_raw,p_timing) on conflict(event_id) do nothing;
  update public.workstation_telnyx_webhook_events set raw_body=coalesce(raw_body,p_raw),orchestration_timing=coalesce(orchestration_timing,'{}')||p_timing where event_id=p_event->'data'->>'id';
  if p_role='operator' and exists(select 1 from public.dial_sessions where id=p_session and status in ('stopped','completed')) then
    update public.workstation_telnyx_webhook_events set processed_at=now(),processing_error=null where event_id=p_event->'data'->>'id';
    insert into public.dial_audit_events(session_id,event_type,details) values(p_session,'terminal_operator_event_ignored',p_event);
  else
    perform public.portive_parallel_event(p_session,p_attempt,p_role,p_event->'data'->>'event_type',p_event->'data'->'payload',coalesce((p_event->'data'->>'occurred_at')::timestamptz,now()),p_event->'data'->>'id');
  end if;
  return public.portive_orchestration_work(p_session);
end $$;

-- Recovery only consumes positive terminal evidence; it never retries an uncertain dial.
create or replace function public.portive_orchestration_reconcile(p_session text,p_attempt text,p_alive boolean,p_control text)
returns void language plpgsql set search_path=public as $$
begin
  perform public.portive_orchestration_guard('cloudflare',p_session);
  if not exists(select 1 from public.call_attempts where id=p_attempt and dial_session_id=p_session and telnyx_call_control_id=p_control) then raise exception 'Reconciliation identity mismatch'; end if;
  update public.call_attempts set orchestration_checked_at=now() where id=p_attempt;
  if not p_alive then
    update public.call_attempts set ended_at=coalesce(ended_at,now()),status=case when answered_at is not null then 'completed' else 'failed' end,technical_state=case when technical_state in ('answer_collision','canceled_after_winner','canceled_before_answer','answer_unknown') then technical_state else 'provider_terminal_reconciled' end where id=p_attempt;
    update public.dial_sessions set status='unsafe',reason='Missed terminal webhook reconciled; review disposition before resuming' where id=p_session;
  end if;
  insert into public.dial_audit_events(session_id,attempt_id,event_type,details) values(p_session,p_attempt,'provider_reconciliation',jsonb_build_object('alive',p_alive));
end $$;

create or replace function public.portive_orchestration_operator(p_session text,p_control text,p_alive boolean)
returns void language plpgsql set search_path=public as $$
begin
  perform public.portive_orchestration_guard('cloudflare',p_session);
  if not exists(select 1 from public.dial_sessions where id=p_session and operator_call_control_id=p_control) then raise exception 'Operator reconciliation identity mismatch'; end if;
  update public.dial_sessions set operator_checked_at=now() where id=p_session;
  if p_alive then
    update public.dial_sessions set status='unsafe',reason='Operator leg exceeded bounded lease',browser_media_ready=false where id=p_session;
    perform public.portive_enqueue(p_session,null,'hangup_operator',p_session||':expired-operator');
  else
    update public.dial_sessions set operator_terminal_at=coalesce(operator_terminal_at,now()),operator_leg_state='disconnected',browser_media_ready=false,
      status=case when exists(select 1 from public.call_attempts where dial_session_id=p_session and (ended_at is null or (id=public.dial_sessions.active_call_id and disposition_saved_at is null))) then 'unsafe' else 'stopped' end where id=p_session;
  end if;
  insert into public.dial_audit_events(session_id,event_type,details) values(p_session,'operator_reconciliation',jsonb_build_object('alive',p_alive));
end $$;

-- Delayed verified metadata may arrive after rollback. It must not dispatch commands.
create or replace function public.portive_orchestration_terminal_event(p_session text,p_attempt text,p_role text,p_event jsonb)
returns void language plpgsql set search_path=public as $$
begin
  perform 1 from public.dial_sessions where id=p_session and mode='parallel' and status in ('stopped','completed') for update;
  if not found then raise exception 'Session is not terminal'; end if;
  if not exists(select 1 from public.workstation_telnyx_webhook_events where event_id=p_event->'data'->>'id' and signature_verified) then raise exception 'Verified event required'; end if;
  if p_role='lead' then
    perform 1 from public.call_attempts where id=p_attempt and dial_session_id=p_session and ended_at is not null for update;
    if not found then raise exception 'Terminal attempt required'; end if;
    -- The existing terminal-attempt branch records late answers without enqueuing actions.
    perform public.portive_parallel_event(p_session,p_attempt,p_role,p_event->'data'->>'event_type',p_event->'data'->'payload',coalesce((p_event->'data'->>'occurred_at')::timestamptz,now()),p_event->'data'->>'id');
  else
    update public.workstation_telnyx_webhook_events set processed_at=now(),processing_error=null where event_id=p_event->'data'->>'id';
    insert into public.dial_audit_events(session_id,event_type,details) values(p_session,'terminal_operator_event_ignored',p_event);
  end if;
end $$;

-- Every new function is server-only, including trigger/readiness helpers.
do $$
declare f regprocedure;
begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in (
    'portive_orchestration_guard','portive_set_orchestration_backend','portive_bind_orchestrator','portive_orchestrator_ready','portive_orchestration_prepare','portive_orchestration_work','portive_orchestration_complete','portive_orchestration_authorize','portive_cloudflare_event','portive_orchestration_reconcile','portive_orchestration_operator','portive_orchestration_terminal_event') loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
commit;

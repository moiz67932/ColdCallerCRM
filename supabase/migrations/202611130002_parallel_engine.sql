begin;
create table if not exists public.dialer_provider_verifications (
  id uuid primary key default gen_random_uuid(),
  config_fingerprint text not null,
  connection_id text not null,
  profile_id text not null,
  account_channels integer not null check(account_channels >= 5),
  overflow_slots integer not null check(overflow_slots >= 0),
  rate_ceiling_cents integer not null check(rate_ceiling_cents > 0),
  evidence jsonb not null,
  verified_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check(evidence->>'suite' = 'portive-parallel-v1' and evidence->>'passed' = 'true'),
  check(expires_at > verified_at)
);
-- Refresh the original overflow constraint when upgrading an already-installed table.
alter table public.dialer_provider_verifications
  drop constraint if exists dialer_provider_verifications_overflow_slots_check;
alter table public.dialer_provider_verifications
  add constraint dialer_provider_verifications_overflow_slots_check check(overflow_slots >= 0);
alter table public.dialer_provider_verifications enable row level security;
revoke all on public.dialer_provider_verifications from anon,authenticated;
grant all on public.dialer_provider_verifications to service_role;

alter table public.dial_sessions
  add column if not exists operator_call_control_id text,
  add column if not exists operator_terminal_at timestamptz,
  add column if not exists operator_leg_state text not null default 'disconnected',
  add column if not exists browser_media_ready boolean not null default false,
  add column if not exists parallel_batch integer not null default 0,
  add column if not exists next_batch_at timestamptz not null default now(),
  add column if not exists parallel_options jsonb not null default '{}',
  add column if not exists verification_id uuid references public.dialer_provider_verifications(id),
  add column if not exists reserved_cost_cents integer not null default 0;
alter table public.call_attempts
  add column if not exists parallel_batch integer,
  add column if not exists bridged_at timestamptz,
  add column if not exists ringing_at timestamptz,
  add column if not exists classification_deadline_at timestamptz,
  add column if not exists overflow_call_control_id text,
  add column if not exists overflow_state text,
  add column if not exists failure_deadline_at timestamptz,
  add column if not exists provider_billable_cost numeric,
  add column if not exists provider_billable_seconds numeric;
create index if not exists call_attempts_dial_session on public.call_attempts(dial_session_id,parallel_batch);

create table if not exists public.dial_commands (
  id uuid primary key default gen_random_uuid(),
  command_key text not null unique,
  session_id text not null references public.dial_sessions(id),
  attempt_id text references public.call_attempts(id),
  action text not null check(action in ('dial_operator','dial_lead','bridge','hangup','overflow','hangup_operator','failure_playback')),
  state text not null default 'pending' check(state in ('pending','executing','confirmed','uncertain','canceled')),
  parameters jsonb not null default '{}',
  response_json jsonb,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz
);
alter table public.dial_commands enable row level security;
revoke all on public.dial_commands from anon,authenticated;
grant all on public.dial_commands to service_role;

create or replace function public.portive_attempt_integrity() returns trigger language plpgsql set search_path = public as $$
declare l public.leads; s public.dial_sessions;
begin
  if tg_op = 'INSERT' and new.status = 'dialing' and new.ended_at is null then
    perform pg_advisory_xact_lock(hashtextextended('portive-single-operator', 0));
    select * into l from public.leads where id = new.lead_id;
    if exists (select 1 from public.dial_suppressions where phone_number = public.portive_phone(l.phone_number))
      or l.derived_status in ('bad_number','closed_lost') or coalesce(l.custom_fields_json->>'doNotCall','false') = 'true'
      or coalesce(l.custom_fields_json->>'suppressed','false') = 'true' then
      raise exception 'Destination is suppressed or ineligible';
    end if;
    if exists (select 1 from public.call_attempts c where c.ended_at is null and c.status in ('dialing','connected','voicemail_detected') and (new.dial_session_id is null or c.dial_session_id is distinct from new.dial_session_id)) then
      raise exception 'An active call already exists for this operator';
    end if;
    select * into s from public.dial_sessions where status in ('running','paused','stopping','unsafe') limit 1;
    if s.id is not null and (new.dial_session_id is distinct from s.id or s.status <> 'running') then
      raise exception 'Stop the current dial session before manual dialing';
    end if;
    if s.mode='parallel' then
      if s.active_call_id is not null or not s.browser_media_ready or s.operator_leg_state <> 'ready' then raise exception 'Operator unavailable'; end if;
      if (select count(*) from public.call_attempts where dial_session_id=s.id and ended_at is null) >= s.max_lines then raise exception 'Parallel concurrency limit exceeded'; end if;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.raw_summary_json := coalesce(old.raw_summary_json,'{}') || coalesce(new.raw_summary_json,'{}');
    new.answered_at := coalesce(old.answered_at, new.answered_at);
    new.was_bridged_to_operator := old.was_bridged_to_operator or new.was_bridged_to_operator;
    if old.ended_at is not null then
      new.ended_at := old.ended_at;
      new.status := old.status;
      if old.status = 'canceled' and new.answered_at is not null then new.status := 'completed'; end if;
      if new.raw_summary_json->>'progressState' in ('dialing_lead','lead_ringing','lead_answered','browser_answered','bridged','browser_ready') then
        new.raw_summary_json := jsonb_set(new.raw_summary_json,'{progressState}',to_jsonb(coalesce(old.raw_summary_json->>'progressState','ended')));
      end if;
    elsif old.status = 'connected' and new.status = 'dialing' then
      new.status := 'connected';
      new.raw_summary_json := jsonb_set(new.raw_summary_json,'{progressState}',to_jsonb(coalesce(old.raw_summary_json->>'progressState','bridged')));
    end if;
    if new.status = 'canceled' and new.answered_at is not null then new.status := 'completed'; end if;
    if old.answer_classification = 'human' then
      new.answer_classification := 'human';
    end if;
    if old.was_bridged_to_operator and new.raw_summary_json->>'progressState' in
      ('browser_connecting','browser_ready','dialing_lead','lead_ringing','lead_answered','browser_answered') then
      new.raw_summary_json := jsonb_set(new.raw_summary_json,'{progressState}',to_jsonb(coalesce(old.raw_summary_json->>'progressState','bridged')));
    end if;
  end if;
  if new.ended_at is not null and new.answered_at is not null and new.duration_seconds is null then
    new.duration_seconds := greatest(0, floor(extract(epoch from new.ended_at - new.answered_at)))::integer;
  end if;
  return new;
end $$;

create or replace function public.portive_enqueue(p_session text,p_attempt text,p_action text,p_key text,p_parameters jsonb default '{}')
returns void language sql set search_path=public as $$
  insert into public.dial_commands(session_id,attempt_id,action,command_key,parameters)
  values(p_session,p_attempt,p_action,p_key,p_parameters) on conflict(command_key) do nothing
$$;

create or replace function public.portive_overflow(p_session text,p_attempt text,p_collision boolean)
returns void language plpgsql set search_path=public as $$
begin
  update public.call_attempts set technical_state=case when p_collision then 'answer_collision' else 'answer_unknown' end,
    lost_race_or_abandoned=p_collision,overflow_state='requested',classification_deadline_at=null
    where id=p_attempt and overflow_state is null;
  if found then
    perform public.portive_enqueue(p_session,p_attempt,'overflow',p_attempt||':overflow');
    insert into public.dial_audit_events(session_id,attempt_id,event_type) values(p_session,p_attempt,
      case when p_collision then 'answer_collision' else 'unknown_answer_overflow' end);
  end if;
end $$;

create or replace function public.portive_answer_collision(p_session text,p_attempt text)
returns void language plpgsql set search_path=public as $$
begin
  update public.call_attempts set answer_classification='human',technical_state='answer_collision',
    lost_race_or_abandoned=true,termination_reason=coalesce(termination_reason,'answer_collision'),
    answered_at=coalesce(answered_at,now()),classification_deadline_at=null
    where id=p_attempt and dial_session_id=p_session and ended_at is null;
  if found then
    perform public.portive_enqueue(p_session,p_attempt,'hangup',p_attempt||':cancel');
    insert into public.dial_audit_events(session_id,attempt_id,event_type) values(p_session,p_attempt,'answer_collision_hangup');
  end if;
end $$;

create or replace function public.portive_failure_playback(p_session text,p_attempt text,p_reason text) returns void language plpgsql set search_path=public as $$
begin
  update public.call_attempts set overflow_state='failure_playback',failure_deadline_at=now()+interval '10 seconds',
    lost_race_or_abandoned=true,termination_reason='overflow_failed: '||p_reason where id=p_attempt and dial_session_id=p_session and ended_at is null and overflow_state<>'failure_playback';
  if found then
    perform public.portive_enqueue(p_session,p_attempt,'failure_playback',p_attempt||':failure-explanation');
    update public.dial_sessions set status='unsafe',reason='Live overflow failed; explanation and cleanup required' where id=p_session;
    insert into public.dial_audit_events(session_id,attempt_id,event_type,details) values(p_session,p_attempt,'overflow_failed',jsonb_build_object('reason',p_reason));
  end if;
end $$;
revoke all on function public.portive_failure_playback(text,text,text) from public,anon,authenticated;
grant execute on function public.portive_failure_playback(text,text,text) to service_role;

create or replace function public.portive_cancel_parallel(p_session text,p_reason text)
returns void language plpgsql set search_path=public as $$
declare a public.call_attempts; s public.dial_sessions;
begin
  select * into s from public.dial_sessions where id=p_session for update;
  for a in select * from public.call_attempts where dial_session_id=s.id and id is distinct from s.active_call_id and ended_at is null for update loop
    if a.answered_at is not null and a.answer_classification='human' and s.active_call_id is not null then
      perform public.portive_answer_collision(s.id,a.id);
    elsif a.answered_at is not null and a.answer_classification='unknown' and s.active_call_id is not null then
      null; -- Wait briefly for AMD; the winner is already reserved and no new batch can start.
    elsif a.answered_at is not null and a.answer_classification <> 'machine' then
      update public.call_attempts set answer_classification='unknown',technical_state='answer_unknown',termination_reason=p_reason where id=a.id;
      perform public.portive_enqueue(s.id,a.id,'hangup',a.id||':unknown-answer-hangup','{"force":"true"}');
    else
      update public.call_attempts set termination_reason=p_reason,
        technical_state=case when p_reason='winner_selected' then 'canceled_after_winner' else 'canceled_before_answer' end where id=a.id;
      perform public.portive_enqueue(s.id,a.id,'hangup',a.id||':cancel');
    end if;
  end loop;
end $$;

create or replace function public.portive_parallel_command(
  p_session text,p_controller uuid,p_action text,p_ready boolean default false,
  p_list text default null,p_location text default null,p_lines integer default 4,p_timezone text default null,
  p_reviewed boolean default false,p_options jsonb default '{}'
) returns jsonb language plpgsql set search_path=public as $$
declare s public.dial_sessions; a public.call_attempts; l public.leads; v public.dialer_provider_verifications;
  phone text; business text; n integer:=0; capacity integer; per_attempt integer; candidate record;
begin
  perform pg_advisory_xact_lock(hashtextextended('portive-single-operator',0));
  if p_action='start' then
    select * into v from public.dialer_provider_verifications where id=(p_options->>'verificationId')::uuid and expires_at>now();
    if v.id is null or v.config_fingerprint is distinct from p_options->>'fingerprint' then raise exception 'Current provider verification evidence is missing'; end if;
    if p_lines not between 2 and 4 or v.account_channels < p_lines+1 then
      raise exception 'Verified provider capacity must cover prospect lines plus the operator leg'; end if;
    if not p_ready or not p_reviewed or p_timezone is null then raise exception 'Softphone, list review and timezone are required'; end if;
    perform now() at time zone p_timezone;
    if not exists(select 1 from public.app_settings where key='dialer_watchdog_heartbeat' and (value_json->>'at')::timestamptz>now()-interval '3 seconds') then
      raise exception 'Parallel worker is unavailable'; end if;
    if exists(select 1 from public.call_attempts where ended_at is null and status in ('dialing','connected','voicemail_detected')) then raise exception 'Active call exists'; end if;
    if (p_options->>'ringTimeout')::integer not between 15 and 120
      or (p_options->>'maxCallSeconds')::integer not between 30 and 1800
      or (p_options->>'attemptLimit')::integer not between 1 and 500
      or (p_options->>'batchDelaySeconds')::integer not between 0 and 60
      or (p_options->>'maxSpendCents')::integer < 1 then raise exception 'Invalid session limits'; end if;
    insert into public.dial_sessions(controller_id,selected_list_id,location,time_zone,mode,max_lines,attempt_limit,parallel_options,verification_id,reserved_cost_cents)
      values(p_controller,p_list,nullif(p_location,''),p_timezone,'parallel',p_lines,(p_options->>'attemptLimit')::integer,p_options,v.id,
      ceil(30*v.rate_ceiling_cents)::integer) returning * into s;
    if s.reserved_cost_cents > (p_options->>'maxSpendCents')::integer then raise exception 'Budget does not cover bounded operator leg'; end if;
    perform public.portive_enqueue(s.id,null,'dial_operator',s.id||':operator');
  else
    select * into s from public.dial_sessions where id=p_session and mode='parallel' for update;
    if s.id is null or (p_action <> 'tick' and s.controller_id <> p_controller) then raise exception 'Session controlled by another browser'; end if;
    if s.status in ('stopped','completed') then return to_jsonb(s); end if;
    if p_action='heartbeat' then
      update public.dial_sessions set heartbeat_at=now(),browser_media_ready=p_ready,
        status=case when not p_ready and status='running' then 'unsafe' else status end,
        reason=case when not p_ready then 'Operator audio unavailable' else reason end where id=s.id returning * into s;
      if p_options->>'transportReady'='false' and s.status='running' then
        update public.dial_sessions set status='paused',reason='Realtime transport unavailable; conversation preserved' where id=s.id returning * into s;
        perform public.portive_cancel_parallel(s.id,'transport_unavailable');
      end if;
    elsif p_action='operator_ready' then
      if s.operator_call_control_id is null or nullif(p_options->>'callControlId','') is null or s.operator_call_control_id is distinct from p_options->>'callControlId' or s.operator_leg_state not in ('answered','ready','bridged') then
        raise exception 'Operator media leg has not been verified'; end if;
      update public.dial_sessions set browser_media_ready=p_ready,operator_leg_state=case when operator_leg_state='bridged' then 'bridged' else 'ready' end,heartbeat_at=now() where id=s.id returning * into s;
    elsif p_action='pause' then
      update public.dial_sessions set status='paused',reason='Operator paused' where id=s.id returning * into s;
      perform public.portive_cancel_parallel(s.id,'operator_pause');
    elsif p_action='stop' then
      update public.dial_sessions set status='stopping',reason='Operator stopped; current conversation may finish' where id=s.id returning * into s;
      perform public.portive_cancel_parallel(s.id,'session_stopped');
    elsif p_action='resume' then
      if s.status <> 'paused' or not p_ready then raise exception 'Resume requires a paused session and connected softphone'; end if;
      update public.dial_sessions set status='running',reason=null,heartbeat_at=now() where id=s.id returning * into s;
    elsif p_action in ('continue','skip') then
      if s.active_call_id is not null then
        select * into a from public.call_attempts where id=s.active_call_id for update;
        if a.ended_at is null then raise exception 'Finish the active conversation first'; end if;
        if a.disposition_saved_at is null and p_action <> 'skip' then raise exception 'Save the disposition before continuing'; end if;
        if p_action='skip' then update public.call_attempts set disposition_saved_at=now() where id=a.id;
          insert into public.dial_audit_events(session_id,attempt_id,event_type) values(s.id,a.id,'disposition_explicitly_skipped'); end if;
      end if;
      update public.dial_sessions set parallel_options=jsonb_set(parallel_options,'{continueRequested}','true') where id=s.id returning * into s;
    elsif p_action not in ('tick','next') then raise exception 'Unknown parallel action'; end if;
  end if;

  -- A tick is the authoritative scheduler. Browser events alone never launch a batch.
  if p_action <> 'tick' then return to_jsonb(s); end if;
  if s.heartbeat_at<now()-interval '10 seconds' then
    update public.dial_sessions set status='unsafe',browser_media_ready=false,reason='Operator browser lease expired' where id=s.id returning * into s;
  end if;
  for a in select * from public.call_attempts where dial_session_id=s.id and ended_at is null and failure_deadline_at<=now() loop
    perform public.portive_enqueue(s.id,a.id,'hangup',a.id||':failure-cleanup','{"force":"true"}');
  end loop;
  if s.status='unsafe' then
    perform public.portive_cancel_parallel(s.id,'media_or_provider_failure');
    -- Failed media cannot preserve a usable operator conversation: route to staffed overflow.
    if s.active_call_id is not null and (not s.browser_media_ready or s.operator_terminal_at is not null) and exists(select 1 from public.call_attempts where id=s.active_call_id and ended_at is null) then
      update public.dial_sessions set status='unsafe',reason='Operator media was lost; active prospect call is being ended safely' where id=s.id;
      perform public.portive_enqueue(s.id,s.active_call_id,'hangup',s.active_call_id||':operator-media-lost','{"force":"true"}');
    end if;
    return to_jsonb(s);
  end if;
  for a in select * from public.call_attempts where dial_session_id=s.id and ended_at is null and classification_deadline_at<=now() and overflow_state is null loop
    update public.call_attempts set answer_classification='unknown',technical_state='answer_unknown',termination_reason='amd_deadline_unknown'
      where id=a.id and ended_at is null;
    perform public.portive_enqueue(s.id,a.id,'hangup',a.id||':unknown-answer-hangup','{"force":"true"}');
    update public.dial_sessions set status='paused',reason='AMD classification was unknown; answered prospect was ended and the session paused' where id=s.id returning * into s;
    perform public.portive_cancel_parallel(s.id,'unknown_answer');
  end loop;
  if s.active_call_id is not null then
    select * into a from public.call_attempts where id=s.active_call_id;
    if a.ended_at is null then return to_jsonb(s); end if;
    if a.disposition_saved_at is null then
      if s.phase<>'awaiting_disposition' then update public.dial_sessions set phase='awaiting_disposition' where id=s.id returning * into s; end if;
      return to_jsonb(s);
    end if;
    if s.status='running' and not coalesce((s.parallel_options->>'autoContinue')::boolean,true)
      and not coalesce((s.parallel_options->>'continueRequested')::boolean,false) then return to_jsonb(s); end if;
    update public.dial_sessions set active_call_id=null,phase='ready',
      next_batch_at=now()+make_interval(secs=>(parallel_options->>'batchDelaySeconds')::integer)
      where id=s.id returning * into s;
  end if;
  if exists(select 1 from public.call_attempts where dial_session_id=s.id and ended_at is null) then return to_jsonb(s); end if;
  if s.status='stopping' then
    perform public.portive_enqueue(s.id,null,'hangup_operator',s.id||':stop-operator');
    if s.operator_leg_state='disconnected' then update public.dial_sessions set status='stopped',ended_at=now() where id=s.id returning * into s; end if;
    return to_jsonb(s);
  end if;
  if not coalesce((s.parallel_options->>'autoContinue')::boolean,true) and s.parallel_batch>0 and not coalesce((s.parallel_options->>'continueRequested')::boolean,false) then return to_jsonb(s); end if;
  if s.status <> 'running' or not s.browser_media_ready or s.operator_leg_state <> 'ready' or s.next_batch_at>now() then return to_jsonb(s); end if;
  if s.started_at+interval '1800 seconds' < now()+make_interval(secs=>(s.parallel_options->>'maxCallSeconds')::integer+(s.parallel_options->>'ringTimeout')::integer) then
    update public.dial_sessions set status='stopping',reason='Bounded operator media lease ending' where id=s.id returning * into s;
    perform public.portive_enqueue(s.id,null,'hangup_operator',s.id||':stop-operator'); return to_jsonb(s);
  end if;
  select * into v from public.dialer_provider_verifications where id=s.verification_id and expires_at>now();
  if v.id is null then update public.dial_sessions set status='paused',reason='Provider verification expired' where id=s.id returning * into s; return to_jsonb(s); end if;
  per_attempt:=2*ceil((s.parallel_options->>'maxCallSeconds')::numeric/60)*v.rate_ceiling_cents+2*v.rate_ceiling_cents;
  capacity:=least(s.max_lines,s.attempt_limit-(select count(*)::integer from public.dial_session_targets where session_id=s.id));
  update public.dial_sessions set parallel_batch=parallel_batch+1,parallel_options=jsonb_set(parallel_options,'{continueRequested}','false') where id=s.id returning * into s;
  for candidate in
    select x.id,c.last_call from public.leads x left join lateral (
      select max(created_at) last_call from public.call_attempts where lead_id=x.id
        and status not in ('dialing','connected') and coalesce(technical_state,'') not in ('canceled_after_winner','canceled_before_answer')
        and (answered_at is null or disposition_saved_at is not null or outcome is not null)
    ) c on true where x.lead_list_id=s.selected_list_id and (s.location is null or x.location=s.location)
    order by c.last_call asc nulls first,x.created_at desc,x.id
  loop
    exit when n>=capacity;
    if s.reserved_cost_cents+per_attempt>(s.parallel_options->>'maxSpendCents')::integer then exit; end if;
    select * into l from public.leads where id=candidate.id for update;
    phone:=public.portive_phone(l.phone_number);
    business:=coalesce(nullif(l.custom_fields_json->>'organizationId',''),nullif(regexp_replace(lower(l.website),'^(https?://)?(www\.)?([^/]+).*','\3'),''),nullif(lower(l.business_name),''),phone);
    if phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' or l.derived_status in ('bad_number','closed_lost')
      or coalesce(l.custom_fields_json->>'workspaceHidden','false')='true' or coalesce(l.custom_fields_json->>'doNotCall','false')='true'
      or coalesce(l.custom_fields_json->>'suppressed','false')='true' or coalesce(l.custom_fields_json->>'automatedCallingApproved','true')='false'
      or exists(select 1 from public.dial_suppressions where phone_number=phone)
      or exists(select 1 from public.dial_session_targets where session_id=s.id and (phone_number=phone or lead_id=l.id))
      or exists(select 1 from public.follow_ups where lead_id=l.id and status='open' and due_at>now())
      or exists(select 1 from public.call_attempts where lead_id=l.id and (ended_at is null and status in ('dialing','connected') or callback_at>now()))
      or exists(select 1 from public.dial_session_targets t join public.call_attempts active_attempt on active_attempt.id=t.attempt_id where active_attempt.ended_at is null and t.business_key=business)
      then continue; end if;
    begin
      if extract(hour from now() at time zone coalesce(l.custom_fields_json->>'timeZone',s.time_zone)) not between 9 and 19 then continue; end if;
    exception when invalid_parameter_value then continue; end;
    insert into public.call_attempts(lead_id,dial_session_id,parallel_batch,status,technical_state,started_at,raw_summary_json)
      values(l.id,s.id,s.parallel_batch,'dialing','reserved',now(),jsonb_build_object('mode','parallel','progressState','dialing_lead')) returning * into a;
    insert into public.dial_session_targets values(s.id,l.id,phone,business,a.id);
    perform public.portive_enqueue(s.id,a.id,'dial_lead',a.id||':dial',jsonb_build_object('to',phone));
    n:=n+1;
    update public.dial_sessions set reserved_cost_cents=reserved_cost_cents+per_attempt,phase='calling' where id=s.id returning * into s;
  end loop;
  if n=0 then
    update public.dial_sessions set status='stopping',reason=case when capacity=0 then 'Attempt limit reached' else 'No eligible leads or insufficient reserved budget' end where id=s.id returning * into s;
    perform public.portive_enqueue(s.id,null,'hangup_operator',s.id||':stop-operator');
  end if;
  return to_jsonb(s);
end $$;

create or replace function public.portive_parallel_event(p_session text,p_attempt text,p_role text,p_type text,p_payload jsonb,p_at timestamptz,p_event text)
returns void language plpgsql set search_path=public as $$
declare s public.dial_sessions; a public.call_attempts; classification text; cause text;
begin
  select * into s from public.dial_sessions where id=p_session and mode='parallel' for update;
  if s.id is null then raise exception 'Parallel session not found'; end if;
  if p_role not in ('operator','lead','overflow') then raise exception 'Unknown provider leg role'; end if;
  if exists(select 1 from public.workstation_telnyx_webhook_events where event_id=p_event and processed_at is not null and processing_error is null) then return; end if;
  if p_role='operator' then
    if p_type in ('call.initiated','call.answered') and s.operator_terminal_at is null and s.status not in ('stopped','completed') then
      update public.dial_sessions set operator_call_control_id=coalesce(operator_call_control_id,p_payload->>'call_control_id'),
        operator_leg_state=case when p_type='call.answered' and operator_leg_state not in ('ready','bridged','bridging') then 'answered' when operator_leg_state='disconnected' then 'dialing' else operator_leg_state end where id=s.id;
    elsif p_type='call.hangup' then
      update public.dial_sessions set operator_leg_state='disconnected',operator_terminal_at=p_at,browser_media_ready=false,
        status=case when status='stopping' then status else 'unsafe' end,reason=case when status='stopping' then reason else 'Operator leg ended' end where id=s.id;
    elsif p_type='call.unbridged' then
      update public.dial_sessions set operator_leg_state='ready' where id=s.id and operator_leg_state='bridged';
    end if;
  else
    select * into a from public.call_attempts where id=p_attempt and dial_session_id=s.id for update;
    if a.id is null then raise exception 'Attempt/session mismatch'; end if;
    if p_role='overflow' then
      update public.call_attempts set overflow_call_control_id=coalesce(overflow_call_control_id,p_payload->>'call_control_id'),
        overflow_state=case when p_type in ('call.answered','call.bridged') then 'connected' else overflow_state end where id=a.id;
      if p_type='call.hangup' and a.ended_at is null then
        if a.overflow_state='connected' then
          perform public.portive_enqueue(s.id,a.id,'hangup',a.id||':overflow-ended','{"force":"true"}');
        else
          perform public.portive_failure_playback(s.id,a.id,coalesce(p_payload->>'hangup_cause','overflow leg failed before answer'));
        end if;
      end if;
    else
      if a.telnyx_call_control_id is not null and p_payload->>'call_control_id' is not null and a.telnyx_call_control_id<>p_payload->>'call_control_id' then raise exception 'Provider call leg does not match the attempt'; end if;
      update public.call_attempts set telnyx_call_control_id=coalesce(telnyx_call_control_id,p_payload->>'call_control_id'),
        telnyx_call_leg_id=coalesce(telnyx_call_leg_id,p_payload->>'call_leg_id'),telnyx_call_session_id=coalesce(telnyx_call_session_id,p_payload->>'call_session_id') where id=a.id;
      classification:=case when p_payload->>'result' in ('human','human_business','human_residence') then 'human' when p_payload->>'result' in ('machine','beep_detected') then 'machine' else 'unknown' end;
      if a.ended_at is not null then
        if p_type='call.answered' or p_type like 'call.machine.%' and classification='human' then
          update public.call_attempts set answered_at=coalesce(answered_at,p_at),answer_classification=case when classification='human' then 'human' else answer_classification end,
            technical_state='answer_collision',lost_race_or_abandoned=true where id=a.id and technical_state='canceled_after_winner';
          if found then
            insert into public.dial_audit_events(session_id,attempt_id,event_type) values(s.id,a.id,'late_answer_collision_hangup_already_confirmed');
          end if;
        end if;
      elsif p_type='call.ringing' then
        update public.call_attempts set ringing_at=coalesce(ringing_at,p_at),technical_state='ringing' where id=a.id and answered_at is null;
      elsif p_type='call.initiated' then
        update public.call_attempts set technical_state='initiating' where id=a.id and technical_state='reserved';
      elsif p_type='call.answered' then
        update public.call_attempts set answered_at=coalesce(answered_at,p_at),technical_state='carrier_answered',
          classification_deadline_at=least(now(),p_at)+interval '1 second' where id=a.id and answer_classification='unknown' and overflow_state is null;
      elsif p_type like 'call.machine.%' then
        update public.call_attempts set amd_result=p_payload->>'result' where id=a.id;
        if a.was_bridged_to_operator or a.answer_classification='human' then
          -- Never cut off an established conversation on a delayed classifier result.
          update public.call_attempts set raw_summary_json=coalesce(raw_summary_json,'{}')||jsonb_build_object('delayedAmdResult',p_payload->>'result') where id=a.id;
        elsif a.answer_classification='machine' and classification='human' then
          update public.call_attempts set answer_classification='unknown',outcome=null,technical_state='answer_unknown',termination_reason='conflicting_amd_results' where id=a.id;
          perform public.portive_enqueue(s.id,a.id,'hangup',a.id||':unknown-answer-hangup','{"force":"true"}');
          update public.dial_sessions set status='paused',reason='Conflicting AMD results; answered call ended and the session paused' where id=s.id;
        elsif classification='machine' and a.overflow_state is null then
          update public.call_attempts set answer_classification='machine',technical_state='machine_detected',answered_at=coalesce(answered_at,p_at),outcome='voicemail',termination_reason='machine_detected',classification_deadline_at=null where id=a.id;
          perform public.portive_enqueue(s.id,a.id,'hangup',a.id||':machine');
        elsif classification='human' and a.overflow_state is not null then
          update public.call_attempts set answer_classification='human' where id=a.id;
          if s.active_call_id is not null and s.active_call_id<>a.id then perform public.portive_answer_collision(s.id,a.id); end if;
        elsif classification='human' and a.overflow_state is null then
          update public.call_attempts set answered_at=coalesce(answered_at,p_at),answer_classification='human',technical_state='human_detected',classification_deadline_at=null where id=a.id;
          if s.active_call_id=a.id then null;
          elsif s.active_call_id is null and s.browser_media_ready and s.operator_leg_state='ready' and s.status in ('running','paused','stopping') then
            update public.dial_sessions set active_call_id=a.id,phase='calling',operator_leg_state='bridging' where id=s.id;
            update public.call_attempts set technical_state='bridging' where id=a.id;
            perform public.portive_enqueue(s.id,a.id,'bridge',s.id||':bridge:'||a.id);
            perform public.portive_cancel_parallel(s.id,'winner_selected');
          else
            perform public.portive_answer_collision(s.id,a.id);
          end if;
        elsif classification='unknown' and a.overflow_state is null then
          update public.call_attempts set answer_classification='unknown',technical_state='answer_unknown',termination_reason='amd_unknown' where id=a.id;
          perform public.portive_enqueue(s.id,a.id,'hangup',a.id||':unknown-answer-hangup','{"force":"true"}');
          update public.dial_sessions set status='paused',reason='AMD classification was unknown; answered prospect was ended and the session paused' where id=s.id;
        end if;
      elsif p_type='call.bridged' then
        if a.overflow_state is not null then update public.call_attempts set overflow_state='connected' where id=a.id;
        elsif s.active_call_id=a.id then
          update public.call_attempts set status='connected',technical_state='connected_to_operator',was_bridged_to_operator=true,bridged_at=coalesce(bridged_at,p_at),
            telnyx_agent_call_control_id=s.operator_call_control_id,raw_summary_json=coalesce(raw_summary_json,'{}')||'{"progressState":"bridged"}' where id=a.id;
          update public.dial_sessions set operator_leg_state='bridged' where id=s.id;
        else
          update public.dial_sessions set status='unsafe',reason='Unexpected bridge on non-winning attempt; disconnecting non-winning leg' where id=s.id;
          perform public.portive_answer_collision(s.id,a.id);
        end if;
      elsif p_type='call.playback.ended' and a.overflow_state='failure_playback' then
        perform public.portive_enqueue(s.id,a.id,'hangup',a.id||':failure-cleanup','{"force":"true"}');
      elsif p_type='call.hangup' then
        cause:=coalesce(p_payload->>'hangup_cause','unknown');
        update public.call_attempts set ended_at=p_at,duration_seconds=case when bridged_at is not null then greatest(0,floor(extract(epoch from p_at-bridged_at)))::integer else duration_seconds end,status=case when a.answered_at is not null then 'completed' when a.termination_reason is not null then 'canceled' else 'failed' end,
          technical_state=case when a.technical_state in ('answer_collision','answer_unknown','canceled_after_winner','canceled_before_answer') then a.technical_state
            when a.outcome='voicemail' then 'machine_detected' when a.was_bridged_to_operator then 'completed'
            when cause in ('no_answer','timeout') then 'no_answer' when cause='user_busy' then 'busy' else 'failed' end,
          termination_reason=coalesce(termination_reason,cause),outcome=case when outcome is not null then outcome when cause in ('no_answer','timeout') and termination_reason is null then 'no_answer' else outcome end
          where id=a.id;
        if s.active_call_id=a.id then update public.dial_sessions set operator_leg_state='ready' where id=s.id and operator_terminal_at is null; end if;
        if not exists(select 1 from public.call_attempts where dial_session_id=s.id and ended_at is null) then
          update public.dial_sessions set next_batch_at=now()+make_interval(secs=>(parallel_options->>'batchDelaySeconds')::integer),phase=case when active_call_id is null then 'ready' else phase end where id=s.id; end if;
      end if;
    end if;
  end if;
  insert into public.dial_audit_events(session_id,attempt_id,event_type,details) values(s.id,p_attempt,p_type,p_payload);
  update public.workstation_telnyx_webhook_events set processed_at=now(),processing_error=null where event_id=p_event;
end $$;

create or replace function public.portive_claim_parallel_commands(p_limit integer default 12)
returns setof public.dial_commands language plpgsql set search_path=public as $$
begin
  return query update public.dial_commands set state='executing',claimed_at=now() where id in (
    select id from public.dial_commands where state='pending' order by created_at for update skip locked limit least(p_limit,12)
  ) returning *;
end $$;

revoke all on function public.portive_parallel_command(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb),
  public.portive_parallel_event(text,text,text,text,jsonb,timestamptz,text),public.portive_claim_parallel_commands(integer),
  public.portive_enqueue(text,text,text,text,jsonb),public.portive_overflow(text,text,boolean),public.portive_answer_collision(text,text),public.portive_cancel_parallel(text,text)
  from public,anon,authenticated;
grant execute on function public.portive_parallel_command(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb),
  public.portive_parallel_event(text,text,text,text,jsonb,timestamptz,text),public.portive_claim_parallel_commands(integer),
  public.portive_enqueue(text,text,text,text,jsonb),public.portive_overflow(text,text,boolean),public.portive_answer_collision(text,text),public.portive_cancel_parallel(text,text) to service_role;
create or replace function public.portive_session_command(
  p_session_id text, p_controller uuid, p_action text, p_ready boolean default false,
  p_list_id text default null, p_location text default null, p_limit integer default 100,
  p_mode text default 'power', p_lines integer default 1, p_timezone text default null, p_reviewed boolean default false
) returns jsonb language plpgsql set search_path = public as $$
declare s public.dial_sessions; a public.call_attempts; l public.leads; phone text; business text; candidate record;
begin
  perform pg_advisory_xact_lock(hashtextextended('portive-single-operator', 0));
  if p_action in ('start','next','resume','continue','skip') and not exists (
    select 1 from public.app_settings where key='dialer_watchdog_heartbeat'
      and (value_json->>'at')::timestamptz > now() - interval '30 seconds'
  ) then raise exception 'Dialer watchdog is unavailable; start npm run dialer:watchdog before automated calling'; end if;
  if p_action = 'start' then
    -- Technical release gate is intentionally enforced in Postgres as well as the API.
    if p_mode <> 'power' or p_lines <> 1 then
      raise exception 'Parallel routing is not released: provider capacity, operator bridge and answered-person collision handling require verification';
    end if;
    if not p_reviewed or p_timezone is null then raise exception 'Review list eligibility and choose its local timezone'; end if;
    perform now() at time zone p_timezone;
    if not p_ready then raise exception 'Connect the softphone and grant microphone access first'; end if;
    if exists (select 1 from public.call_attempts where ended_at is null and status in ('dialing','connected','voicemail_detected')) then
      raise exception 'An active call already exists';
    end if;
    insert into public.dial_sessions(controller_id,selected_list_id,location,mode,max_lines,attempt_limit,time_zone)
      values(p_controller,p_list_id,nullif(p_location,''),p_mode,p_lines,p_limit,p_timezone) returning * into s;
  else
    select * into s from public.dial_sessions where id = p_session_id for update;
    if s.id is null or s.controller_id <> p_controller then raise exception 'Session is controlled by another browser'; end if;
    if s.status in ('stopped','completed') then return jsonb_build_object('session',to_jsonb(s),'dispatch',false); end if;
    if p_action = 'pause' then s.status := 'paused'; s.reason := 'Operator paused';
    elsif p_action = 'stop' then s.status := 'stopping'; s.reason := 'Operator stopped';
    elsif p_action = 'resume' then
      if s.status <> 'paused' then raise exception 'Only a paused session can resume'; end if;
      if not p_ready then raise exception 'Softphone or microphone unavailable'; end if;
      s.status := 'running'; s.reason := null;
    elsif p_action not in ('next','heartbeat','continue','skip') then raise exception 'Unknown session action';
    end if;
    if p_action in ('next','heartbeat','continue','skip') and s.heartbeat_at < now() - interval '45 seconds' then
      s.status := 'paused'; s.reason := 'Browser heartbeat expired; inspect the active call before resuming';
    end if;
    if not p_ready and s.status = 'running' then s.status := 'paused'; s.reason := 'Softphone or microphone unavailable'; end if;
    update public.dial_sessions set status=s.status,reason=s.reason,heartbeat_at=now() where id=s.id;
  end if;

  if s.active_call_id is not null then
    select * into a from public.call_attempts where id = s.active_call_id for update;
    if a.ended_at is null then
      if a.answered_at is null and a.started_at < now() - interval '2 minutes' then
        update public.dial_sessions set status='unsafe',reason='Attempt has no answer or terminal evidence after two minutes' where id=s.id returning * into s;
      end if;
      return jsonb_build_object('session',to_jsonb(s),'attempt',to_jsonb(a),'dispatch',false);
    end if;
    if a.status='failed' and a.outcome is null and coalesce(a.technical_state,'unknown') not in ('busy','no_answer')
      and p_action not in ('skip','stop') then
      update public.dial_sessions set status='paused',reason='Unexplained call failure; inspect provider events and explicitly skip before continuing' where id=s.id returning * into s;
      return jsonb_build_object('session',to_jsonb(s),'attempt',to_jsonb(a),'dispatch',false);
    end if;
    if a.answered_at is not null and a.disposition_saved_at is null
      and not (a.answer_classification = 'machine' and a.outcome = 'voicemail') and p_action <> 'skip' then
      update public.dial_sessions set phase='awaiting_disposition' where id=s.id returning * into s;
      return jsonb_build_object('session',to_jsonb(s),'attempt',to_jsonb(a),'dispatch',false);
    end if;
    if p_action = 'skip' then
      insert into public.dial_audit_events(session_id,attempt_id,event_type) values(s.id,a.id,'disposition_explicitly_skipped');
    end if;
    update public.dial_sessions set active_call_id=null,phase='ready' where id=s.id returning * into s;
  end if;
  if p_action not in ('next','continue','skip') or s.status <> 'running' then
    return jsonb_build_object('session',to_jsonb(s),'dispatch',false);
  end if;
  if (select count(*) from public.dial_session_targets where session_id=s.id) >= s.attempt_limit then
    update public.dial_sessions set status='completed',ended_at=now(),reason='Session attempt limit reached' where id=s.id returning * into s;
    return jsonb_build_object('session',to_jsonb(s),'dispatch',false);
  end if;

  -- Same queue ordering as sortLeadsForQueue: uncalled newest first, then oldest last call.
  for candidate in
    select x.*, c.last_call from public.leads x
    left join lateral (select max(created_at) last_call from public.call_attempts where lead_id=x.id and coalesce(technical_state,'') not in ('canceled_after_winner','canceled_before_answer')) c on true
    where x.lead_list_id=s.selected_list_id and (s.location is null or x.location=s.location)
      and x.derived_status not in ('bad_number','closed_lost')
      and coalesce(x.custom_fields_json->>'workspaceHidden','false') <> 'true'
      and not exists (select 1 from public.follow_ups f where f.lead_id=x.id and f.status='open' and f.due_at>now())
      and not exists (select 1 from public.call_attempts c where c.lead_id=x.id and c.callback_at>now())
    order by c.last_call asc nulls first,x.created_at desc,x.id
  loop
    select * into l from public.leads where id=candidate.id for update;
    phone := public.portive_phone(l.phone_number);
    if phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' then continue; end if;
    if exists (select 1 from public.dial_suppressions where phone_number=phone)
      or coalesce(l.custom_fields_json->>'doNotCall','false')='true'
      or coalesce(l.custom_fields_json->>'suppressed','false')='true' then continue; end if;
    if exists (select 1 from public.dial_session_targets where session_id=s.id and (phone_number=phone or lead_id=l.id)) then continue; end if;
    -- Explicit reviewed eligibility is required for automated calling. No area-code timezone guesses.
    if coalesce(l.custom_fields_json->>'automatedCallingApproved','true') = 'false' then continue; end if;
    begin
      if extract(hour from now() at time zone coalesce(nullif(l.custom_fields_json->>'timeZone',''), s.time_zone)) < 9
        or extract(hour from now() at time zone coalesce(nullif(l.custom_fields_json->>'timeZone',''), s.time_zone)) >= 20 then continue; end if;
    exception when invalid_parameter_value then continue;
    end;
    business := coalesce(nullif(l.custom_fields_json->>'organizationId',''),nullif(lower(l.website),''),nullif(lower(l.business_name),''),phone);
    insert into public.call_attempts(lead_id,status,started_at,dial_session_id,technical_state,raw_summary_json)
      values(l.id,'dialing',now(),s.id,'initiated',jsonb_build_object('manualDialFlow','browser_first','progressState','browser_ready')) returning * into a;
    insert into public.dial_session_targets values(s.id,l.id,phone,business,a.id);
    update public.dial_sessions set active_call_id=a.id,phase='calling' where id=s.id returning * into s;
    insert into public.dial_audit_events(session_id,attempt_id,event_type,details)
      values(s.id,a.id,'attempt_reserved',jsonb_build_object('leadId',l.id,'phone',phone));
    return jsonb_build_object('session',to_jsonb(s),'attempt',to_jsonb(a),'lead',to_jsonb(l),'destination',phone,'dispatch',true);
  end loop;
  update public.dial_sessions set status='completed',ended_at=now(),reason='No eligible leads remaining' where id=s.id returning * into s;
  return jsonb_build_object('session',to_jsonb(s),'dispatch',false);
end $$;

create or replace function public.portive_parallel_snapshot(p_session text) returns jsonb language sql set search_path=public as $$
select jsonb_build_object('session',to_jsonb(s),'attempts',coalesce((
  select jsonb_agg(to_jsonb(a)||jsonb_build_object('leads',jsonb_build_object('business_name',l.business_name,'phone_number',l.phone_number,'lead_lists',jsonb_build_object('name',ll.name))))
  from public.call_attempts a join public.leads l on l.id=a.lead_id join public.lead_lists ll on ll.id=l.lead_list_id
  where a.dial_session_id=s.id and (a.parallel_batch=s.parallel_batch or a.id=s.active_call_id)
),'[]'),'metrics',(
  select jsonb_build_object(
    'total_dials',count(*) filter(where a.telnyx_call_control_id is not null),
    'human_connections',count(*) filter(where a.was_bridged_to_operator and a.answer_classification='human'),
    'voicemails',count(*) filter(where a.outcome='voicemail'),
    'no_answers',count(*) filter(where a.technical_state='no_answer'),
    'canceled_before_answer',count(*) filter(where a.technical_state in ('canceled_before_answer','canceled_after_winner')),
    'collisions',count(*) filter(where a.technical_state='answer_collision'),
    'conversations_completed',count(*) filter(where a.was_bridged_to_operator and a.ended_at is not null),
    'callbacks_created',(select count(*) from public.follow_ups f join public.call_attempts c on c.id=f.call_attempt_id where c.dial_session_id=s.id),
    'demos_requested',count(*) filter(where a.outcome='demo_requested'),'demos_booked',null,
    'conversation_seconds',coalesce(sum(a.duration_seconds) filter(where a.was_bridged_to_operator),0),
    'reserved_budget_cents',s.reserved_cost_cents,'provider_billable_cost',sum(a.provider_billable_cost))
  from public.call_attempts a where a.dial_session_id=s.id
)) from public.dial_sessions s where s.id=p_session and s.operator_id='operator'
$$;
revoke all on function public.portive_parallel_snapshot(text) from public,anon,authenticated;
grant execute on function public.portive_parallel_snapshot(text) to service_role;
do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='dial_sessions') then alter publication supabase_realtime add table public.dial_sessions; end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='call_attempts') then alter publication supabase_realtime add table public.call_attempts; end if;
  end if;
end $$;
create or replace function public.portive_parallel_transport_ready() returns boolean language sql set search_path=public as $$
select count(*)=2 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('dial_sessions','call_attempts')
$$;
revoke all on function public.portive_parallel_transport_ready() from public,anon,authenticated;
grant execute on function public.portive_parallel_transport_ready() to service_role;
commit;

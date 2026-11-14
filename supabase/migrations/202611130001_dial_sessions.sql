-- Additive migration. Existing attempt IDs, outcomes, notes and foreign keys stay intact.
begin;
create table public.dial_sessions (
  id text primary key default gen_random_uuid()::text,
  operator_id text not null default 'operator' check (operator_id = 'operator'),
  controller_id uuid not null,
  selected_list_id text not null references public.lead_lists(id),
  location text,
  time_zone text not null,
  review_confirmed_at timestamptz not null default now(),
  mode text not null check (mode in ('power', 'parallel')),
  max_lines integer not null check (max_lines between 1 and 4),
  status text not null default 'running' check (status in ('running','paused','stopping','stopped','completed','unsafe')),
  phase text not null default 'ready' check (phase in ('ready','calling','awaiting_disposition')),
  active_call_id text references public.call_attempts(id),
  attempt_limit integer not null default 100 check (attempt_limit between 1 and 500),
  heartbeat_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  reason text,
  check ((mode = 'power' and max_lines = 1) or (mode = 'parallel' and max_lines between 2 and 4))
);
create unique index dial_sessions_one_operator on public.dial_sessions(operator_id)
  where status in ('running','paused','stopping','unsafe');

alter table public.call_attempts
  add column dial_session_id text references public.dial_sessions(id),
  add column answer_classification text not null default 'unknown' check (answer_classification in ('unknown','human','machine')),
  add column technical_state text,
  add column termination_reason text,
  add column was_bridged_to_operator boolean not null default false,
  add column lost_race_or_abandoned boolean not null default false,
  add column disposition_saved_at timestamptz,
  add column recording_consent_at timestamptz;

create table public.dial_session_targets (
  session_id text not null references public.dial_sessions(id),
  lead_id text not null references public.leads(id),
  phone_number text not null,
  business_key text not null,
  attempt_id text not null unique references public.call_attempts(id),
  primary key (session_id, phone_number),
  unique (session_id, lead_id)
);
create table public.dial_suppressions (
  phone_number text primary key check (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  reason text not null,
  created_at timestamptz not null default now()
);
create table public.dial_audit_events (
  id bigint generated always as identity primary key,
  session_id text references public.dial_sessions(id),
  attempt_id text references public.call_attempts(id),
  event_type text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table public.dial_provider_commands (
  command_key text primary key,
  attempt_id text not null references public.call_attempts(id),
  state text not null check (state in ('executing','confirmed','uncertain')),
  response_json jsonb,
  created_at timestamptz not null default now()
);

-- No browser/anon role may call the orchestrator or change its safety data.
alter table public.dial_sessions enable row level security;
alter table public.dial_session_targets enable row level security;
alter table public.dial_suppressions enable row level security;
alter table public.dial_audit_events enable row level security;
alter table public.dial_provider_commands enable row level security;
revoke all on public.dial_sessions, public.dial_session_targets, public.dial_suppressions, public.dial_audit_events from anon, authenticated;
revoke all on public.dial_provider_commands from anon, authenticated;
grant all on public.dial_sessions,public.dial_session_targets,public.dial_suppressions,public.dial_audit_events,public.dial_provider_commands to service_role;
grant usage,select on sequence public.dial_audit_events_id_seq to service_role;

create function public.portive_phone(p text) returns text language sql immutable as $$
  select case when length(d) = 10 then '+1' || d when length(d) = 11 and left(d,1) = '1' then '+' || d else p end
  from (select regexp_replace(p, '[^0-9]', '', 'g') d) s
$$;

-- All writers, including browser progress updates and delayed webhooks, share these invariants.
create function public.portive_attempt_integrity() returns trigger language plpgsql set search_path = public as $$
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
    if exists (select 1 from public.call_attempts where ended_at is null and status in ('dialing','connected','voicemail_detected')) then
      raise exception 'An active call already exists for this operator';
    end if;
    select * into s from public.dial_sessions where status in ('running','paused','stopping','unsafe') limit 1;
    if s.id is not null and (new.dial_session_id is distinct from s.id or s.status <> 'running') then
      raise exception 'Stop the current dial session before manual dialing';
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
create trigger portive_attempt_integrity before insert or update on public.call_attempts
  for each row execute function public.portive_attempt_integrity();

-- Repair only records with explicit answer evidence; leave original notes/outcomes intact.
update public.call_attempts set status = 'completed' where status = 'canceled' and answered_at is not null;

create function public.portive_session_command(
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
    left join lateral (select max(created_at) last_call from public.call_attempts where lead_id=x.id) c on true
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
revoke all on function public.portive_session_command(text,uuid,text,boolean,text,text,integer,text,integer,text,boolean) from public,anon,authenticated;
grant execute on function public.portive_session_command(text,uuid,text,boolean,text,text,integer,text,integer,text,boolean) to service_role;

-- Serialize processing per attempt across processes and acknowledge only successfully processed events.
alter table public.workstation_telnyx_webhook_events add column processing_started_at timestamptz, add column processing_attempt_id text;
create function public.portive_claim_voice_event(p_event_id text, p_attempt_id text) returns text
language plpgsql set search_path=public as $$
declare e public.workstation_telnyx_webhook_events;
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_attempt_id,p_event_id),1));
  select * into e from public.workstation_telnyx_webhook_events where event_id=p_event_id for update;
  if e.processed_at is not null and e.processing_error is null then return 'processed'; end if;
  if not e.signature_verified then return 'unverified'; end if;
  if exists (select 1 from public.workstation_telnyx_webhook_events
    where (processing_attempt_id=p_attempt_id or event_id=p_event_id)
      and processing_started_at>now()-interval '60 seconds') then return 'busy'; end if;
  update public.workstation_telnyx_webhook_events set processing_started_at=now(),processing_attempt_id=p_attempt_id where id=e.id;
  return 'claimed';
end $$;
revoke all on function public.portive_claim_voice_event(text,text) from public,anon,authenticated;
grant execute on function public.portive_claim_voice_event(text,text) to service_role;

-- Defend the note/follow-up relationship even if another API forgets to check it.
create function public.portive_check_attempt_lead() returns trigger language plpgsql set search_path=public as $$
begin
  if new.call_attempt_id is not null and not exists
    (select 1 from public.call_attempts where id=new.call_attempt_id and lead_id=new.lead_id) then
    raise exception 'Call attempt does not belong to this lead';
  end if;
  return new;
end $$;
create trigger portive_note_lead before insert or update on public.lead_notes for each row execute function public.portive_check_attempt_lead();
create trigger portive_followup_lead before insert or update on public.follow_ups for each row execute function public.portive_check_attempt_lead();

create function public.portive_audit_attempt() returns trigger language plpgsql set search_path=public as $$
begin
  if old.status is distinct from new.status or old.answer_classification is distinct from new.answer_classification
    or old.was_bridged_to_operator is distinct from new.was_bridged_to_operator
    or old.ended_at is distinct from new.ended_at then
    insert into public.dial_audit_events(session_id,attempt_id,event_type,details) values(
      new.dial_session_id,new.id,'call_state_changed',jsonb_build_object(
        'status',new.status,'classification',new.answer_classification,'bridged',new.was_bridged_to_operator,
        'terminationReason',new.termination_reason,'abandoned',new.lost_race_or_abandoned));
  end if;
  return new;
end $$;
create trigger portive_audit_attempt after update on public.call_attempts for each row execute function public.portive_audit_attempt();

-- Wrap-up is one transaction: advancement cannot observe a saved disposition
-- before its notes, lead status and callback have all been committed.
create function public.portive_save_disposition(
  p_attempt_id text,p_lead_id text,p_outcome text,p_notes text default null,
  p_callback timestamptz default null,p_next_action text default null
) returns jsonb language plpgsql set search_path=public as $$
declare a public.call_attempts;
begin
  select * into a from public.call_attempts where id=p_attempt_id and lead_id=p_lead_id for update;
  if a.id is null then raise exception 'Call attempt not found for this lead'; end if;
  if a.dial_session_id is not null and a.ended_at is null then raise exception 'End the call before saving disposition'; end if;
  if p_outcome not in ('answered','voicemail','no_answer','not_interested','callback','gatekeeper','bad_number','interested','demo_requested','already_have_system') then
    raise exception 'Invalid sales disposition';
  end if;
  update public.call_attempts set outcome=p_outcome,operator_notes=coalesce(p_notes,operator_notes),callback_at=p_callback,
    next_action=coalesce(p_next_action,next_action),disposition_saved_at=now(),
    answer_classification=case when answered_at is not null and p_outcome in ('answered','gatekeeper','callback','interested','not_interested','demo_requested','already_have_system') then 'human' else answer_classification end
    where id=a.id returning * into a;
  if p_outcome='callback' and p_callback is not null and not exists (
    select 1 from public.follow_ups where call_attempt_id=a.id and due_at=p_callback and status='open'
  ) then
    insert into public.follow_ups(lead_id,call_attempt_id,due_at,status,channel,note)
      values(p_lead_id,a.id,p_callback,'open','call',coalesce(p_next_action,'Callback requested'));
  end if;
  update public.leads set
    notes=coalesce(p_notes,notes),
    derived_status=case
      when p_outcome='bad_number' then 'bad_number' when p_outcome='interested' then 'interested'
      when p_outcome='demo_requested' then 'demo_requested' when p_outcome='not_interested' then 'closed_lost'
      when p_outcome='callback' or p_next_action='manager_callback_pending' then 'follow_up' else 'contacted' end
    where id=p_lead_id;
  return to_jsonb(a);
end $$;
revoke all on function public.portive_save_disposition(text,text,text,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.portive_save_disposition(text,text,text,text,timestamptz,text) to service_role;
commit;

-- Normal Parallel uses live provider capacity and an independent cost ceiling,
-- never an acceptance report. Existing diagnostic grants remain independent.
begin;

-- Administrative policy data. No lead editor/browser can grant an hours exception
-- by changing a custom field or declaring a number to be a business landline.
create table if not exists public.dialer_calling_rules (
  jurisdiction text primary key,
  start_minute integer not null check(start_minute between 0 and 1439),
  end_minute integer not null check(end_minute between 1 and 1440),
  sunday_start_minute integer check(sunday_start_minute between 0 and 1439),
  source text not null check(length(source)>8),
  check(start_minute<end_minute)
);
insert into public.dialer_calling_rules values
 ('US',480,1260,null,'https://www.ftc.gov/business-guidance/resources/complying-telemarketing-sales-rule'),
 ('US-FL',480,1200,null,'https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.616.html'),
 ('US-MD',480,1200,null,'https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gcl&section=14-4502'),
 ('US-OK',480,1200,null,'https://www.oklegislature.gov/OK_Statutes/CompleteTitles/os15.pdf'),
 ('US-TX',540,1260,720,'https://statutes.capitol.texas.gov/Docs/BC/htm/BC.301.htm')
on conflict do nothing;

create table if not exists public.dialer_campaign_calling_policies (
  list_id text primary key references public.lead_lists(id),
  classification text not null default 'consumer' check(classification in ('consumer','business_landline')),
  jurisdictions text[] not null check(cardinality(jurisdictions)>0),
  start_minute integer not null default 480 check(start_minute between 0 and 1439),
  end_minute integer not null default 1260 check(end_minute between 1 and 1440),
  days integer[] not null default array[1,2,3,4,5,6,7] check(days <@ array[1,2,3,4,5,6,7] and cardinality(days)>0),
  legal_basis text not null check(length(legal_basis)>8),
  -- A B2B scope must list exact independently classified numbers, not all list members.
  business_numbers text[] not null default '{}',
  check(start_minute<end_minute)
);
create table if not exists public.dialer_calling_consents (
  lead_id text references public.leads(id),
  list_id text references public.lead_lists(id),
  phone_number text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  consent_reference text not null check(length(consent_reference)>8),
  legal_basis text not null check(length(legal_basis)>8),
  revoked_at timestamptz,
  primary key(lead_id,list_id,starts_at),
  check(ends_at>starts_at)
);
alter table public.dialer_calling_rules enable row level security;
alter table public.dialer_campaign_calling_policies enable row level security;
alter table public.dialer_calling_consents enable row level security;
revoke all on public.dialer_calling_rules,public.dialer_campaign_calling_policies,public.dialer_calling_consents from public,anon,authenticated,service_role;
grant select on public.dialer_calling_rules,public.dialer_campaign_calling_policies,public.dialer_calling_consents to service_role;

create or replace function public.portive_calling_hours(p_lead text,p_timezone text,p_at timestamptz default clock_timestamp())
returns text language plpgsql security definer set search_path=public as $$
declare l public.leads; p public.dialer_campaign_calling_policies; r public.dialer_calling_rules;
  local_at timestamp; minute integer; v_jurisdiction text; jurisdictions text[]; start_at integer; end_at integer;
begin
  select * into l from public.leads where id=p_lead;
  if l.id is null then return 'lead_missing'; end if;
  begin
    if nullif(p_timezone,'') is null then return 'invalid_timezone'; end if;
    local_at:=p_at at time zone p_timezone;
  exception when invalid_parameter_value then return 'invalid_timezone'; end;
  minute:=extract(hour from local_at)::integer*60+extract(minute from local_at)::integer;
  select * into p from public.dialer_campaign_calling_policies where list_id=l.lead_list_id;
  -- A documented, exact-number/time invitation is separate from DNC eligibility.
  -- Only an administrator may record that the exception is lawful in all applicable jurisdictions.
  if exists(select 1 from public.dialer_calling_consents c where c.lead_id=l.id and c.list_id=l.lead_list_id
    and c.phone_number=public.portive_phone(l.phone_number) and c.revoked_at is null and p_at>=c.starts_at and p_at<c.ends_at) then return null; end if;
  start_at:=coalesce(p.start_minute,480); end_at:=coalesce(p.end_minute,1260);
  if p.list_id is not null and not extract(isodow from local_at)::integer=any(p.days) then return 'outside_campaign_calling_days'; end if;
  jurisdictions:=coalesce(p.jurisdictions,array['US']);
  -- Destination-specific rules are always intersected with campaign policy.
  v_jurisdiction:=coalesce(nullif(l.custom_fields_json->>'callingJurisdiction',''),
    case when upper(l.custom_fields_json->>'state') ~ '^[A-Z]{2}$' then 'US-'||upper(l.custom_fields_json->>'state') end);
  if p.list_id is null and v_jurisdiction is null then return 'calling_jurisdiction_missing'; end if;
  if v_jurisdiction is not null then jurisdictions:=array_append(jurisdictions,v_jurisdiction); end if;
  if p.classification='business_landline' and public.portive_phone(l.phone_number)=any(p.business_numbers) then
    -- Business-only scope and its applicable rules were recorded administratively.
    -- Federal residential hours do not automatically apply to a classified business landline.
    jurisdictions:=array_remove(jurisdictions,'US');
  end if;
  foreach v_jurisdiction in array jurisdictions loop
    select * into r from public.dialer_calling_rules where dialer_calling_rules.jurisdiction=v_jurisdiction;
    if r.jurisdiction is null then return 'calling_rule_missing:'||v_jurisdiction; end if;
    start_at:=greatest(start_at,r.start_minute,case when extract(isodow from local_at)=7 then r.sunday_start_minute end);
    end_at:=least(end_at,r.end_minute);
  end loop;
  if minute<start_at or minute>=end_at then return 'outside_calling_window'; end if;
  return null;
end $$;
revoke all on function public.portive_calling_hours(text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.portive_calling_hours(text,text,timestamptz) to service_role;

create or replace function public.portive_parallel_eligibility(p_list text,p_location text,p_timezone text)
returns jsonb language sql security definer set search_path=public as $$
with reasons as (
 select case
  when public.portive_phone(l.phone_number) !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' then 'invalid_phone'
  when l.derived_status in ('bad_number','closed_lost') or coalesce(l.custom_fields_json->>'workspaceHidden','false')='true'
    or coalesce(l.custom_fields_json->>'doNotCall','false')='true' or coalesce(l.custom_fields_json->>'suppressed','false')='true'
    or exists(select 1 from public.dial_suppressions where phone_number=public.portive_phone(l.phone_number)) then 'suppressed_or_ineligible'
  when coalesce(l.custom_fields_json->>'automatedCallingApproved','true')='false' then 'automated_calling_disabled'
  when exists(select 1 from public.follow_ups where lead_id=l.id and status='open' and due_at>now())
    or exists(select 1 from public.call_attempts where lead_id=l.id and (ended_at is null and status in ('dialing','connected') or callback_at>now())) then 'active_call_or_future_callback'
  else public.portive_calling_hours(l.id,coalesce(nullif(l.custom_fields_json->>'timeZone',''),p_timezone)) end reason
 from public.leads l where l.lead_list_id=p_list and (p_location is null or l.location=p_location)
), counts as (select coalesce(reason,'eligible') reason,count(*) n from reasons group by reason)
select jsonb_build_object('eligible',coalesce((select n from counts where reason='eligible'),0),
 'reasons',coalesce((select jsonb_object_agg(reason,n) from counts where reason<>'eligible'),'{}'::jsonb))
$$;
revoke all on function public.portive_parallel_eligibility(text,text,text) from public,anon,authenticated;
grant execute on function public.portive_parallel_eligibility(text,text,text) to service_role;

-- Patch the installed normal scheduler only, retaining leases, reservations,
-- winner selection, dispositions, backend fencing and optional grant wrapper.
do $patch$
declare src text; patched text;
begin
  src:=pg_get_functiondef('public.portive_parallel_command_base(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)'::regprocedure);
  if position('Current provider verification evidence is missing' in src)>0 then
    patched:=replace(src,$old$select * into v from public.dialer_provider_verifications where id=(p_options->>'verificationId')::uuid and expires_at>now();
    if v.id is null or v.config_fingerprint is distinct from p_options->>'fingerprint' then raise exception 'Current provider verification evidence is missing'; end if;$old$,
    $new$v.account_channels:=(p_options->>'accountChannels')::integer;
    v.rate_ceiling_cents:=(p_options->>'rateCeilingCents')::integer;
    if coalesce(v.account_channels,0)<3 or coalesce(v.rate_ceiling_cents,0)<1 or v.rate_ceiling_cents>10000
      or nullif(p_options->>'fingerprint','') is null or coalesce(p_options->>'operatorSipUri','') !~ '^sip:[A-Za-z0-9_.+-]+@sip[.]telnyx[.]com$'
      then raise exception 'Live provider capacity, cost ceiling and operator SIP connection are required'; end if;$new$);
    if patched=src then raise exception 'Regular Parallel start body drift'; end if;
    patched:=replace(patched,$old$select * into v from public.dialer_provider_verifications where id=s.verification_id and expires_at>now();
  if v.id is null then update public.dial_sessions set status='paused',reason='Provider verification expired' where id=s.id returning * into s; return to_jsonb(s); end if;$old$,
    $new$v.rate_ceiling_cents:=(s.parallel_options->>'rateCeilingCents')::integer;
  if coalesce(v.rate_ceiling_cents,0)<1 then update public.dial_sessions set status='paused',reason='Session cost ceiling is missing; stop and start a new session' where id=s.id returning * into s; return to_jsonb(s); end if;$new$);
    if position('Provider verification expired' in patched)>0 then raise exception 'Regular Parallel scheduler body drift'; end if;
    patched:=replace(patched,$old$if s.reserved_cost_cents > (p_options->>'maxSpendCents')::integer then raise exception 'Budget does not cover bounded operator leg'; end if;$old$,
      $new$if s.reserved_cost_cents + 2*(ceil((p_options->>'maxCallSeconds')::numeric/60)+1)*v.rate_ceiling_cents > (p_options->>'maxSpendCents')::integer then
        raise exception 'Budget must cover the bounded operator leg and at least one prospect; increase maximum spend or reduce call duration'; end if;$new$);
    patched:=replace(patched,$old$if extract(hour from now() at time zone coalesce(nullif(l.custom_fields_json->>'timeZone',''),s.time_zone)) not between 9 and 19 then continue; end if;$old$,
      $new$if public.portive_calling_hours(l.id,coalesce(nullif(l.custom_fields_json->>'timeZone',''),s.time_zone)) is not null then continue; end if;$new$);
    patched:=replace(patched,'No eligible leads or insufficient reserved budget','No dispatchable leads: check DNC/suppression, recipient timezone/calling policy, callbacks, prior attempts and remaining reserved budget');
    -- Fail before the operator leg when the list itself is missing or empty.
    patched:=replace(patched,$old$if p_action='start' then$old$,$new$if p_action='start' then
    if not exists(select 1 from public.lead_lists where id=p_list) then raise exception 'Select an existing lead list'; end if;
    if not exists(select 1 from public.leads where lead_list_id=p_list and (p_location is null or location=p_location)) then raise exception 'Selected list/location has no leads'; end if;
    if (public.portive_parallel_eligibility(p_list,p_location,p_timezone)->>'eligible')::integer=0 then
      raise exception 'No eligible leads: %',public.portive_parallel_eligibility(p_list,p_location,p_timezone)->'reasons'; end if;$new$);
    if position('public.portive_calling_hours(l.id' in patched)=0 then raise exception 'Regular calling policy scheduler body drift'; end if;
    execute patched;
  end if;
  src:=pg_get_functiondef('public.portive_orchestration_authorize(uuid)'::regprocedure);
  if position('public.portive_calling_hours(l.id' in src)=0 then
    patched:=replace(src,$old$local_hour:=extract(hour from checked_at at time zone coalesce(nullif(l.custom_fields_json->>'timeZone',''),s.time_zone));
          if local_hour is null or local_hour<9 or local_hour>=20 then deny_reason:='outside_calling_window'; end if;$old$,
    $new$if s.mode='parallel' then
            deny_reason:=public.portive_calling_hours(l.id,coalesce(nullif(l.custom_fields_json->>'timeZone',''),s.time_zone),checked_at);
          else
            local_hour:=extract(hour from checked_at at time zone coalesce(nullif(l.custom_fields_json->>'timeZone',''),s.time_zone));
            if local_hour is null or local_hour<9 or local_hour>=20 then deny_reason:='outside_calling_window'; end if;
          end if;$new$);
    if patched=src then raise exception 'Final calling policy body drift'; end if;
    execute patched;
  end if;
end $patch$;

-- Explain an answered-person collision before disconnecting. Keep abandonment
-- accounting honest. Playback completion or the existing 10s deadline cleans up.
create or replace function public.portive_answer_collision(p_session text,p_attempt text)
returns void language plpgsql set search_path=public as $$
begin
  update public.call_attempts set answer_classification='human',technical_state='answer_collision',
    lost_race_or_abandoned=true,termination_reason=coalesce(termination_reason,'answer_collision'),
    answered_at=coalesce(answered_at,now()),classification_deadline_at=null,
    overflow_state='failure_playback',failure_deadline_at=coalesce(failure_deadline_at,now()+interval '10 seconds')
    where id=p_attempt and dial_session_id=p_session and ended_at is null;
  if found then
    update public.dial_commands set state='canceled',completed_at=clock_timestamp(),error='Answered collision requires explanation before hangup'
      where attempt_id=p_attempt and action='hangup' and state='pending' and parameters->>'force' is distinct from 'true';
    perform public.portive_enqueue(p_session,p_attempt,'failure_playback',p_attempt||':collision-explanation');
    insert into public.dial_audit_events(session_id,attempt_id,event_type) values(p_session,p_attempt,'answer_collision_explanation');
  end if;
end $$;
do $event$
declare src text; patched text;
begin
 src:=pg_get_functiondef('public.portive_parallel_event(text,text,text,text,jsonb,timestamp with time zone,text)'::regprocedure);
 patched:=replace(src,$old$p_type='call.playback.ended' and a.overflow_state='failure_playback'$old$, $new$p_type in ('call.playback.ended','call.speak.ended') and a.overflow_state='failure_playback'$new$);
 execute patched;
end $event$;
do $deadline$
declare src text;
begin
 src:=pg_get_functiondef('public.portive_orchestration_work(text)'::regprocedure);
 if position('union all select failure_deadline_at' in src)=0 then
   src:=replace(src,'union all select classification_deadline_at',
     'union all select failure_deadline_at from public.call_attempts where dial_session_id=s.id and ended_at is null union all select classification_deadline_at');
   execute src;
 end if;
end $deadline$;
create or replace function public.portive_regular_parallel_status()
returns jsonb language sql security definer set search_path=public as $$
select jsonb_build_object('schemaVersion','202611160001','reportRequired',false,
 'activeSessions',(select count(*) from public.dial_sessions where status in ('running','paused','stopping','unsafe')),
 'activeAttempts',(select count(*) from public.call_attempts where ended_at is null and status in ('dialing','connected','voicemail_detected')),
 'unsettledCommands',(select count(*) from public.dial_commands where state in ('pending','executing','uncertain')),
 'unsettledProviderCommands',(select count(*) from public.dial_provider_commands where state in ('executing','uncertain')))
$$;
revoke all on function public.portive_regular_parallel_status() from public,anon,authenticated;
grant execute on function public.portive_regular_parallel_status() to service_role;
commit;

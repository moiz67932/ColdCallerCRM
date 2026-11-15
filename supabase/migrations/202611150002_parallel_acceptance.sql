-- Restricted first-run authorization. This is NOT provider verification evidence.
-- No grant is installed, no flag is enabled, and no call is initiated by this migration.
begin;
create table if not exists public.dialer_acceptance_grants (
  id uuid primary key default gen_random_uuid(),
  controller_id uuid not null,
  list_id text not null references public.lead_lists(id),
  time_zone text not null,
  destinations jsonb not null check (jsonb_typeof(destinations)='array' and jsonb_array_length(destinations) in (1,4)),
  config_fingerprint text not null check (config_fingerprint ~ '^[0-9a-f]{64}$'),
  profile_id text not null,
  operator_sip_uri text not null check (operator_sip_uri ~ '^sip:[A-Za-z0-9_.+-]+@sip[.]telnyx[.]com$'),
  account_channels integer not null check (account_channels>=5),
  rate_ceiling_cents integer not null check (rate_ceiling_cents between 1 and 100),
  max_spend_cents integer not null check (max_spend_cents between 1 and 200),
  remaining_daily_cents integer not null check (remaining_daily_cents>=max_spend_cents),
  approval_reference text not null check (length(trim(approval_reference))>=8),
  capacity_reference text not null check (length(trim(capacity_reference))>=8),
  rate_reference text not null check (length(trim(rate_reference))>=8),
  reviewed_at timestamptz not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '15 minutes',
  consumed_session_id text unique references public.dial_sessions(id),
  revoked_at timestamptz,
  check (expires_at>created_at and expires_at<=created_at+interval '15 minutes'),
  check (max_spend_cents >= (2+4*jsonb_array_length(destinations))*rate_ceiling_cents)
);
alter table public.dialer_acceptance_grants enable row level security;
revoke all on public.dialer_acceptance_grants from public,anon,authenticated,service_role;
grant select on public.dialer_acceptance_grants to service_role;
alter table public.dial_sessions add column if not exists acceptance_grant_id uuid references public.dialer_acceptance_grants(id);

-- Only an explicitly approved administrative invocation can create a capability.
-- The browser has no issuance endpoint. The manifest must contain externally
-- verified capacity/rates and per-recipient consent references, never a passed report.
create or replace function public.portive_acceptance_issue(p_manifest jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare g public.dialer_acceptance_grants; d jsonb; l public.leads;
begin
  perform pg_advisory_xact_lock(hashtextextended('portive-single-operator',0));
  if exists(select 1 from public.dial_sessions where status in ('running','paused','stopping','unsafe'))
    or exists(select 1 from public.call_attempts where ended_at is null and status in ('dialing','connected','voicemail_detected'))
    or exists(select 1 from public.dial_commands where state in ('pending','executing','uncertain'))
    or exists(select 1 from public.dial_provider_commands where state in ('executing','uncertain')) then
    raise exception 'Reconcile all active or uncertain work before acceptance authorization'; end if;
  if jsonb_typeof(p_manifest->'destinations') is distinct from 'array'
    or jsonb_array_length(p_manifest->'destinations') not in (1,4) then raise exception 'Exactly one or four consenting destinations required'; end if;
  if (p_manifest->>'reviewed_at')::timestamptz is null or (p_manifest->>'reviewed_at')::timestamptz<clock_timestamp()-interval '24 hours'
    or (p_manifest->>'reviewed_at')::timestamptz>clock_timestamp() then raise exception 'Current provider review required'; end if;
  perform now() at time zone (p_manifest->>'time_zone');
  for d in select value from jsonb_array_elements(p_manifest->'destinations') loop
    select * into l from public.leads where id=d->>'lead_id';
    if l.id is null or l.lead_list_id is distinct from p_manifest->>'list_id'
      or public.portive_phone(l.phone_number) is distinct from d->>'phone_number'
      or coalesce(d->>'phone_number','') !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'
      or coalesce(length(trim(d->>'consent_reference')),0)<8 or nullif(d->>'time_zone','') is null
      then raise exception 'Destination must identify a consenting +1 lead in the approved list'; end if;
    perform now() at time zone (d->>'time_zone');
  end loop;
  if (select count(distinct value->>'phone_number') from jsonb_array_elements(p_manifest->'destinations'))<>jsonb_array_length(p_manifest->'destinations')
    or (select count(distinct value->>'lead_id') from jsonb_array_elements(p_manifest->'destinations'))<>jsonb_array_length(p_manifest->'destinations')
    then raise exception 'Duplicate destinations forbidden'; end if;
  if exists(select 1 from public.dialer_acceptance_grants where revoked_at is null and expires_at>now()) then
    raise exception 'Revoke or finish the existing acceptance authorization first'; end if;
  insert into public.dialer_acceptance_grants(controller_id,list_id,time_zone,destinations,config_fingerprint,profile_id,operator_sip_uri,
    account_channels,rate_ceiling_cents,max_spend_cents,remaining_daily_cents,approval_reference,capacity_reference,rate_reference,reviewed_at)
  values((p_manifest->>'controller_id')::uuid,p_manifest->>'list_id',p_manifest->>'time_zone',p_manifest->'destinations',
    p_manifest->>'config_fingerprint',p_manifest->>'profile_id',p_manifest->>'operator_sip_uri',
    (p_manifest->>'account_channels')::integer,(p_manifest->>'rate_ceiling_cents')::integer,(p_manifest->>'max_spend_cents')::integer,
    (p_manifest->>'remaining_daily_cents')::integer,p_manifest->>'approval_reference',p_manifest->>'capacity_reference',p_manifest->>'rate_reference',
    (p_manifest->>'reviewed_at')::timestamptz) returning * into g;
  return g.id;
end $$;

create or replace function public.portive_acceptance_destination(p_session text,p_lead text,p_phone text,p_timezone text)
returns boolean language sql stable security definer set search_path=public as $$
select exists(select 1 from public.dial_sessions s join public.dialer_acceptance_grants g on g.id=s.acceptance_grant_id,
  lateral jsonb_array_elements(g.destinations) d
  where s.id=p_session and g.consumed_session_id=s.id and g.controller_id=s.controller_id and g.list_id=s.selected_list_id
    and g.revoked_at is null and g.expires_at>clock_timestamp() and s.started_at+interval '120 seconds'>clock_timestamp()
    and g.config_fingerprint=s.parallel_options->>'fingerprint'
    and d->>'lead_id'=p_lead and d->>'phone_number'=p_phone and d->>'time_zone'=p_timezone)
$$;

-- Keep the installed normal scheduler intact. Clone it for the restricted path,
-- replacing only its evidence lookup and adding the immutable destination filter.
-- Fail atomically on schema drift rather than silently patching an unknown body.
do $patch$
declare src text; patched text;
begin
  if to_regprocedure('public.portive_parallel_command_base(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)') is null then
    alter function public.portive_parallel_command(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb) rename to portive_parallel_command_base;
  end if;
  src:=pg_get_functiondef('public.portive_parallel_command_base(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)'::regprocedure);
  if position('Operator browser lease expired' in src)=0 or position('nullif(l.custom_fields_json->>''timeZone'','''')' in src)=0 then
    raise exception 'Acceptance requires installed 202611150001 safety scheduler'; end if;
  patched:=replace(src,'public.portive_parallel_command_base(','public.portive_parallel_acceptance_engine(');
  patched:=replace(patched,$old$select * into v from public.dialer_provider_verifications where id=s.verification_id and expires_at>now();
  if v.id is null then$old$,$new$select g.account_channels,g.rate_ceiling_cents into v.account_channels,v.rate_ceiling_cents
    from public.dialer_acceptance_grants g where g.id=s.acceptance_grant_id and g.consumed_session_id=s.id and g.revoked_at is null and g.expires_at>clock_timestamp();
  if v.rate_ceiling_cents is null then$new$);
  if position('where id=s.verification_id' in patched)>0 then raise exception 'Acceptance scheduler evidence lookup drift'; end if;
  patched:=replace(patched,'where x.lead_list_id=s.selected_list_id and (s.location is null or x.location=s.location)',
    'where x.lead_list_id=s.selected_list_id and (s.location is null or x.location=s.location) and public.portive_acceptance_destination(s.id,x.id,public.portive_phone(x.phone_number),coalesce(nullif(x.custom_fields_json->>''timeZone'',''''),s.time_zone))');
  if position('and public.portive_acceptance_destination(s.id,x.id' in patched)=0 then raise exception 'Acceptance candidate filter drift'; end if;
  execute patched;
end $patch$;

create or replace function public.portive_parallel_command(
  p_session text,p_controller uuid,p_action text,p_ready boolean default false,p_list text default null,p_location text default null,
  p_lines integer default 4,p_timezone text default null,p_reviewed boolean default false,p_options jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.dial_sessions; g public.dialer_acceptance_grants; opts jsonb; result jsonb; operator_not_submitted boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('portive-single-operator',0));
  if p_session is not null then select * into s from public.dial_sessions where id=p_session for update; end if;
  if p_action='start' and p_options ? 'acceptanceGrantId' then
    perform public.portive_orchestration_guard('cloudflare',null);
    select * into g from public.dialer_acceptance_grants where id=(p_options->>'acceptanceGrantId')::uuid for update;
    if g.id is null or g.revoked_at is not null or g.expires_at<=clock_timestamp() or g.consumed_session_id is not null
      or g.controller_id is distinct from p_controller or g.config_fingerprint is distinct from p_options->>'fingerprint'
      or not p_ready or not p_reviewed then raise exception 'Acceptance authorization unavailable or browser not ready'; end if;
    if not public.portive_orchestrator_ready(3) then raise exception 'Cloudflare worker unavailable'; end if;
    if exists(select 1 from public.dial_sessions where status in ('running','paused','stopping','unsafe'))
      or exists(select 1 from public.call_attempts where ended_at is null and status in ('dialing','connected','voicemail_detected'))
      or exists(select 1 from public.dial_commands where state in ('pending','executing','uncertain'))
      or exists(select 1 from public.dial_provider_commands where state in ('executing','uncertain')) then raise exception 'Active or uncertain work exists'; end if;
    opts:=jsonb_build_object('acceptanceGrantId',g.id,'fingerprint',g.config_fingerprint,'operatorSipUri',g.operator_sip_uri,
      'ringTimeout',15,'maxCallSeconds',60,'batchDelaySeconds',0,'attemptLimit',jsonb_array_length(g.destinations),
      'maxSpendCents',g.max_spend_cents,'autoContinue',false,'autoRefill',false,'silentRingback',false);
    insert into public.dial_sessions(controller_id,selected_list_id,time_zone,mode,max_lines,attempt_limit,parallel_options,
      acceptance_grant_id,reserved_cost_cents)
    values(p_controller,g.list_id,g.time_zone,'parallel',greatest(2,jsonb_array_length(g.destinations)),jsonb_array_length(g.destinations),opts,g.id,2*g.rate_ceiling_cents)
      returning * into s;
    update public.dialer_acceptance_grants set consumed_session_id=s.id where id=g.id;
    insert into public.dial_audit_events(session_id,event_type,details) values(s.id,'acceptance_authorized',jsonb_build_object('grantId',g.id,'approvalReference',g.approval_reference));
    perform public.portive_enqueue(s.id,null,'dial_operator',s.id||':operator');
    return to_jsonb(s);
  end if;
  if s.acceptance_grant_id is null then
    return public.portive_parallel_command_base(p_session,p_controller,p_action,p_ready,p_list,p_location,p_lines,p_timezone,p_reviewed,p_options);
  end if;
  if p_action<>'tick' and s.controller_id is distinct from p_controller then raise exception 'Session controlled by another browser'; end if;
  if p_action in ('start','resume','continue','skip','next') then raise exception 'Acceptance is one batch; authorize a fresh session after reconciliation'; end if;
  select * into g from public.dialer_acceptance_grants where id=s.acceptance_grant_id for update;
  if s.status not in ('completed','stopped') and (g.revoked_at is not null or g.expires_at<=clock_timestamp() or s.started_at+interval '120 seconds'<=clock_timestamp()) then
    update public.dial_sessions set status='unsafe',browser_media_ready=false,reason='Acceptance authorization ended' where id=s.id;
    perform public.portive_cancel_parallel(s.id,'acceptance_ended');
    operator_not_submitted:=s.operator_call_control_id is null
      and exists(select 1 from public.dial_commands where session_id=s.id and action='dial_operator' and state='canceled')
      and not exists(select 1 from public.dial_commands where session_id=s.id and action='dial_operator' and state in ('pending','executing','uncertain'));
    if operator_not_submitted then
      update public.dial_commands set state='canceled',completed_at=clock_timestamp(),error='Operator was never submitted; no provider hangup target'
        where session_id=s.id and action='hangup_operator' and state='pending';
    elsif s.operator_terminal_at is null then perform public.portive_enqueue(s.id,null,'hangup_operator',s.id||':acceptance-end'); end if;
    result:=public.portive_parallel_acceptance_engine(p_session,p_controller,'tick',false,p_list,p_location,p_lines,p_timezone,p_reviewed,p_options);
    -- Only genuine provider terminal evidence and a reconciled ledger release the
    -- single-operator fence. Expiry/revocation alone never marks a call ended.
    if (operator_not_submitted or exists(select 1 from public.dial_sessions where id=s.id and operator_terminal_at is not null))
      and not exists(select 1 from public.call_attempts where dial_session_id=s.id and ended_at is null)
      and not exists(select 1 from public.dial_commands where session_id=s.id and state in ('pending','executing','uncertain'))
      and not exists(select 1 from public.dial_provider_commands where attempt_id in (select id from public.call_attempts where dial_session_id=s.id) and state in ('executing','uncertain')) then
      update public.dial_sessions set status='stopped',ended_at=clock_timestamp(),reason='Acceptance ended; provider terminals reconciled' where id=s.id returning * into s;
      return to_jsonb(s);
    end if;
    return result;
  end if;
  return public.portive_parallel_acceptance_engine(p_session,p_controller,p_action,p_ready,p_list,p_location,p_lines,p_timezone,p_reviewed,p_options);
end $$;

-- Add the allowlist/lease check to the existing final-authorization transaction,
-- retaining its cancellation, uncertainty and duplicate-reservation semantics.
do $patch$
declare src text; patched text;
begin
  src:=pg_get_functiondef('public.portive_orchestration_authorize(uuid)'::regprocedure);
  if position('acceptance_not_authorized' in src)=0 then
    patched:=replace(src,$old$  if c.action='dial_lead' and deny_reason is null then$old$,$new$  if s.acceptance_grant_id is not null and c.action in ('dial_operator','dial_lead','bridge') then
    if not exists(select 1 from public.dialer_acceptance_grants g where g.id=s.acceptance_grant_id and g.consumed_session_id=s.id
      and g.controller_id=s.controller_id and g.config_fingerprint=s.parallel_options->>'fingerprint' and g.revoked_at is null
      and g.expires_at>clock_timestamp() and s.started_at+interval '120 seconds'>clock_timestamp()) then deny_reason:='acceptance_not_authorized';
    elsif c.action='dial_lead' and not public.portive_acceptance_destination(s.id,a.lead_id,c.parameters->>'to',
      (select coalesce(nullif(custom_fields_json->>'timeZone',''),s.time_zone) from public.leads where id=a.lead_id)) then deny_reason:='acceptance_destination_denied';
    elsif c.action='dial_operator' and s.operator_call_control_id is not null then deny_reason:='acceptance_operator_already_present';
    elsif c.action='bridge' and (s.status<>'running' or not s.browser_media_ready) then deny_reason:='acceptance_media_unavailable'; end if;
  end if;
  if c.action='dial_lead' and deny_reason is null then$new$);
    if patched=src then raise exception 'Final authorization body drift'; end if;
    patched:=replace(patched,$old$if c.action='dial_lead' and a.ended_at is null and
      (a.telnyx_call_control_id is not null or a.telnyx_agent_call_control_id is not null or a.answered_at is not null) then$old$,$new$if (c.action='dial_lead' and a.ended_at is null and
      (a.telnyx_call_control_id is not null or a.telnyx_agent_call_control_id is not null or a.answered_at is not null))
      or (c.action='dial_operator' and s.operator_call_control_id is not null and s.operator_terminal_at is null) then$new$);
    if position('or (c.action=''dial_operator'' and s.operator_call_control_id' in patched)=0 then raise exception 'Uncertainty body drift'; end if;
    patched:=replace(patched,$old$return jsonb_build_object('allowed',true,'session',to_jsonb(s),'attempt',to_jsonb(a));$old$,
      $new$return jsonb_build_object('allowed',true,'session',to_jsonb(s),'attempt',to_jsonb(a),'acceptance',
        (select jsonb_build_object('id',g.id,'expiresAt',least(g.expires_at,s.started_at+interval '120 seconds'),
          'destinations',g.destinations,'operatorSipUri',g.operator_sip_uri,'maxSpendCents',g.max_spend_cents)
         from public.dialer_acceptance_grants g where g.id=s.acceptance_grant_id));$new$);
    if position('''expiresAt'',least(g.expires_at' in patched)=0 then raise exception 'Authorization result body drift'; end if;
    execute patched;
  end if;
end $patch$;

create or replace function public.portive_acceptance_revoke(p_grant uuid)
returns void language plpgsql security definer set search_path=public as $$
declare s public.dial_sessions;
begin
  perform pg_advisory_xact_lock(hashtextextended('portive-single-operator',0));
  update public.dialer_acceptance_grants set revoked_at=clock_timestamp() where id=p_grant;
  update public.dial_sessions set status='unsafe',browser_media_ready=false,reason='Acceptance authorization revoked'
    where acceptance_grant_id=p_grant and status not in ('completed','stopped');
  for s in select * from public.dial_sessions where acceptance_grant_id=p_grant and status='unsafe' loop
    perform public.portive_cancel_parallel(s.id,'acceptance_revoked');
    if s.active_call_id is not null then
      perform public.portive_enqueue(s.id,s.active_call_id,'hangup',s.active_call_id||':operator-media-lost','{"force":"true"}');
    end if;
    if s.operator_terminal_at is null then perform public.portive_enqueue(s.id,null,'hangup_operator',s.id||':acceptance-end'); end if;
  end loop;
end $$;
revoke all on function public.portive_parallel_command_base(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb),
  public.portive_parallel_acceptance_engine(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb),
  public.portive_acceptance_destination(text,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.portive_acceptance_issue(jsonb),public.portive_acceptance_revoke(uuid),
  public.portive_parallel_command(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.portive_acceptance_issue(jsonb),public.portive_acceptance_revoke(uuid),
  public.portive_parallel_command(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb),public.portive_acceptance_destination(text,text,text,text) to service_role;
commit;

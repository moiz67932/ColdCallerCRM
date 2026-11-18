begin;

-- Daily authorization covers calls which may incur usage today. Older terminal
-- holds still reduce provider credit; incomplete invoices are never released.
create or replace function public.portive_budget_status(p_session text default null)
returns jsonb language sql security definer set search_path=public as $$
select jsonb_build_object('budgetVersion','exposure-v1','queueVersion','202611180002',
 'heldCents',coalesce(sum(cap_cents) filter(where state='held'),0),
 'dailyHeldCents',coalesce(sum(cap_cents) filter(where state='held' and
   (terminal_at is null or terminal_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')),0),
 'actualObservedMicros',coalesce(sum(billed_micros),0),
 'billingComplete',coalesce(bool_and(state in ('reconciled','canceled')),false),
 'reconciledCents',coalesce(sum(ceil(billed_micros::numeric/10000)) filter(where state='reconciled'),0))
from public.dialer_cost_holds where p_session is null or session_id=p_session
$$;

-- Retain the full possible collision-explanation allowance at dispatch. AMD is
-- absent from first-answer requests, so it must not consume their funding.
do $patch$
declare src text; patched text;
begin
 src:=pg_get_functiondef('public.portive_leg_cap(jsonb,text,integer)'::regprocedure);
 if position('first_answer' in src)=0 then
  patched:=replace(src,$old$(p->>'amdPerCallMicros')::numeric+$old$,
   $new$(case when p_options->>'answerPolicy'='first_answer' then 0 else (p->>'amdPerCallMicros')::numeric end)+$new$);
  if patched=src then raise exception 'Policy pricing body drift';end if;execute patched;
 end if;
 src:=pg_get_functiondef('public.portive_validate_cost(jsonb,integer)'::regprocedure);
 if position('dailyHeldCents' in src)=0 then
  patched:=replace(src,$old$if required+held>coalesce((p_options->>'dailyHeadroomCents')::integer,0)$old$,
   $new$if required+(public.portive_budget_status()->>'dailyHeldCents')::integer>coalesce((p_options->>'dailyHeadroomCents')::integer,0)$new$);
  if patched=src then raise exception 'Daily authorization body drift';end if;execute patched;
 end if;
 -- Terminal signed evidence and settled commands can exclude an explanation
 -- that was never requested. Retain minute minimums, fixed buffers and all
 -- observed bills; do not label any invoice complete.
 src:=pg_get_functiondef('public.portive_bound_terminal_costs()'::regprocedure);
 if position('unused_collision_allowance' in src)=0 then
  patched:=replace(src,$old$bound:=greatest(public.portive_leg_cap(opts,$old$,
   $new$-- unused_collision_allowance: immutable evidence only, never browser assertions.
  if h.role='prospect' and not exists(select 1 from public.dial_commands where attempt_id=h.attempt_id and action='failure_playback')
   and not exists(select 1 from public.call_attempts where id=h.attempt_id and (overflow_state is not null or lost_race_or_abandoned)) then
    opts:=jsonb_set(opts,'{costProfile,ttsPerCharacterMicros}','0');
  end if;
  bound:=greatest(public.portive_leg_cap(opts,$new$);
  if patched=src then raise exception 'Terminal component evidence body drift';end if;execute patched;
 end if;
 src:=pg_get_functiondef('public.portive_bound_terminal_costs()'::regprocedure);
 patched:=replace(src,'public.portive_bound_terminal_costs()','public.portive_bound_session_costs(p_session text)');
 patched:=replace(patched,$old$where state='held' and terminal_at is not null order by session_id,id$old$,
  $new$where session_id=p_session and state='held' and terminal_at is not null order by session_id,id$new$);
 if position('where session_id=p_session' in patched)=0 then raise exception 'Session bounding body drift';end if;
 execute patched;
end $patch$;
revoke all on function public.portive_bound_session_costs(text) from public,anon,authenticated;
grant execute on function public.portive_bound_session_costs(text) to service_role;

-- One second attempt is permitted only for an unanswered winner cancellation.
-- A possibly live call, uncertain provider request, DNC, callback, or a prior
-- answered/no-answer result cannot be recycled by this function.
create or replace function public.portive_canceled_retry_at(p_session text,p_lead text,p_phone text)
returns timestamptz language sql stable set search_path=public as $$
select a.ended_at+interval '60 seconds'
from public.dial_session_targets t join public.dial_sessions s on s.id=t.session_id
join public.call_attempts a on a.id=t.attempt_id
where t.session_id=p_session and t.lead_id=p_lead and t.phone_number=p_phone
 and s.parallel_options->>'answerPolicy'='first_answer'
 and a.ended_at is not null and a.answered_at is null and not a.was_bridged_to_operator
 and a.technical_state='canceled_after_winner' and a.termination_reason='winner_selected'
 and (select count(*) from public.call_attempts x where x.dial_session_id=s.id and x.lead_id=p_lead)=1
 and not exists(select 1 from public.dial_commands c where c.attempt_id=a.id and c.state in ('pending','executing','uncertain'))
 and (a.telnyx_call_control_id is null and exists(select 1 from public.dial_commands c where c.attempt_id=a.id and c.action='dial_lead' and c.state='canceled')
   or exists(select 1 from public.workstation_telnyx_webhook_events e where e.call_control_id=a.telnyx_call_control_id and e.event_type='call.hangup' and e.signature_verified and e.processed_at is not null))
$$;
revoke all on function public.portive_canceled_retry_at(text,text,text) from public,anon,authenticated;
grant execute on function public.portive_canceled_retry_at(text,text,text) to service_role;

do $patch$
declare src text; patched text;
begin
 src:=pg_get_functiondef('public.portive_parallel_command_base(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)'::regprocedure);
 if position('bounded_canceled_retry' in src)=0 then
  patched:=replace(src,'per_attempt integer; candidate record;','per_attempt integer; candidate record; fresh_batch boolean:=false;');
  -- Count attempts, including retries, rather than unique target numbers.
  patched:=replace(patched,'(select count(*)::integer from public.dial_session_targets where session_id=s.id)',
   '(select count(*)::integer from public.call_attempts where dial_session_id=s.id)');
  patched:=replace(patched,'select x.id,c.last_call from public.leads x left join lateral (',
   $new$select x.id,c.last_call,exists(select 1 from public.dial_session_targets t where t.session_id=s.id and (t.lead_id=x.id or t.phone_number=public.portive_phone(x.phone_number))) previously_targeted from public.leads x left join lateral ($new$);
  patched:=replace(patched,'order by c.last_call asc nulls first,x.created_at desc,x.id',
   'order by previously_targeted,c.last_call asc nulls first,x.created_at desc,x.id');
  patched:=replace(patched,'exit when n>=capacity;',
   'exit when n>=capacity; exit when candidate.previously_targeted and fresh_batch;');
  patched:=replace(patched,
   $old$or exists(select 1 from public.dial_session_targets where session_id=s.id and (phone_number=phone or lead_id=l.id))$old$,
   $new$or (exists(select 1 from public.dial_session_targets where session_id=s.id and (phone_number=phone or lead_id=l.id))
      and coalesce(public.portive_canceled_retry_at(s.id,l.id,phone)>now(),true))$new$);
  patched:=replace(patched,
   $old$insert into public.dial_session_targets values(s.id,l.id,phone,business,a.id);$old$,
   $new$-- bounded_canceled_retry: preserve all old attempts and audit the new reservation.
    insert into public.dial_audit_events(session_id,attempt_id,event_type,details)
      select s.id,a.id,'canceled_line_retried',jsonb_build_object('previousAttemptId',t.attempt_id,'cooldownSeconds',60,'maximumAttemptsPerNumber',2)
      from public.dial_session_targets t where t.session_id=s.id and t.phone_number=phone;
    insert into public.dial_session_targets values(s.id,l.id,phone,business,a.id)
      on conflict(session_id,phone_number) do update set attempt_id=excluded.attempt_id,business_key=excluded.business_key;$new$);
  -- Only count a batch when at least one durable attempt was reserved.
  patched:=replace(patched,'set parallel_batch=parallel_batch+1,parallel_options=jsonb_set',
   'set parallel_options=jsonb_set');
  patched:=replace(patched,
   $old$insert into public.call_attempts(lead_id,dial_session_id,parallel_batch,status,technical_state,started_at,raw_summary_json)$old$,
   $new$fresh_batch:=fresh_batch or not candidate.previously_targeted;
    if n=0 then update public.dial_sessions set parallel_batch=parallel_batch+1,reason=null where id=s.id returning * into s;end if;
    insert into public.call_attempts(lead_id,dial_session_id,parallel_batch,status,technical_state,started_at,raw_summary_json)$new$);
  patched:=replace(patched,
   $old$if n=0 then
    update public.dial_sessions set status='stopping',reason=case when capacity=0 then 'Attempt limit reached' else 'No dispatchable leads: check DNC/suppression, recipient timezone/calling policy, callbacks, prior attempts and remaining reserved budget' end where id=s.id returning * into s;$old$,
   $new$if n=0 then
    -- A cooldown is a scheduled wait, never list completion or an immediate redial loop.
    if capacity>0 and s.reserved_cost_cents+per_attempt<=(s.parallel_options->>'maxSpendCents')::integer then
      select min(public.portive_canceled_retry_at(s.id,x.id,public.portive_phone(x.phone_number))) into s.next_batch_at
      from public.leads x where x.lead_list_id=s.selected_list_id and (s.location is null or x.location=s.location)
       and public.portive_canceled_retry_at(s.id,x.id,public.portive_phone(x.phone_number))>now()
       and coalesce(x.derived_status,'') not in ('bad_number','closed_lost')
       and coalesce(x.custom_fields_json->>'doNotCall','false')<>'true'
       and coalesce(x.custom_fields_json->>'suppressed','false')<>'true'
       and coalesce(x.custom_fields_json->>'workspaceHidden','false')<>'true'
       and coalesce(x.custom_fields_json->>'automatedCallingApproved','true')<>'false'
       and not exists(select 1 from public.dial_suppressions where phone_number=public.portive_phone(x.phone_number))
       and not exists(select 1 from public.follow_ups where lead_id=x.id and status='open' and due_at>now())
       and not exists(select 1 from public.call_attempts where lead_id=x.id and callback_at>now())
       and public.portive_calling_hours(x.id,coalesce(nullif(x.custom_fields_json->>'timeZone',''),s.time_zone)) is null;
      if s.next_batch_at is not null then
        update public.dial_sessions set next_batch_at=s.next_batch_at,reason='Waiting for canceled-line retry cooldown' where id=s.id returning * into s;
        return to_jsonb(s);
      end if;
    end if;
    update public.dial_sessions set status='stopping',reason=case
      when capacity=0 then 'Attempt limit reached'
      when s.reserved_cost_cents+per_attempt>(s.parallel_options->>'maxSpendCents')::integer then
        format('Session budget reserved: %s cents retained; %s more cents required for another call. Unsettled charges remain held.',s.reserved_cost_cents,per_attempt)
      else 'Eligible queue complete: every currently callable number attempted; canceled-line retry limit reached. DNC, callbacks and recipient-local hours still apply.' end
      where id=s.id returning * into s;$new$);
  if patched=src or position('bounded_canceled_retry' in patched)=0 or position('Session budget reserved:' in patched)=0 then raise exception 'Queue scheduler body drift';end if;
  -- Rebound settled terminal components during authoritative scheduling, not
  -- only when somebody happens to refresh a quote in the browser.
  patched:=replace(patched,'s:=public.portive_budget_tick(s.id);',
   's:=public.portive_budget_tick(s.id); perform public.portive_bound_session_costs(s.id); select * into s from public.dial_sessions where id=p_session;');
  execute patched;
 end if;
end $patch$;
-- One manual Continue authorizes the next batch even if its canceled lines are
-- still cooling down. Consume that request only when a batch is actually made.
do $patch$
declare src text; patched text;
begin
 src:=pg_get_functiondef('public.portive_parallel_command_base(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)'::regprocedure);
 if position('queued_manual_continue' in src)=0 then
  patched:=replace(src,
   $old$update public.dial_sessions set parallel_options=jsonb_set(parallel_options,'{continueRequested}','false') where id=s.id returning * into s;$old$,
   $new$-- queued_manual_continue: waiting consumes no manual batch authorization.
   null;$new$);
  patched:=replace(patched,
   $old$set parallel_batch=parallel_batch+1,reason=null where id=s.id returning * into s;$old$,
   $new$set parallel_batch=parallel_batch+1,reason=null,parallel_options=jsonb_set(parallel_options,'{continueRequested}','false') where id=s.id returning * into s;$new$);
  if patched=src or position('queued_manual_continue' in patched)=0 then raise exception 'Manual queue body drift';end if;execute patched;
 end if;
end $patch$;
commit;

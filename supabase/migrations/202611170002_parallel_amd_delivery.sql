begin;
do $patch$
declare src text; patched text;
begin
 src:=pg_get_functiondef('public.portive_parallel_event(text,text,text,text,jsonb,timestamptz,text)'::regprocedure);
 if position('interval ''8 seconds''' in src)=0 then
  patched:=replace(src,'classification_deadline_at=least(now(),p_at)+interval ''1 second''',
   'classification_deadline_at=coalesce(classification_deadline_at,greatest(p_at+interval ''8 seconds'',clock_timestamp()+interval ''3 seconds''))');
  if patched=src then raise exception 'AMD deadline body drift';end if;
  -- An already canceled/expired attempt must never become a new winner when a
  -- delayed AMD result arrives while the provider hangup is in flight.
  patched:=replace(patched,'if a.was_bridged_to_operator or a.answer_classification=''human'' then',
   $q$if a.termination_reason is not null and not a.was_bridged_to_operator then
          update public.call_attempts set raw_summary_json=coalesce(raw_summary_json,'{}')||jsonb_build_object('lateAmdResult',p_payload->>'result') where id=a.id;
        elsif a.was_bridged_to_operator or a.answer_classification='human' then$q$);
  execute patched;
 end if;
 src:=pg_get_functiondef('public.portive_parallel_command_base(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)'::regprocedure);
 if position('amd_wait_expired' in src)=0 then
  patched:=replace(src,'update public.call_attempts set answer_classification=''unknown'',technical_state=''answer_unknown'',termination_reason=''amd_deadline_unknown''',
   $q$insert into public.dial_audit_events(session_id,attempt_id,event_type,details)
      values(s.id,a.id,'amd_wait_expired',jsonb_build_object('answeredAt',a.answered_at,'deadlineAt',a.classification_deadline_at,'checkedAt',clock_timestamp()));
    update public.call_attempts set answer_classification='unknown',technical_state='answer_unknown',termination_reason='amd_deadline_unknown'$q$);
  if patched=src then raise exception 'AMD scheduler body drift';end if;
  execute patched;
 end if;
 -- Normalize the saved fallback for an all-Colorado list. Per-lead explicit
 -- timezone and jurisdiction rules still control final authorization.
 src:=pg_get_functiondef('public.portive_parallel_command(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)'::regprocedure);
 if position('parallel_command_received' in src)=0 then
  patched:=replace(src,'perform pg_advisory_xact_lock(hashtextextended(''portive-single-operator'',0));',
   $q$perform pg_advisory_xact_lock(hashtextextended('portive-single-operator',0));
  if p_action='start' and p_list is not null and exists(select 1 from public.leads where lead_list_id=p_list)
    and not exists(select 1 from public.leads where lead_list_id=p_list and public.portive_us_state(state) is distinct from 'CO') then p_timezone:='America/Denver';end if;
  if p_action in ('stop','pause','resume') and s.id is not null and s.controller_id=p_controller then
    insert into public.dial_audit_events(session_id,event_type,details) values(s.id,'parallel_command_received',jsonb_build_object('action',p_action,'receivedAt',clock_timestamp()));
  end if;$q$);
  -- s is loaded just after the advisory lock in the wrapper, so audit against
  -- the persisted identity without relying on the uninitialized local row.
  patched:=replace(patched,'and s.id is not null and s.controller_id=p_controller','and exists(select 1 from public.dial_sessions where id=p_session and controller_id=p_controller)');
  patched:=replace(patched,'values(s.id,''parallel_command_received''','values(p_session,''parallel_command_received''');
  if patched=src then raise exception 'Parallel command audit body drift';end if;execute patched;
 end if;
end $patch$;
commit;

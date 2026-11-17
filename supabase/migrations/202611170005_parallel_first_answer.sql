begin;
-- Explicit per-session policy. Missing/confirmed_human preserves the existing
-- AMD engine, including its timeouts, machine rejection and collision handling.
do $patch$
declare src text; patched text;
begin
 src:=pg_get_functiondef('public.portive_parallel_event(text,text,text,text,jsonb,timestamptz,text)'::regprocedure);
 if position('first_answer_selection' in src)=0 then
  patched:=replace(src,$old$elsif p_type='call.answered' then
        update public.call_attempts$old$,$new$elsif p_type='call.answered' and s.parallel_options->>'answerPolicy'='first_answer' then
        -- first_answer_selection: the session row lock serializes all answers.
        -- A carrier answer is not evidence of a human; keep classification honest.
        update public.call_attempts set answered_at=coalesce(answered_at,p_at),classification_deadline_at=null where id=a.id;
        if s.active_call_id=a.id then null; -- duplicate answer cannot requeue bridge
        elsif a.termination_reason is null and a.overflow_state is null and s.active_call_id is null
          and s.status='running' and s.browser_media_ready and s.operator_leg_state='ready' and s.operator_terminal_at is null then
          update public.dial_sessions set active_call_id=a.id,phase='calling',operator_leg_state='bridging' where id=s.id;
          update public.call_attempts set technical_state='bridging' where id=a.id;
          insert into public.dial_audit_events(session_id,attempt_id,event_type,details)
            values(s.id,a.id,'winner_claimed',jsonb_build_object('policy','first_answer','providerAnsweredAt',p_at,'classification','unknown'));
          perform public.portive_enqueue(s.id,a.id,'bridge',s.id||':bridge:'||a.id);
          perform public.portive_cancel_parallel(s.id,'winner_selected');
        else
          perform public.portive_answer_collision(s.id,a.id);
        end if;
      elsif p_type='call.answered' then
        update public.call_attempts$new$);
  if patched=src then raise exception 'First-answer selection body drift';end if;
  -- Any unexpected/delayed AMD event is evidence only for first-answer sessions:
  -- it must not end the selected call or claim another winner.
  patched:=replace(patched,$old$if a.termination_reason is not null and not a.was_bridged_to_operator then$old$,$new$if s.parallel_options->>'answerPolicy'='first_answer' then
          update public.call_attempts set raw_summary_json=coalesce(raw_summary_json,'{}')||jsonb_build_object('nonSelectingAmdResult',p_payload->>'result') where id=a.id;
        elsif a.termination_reason is not null and not a.was_bridged_to_operator then$new$);
  if position('nonSelectingAmdResult' in patched)=0 then raise exception 'First-answer AMD guard drift';end if;
  execute patched;
 end if;
 src:=pg_get_functiondef('public.portive_cancel_parallel(text,text)'::regprocedure);
 if position('first_answer_collision' in src)=0 then
  patched:=replace(src,$old$if a.answered_at is not null and a.answer_classification='human' and s.active_call_id is not null then$old$,$new$if a.answered_at is not null and s.parallel_options->>'answerPolicy'='first_answer' then
      -- first_answer_collision: no AMD will arrive to clean up answered siblings.
      perform public.portive_answer_collision(s.id,a.id);
    elsif a.answered_at is not null and a.answer_classification='human' and s.active_call_id is not null then$new$);
  if patched=src then raise exception 'First-answer cancellation body drift';end if;execute patched;
 end if;
 src:=pg_get_functiondef('public.portive_answer_collision(text,text)'::regprocedure);
 if position('first_answer' in src)=0 then
  patched:=replace(src,$old$set answer_classification='human',technical_state='answer_collision'$old$,$new$set answer_classification=case when (select parallel_options->>'answerPolicy' from public.dial_sessions where id=p_session)='first_answer' then answer_classification else 'human' end,technical_state='answer_collision'$new$);
  if patched=src then raise exception 'First-answer collision classification drift';end if;execute patched;
 end if;
end $patch$;
create or replace function public.portive_first_answer_ready() returns boolean
language sql security definer set search_path=public as $$select true$$;
revoke all on function public.portive_first_answer_ready() from public,anon,authenticated;
grant execute on function public.portive_first_answer_ready() to service_role;
commit;

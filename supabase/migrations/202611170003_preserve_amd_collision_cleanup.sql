begin;
-- A late human on a canceled sibling is still an answer collision. Preserve
-- its explanation/cleanup without ever allowing that sibling to become winner.
do $patch$
declare src text; patched text;
begin
 src:=pg_get_functiondef('public.portive_parallel_event(text,text,text,text,jsonb,timestamptz,text)'::regprocedure);
 if position('late_amd_winner_collision' in src)=0 then
  patched:=replace(src,
   $q$update public.call_attempts set raw_summary_json=coalesce(raw_summary_json,'{}')||jsonb_build_object('lateAmdResult',p_payload->>'result') where id=a.id;$q$,
   $q$update public.call_attempts set raw_summary_json=coalesce(raw_summary_json,'{}')||jsonb_build_object('lateAmdResult',p_payload->>'result') where id=a.id;
          -- late_amd_winner_collision: never select another winner.
          if classification='human' and a.termination_reason='winner_selected' then
            perform public.portive_answer_collision(s.id,a.id);
          end if;$q$);
  if patched=src then raise exception 'Late AMD collision guard body drift';end if;
  execute patched;
 end if;
end $patch$;
commit;

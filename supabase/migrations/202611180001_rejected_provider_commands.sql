begin;
-- An explicit HTTP rejection is settled command evidence. It does not prove any
-- call ended or release its billing hold. Network/408/5xx remain uncertain.
do $patch$
declare src text; patched text;
begin
 src:=pg_get_functiondef('public.portive_orchestration_complete(uuid,boolean,jsonb,integer,boolean)'::regprocedure);
 if position('rejected_provider_request' in src)=0 then
  patched:=replace(src,
   $old$update public.dial_commands set state='uncertain',error='Provider request failed or acknowledgement uncertain (HTTP '||p_status||')' where id=c.id;$old$,
   $new$-- rejected_provider_request: do not leave a rejected bridge pending forever.
    update public.dial_commands set state=case when p_status between 400 and 499 and p_status<>408 then 'canceled' else 'uncertain' end,
      completed_at=case when p_status between 400 and 499 and p_status<>408 then clock_timestamp() else null end,
      response_json=p_response,error='Provider request failed or acknowledgement uncertain (HTTP '||p_status||')' where id=c.id;$new$);
  if patched=src then raise exception 'Provider rejection completion body drift';end if;
  patched:=replace(patched,
   $old$jsonb_build_object('commandId',c.id,'status',p_status)$old$,
   $new$jsonb_build_object('commandId',c.id,'status',p_status,'diagnostic',p_response->'error')$new$);
  execute patched;
 end if;
end $patch$;
commit;

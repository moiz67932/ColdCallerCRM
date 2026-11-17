begin;
-- Stop is durable even after the browser has closed. An expired heartbeat must
-- not overwrite stopping before the existing provider-evidence cleanup runs.
do $patch$
declare src text; changed text;
begin
 src:=pg_get_functiondef('public.portive_parallel_command_base(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)'::regprocedure);
 if position('s.status in (''running'',''paused'') and s.heartbeat_at' in src)=0 then
  changed:=replace(src,'if s.heartbeat_at<now()-interval ''10 seconds'' then',
   'if s.status in (''running'',''paused'') and s.heartbeat_at<now()-interval ''10 seconds'' then');
  if changed=src then raise exception 'Parallel lease guard body drift'; end if;
  execute changed;
 end if;
end $patch$;
commit;

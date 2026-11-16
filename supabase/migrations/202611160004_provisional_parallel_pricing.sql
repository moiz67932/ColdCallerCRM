begin;
create or replace function public.portive_validate_cost(p_options jsonb,p_lines integer)
returns void language plpgsql set search_path=public as $$
declare p jsonb:=p_options->'costProfile'; configured jsonb; k text; held integer; required integer;
begin
 if p->>'pricingMode'='owner-provisional' and coalesce((p_options->>'spendingApproved')::boolean,false) is not true then raise exception 'Accept the bounded session spending limit before Start';end if;
 select value_json into configured from public.app_settings where key='dialer_cost_profile';
 if p is null or p is distinct from configured or p->>'version' is distinct from 'exposure-v1' or p->>'currency' is distinct from 'USD' or p->>'reviewedAt' is null or p->>'expiresAt' is null
  or length(coalesce(p->>'source',''))<8 or (p->>'reviewedAt')::timestamptz>clock_timestamp()
  or (p->>'pricingMode' is distinct from 'owner-provisional' and (p->>'expiresAt')::timestamptz<=clock_timestamp()+make_interval(secs=>(p_options->>'sessionSeconds')::integer))
  or (p->>'pricingMode' is distinct from 'owner-provisional' and (p->>'expiresAt')::timestamptz>(p->>'reviewedAt')::timestamptz+interval '7 days')
  then raise exception 'Configure current account tariff components; illustrative rates cannot authorize calls'; end if;
 foreach k in array array['sipPerMinuteMicros','operatorSipPerMinuteMicros','callControlPerMinuteMicros','webrtcPerMinuteMicros','bridgePerMinuteMicros','recordingPerMinuteMicros','otherPerMinuteMicros','amdPerCallMicros','ttsPerCharacterMicros','operatorFixedMicros','prospectFixedMicros'] loop
  if p->>k is null or (p->>k)::numeric<0 or (p->>k)::numeric<>trunc((p->>k)::numeric) then raise exception 'Invalid tariff component: %',k; end if;
 end loop;
 if coalesce((p_options->>'sessionSeconds')::integer,0)<(p_options->>'maxCallSeconds')::integer+(p_options->>'ringTimeout')::integer+60
   or p_options->>'maxCallSeconds' is null or p_options->>'ringTimeout' is null or p->>'minimumSeconds' is null or p->>'incrementSeconds' is null or p->'destinationPrefixes' is null or (p_options->>'sessionSeconds')::integer>3600 or (p->>'minimumSeconds')::integer not between 1 and 300
   or (p->>'incrementSeconds')::integer not between 1 and 60 or jsonb_array_length(p->'destinationPrefixes')<1 then raise exception 'Invalid funded duration or tariff scope'; end if;
 required:=public.portive_leg_cap(p_options,'operator')+p_lines*public.portive_leg_cap(p_options,'prospect');
 if required>(p_options->>'maxSpendCents')::integer then raise exception 'First batch requires % cents; maximum spend is % cents',required,p_options->>'maxSpendCents'; end if;
 select coalesce(sum(case when state='reconciled' then 0 else cap_cents end),0) into held from public.dialer_cost_holds where state<>'canceled';
 if required+held>coalesce((p_options->>'availableCreditCents')::integer,0) then raise exception 'Available credit must cover % cents plus % cents of unsettled prior exposure',required,held; end if;
 if required+held>coalesce((p_options->>'dailyHeadroomCents')::integer,0) then raise exception 'Remaining provider daily headroom cannot cover funded exposure'; end if;
end $$;

do $$declare src text;patched text;begin
 src:=pg_get_functiondef('public.portive_parallel_command_base(text,uuid,text,boolean,text,text,integer,text,boolean,jsonb)'::regprocedure);
 patched:=replace(src,$old$if (s.parallel_options->'costProfile'->>'expiresAt')::timestamptz<=clock_timestamp() then$old$,$new$if s.parallel_options->'costProfile'->>'pricingMode' is distinct from 'owner-provisional' and (s.parallel_options->'costProfile'->>'expiresAt')::timestamptz<=clock_timestamp() then$new$);
 if patched=src and position('pricingMode' in src)=0 then raise exception 'Scheduler expiry body drift';end if;
 execute patched;
end $$;
-- This seeds owner-approved estimates, never provider-verified pricing or capacity.
insert into public.app_settings(key,value_json) values('dialer_cost_profile',
'{"version": "exposure-v1", "pricingMode": "owner-provisional", "currency": "USD", "source": "Owner authorized provisional risk buffer; https://telnyx.com/pricing/voice-api; historical SIP/WebRTC/recording CDRs. Not verified account tariffs. Scope Colorado 303/720. SIP 2x public floor; other recurring 1.5x published; bridge/tax/fixed/TTS padded allowances.", "destinationPrefixes": ["+1303", "+1720"], "sipPerMinuteMicros": 10000, "operatorSipPerMinuteMicros": 3000, "callControlPerMinuteMicros": 3000, "webrtcPerMinuteMicros": 3000, "recordingPerMinuteMicros": 3000, "bridgePerMinuteMicros": 2000, "otherPerMinuteMicros": 3000, "amdPerCallMicros": 10000, "ttsPerCharacterMicros": 48, "operatorFixedMicros": 10000, "prospectFixedMicros": 10000, "minimumSeconds": 60, "incrementSeconds": 60}'::jsonb||jsonb_build_object( 'reviewedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char((clock_timestamp()+interval '7 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) on conflict(key) do update set value_json=excluded.value_json;
commit;

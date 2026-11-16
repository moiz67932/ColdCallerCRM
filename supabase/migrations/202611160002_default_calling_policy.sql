-- Optional campaign overrides; ordinary sessions work with the built-in default.
-- Run after 202611160001. This migration creates no grants, reports or sessions.
begin;
alter table public.dialer_calling_rules add column if not exists days integer[] not null default array[1,2,3,4,5,6,7]
  check(days <@ array[1,2,3,4,5,6,7] and cardinality(days)>0);
insert into public.dialer_calling_rules(jurisdiction,start_minute,end_minute,days,source)
values('US-PA',540,1140,array[1,2,3,4,5,6],'https://www.legis.state.pa.us/WU01/LI/LI/US/HTM/1996/0/0147..HTM'),
 ('US-CO',480,1260,array[1,2,3,4,5,6,7],'https://www.ftc.gov/business-guidance/resources/complying-telemarketing-sales-rule')
on conflict do nothing;

create or replace function public.portive_us_state(p_state text)
returns text language sql immutable set search_path=public as $$
select code from (values
 ('AL','ALABAMA'),('AK','ALASKA'),('AZ','ARIZONA'),('AR','ARKANSAS'),('CA','CALIFORNIA'),('CO','COLORADO'),('CT','CONNECTICUT'),('DE','DELAWARE'),('DC','DISTRICT OF COLUMBIA'),('FL','FLORIDA'),('GA','GEORGIA'),('HI','HAWAII'),('ID','IDAHO'),('IL','ILLINOIS'),('IN','INDIANA'),('IA','IOWA'),('KS','KANSAS'),('KY','KENTUCKY'),('LA','LOUISIANA'),('ME','MAINE'),('MD','MARYLAND'),('MA','MASSACHUSETTS'),('MI','MICHIGAN'),('MN','MINNESOTA'),('MS','MISSISSIPPI'),('MO','MISSOURI'),('MT','MONTANA'),('NE','NEBRASKA'),('NV','NEVADA'),('NH','NEW HAMPSHIRE'),('NJ','NEW JERSEY'),('NM','NEW MEXICO'),('NY','NEW YORK'),('NC','NORTH CAROLINA'),('ND','NORTH DAKOTA'),('OH','OHIO'),('OK','OKLAHOMA'),('OR','OREGON'),('PA','PENNSYLVANIA'),('RI','RHODE ISLAND'),('SC','SOUTH CAROLINA'),('SD','SOUTH DAKOTA'),('TN','TENNESSEE'),('TX','TEXAS'),('UT','UTAH'),('VT','VERMONT'),('VA','VIRGINIA'),('WA','WASHINGTON'),('WV','WEST VIRGINIA'),('WI','WISCONSIN'),('WY','WYOMING')
) s(code,name) where upper(trim(p_state)) in (code,name)
$$;

create or replace function public.portive_default_calling_holiday(p_date date)
returns boolean language sql immutable set search_path=public as $$
with fixed as (
 select make_date(y,m,d) dt from generate_series(extract(year from p_date)::integer-1,extract(year from p_date)::integer+1) y,
 (values(1,1),(6,19),(7,4),(11,11),(12,25)) h(m,d)
)
select exists(select 1 from fixed where p_date=dt or p_date=dt+case extract(isodow from dt) when 6 then -1 when 7 then 1 else 0 end)
 or (extract(isodow from p_date)=1 and
   ((extract(month from p_date) in (1,2) and extract(day from p_date) between 15 and 21)
    or (extract(month from p_date)=5 and extract(day from p_date)>=25)
    or (extract(month from p_date)=9 and extract(day from p_date)<=7)
    or (extract(month from p_date)=10 and extract(day from p_date) between 8 and 14)))
 or (extract(month from p_date)=11 and extract(isodow from p_date)=4 and extract(day from p_date) between 22 and 28)
$$;
revoke all on function public.portive_us_state(text),public.portive_default_calling_holiday(date) from public,anon,authenticated;
grant execute on function public.portive_us_state(text),public.portive_default_calling_holiday(date) to service_role;

create or replace function public.portive_calling_hours(p_lead text,p_timezone text,p_at timestamptz default clock_timestamp())
returns text language plpgsql security definer set search_path=public as $$
declare l public.leads; p public.dialer_campaign_calling_policies; r public.dialer_calling_rules;
  local_at timestamp; minute integer; v_jurisdiction text; jurisdictions text[]; start_at integer; end_at integer; destination_state text; country text; default_known boolean:=false;
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
  -- No campaign row is required. Unknown line type remains residential.
  destination_state:=public.portive_us_state(coalesce(nullif(l.state,''),nullif(l.custom_fields_json->>'state',''),l.custom_fields_json->>'stateCode'));
  country:=upper(trim(coalesce(l.custom_fields_json->>'countryCode','')));
  if country<>'' and country not in ('US','USA') then return 'unsupported_destination_country'; end if;
  if p.list_id is null then
    if country='' and destination_state is null then return 'destination_country_unknown'; end if;
    default_known:=destination_state in ('CO','FL','MD','OK','TX','PA');
    -- Known destination rules supply the actual window; otherwise use a
    -- conservative residential envelope, with no Sunday/holiday default calls.
    if (not coalesce(default_known,false) and extract(isodow from local_at)=7) or public.portive_default_calling_holiday(local_at::date) then return 'outside_default_calling_days'; end if;
  end if;
  start_at:=coalesce(p.start_minute,case when default_known then 0 else 540 end); end_at:=coalesce(p.end_minute,case when default_known then 1440 else 1140 end);
  if p.list_id is not null and not extract(isodow from local_at)::integer=any(p.days) then return 'outside_campaign_calling_days'; end if;
  jurisdictions:=coalesce(p.jurisdictions,array['US']);
  -- Destination-specific rules are always intersected with campaign policy.
  v_jurisdiction:=nullif(l.custom_fields_json->>'callingJurisdiction','');
  if destination_state is not null and exists(select 1 from public.dialer_calling_rules where jurisdiction='US-'||destination_state) then
    jurisdictions:=array_append(jurisdictions,'US-'||destination_state); end if;
  if v_jurisdiction is not null then jurisdictions:=array_append(jurisdictions,v_jurisdiction); end if;
  if p.classification='business_landline' and public.portive_phone(l.phone_number)=any(p.business_numbers) then
    -- Business-only scope and its applicable rules were recorded administratively.
    -- Federal residential hours do not automatically apply to a classified business landline.
    jurisdictions:=array_remove(jurisdictions,'US');
  end if;
  foreach v_jurisdiction in array jurisdictions loop
    select * into r from public.dialer_calling_rules where dialer_calling_rules.jurisdiction=v_jurisdiction;
    if r.jurisdiction is null then
      if public.portive_us_state(replace(v_jurisdiction,'US-','')) is not null and p.list_id is null then continue; end if;
      return 'calling_rule_missing:'||v_jurisdiction; end if;
    if not extract(isodow from local_at)::integer=any(r.days) then return 'outside_jurisdiction_calling_days'; end if;
    start_at:=greatest(start_at,r.start_minute,case when extract(isodow from local_at)=7 then r.sunday_start_minute end);
    end_at:=least(end_at,r.end_minute);
  end loop;
  if minute<start_at or minute>=end_at then return 'outside_calling_window'; end if;
  return null;
end $$;
revoke all on function public.portive_calling_hours(text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.portive_calling_hours(text,text,timestamptz) to service_role;

create or replace function public.portive_regular_parallel_status()
returns jsonb language sql security definer set search_path=public as $$
select jsonb_build_object('schemaVersion','202611160001','hoursPolicyVersion','202611160002','campaignPolicyRequired',false,'reportRequired',false,
 'activeSessions',(select count(*) from public.dial_sessions where status in ('running','paused','stopping','unsafe')),
 'activeAttempts',(select count(*) from public.call_attempts where ended_at is null and status in ('dialing','connected','voicemail_detected')),
 'unsettledCommands',(select count(*) from public.dial_commands where state in ('pending','executing','uncertain')),
 'unsettledProviderCommands',(select count(*) from public.dial_provider_commands where state in ('executing','uncertain')))
$$;
revoke all on function public.portive_regular_parallel_status() from public,anon,authenticated;
grant execute on function public.portive_regular_parallel_status() to service_role;
commit;

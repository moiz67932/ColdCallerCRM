import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";
import {costProfileSchema} from "../../lib/dialer/budget";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import ts from "typescript";

// Explicitly targets a disposable local container. Never reads production DB credentials.
const container = "portive-dialer-test-20261113";
const dbName = `parallel_suite_${process.pid}`;
const controller = "11111111-1111-4111-8111-111111111111";
const offset = 12 - new Date().getUTCHours();
const zone = `Etc/GMT${offset >= 0 ? "-" : "+"}${Math.abs(offset)}`;
function sql(query: string, database = dbName) {
  return execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], {
    input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function fixture() {
  sql(`truncate public.dial_audit_events,public.dial_session_targets,public.dial_sessions,public.lead_lists cascade;
    select public.portive_set_orchestration_backend('node',false);
    insert into public.app_settings(key,value_json) values('dialer_cost_profile','${JSON.stringify(costProfile)}') on conflict(key) do update set value_json=excluded.value_json;
    delete from public.dial_suppressions; delete from public.dialer_calling_consents;
    insert into public.app_settings(key,value_json) values('dialer_watchdog_heartbeat',jsonb_build_object('at',now()))
      on conflict(key) do update set value_json=excluded.value_json;
    insert into public.lead_lists(id,name,source_file_name) values('list','Test list','test.csv');
    insert into public.leads(id,lead_list_id,phone_number,business_name,created_at) values
      ('first','list','+12125550101','First',now()),('second','list','+12125550102','Second',now()-interval '1 day'),
      ('third','list','+12125550103','Third',now()-interval '2 days');
    insert into public.dialer_campaign_calling_policies(list_id,jurisdictions,legal_basis) values('list',array['US'],'Offline federal-only fixture jurisdiction');`);
}

const verificationId = "33333333-3333-4333-8333-333333333333";
const costProfile={version:'exposure-v1',currency:'USD',source:'Synthetic disposable test tariff',reviewedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),destinationPrefixes:['+1212'],sipPerMinuteMicros:5000,operatorSipPerMinuteMicros:2000,callControlPerMinuteMicros:2000,webrtcPerMinuteMicros:2000,bridgePerMinuteMicros:0,recordingPerMinuteMicros:0,otherPerMinuteMicros:0,amdPerCallMicros:6500,ttsPerCharacterMicros:9,operatorFixedMicros:0,prospectFixedMicros:0,minimumSeconds:60,incrementSeconds:60};
const options = { costProfile,availableCreditCents:100000,dailyHeadroomCents:100000,sessionSeconds:600,accountChannels:5, fingerprint: "controlled-fixture", operatorSipUri: "sip:test@sip.telnyx.com", ringTimeout: 30,
  maxCallSeconds: 300, batchDelaySeconds: 0, attemptLimit: 100, maxSpendCents: 5000, autoContinue: true, autoRefill: false };
function invoke(action: string, session: string | null = null, extra: Record<string, unknown> = {}) {
  return JSON.parse(sql(`select public.portive_parallel_command(${session ? `'${session}'` : "null"},'${controller}','${action}',true,'list',null,4,'${zone}',true,'${JSON.stringify({ ...options,...extra })}')`));
}
function setup() {
  fixture(); sql(`insert into public.leads(id,lead_list_id,phone_number,business_name,created_at) values('fourth','list','+12125550104','Fourth',now()-interval '3 days')`);
}

function start(extra: Record<string,unknown> = {}) {
  const s = invoke("start",null,extra);
  event(s.id,null,"operator","call.initiated",{call_control_id:"operator"});
  event(s.id,null,"operator","call.answered",{call_control_id:"operator"});
  invoke("operator_ready",s.id,{callControlId:"operator"});
  invoke("tick",s.id); return s.id as string;
}
function attempts(s: string) { return JSON.parse(sql(`select json_agg(a order by created_at,lead_id) from public.call_attempts a where dial_session_id='${s}'`) || "null"); }
function event(s: string, id: string | null, role: string, type: string, payload: Record<string,unknown> = {}, eventId = crypto.randomUUID()) {
  sql(`insert into public.workstation_telnyx_webhook_events(event_id,event_type,payload_json,signature_verified) values('${eventId}','${type}','{}',true) on conflict(event_id) do nothing;
    select public.portive_parallel_event('${s}',${id ? `'${id}'` : "null"},'${role}','${type}','${JSON.stringify(payload)}',now(),'${eventId}')`);
}
function answer(s: string, id: string, result = "human_business") {
  event(s,id,"lead","call.answered",{call_control_id:id});
  event(s,id,"lead","call.machine.premium.detection.ended",{result});
}

test("parallel migrations apply on top of the Power schema and rerun without losing records", () => {
  sql(`create database ${dbName}`,"postgres");
  for (const file of ["202604260001_colcaller_workstation.sql","202606240001_lead_locations.sql","202611130001_dial_sessions.sql","202611130002_parallel_engine.sql","202611140001_single_operator_collisions.sql"]) {
    sql(readFileSync(`supabase/migrations/${file}`,"utf8"));
  }
  sql(`insert into public.dialer_provider_verifications(id,config_fingerprint,connection_id,profile_id,account_channels,overflow_slots,rate_ceiling_cents,evidence,expires_at)
    values('44444444-4444-4444-8444-444444444444','rerun-marker','connection','profile',5,3,1,'{"suite":"portive-parallel-v1","passed":true}',now()+interval '1 day');
    alter table public.dialer_provider_verifications drop constraint dialer_provider_verifications_overflow_slots_check;
    alter table public.dialer_provider_verifications add constraint dialer_provider_verifications_overflow_slots_check check(overflow_slots >= 3)`);
  for (const file of ["202611130002_parallel_engine.sql","202611140001_single_operator_collisions.sql"]) {
    sql(readFileSync(`supabase/migrations/${file}`,"utf8"));
  }
  assert.equal(sql("select count(*) from public.dialer_provider_verifications where config_fingerprint='rerun-marker'"),"1");
  sql("update public.dialer_provider_verifications set overflow_slots=0 where config_fingerprint='rerun-marker'");
  sql("delete from public.dialer_provider_verifications where config_fingerprint='rerun-marker'");
  sql(readFileSync("supabase/migrations/202611140002_cloudflare_orchestration.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611150001_parallel_dispatch_safety.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611150002_parallel_acceptance.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611160001_regular_parallel.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611160002_default_calling_policy.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611160003_parallel_exposure_budget.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611170001_parallel_stop_lease.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611170002_parallel_amd_delivery.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611170003_preserve_amd_collision_cleanup.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611170004_usage_cache_and_operator_recovery.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611170005_parallel_first_answer.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611170005_parallel_first_answer.sql", "utf8"));
});
test("first-answer policy selects and bridges without AMD while retaining unknown classification", () => {
 setup();const s=start({answerPolicy:'first_answer'}),a=attempts(s);
 event(s,a[0].id,'lead','call.answered',{call_control_id:a[0].id});
 assert.equal(sql(`select active_call_id from public.dial_sessions where id='${s}'`),a[0].id);
 assert.equal(sql(`select answer_classification||':'||(classification_deadline_at is null)::text from public.call_attempts where id='${a[0].id}'`),'unknown:true');
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='bridge'`),'1');
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='hangup'`),'3');
 event(s,a[0].id,'lead','call.answered');event(s,a[0].id,'lead','call.bridged');
 assert.equal(sql(`select was_bridged_to_operator from public.call_attempts where id='${a[0].id}'`),'t');
 for(const result of ['not_sure','machine','human_business'])event(s,a[0].id,'lead','call.machine.premium.detection.ended',{result});
 assert.equal(sql(`select count(*) from public.dial_commands where attempt_id='${a[0].id}' and action='hangup'`),'0');
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='bridge'`),'1');
 assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),'running');
});
test("first-answer collision never replaces winner or falsely labels an answer human", () => {
 setup();const s=start({answerPolicy:'first_answer'}),a=attempts(s);
 for(const item of a)event(s,item.id,'lead','call.answered',{call_control_id:item.id});
 assert.equal(sql(`select active_call_id from public.dial_sessions where id='${s}'`),a[0].id);
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='bridge'`),'1');
 assert.equal(sql(`select count(*) from public.call_attempts where dial_session_id='${s}' and technical_state='answer_collision' and answer_classification='unknown'`),'3');
 for(const item of a.slice(1)){event(s,item.id,'lead','call.speak.ended');assert.equal(sql(`select count(*) from public.dial_commands where attempt_id='${item.id}' and action='hangup' and parameters->>'force'='true'`),'1');}
});
test("simultaneous first answers serialize to exactly one winner and bridge", async () => {
 setup();const s=start({answerPolicy:'first_answer'}),a=attempts(s);
 await Promise.all(a.map((item:{id:string})=>promisify(execFile)('docker',['exec','-i',container,'psql','-X','-qAt','-U','postgres','-d',dbName,'-v','ON_ERROR_STOP=1','-c',
  `select public.portive_parallel_event('${s}','${item.id}','lead','call.answered','{"call_control_id":"${item.id}"}',now(),'${crypto.randomUUID()}')`])));
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='bridge'`),'1');
 assert.equal(sql(`select count(*) from public.dial_audit_events where session_id='${s}' and event_type='winner_claimed'`),'1');
 assert.equal(sql(`select count(*) from public.call_attempts where dial_session_id='${s}' and technical_state='answer_collision'`),'3');
});
test("Stop before first answer prevents a new bridge; Stop after bridge preserves the conversation", () => {
 setup();let s=start({answerPolicy:'first_answer'}),a=attempts(s);invoke('stop',s);event(s,a[0].id,'lead','call.answered');
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='bridge'`),'0');
 setup();s=start({answerPolicy:'first_answer'});a=attempts(s);event(s,a[0].id,'lead','call.answered');event(s,a[0].id,'lead','call.bridged');invoke('stop',s);invoke('tick',s);
 assert.equal(sql(`select count(*) from public.dial_commands where attempt_id='${a[0].id}' and action='hangup'`),'0');
});
test("first-answer winner hangup waits for disposition then continues with the same parked operator", () => {
 setup();const s=start({answerPolicy:'first_answer'}),a=attempts(s);
 sql(`insert into public.leads(id,lead_list_id,phone_number,business_name) values('fifth','list','+12125550105','Fifth')`);
 event(s,a[0].id,'lead','call.answered');event(s,a[0].id,'lead','call.bridged');
 for(const item of a)event(s,item.id,'lead','call.hangup',{hangup_cause:'normal_clearing'});invoke('tick',s);
 assert.equal(sql(`select phase from public.dial_sessions where id='${s}'`),'awaiting_disposition');
 sql(`select public.portive_save_disposition('${a[0].id}','${a[0].lead_id}','voicemail','Automated greeting',null,null)`);invoke('tick',s);
 assert.equal(sql(`select parallel_batch from public.dial_sessions where id='${s}'`),'2');
 assert.equal(sql(`select operator_call_control_id from public.dial_sessions where id='${s}'`),'operator');
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='dial_operator'`),'1');
});
for(const autoContinue of [true,false])test(`first-answer repeats a full four-line batch with ${autoContinue?'automatic':'button'} continuation`,()=>{
 setup();const s=start({answerPolicy:'first_answer',autoContinue}),first=attempts(s);
 sql(`insert into public.leads(id,lead_list_id,phone_number,business_name) values
  ('next5','list','+12125550105','Next5'),('next6','list','+12125550106','Next6'),
  ('next7','list','+12125550107','Next7'),('next8','list','+12125550108','Next8')`);
 event(s,first[0].id,'lead','call.answered');event(s,first[0].id,'lead','call.bridged');
 for(const item of first)event(s,item.id,'lead','call.hangup',{hangup_cause:'normal_clearing'});
 invoke('tick',s);assert.equal(sql(`select phase from public.dial_sessions where id='${s}'`),'awaiting_disposition');
 assert.equal(attempts(s).length,4);
 sql(`select public.portive_save_disposition('${first[0].id}','${first[0].lead_id}','answered','Completed test conversation',null,null)`);
 invoke('tick',s);
 if(!autoContinue){assert.equal(attempts(s).length,4);invoke('continue',s);invoke('tick',s);}
 const all=attempts(s);assert.equal(all.length,8);
 assert.equal(sql(`select count(distinct lead_id) from public.call_attempts where dial_session_id='${s}'`),'8');
 assert.equal(sql(`select count(*) from public.call_attempts where dial_session_id='${s}' and parallel_batch=2 and ended_at is null`),'4');
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='dial_operator'`),'1');
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='hangup_operator'`),'0');
});
test("Stop after browser lease expiry reaches terminal only with operator terminal evidence", () => {
  setup(); const s=invoke("start").id;
  event(s,null,"operator","call.answered",{call_control_id:"operator"});
  sql(`update public.dial_sessions set heartbeat_at=now()-interval '5 minutes' where id='${s}'`);
  invoke("stop",s); invoke("tick",s);
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),'stopping');
  assert.equal(sql(`select ended_at is null from public.dial_sessions where id='${s}'`),'t');
  event(s,null,"operator","call.hangup",{call_control_id:"operator"}); invoke("tick",s);
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),'stopped');
  assert.equal(sql(`select ended_at is not null from public.dial_sessions where id='${s}'`),'t');
  assert.equal(sql(`select count(*) from public.call_attempts where dial_session_id='${s}'`),'0');
});
test("live operator status observation preserves a healthy paused connection", () => {
 const s=cloudflareStart(); invoke('pause',s);
 sql(`select public.portive_orchestration_operator('${s}','operator',true)`);
 assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),'paused');
 assert.equal(sql(`select count(*) from public.dial_commands where action='hangup_operator' and session_id='${s}'`),'0');
});
test("shared usage cache grants one lease and preserves unavailable evidence on cooldown", () => {
 setup(); const key='voice-usage:0123456789abcdef:2026-11-17',other='22222222-2222-4222-8222-222222222222';
 const call=(owner:string)=>JSON.parse(sql(`select public.portive_usage_claim('${key}','${owner}',60)`));
 assert.equal(call(controller).claimed,true);assert.equal(call(other).busy,true);
 sql(`select public.portive_usage_finish('${key}','${controller}',null,60)`);
 assert(call(other).retryAfterSeconds>0);
 sql(`update public.dialer_usage_cache set retry_at=null where key='${key}'`);
 assert.equal(call(other).claimed,true);sql(`select public.portive_usage_finish('${key}','${other}',7)`);
 assert.equal(call(controller).observedCents,7);
 assert.throws(()=>sql(`set role anon;select public.portive_usage_claim('${key}','${controller}',60)`),/permission denied/);
});
test("terminal duration reduces only excess exposure and retains an uncertain billing hold", () => {
 setup();const s=start(),a=attempts(s)[0];event(s,a.id,'lead','call.hangup',{call_control_id:a.id});
 sql(`update public.dial_commands set state='confirmed' where session_id='${s}';
 update public.workstation_telnyx_webhook_events set call_control_id='${a.id}',payload_json=jsonb_build_object('data',jsonb_build_object('payload',jsonb_build_object('start_time',now()-interval '10 seconds','end_time',now()))) where event_type='call.hangup';`);
 const old=Number(sql(`select cap_cents from public.dialer_cost_holds where id='${a.id}'`));
 sql(`select public.portive_bound_terminal_costs()`);
 const cap=Number(sql(`select cap_cents from public.dialer_cost_holds where id='${a.id}'`));
 assert(cap>0&&cap<old);assert.equal(sql(`select state from public.dialer_cost_holds where id='${a.id}'`),'held');
 assert.equal(sql(`select billed_micros is null from public.dialer_cost_holds where id='${a.id}'`),'t');
});
test("no prospects are reserved until both provider answer and browser media acknowledgement", () => {
  setup(); const s=invoke("start").id; invoke("tick",s); assert.equal(sql("select count(*) from public.call_attempts"),"0");
  event(s,null,"operator","call.answered",{call_control_id:"operator"});
  invoke("tick",s); assert.equal(sql("select count(*) from public.call_attempts"),"0");
});
test("one tick reserves four separate durable attempts and dial commands", () => {
  setup(); const s=start(); assert.equal(attempts(s).length,4);
  assert.equal(sql("select count(*) from public.dial_commands where action='dial_lead'"),"4");
  invoke("tick",s); assert.equal(attempts(s).length,4);
});
test("first human selects one operator and cancels only ringing siblings", () => {
  setup(); const s=start(); const a=attempts(s); answer(s,a[1].id);
  assert.equal(sql(`select active_call_id from public.dial_sessions where id='${s}'`),a[1].id);
  assert.equal(sql("select count(*) from public.dial_commands where action='bridge'"),"1");
  assert.equal(sql("select count(*) from public.call_attempts where technical_state='canceled_after_winner'"),"3");
});
test("canceled leads are not dialed twice in-session and recycle in existing priority order next session", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id); event(s,a[0].id,"lead","call.bridged");
  for (const sibling of a.slice(1)) event(s,sibling.id,"lead","call.hangup",{hangup_cause:"normal_clearing"});
  event(s,a[0].id,"lead","call.hangup",{hangup_cause:"normal_clearing"});
  sql(`select public.portive_save_disposition('${a[0].id}','${a[0].lead_id}','gatekeeper','Talked to receptionist',null,null)`);
  invoke("tick",s); assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),"stopping");
  event(s,null,"operator","call.hangup"); invoke("tick",s);
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),"stopped");
  sql("update public.app_settings set value_json=jsonb_build_object('at',now()) where key='dialer_watchdog_heartbeat'");
  assert.equal(sql(`select count(*) from public.call_attempts where dial_session_id='${s}'`),"4");
  assert.equal(sql(`select count(*) from public.call_attempts where dial_session_id='${s}' and technical_state='canceled_after_winner' and outcome is null`),"3");
  const next=start();
  assert.deepEqual(new Set(attempts(next).map((item: { lead_id: string })=>item.lead_id)),new Set(a.map((item: { lead_id: string })=>item.lead_id)));
  assert.equal(sql(`select count(*) from public.call_attempts where lead_id in (${a.slice(1).map((item: { lead_id: string })=>`'${item.lead_id}'`).join(",")})`),"6");
});
test("carrier answer and voicemail never claim the primary operator", () => {
  setup(); const s=start(); const a=attempts(s); answer(s,a[0].id,"machine");
  assert.equal(sql(`select active_call_id is null from public.dial_sessions where id='${s}'`),"t");
  assert.equal(sql(`select outcome from public.call_attempts where id='${a[0].id}'`),"voicemail");
  answer(s,a[1].id); assert.equal(sql(`select active_call_id from public.dial_sessions where id='${s}'`),a[1].id);
});
test("two near-simultaneous answers produce one bridge and explain the collision before cleanup", async () => {
  setup(); const s=start(); const a=attempts(s);
  for (const item of a.slice(0,2)) event(s,item.id,"lead","call.answered",{call_control_id:item.id});
  const run=promisify(execFile);
  await Promise.all(a.slice(0,2).map((item: { id: string }) => run("docker",["exec",container,"psql","-X","-qAt","-U","postgres","-d",dbName,"-v","ON_ERROR_STOP=1","-c",
    `select public.portive_parallel_event('${s}','${item.id}','lead','call.machine.premium.detection.ended','{"result":"human_business"}',now(),'${crypto.randomUUID()}')`])));
  assert.equal(sql("select count(*) from public.dial_commands where action='bridge'"),"1");
  assert.equal(sql(`select count(*) from public.dial_commands where action='failure_playback' and attempt_id in ('${a[0].id}','${a[1].id}')`),"1");
  assert.equal(sql("select count(*) from public.call_attempts where technical_state='answer_collision'"),"1");
  const winner=sql(`select active_call_id from public.dial_sessions where id='${s}'`);
  assert([a[0].id,a[1].id].includes(winner));
  assert.equal(sql(`select ended_at is null from public.call_attempts where id='${winner}'`),"t");
  assert.equal(sql(`select count(*) from public.dial_commands where action='hangup' and attempt_id='${winner}'`),"0");
});
test("duplicate human events do not duplicate bridge commands", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id); const key=crypto.randomUUID();
  event(s,a[0].id,"lead","call.machine.premium.detection.ended",{result:"human_business"},key);
  event(s,a[0].id,"lead","call.machine.premium.detection.ended",{result:"human_business"},key);
  assert.equal(sql("select count(*) from public.dial_commands where action='bridge'"),"1");
});
test("delayed carrier answer survives the former 1s cutoff and human AMD bridges exactly once", () => {
  setup(); const s=start(), a=attempts(s)[0], ev=crypto.randomUUID();
  sql(`insert into public.workstation_telnyx_webhook_events(event_id,event_type,payload_json,signature_verified) values('${ev}','call.answered','{}',true);
    select public.portive_parallel_event('${s}','${a.id}','lead','call.answered','{"call_control_id":"${a.id}"}',now()-interval '1.25 seconds','${ev}')`);
  invoke('tick',s);
  assert.equal(sql(`select ended_at is null and termination_reason is null from public.call_attempts where id='${a.id}'`),'t');
  assert.equal(sql(`select classification_deadline_at>now()+interval '5 seconds' from public.call_attempts where id='${a.id}'`),'t');
  assert.equal(sql(`select count(*) from public.dial_commands where action='bridge'`),'0');
  event(s,a.id,'lead','call.machine.premium.detection.ended',{result:'human_business'});
  event(s,a.id,'lead','call.machine.premium.detection.ended',{result:'human_business'});
  assert.equal(sql(`select count(*) from public.dial_commands where action='bridge'`),'1');
  assert.equal(sql(`select was_bridged_to_operator from public.call_attempts where id='${a.id}'`),'f');
  event(s,a.id,'lead','call.bridged');
  assert.equal(sql(`select was_bridged_to_operator from public.call_attempts where id='${a.id}'`),'t');
});
test("early Stop and late AMD cannot resurrect or bridge a canceled prospect", () => {
  setup(); const s=start(), a=attempts(s)[0];
  event(s,a.id,'lead','call.answered'); invoke('stop',s);
  event(s,a.id,'lead','call.machine.premium.detection.ended',{result:'human_business'});
  assert.equal(sql(`select count(*) from public.dial_commands where action='bridge'`),'0');
  assert.equal(sql(`select details->>'action' from public.dial_audit_events where event_type='parallel_command_received'`),'stop');
});
test("Colorado recipient hours use Denver despite New York fallback and respect campaign boundaries", () => {
  setup(); sql("update public.leads set state='Colorado'; delete from public.dialer_campaign_calling_policies");
  assert.equal(sql("select public.portive_calling_hours('first','America/New_York','2026-11-17T14:59:00Z')"),'outside_calling_window');
  assert.equal(sql("select public.portive_calling_hours('first','America/New_York','2026-11-17T15:14:00Z') is null"),'t');
  sql("insert into public.dialer_campaign_calling_policies(list_id,jurisdictions,legal_basis,start_minute,end_minute) values('list',array['US-CO'],'Controlled campaign hours',540,1020)");
  assert.equal(sql("select public.portive_calling_hours('first','America/New_York','2026-11-17T15:14:00Z')"),'outside_calling_window');
  assert.equal(sql("select public.portive_calling_hours('first','America/New_York','2026-11-17T16:00:00Z') is null"),'t');
  assert.equal(sql("select public.portive_calling_hours('first','America/New_York','2026-11-18T00:00:00Z')"),'outside_calling_window');
});
test("unknown AMD ends the answered call and pauses without inventing a disposition", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id,"not_sure");
  const row=attempts(s)[0]; assert.equal(row.answer_classification,"unknown"); assert.equal(row.outcome,null);
  assert.equal(row.technical_state,"answer_unknown");
  assert.equal(sql(`select count(*) from public.dial_commands where action='hangup' and attempt_id='${a[0].id}'`),"1");
});
test("classification deadline ends an unknown answer and pauses the session", () => {
  setup(); const s=start(), a=attempts(s); event(s,a[0].id,"lead","call.answered",{call_control_id:a[0].id});
  sql(`update public.call_attempts set classification_deadline_at=now()-interval '1 second' where id='${a[0].id}'`); invoke("tick",s);
  assert.equal(sql(`select technical_state from public.call_attempts where id='${a[0].id}'`),"answer_unknown");
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),"paused");
});
test("no answer on all four advances to another eligible batch", () => {
  setup(); const s=start(); sql("insert into public.leads(id,lead_list_id,phone_number,business_name) values('next','list','+12125550105','Next')");
  for (const a of attempts(s)) event(s,a.id,"lead","call.hangup",{hangup_cause:"timeout"});
  invoke("tick",s); assert.equal(attempts(s).length,5);
  assert.equal(sql("select count(*) from public.call_attempts where outcome='no_answer'"),"4");
});
test("busy line ends independently; batch mode waits for its siblings", () => {
  setup(); const s=start(), a=attempts(s); event(s,a[0].id,"lead","call.hangup",{hangup_cause:"user_busy"}); invoke("tick",s);
  assert.equal(attempts(s).length,4); assert.equal(attempts(s)[0].technical_state,"busy");
});
test("pause and stop preserve an established human conversation", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id); event(s,a[0].id,"lead","call.bridged");
  invoke("pause",s); invoke("stop",s); invoke("tick",s);
  assert.equal(sql(`select ended_at is null from public.call_attempts where id='${a[0].id}'`),"t");
  assert.equal(sql(`select count(*) from public.dial_commands where action='hangup' and attempt_id='${a[0].id}'`),"0");
});
test("winner normal hangup is completed and disposition holds the next batch", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id); event(s,a[0].id,"lead","call.bridged");
  for (const item of a) event(s,item.id,"lead","call.hangup",{hangup_cause:"normal_clearing"}); invoke("tick",s);
  assert.equal(sql(`select status from public.call_attempts where id='${a[0].id}'`),"completed");
  assert.equal(sql(`select phase from public.dial_sessions where id='${s}'`),"awaiting_disposition");
  sql(`select public.portive_save_disposition('${a[0].id}','${a[0].lead_id}','gatekeeper','Manager will call',null,'manager_callback_pending')`);
  assert.equal(sql(`select next_action from public.call_attempts where id='${a[0].id}'`),"manager_callback_pending");
});
test("late terminal events cannot reactivate a completed call", () => {
  setup(); const s=start(), a=attempts(s); event(s,a[0].id,"lead","call.hangup",{hangup_cause:"timeout"});
  event(s,a[0].id,"lead","call.ringing"); assert.equal(attempts(s)[0].technical_state,"no_answer");
});
test("late human evidence on a canceled non-winner is audited without interrupting the winner", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id); event(s,a[1].id,"lead","call.hangup");
  event(s,a[1].id,"lead","call.answered"); assert.equal(attempts(s)[1].technical_state,"answer_collision");
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),"running");
});
test("browser expiry stops new reservations and ends the active prospect safely", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id); sql(`update public.dial_sessions set heartbeat_at=now()-interval '11 seconds' where id='${s}'`); invoke("tick",s);
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),"unsafe"); assert.equal(attempts(s).length,4);
  assert.equal(sql(`select count(*) from public.dial_commands where action='hangup' and attempt_id='${a[0].id}'`),"1");
});
test("one known business cannot occupy multiple concurrent lines", () => {
  setup(); sql("update public.leads set website='https://same-company.example/location' where id in ('first','second')");
  assert.equal(attempts(start()).length,3);
});
test("suppression and future callbacks exclude destinations", () => {
  setup(); sql("insert into public.dial_suppressions values('+12125550101','DNC',now()); insert into public.follow_ups(lead_id,due_at,status,channel) values('second',now()+interval '1 day','open','call')");
  assert.equal(attempts(start()).length,2);
});
test("five provider channels cover four prospects and the operator without overflow staffing", () => {
  setup(); assert.equal(options.accountChannels,5);
  assert.equal(attempts(start()).length,4);
});
test("spend ceiling remains enforced inside the database", () => {
  setup();
  assert.throws(()=>start({maxSpendCents:29}),/First batch requires/);
});
test("two workers claim each provider command at most once", async () => {
  setup(); start(); const run=promisify(execFile);
  const results=await Promise.all([1,2].map(() => run("docker",["exec",container,"psql","-X","-qAt","-U","postgres","-d",dbName,"-c","select coalesce(json_agg(c),'[]') from public.portive_claim_parallel_commands(12) c"])));
  const ids=results.flatMap((result) => JSON.parse(result.stdout).map((c: { id: string }) => c.id)); assert.equal(new Set(ids).size,ids.length); assert.equal(ids.length,5);
});
test("all four records remain separately visible in snapshot/history metadata", () => {
  setup(); const s=start(); const snapshot=JSON.parse(sql(`select public.portive_parallel_snapshot('${s}')`));
  assert.equal(snapshot.attempts.length,4); assert.equal(snapshot.metrics.human_connections,0); assert.equal(snapshot.metrics.total_dials,0);
});
test("anonymous access and a different browser cannot dispatch", () => {
  setup(); const s=start();
  assert.throws(() => sql(`select public.portive_parallel_command('${s}','22222222-2222-4222-8222-222222222222','resume',true)`),/another browser/);
  assert.throws(() => sql(`set role anon; select public.portive_parallel_snapshot('${s}')`),/permission denied/);
});

test("out-of-order operator answer is accepted, but a terminal operator cannot resurrect", () => {
  setup(); const s=invoke("start").id;
  event(s,null,"operator","call.answered",{call_control_id:"operator"}); invoke("operator_ready",s,{callControlId:"operator"});
  assert.equal(sql(`select operator_leg_state from public.dial_sessions where id='${s}'`),"ready");
  event(s,null,"operator","call.hangup"); event(s,null,"operator","call.answered",{call_control_id:"operator"});
  assert.equal(sql(`select operator_leg_state from public.dial_sessions where id='${s}'`),"disconnected");
});
test("unknown media acknowledgements cannot unlock dialing", () => {
  setup(); const s=invoke("start").id;
  assert.throws(()=>invoke("operator_ready",s,{callControlId:"wrong"}),/not been verified/);
  assert.equal(sql("select count(*) from public.call_attempts"),"0");
});
test("manual batch continuation waits after a saved disposition until Continue", () => {
  setup(); const s=start({autoContinue:false}), a=attempts(s);
  sql("insert into public.leads(id,lead_list_id,phone_number,business_name) values('fifth','list','+12125550105','Fifth')");
  answer(s,a[0].id); event(s,a[0].id,"lead","call.bridged");
  for(const item of a) event(s,item.id,"lead","call.hangup");
  sql(`select public.portive_save_disposition('${a[0].id}','${a[0].lead_id}','gatekeeper','Notes',null,null)`);
  invoke("tick",s); assert.equal(attempts(s).length,4);
  invoke("continue",s); invoke("tick",s); assert.equal(attempts(s).length,5);
});
test("configured batch delay and bounded operator media lease are enforced server-side", () => {
  setup(); const s=start({batchDelaySeconds:10}), a=attempts(s);
  for(const item of a) event(s,item.id,"lead","call.hangup",{hangup_cause:"timeout"});
  invoke("tick",s); assert.equal(sql(`select parallel_batch from public.dial_sessions where id='${s}'`),"1");
  sql(`update public.dial_sessions set next_batch_at=now(),started_at=now()-interval '29 minutes' where id='${s}'`);
  assert.equal(invoke("tick",s).status,"stopping");
});
test("duplicate human detection never converts the primary winner into a collision", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id);
  event(s,a[0].id,"lead","call.machine.premium.detection.ended",{result:"human_business"});
  assert.equal(sql(`select overflow_state is null from public.call_attempts where id='${a[0].id}'`),"t");
});

test("a delayed machine result cannot hang up a human already claiming the operator", () => {
  setup(); const s=start(),a=attempts(s); answer(s,a[0].id);
  event(s,a[0].id,"lead","call.machine.premium.detection.ended",{result:"machine"});
  assert.equal(sql(`select outcome is null from public.call_attempts where id='${a[0].id}'`),"t");
  assert.equal(sql(`select count(*) from public.dial_commands where action='hangup' and attempt_id='${a[0].id}'`),"0");
});

test("answered collision hangup does not interrupt the primary conversation", () => {
  setup(); const s=start(),a=attempts(s);
  event(s,a[1].id,"lead","call.answered",{call_control_id:a[1].id});
  answer(s,a[0].id);event(s,a[0].id,"lead","call.bridged");
  event(s,a[1].id,"lead","call.hangup",{hangup_cause:"user_busy"});invoke("tick",s);
  assert.equal(sql(`select overflow_state is null from public.call_attempts where id='${a[0].id}'`),"t");
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),"running");
});
test("Realtime failure pauses the scheduler without interrupting healthy operator audio", () => {
  setup();const s=start(),a=attempts(s);answer(s,a[0].id);event(s,a[0].id,"lead","call.bridged");
  invoke("heartbeat",s,{transportReady:false});invoke("tick",s);
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),"paused");
  assert.equal(sql(`select overflow_state is null from public.call_attempts where id='${a[0].id}'`),"t");
});

function cloudflareWork(s: string) {return JSON.parse(sql(`select public.portive_orchestration_work('${s}')`));}
function cloudflareComplete(command: {id:string}, ok=true, status=0, control="fixture-control") {
  sql(`select public.portive_orchestration_complete('${command.id}',${ok},'{"data":{"call_control_id":"${control}"}}',${status})`);
}
function cloudflareReserved() {
  setup();sql("select public.portive_set_orchestration_backend('cloudflare',true);select public.portive_orchestration_prepare('cloudflare')");
  const s=invoke('start').id,op=cloudflareWork(s).commands;
  assert.equal(op.length,1);assert.equal(op[0].action,'dial_operator');cloudflareComplete(op[0],true,0,'operator');
  event(s,null,'operator','call.answered',{call_control_id:'operator'});invoke('operator_ready',s,{callControlId:'operator'});
  const work=cloudflareWork(s);assert.equal(work.commands.length,4);
  return { session: s as string, work };
}
function cloudflareStart() {
  const { session: s, work } = cloudflareReserved();
  for(const c of work.commands) cloudflareComplete(c,true,0,c.attempt_id);
  return s as string;
}
function cloudflareEvent(s:string,a:string,type:string,payload:Record<string,unknown>,eventId=crypto.randomUUID()) {
  const ev={data:{id:eventId,event_type:type,occurred_at:new Date().toISOString(),payload}};
  return JSON.parse(sql(`select public.portive_cloudflare_event('${s}','${a}','lead','${JSON.stringify(ev)}','${JSON.stringify(ev)}','{"cloudflareArrival":1}')`));
}
test('Cloudflare owns each session and fences Node claims and unsafe backend switches',()=>{
  const s=cloudflareStart();assert.equal(sql(`select orchestration_backend from public.dial_sessions where id='${s}'`),'cloudflare');
  assert.throws(()=>sql('select public.portive_claim_parallel_commands(4)'),/backend mismatch/);
  assert.throws(()=>sql("select public.portive_set_orchestration_backend('node',false)"),/Finish sessions/);
  assert.equal(cloudflareWork(s).commands.length,0);
});
test('Cloudflare event RPC claims winner and returns immediate bridge plus ringing cancellations',()=>{
  const s=cloudflareStart(),a=attempts(s);
  cloudflareEvent(s,a[0].id,'call.answered',{call_control_id:a[0].id});
  const work=cloudflareEvent(s,a[0].id,'call.machine.premium.detection.ended',{result:'human_business'});
  assert.equal(work.session.active_call_id,a[0].id);assert.equal(work.commands.filter((c:{action:string})=>c.action==='bridge').length,1);
  assert.equal(sql(`select count(*) from public.call_attempts where dial_session_id='${s}' and technical_state='canceled_after_winner'`),'3');
  assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='dial_lead'`),'4');
});
test('Cloudflare duplicate and delayed events retain one operator bridge and distinct collision',()=>{
  const s=cloudflareStart(),a=attempts(s);
  for(const item of a.slice(0,2)) cloudflareEvent(s,item.id,'call.answered',{call_control_id:item.id});
  const key=crypto.randomUUID();cloudflareEvent(s,a[0].id,'call.machine.premium.detection.ended',{result:'human_business'},key);
  cloudflareEvent(s,a[0].id,'call.machine.premium.detection.ended',{result:'human_business'},key);
  cloudflareEvent(s,a[1].id,'call.machine.premium.detection.ended',{result:'human_business'});
  cloudflareEvent(s,a[0].id,'call.machine.premium.detection.ended',{result:'machine'});
  assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='bridge'`),'1');
  assert.equal(sql(`select technical_state from public.call_attempts where id='${a[1].id}'`),'answer_collision');
  assert.equal(sql(`select active_call_id from public.dial_sessions where id='${s}'`),a[0].id);
});
test('Cloudflare stale command acknowledgement is uncertain and cannot be redialed after restart',()=>{
  const s=cloudflareStart();sql(`update public.dial_commands set state='executing',claimed_at=now()-interval '61 seconds' where session_id='${s}' and action='dial_lead'`);
  const work=cloudflareWork(s);assert.equal(work.session.status,'unsafe');
  assert.equal(work.commands.filter((c:{action:string})=>c.action==='dial_lead').length,0);
  assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='dial_lead' and state='uncertain'`),'4');
});
test('Cloudflare bridge rejection pauses and queues provider cleanup without a replacement dial',()=>{
  const s=cloudflareStart(),a=attempts(s);cloudflareEvent(s,a[0].id,'call.answered',{call_control_id:a[0].id});
  const work=cloudflareEvent(s,a[0].id,'call.machine.premium.detection.ended',{result:'human_business'}),bridge=work.commands.find((c:{action:string})=>c.action==='bridge');
  cloudflareComplete(bridge,false,422);assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),'unsafe');
  assert.equal(sql(`select count(*) from public.dial_commands where command_key='${a[0].id}:bridge-failure' and action='hangup'`),'1');
});
test('Cloudflare missed terminal webhook reconciliation retains reservations and disposition safety',()=>{
  const s=cloudflareStart(),a=attempts(s);answer(s,a[0].id);event(s,a[0].id,'lead','call.bridged');
  sql(`select public.portive_orchestration_reconcile('${s}','${a[0].id}',false,'${a[0].id}')`);
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),'unsafe');
  assert.equal(sql(`select ended_at is not null from public.call_attempts where id='${a[0].id}'`),'t');
  assert.equal(sql(`select disposition_saved_at is null from public.call_attempts where id='${a[0].id}'`),'t');
  assert.throws(()=>sql(`select public.portive_orchestration_reconcile('${s}','${a[1].id}',false,'wrong-control')`),/identity mismatch/);
});
test('Cloudflare alarms only receive future relevant deadlines',()=>{
  const s=cloudflareStart();const work=cloudflareWork(s);assert(work.deadlines.length>0);
  for(const deadline of work.deadlines)assert(Date.parse(deadline)>Date.now()-1000);
});
test('Cloudflare migration reruns safely after its own readiness replacements',()=>{
  setup();sql(readFileSync('supabase/migrations/202611160002_default_calling_policy.sql','utf8'));
  assert.doesNotThrow(()=>sql("select public.portive_orchestration_guard('node')"));
  assert.throws(()=>sql("set role anon; select public.portive_orchestration_prepare('cloudflare')"),/permission denied/);
});
test('Cloudflare bounded operator recovery cleans a parked leg without changing winner rules',()=>{
 const s=cloudflareStart();sql(`update public.dial_sessions set started_at=now()-interval '31 minutes',parallel_options=jsonb_set(parallel_options,'{deadlineAt}',to_jsonb((now()-interval '30 seconds')::text)) where id='${s}'`);
 const work=cloudflareWork(s);assert.equal(work.operator_reconcile,true);
 sql(`select public.portive_orchestration_operator('${s}','operator',true)`);
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='hangup_operator'`),'1');
 sql(`select public.portive_orchestration_operator('${s}','operator',false)`);
 assert.equal(sql(`select operator_leg_state from public.dial_sessions where id='${s}'`),'disconnected');
});
test('Cloudflare zero-worker enablement cannot authorize dialing',()=>{
 setup();sql("select public.portive_set_orchestration_backend('cloudflare',false)");
 assert.throws(()=>sql("select public.portive_orchestration_prepare('cloudflare')"),/disabled/);
});
test('Cloudflare uncertain bridge acknowledgement preserves the possibly connected winner',()=>{
 const s=cloudflareStart(),a=attempts(s);cloudflareEvent(s,a[0].id,'call.answered',{call_control_id:a[0].id});
 const work=cloudflareEvent(s,a[0].id,'call.machine.premium.detection.ended',{result:'human_business'}),bridge=work.commands.find((c:{action:string})=>c.action==='bridge');
 cloudflareComplete(bridge,false,0);
 assert.equal(sql(`select count(*) from public.dial_commands where attempt_id='${a[0].id}' and action='hangup'`),'0');
 assert.equal(sql(`select active_call_id from public.dial_sessions where id='${s}'`),a[0].id);
});
test('Cloudflare final authorization cancels a stale unsent prospect command after winner selection',()=>{
 const s=cloudflareStart(),a=attempts(s);answer(s,a[0].id);
 const c=sql(`select id from public.dial_commands where attempt_id='${a[1].id}' and action='dial_lead'`);
 sql(`update public.dial_commands set state='executing' where id='${c}'`);
 assert.equal(JSON.parse(sql(`select public.portive_orchestration_authorize('${c}')`)).allowed,false);
});
test('Cloudflare operator cleanup cannot bypass an ended winner disposition',()=>{
 const s=cloudflareStart(),a=attempts(s);answer(s,a[0].id);event(s,a[0].id,'lead','call.bridged');
 for(const item of a)event(s,item.id,'lead','call.hangup');
 sql(`select public.portive_orchestration_operator('${s}','operator',false)`);
 assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),'unsafe');
 assert.equal(sql(`select active_call_id from public.dial_sessions where id='${s}'`),a[0].id);
 assert.throws(()=>sql("select public.portive_set_orchestration_backend('node',false)"),/Finish sessions/);
});
test('Cloudflare late answered cancellation after rollback stays audited without a competing executor',()=>{
 const s=cloudflareStart(),a=attempts(s);sql(`update public.call_attempts set ended_at=now(),status='canceled',technical_state='canceled_after_winner' where dial_session_id='${s}';update public.dial_commands set state='confirmed' where session_id='${s}';update public.dial_sessions set status='stopped',operator_terminal_at=now() where id='${s}';select public.portive_set_orchestration_backend('node',false)`);
 const key=crypto.randomUUID(),ev={data:{id:key,event_type:'call.answered',occurred_at:new Date().toISOString(),payload:{}}};
 sql(`insert into public.workstation_telnyx_webhook_events(event_id,event_type,payload_json,signature_verified) values('${key}','call.answered','${JSON.stringify(ev)}',true);select public.portive_orchestration_terminal_event('${s}','${a[0].id}','lead','${JSON.stringify(ev)}')`);
 assert.equal(sql(`select technical_state from public.call_attempts where id='${a[0].id}'`),'answer_collision');
 assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),'stopped');
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and state<>'confirmed'`),'0');
});

function authorize(command: { id: string }) {
  return JSON.parse(sql(`select public.portive_orchestration_authorize('${command.id}')`));
}
function zoneAtHour(hour: number) {
  return sql(`select name from pg_timezone_names where name like 'Etc/GMT%' and extract(hour from clock_timestamp() at time zone name)=${hour} limit 1`);
}
test('final DNC denial closes only the unsent reservation, keeps duplicate protection and cannot be reclaimed',()=>{
  const {session,work}=cloudflareReserved(), command=work.commands[0];
  assert.equal(authorize(command).allowed,true);
  sql(`insert into public.dial_suppressions(phone_number,reason) values('${command.parameters.to}','Fixture DNC after reservation')`);
  assert.deepEqual(authorize(command),{allowed:false,reason:'destination_suppressed'});
  assert.equal(sql(`select state||':'||(completed_at is not null) from public.dial_commands where id='${command.id}'`),'canceled:true');
  assert.equal(sql(`select status||':'||technical_state||':'||(ended_at is not null) from public.call_attempts where id='${command.attempt_id}'`),'canceled:canceled_before_answer:true');
  assert.equal(sql(`select count(*) from public.dial_session_targets where session_id='${session}' and attempt_id='${command.attempt_id}'`),'1');
  assert.equal(authorize(command).allowed,false);
  cloudflareComplete(command,true,0,'must-not-be-written');
  assert.equal(sql(`select telnyx_call_control_id is null from public.call_attempts where id='${command.attempt_id}'`),'t');
  assert(!cloudflareWork(session).commands.some((c:{id:string})=>c.id===command.id));
  assert.equal(sql(`select count(*) from public.dial_audit_events where attempt_id='${command.attempt_id}' and event_type='dispatch_denied'`),'1');
  assert.equal(authorize(work.commands[1]).allowed,true);
});
test('current per-lead DNC and suppression flags block an already queued prospect',()=>{
  for(const flag of ['doNotCall','suppressed']) {
    const {work}=cloudflareReserved(),command=work.commands[0];
    sql(`update public.leads set custom_fields_json=jsonb_build_object('${flag}',true) where id='${command.attempt.lead_id}'`);
    assert.deepEqual(authorize(command),{allowed:false,reason:'destination_suppressed'});
  }
});
test('final calling-hour gate allows 8 through 20, denies 7 and 21 and honors lead overrides',()=>{
  for(const hour of [8,20,7,21]) {
    const {work}=cloudflareReserved(),command=work.commands[0];
    sql(`update public.leads set custom_fields_json=jsonb_build_object('timeZone','${zoneAtHour(hour)}') where id='${command.attempt.lead_id}'`);
    const result=authorize(command);
    assert.equal(result.allowed,hour>=8&&hour<21,`local hour ${hour}`);
    if(!result.allowed) {
      assert.equal(result.reason,'outside_calling_window');
      assert.equal(sql(`select state from public.dial_commands where id='${command.id}'`),'canceled');
      assert.equal(sql(`select ended_at is not null from public.call_attempts where id='${command.attempt_id}'`),'t');
    }
  }
});
test('Parallel blank timezone falls back at reservation and final authorization; invalid timezone fails closed',()=>{
  setup();sql(`update public.leads set custom_fields_json='{"timeZone":""}'`);
  assert.equal(attempts(start()).length,4);
  const {session,work}=cloudflareReserved(),command=work.commands[0];
  sql(`update public.leads set custom_fields_json='{"timeZone":""}' where id='${command.attempt.lead_id}'`);
  assert.equal(authorize(command).allowed,true);
  sql(`update public.dial_sessions set time_zone='${zoneAtHour(3)}' where id='${session}'`);
  assert.equal(authorize(command).reason,'outside_calling_window');
  const next=work.commands[1];
  sql(`update public.leads set custom_fields_json='{"timeZone":"Invalid/Zone"}' where id='${next.attempt.lead_id}'`);
  assert.equal(authorize(next).reason,'invalid_timezone');
});
test('denial never invents a terminal event for an attempt with provider identity',()=>{
  const {session,work}=cloudflareReserved(),command=work.commands[0];
  sql(`update public.call_attempts set telnyx_call_control_id='possibly-sent' where id='${command.attempt_id}';insert into public.dial_suppressions(phone_number,reason) values('${command.parameters.to}','DNC')`);
  assert.equal(authorize(command).allowed,false);
  assert.equal(sql(`select state from public.dial_commands where id='${command.id}'`),'uncertain');
  assert.equal(sql(`select ended_at is null from public.call_attempts where id='${command.attempt_id}'`),'t');
  assert.equal(sql(`select status from public.dial_sessions where id='${session}'`),'unsafe');
});
test('startup heartbeats cannot substitute for verified operator media, and media loss blocks queued dials',()=>{
  setup();const s=invoke('start').id;
  event(s,null,'operator','call.answered',{call_control_id:'operator'});
  invoke('heartbeat',s);invoke('tick',s);
  assert.equal(sql(`select browser_media_ready from public.dial_sessions where id='${s}'`),'f');
  assert.equal(attempts(s),null);
  const {session,work}=cloudflareReserved();
  sql(`select public.portive_parallel_command('${session}','${controller}','heartbeat',false)`);
  assert.equal(authorize(work.commands[0]).allowed,false);
  assert.equal(sql(`select state from public.dial_commands where id='${work.commands[0].id}'`),'canceled');
});
test('safety migration reruns without losing reservations or server-only grants',()=>{
  const {session}=cloudflareReserved();
  sql(readFileSync('supabase/migrations/202611160002_default_calling_policy.sql','utf8'));
  assert.equal(sql(`select count(*) from public.dial_session_targets where session_id='${session}'`),'4');
  assert.throws(()=>sql('set role anon;select public.portive_orchestration_authorize(gen_random_uuid())'),/permission denied/);
  assert.equal(sql("select public.portive_orchestrator_ready(3)"),'t');
});

test('ordinary positive heartbeats preserve false readiness until explicit acknowledgement',()=>{
  setup();const s=invoke('start').id;
  event(s,null,'operator','call.answered',{call_control_id:'operator'});
  for(let i=0;i<3;i++) invoke('heartbeat',s);
  assert.equal(sql(`select browser_media_ready from public.dial_sessions where id='${s}'`),'f');
  assert.equal(invoke('tick',s).status,'running'); assert.equal(attempts(s),null);
  invoke('operator_ready',s,{callControlId:'operator'});
  assert.equal(invoke('tick',s).status,'running'); assert.equal(attempts(s).length,4);
});
test('media loss remains latched across stale positive heartbeats and explicit acknowledgements',()=>{
  const {session,work}=cloudflareReserved();
  sql(`select public.portive_parallel_command('${session}','${controller}','heartbeat',false)`);
  for(let i=0;i<3;i++) { invoke('heartbeat',session);invoke('operator_ready',session,{callControlId:'operator'}); }
  const s=invoke('tick',session);assert.equal(s.status,'unsafe');assert.equal(s.browser_media_ready,false);
  for(const c of work.commands) assert.equal(authorize(c).allowed,false);
  assert.equal(sql(`select count(*) from public.dial_session_targets where session_id='${session}'`),'4');
  assert.equal(sql(`select count(*) from public.call_attempts where dial_session_id='${session}'`),'4');
});
test('reordered and duplicate media requests cannot prevent active winner cleanup, including paused sessions',()=>{
  for(const paused of [false,true]) {
    const s=cloudflareStart(),a=attempts(s);answer(s,a[0].id);event(s,a[0].id,'lead','call.bridged');
    if(paused) invoke('pause',s);
    sql(`select public.portive_parallel_command('${s}','${controller}','heartbeat',false)`);
    for(let i=0;i<2;i++) {invoke('heartbeat',s);invoke('operator_ready',s,{callControlId:'operator'});}
    cloudflareWork(s);cloudflareWork(s);
    assert.equal(sql(`select status||':'||browser_media_ready from public.dial_sessions where id='${s}'`),'unsafe:false');
    assert.equal(sql(`select count(*) from public.dial_commands where attempt_id='${a[0].id}' and action='hangup'`),'1');
    assert.equal(sql(`select ended_at is null from public.call_attempts where id='${a[0].id}'`),'t');
    assert.throws(()=>invoke('resume',s),/paused session/);
  }
});
test('healthy transport pause can recover through verified media and explicit resume',()=>{
  const s=cloudflareStart();invoke('heartbeat',s,{transportReady:false});
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),'paused');
  invoke('operator_ready',s,{callControlId:'operator'});
  assert.equal(invoke('resume',s).status,'running');
  assert.equal(sql(`select count(*) from public.call_attempts where dial_session_id='${s}'`),'4');
});

test('Chromium media -> real SQL -> Worker executor preserves startup, DNC denial and reordered winner cleanup', {timeout:60_000}, async()=>{
  // Load the actual Worker adapter without importing Cloudflare platform types
  // into the application's TypeScript program. All provider I/O is replaced.
  const load=createRequire(`${process.cwd()}/package.json`);
  const {executeCommand}=load(`${process.cwd()}/cloudflare/portive-dialer/src/executor.ts`) as {
    executeCommand:(command:unknown,env:unknown,db:unknown,provider:unknown)=>Promise<void>;
  };
  const {fingerprint}=load(`${process.cwd()}/cloudflare/portive-dialer/src/types.ts`) as {
    fingerprint:(env:Record<string,string>)=>Promise<string>;
  };
  const env={DIALER_PARALLEL_ENABLED:'true',TELNYX_PARALLEL_CONNECTION_ID:'fixture-app',
    TELNYX_TELEPHONY_CREDENTIAL_ID:'fixture-credential',TELNYX_FROM_NUMBER:'+12125550100',
    VERCEL_VOICE_WEBHOOK_URL:'https://fixture.invalid/api/webhooks/telnyx/voice'};
  const fp=await fingerprint(env);
  setup();sql(`select public.portive_set_orchestration_backend('cloudflare',true);select public.portive_orchestration_prepare('cloudflare');update public.dialer_provider_verifications set config_fingerprint='${fp}' where id='${verificationId}'`);
  const s=invoke('start',null,{fingerprint:fp}).id;
  const operator=cloudflareWork(s).commands[0];cloudflareComplete(operator,true,0,'operator');
  event(s,null,'operator','call.answered',{call_control_id:'operator'});
  const requests:Array<{path:string;body:Record<string,unknown>}>=[];
  const literal=(v:unknown):string=>v===null?'null':typeof v==='boolean'||typeof v==='number'?String(v):
    typeof v==='string'?`'${v.replaceAll("'","''")}'`:`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`;
  const db={async rpc(name:string,args:Record<string,unknown>) {
    assert(['portive_orchestration_authorize','portive_orchestration_complete','portive_answer_collision'].includes(name));
    return JSON.parse(sql(`select public.${name}(${Object.entries(args).map(([k,v])=>`${k}=>${literal(v)}`).join(',')})`)||'null');
  }};
  const provider={async request(path:string,body:Record<string,unknown>) {
    requests.push({path,body});
    if(path==='calls')return {data:{call_control_id:JSON.parse(Buffer.from(String(body.client_state),'base64').toString()).attemptId}};
    return {data:{}};
  },async action(id:string,action:string,body:Record<string,unknown>) {return this.request(`calls/${id}/actions/${action}`,body);}};
  const run=async(commands:unknown[])=>{for(const c of commands)await executeCommand(c,env,db,provider);};
  const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  try {
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    const statuses:string[]=[];
    await page.exposeFunction('ackMedia',(status:string)=>{
      statuses.push(status);
      if(status==='ready')invoke('operator_ready',s,{callControlId:'operator'});
      if(status==='unavailable')sql(`select public.portive_parallel_command('${s}','${controller}','heartbeat',false)`);
    });
    const script=ts.transpileModule(readFileSync('lib/dialer/parallel-media.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    await page.addScriptTag({type:'module',content:script+'\nwindow.watchMedia=watchParallelOperatorMedia;'});
    await page.waitForFunction('Boolean(window.watchMedia)');
    await page.evaluate(`(async()=>{
      const context=new AudioContext();await context.resume();const oscillator=context.createOscillator(),destination=context.createMediaStreamDestination();
      oscillator.connect(destination);oscillator.start();const audio=document.createElement('audio');document.body.append(audio);
      window.acks=[];window.media=window.watchMedia(audio,destination.stream,status=>window.acks.push(window.ackMedia(status)));
      window.mediaFixture={context,oscillator,audio,destination};
    })()`);
    await page.waitForFunction('window.media.ready()');await page.evaluate('Promise.all(window.acks)');
    assert.deepEqual(statuses,['ready']);
    const work=cloudflareWork(s);assert.equal(work.session.status,'running');assert.equal(work.commands.length,4);
    const denied=work.commands[0];
    sql(`insert into public.dial_suppressions(phone_number,reason) values('${denied.parameters.to}','Fixture DNC after queueing')`);
    await run([denied]);assert.equal(requests.length,0);
    assert.equal(sql(`select state from public.dial_commands where id='${denied.id}'`),'canceled');
    await run(work.commands.slice(1));assert.equal(requests.filter(r=>r.path==='calls').length,3);
    const winner=work.commands[1].attempt_id;answer(s,winner);event(s,winner,'lead','call.bridged');
    await run(cloudflareWork(s).commands);
    await page.evaluate('window.mediaFixture.audio.pause()');
    await page.waitForFunction("window.media.status()==='unavailable'");await page.evaluate('Promise.all(window.acks)');
    // Simulate independent stale requests committing after the browser's loss.
    invoke('heartbeat',s);invoke('operator_ready',s,{callControlId:'operator'});invoke('heartbeat',s);
    const cleanup=cloudflareWork(s);assert.equal(cleanup.session.status,'unsafe');assert.equal(cleanup.session.browser_media_ready,false);
    await run(cleanup.commands);await run(cloudflareWork(s).commands);
    assert.equal(requests.filter(r=>r.path===`calls/${winner}/actions/hangup`).length,1);
    const duplicate=crypto.randomUUID();event(s,winner,'lead','call.hangup',{},duplicate);event(s,winner,'lead','call.hangup',{},duplicate);
    invoke('operator_ready',s,{callControlId:'operator'});await run(cloudflareWork(s).commands);
    assert.equal(requests.filter(r=>r.path==='calls').length,3);
    assert.equal(sql(`select count(*) from public.dial_session_targets where session_id='${s}'`),'4');
    assert.equal(sql(`select count(*) from public.dial_audit_events where session_id='${s}' and attempt_id='${winner}' and event_type='call.hangup'`),'1');
    // An actual rejected browser play promise must still fail closed in SQL.
    await page.evaluate('window.media.dispose()');
    setup();sql("select public.portive_set_orchestration_backend('cloudflare',true);select public.portive_orchestration_prepare('cloudflare')");
    const rejectedSession=invoke('start',null,{fingerprint:fp}).id;
    cloudflareComplete(cloudflareWork(rejectedSession).commands[0],true,0,'operator');
    event(rejectedSession,null,'operator','call.answered',{call_control_id:'operator'});
    const rejectedStatuses:string[]=[];
    await page.exposeFunction('ackRejectedMedia',(status:string)=>{
      rejectedStatuses.push(status);
      if(status==='unavailable')sql(`select public.portive_parallel_command('${rejectedSession}','${controller}','heartbeat',false)`);
    });
    await page.evaluate(`(()=>{
      const blocked=document.createElement('audio');blocked.play=()=>Promise.reject(new DOMException('Fixture autoplay rejection','NotAllowedError'));
      window.rejectedAcks=[];window.rejectedMedia=window.watchMedia(blocked,window.mediaFixture.destination.stream,status=>window.rejectedAcks.push(window.ackRejectedMedia(status)));
    })()`);
    await page.waitForFunction("window.rejectedMedia.status()==='unavailable'");await page.evaluate('Promise.all(window.rejectedAcks)');
    assert.deepEqual(rejectedStatuses,['unavailable']);
    invoke('heartbeat',rejectedSession);invoke('operator_ready',rejectedSession,{callControlId:'operator'});
    assert.equal(sql(`select status||':'||browser_media_ready from public.dial_sessions where id='${rejectedSession}'`),'unsafe:false');
    assert.equal(attempts(rejectedSession),null);
    assert.equal(requests.filter(r=>r.path==='calls').length,3);
    await page.evaluate('window.rejectedMedia.dispose()');
    await page.evaluate('window.media.dispose();window.mediaFixture.oscillator.stop();window.mediaFixture.destination.stream.getTracks().forEach(t=>t.stop());window.mediaFixture.context.close()');
  } finally {await browser.close();}
});

test('regular Start creates a real ledger session without a report or grant',()=>{
 setup();sql('delete from public.dialer_provider_verifications');
 const s=start();assert.equal(attempts(s).length,4);
 assert.equal(sql(`select verification_id is null and acceptance_grant_id is null from public.dial_sessions where id='${s}'`),'t');
 assert.equal(sql('select count(*) from public.dialer_provider_verifications'),'0');
});
test('regular Start rejects missing actual provider configuration and an empty list before operator dialing',()=>{
 setup();assert.throws(()=>invoke('start',null,{costProfile:null}),/account tariff/);
 sql('delete from public.leads');assert.throws(()=>invoke('start'),/has no leads/);
 assert.equal(sql('select count(*) from public.dial_commands'),'0');
});
test('federal hours use 08:00 inclusive and 21:00 exclusive across DST',()=>{
 setup();
 const hours=(at:string)=>sql(`select coalesce(public.portive_calling_hours('first','America/New_York','${at}'),'allowed')`);
 assert.equal(hours('2026-11-16T12:59:00Z'),'outside_calling_window');
 assert.equal(hours('2026-11-16T13:00:00Z'),'allowed');
 assert.equal(hours('2026-11-17T01:59:00Z'),'allowed');
 assert.equal(hours('2026-11-17T02:00:00Z'),'outside_calling_window');
 assert.equal(hours('2026-07-15T12:00:00Z'),'allowed');
 assert.equal(hours('2026-07-16T01:00:00Z'),'outside_calling_window');
});
test('stricter state and Sunday rules intersect recipient-local campaign policy',()=>{
 setup();sql(`update public.leads set custom_fields_json='{"callingJurisdiction":"US-FL"}' where id='first'`);
 assert.equal(sql(`select public.portive_calling_hours('first','America/New_York','2026-11-17T01:00:00Z')`),'outside_calling_window');
 sql(`update public.leads set custom_fields_json='{"callingJurisdiction":"US-TX"}' where id='first'`);
 assert.equal(sql(`select public.portive_calling_hours('first','America/Chicago','2026-11-22T17:59:00Z')`),'outside_calling_window');
 assert.equal(sql(`select public.portive_calling_hours('first','America/Chicago','2026-11-22T18:00:00Z') is null`),'t');
});
test('B2B hours require an administratively classified exact business landline',()=>{
 setup();sql(`delete from public.dialer_campaign_calling_policies;insert into public.dialer_campaign_calling_policies(list_id,classification,jurisdictions,start_minute,end_minute,legal_basis,business_numbers) values('list','business_landline',array['US'],0,1440,'Reviewed offline B2B legal scope',array['+12125550101'])`);
 assert.equal(sql(`select public.portive_calling_hours('first','America/New_York','2026-11-16T05:00:00Z') is null`),'t');
 assert.equal(sql(`select public.portive_calling_hours('second','America/New_York','2026-11-16T05:00:00Z')`),'outside_calling_window');
 sql(`delete from public.dialer_campaign_calling_policies;insert into public.dialer_campaign_calling_policies(list_id,jurisdictions,legal_basis) values('list',array['US'],'Offline federal-only fixture jurisdiction');update public.leads set custom_fields_json='{"businessLandline":true,"consent":true}'`);
 assert.equal(sql(`select public.portive_calling_hours('first','America/New_York','2026-11-16T05:00:00Z')`),'outside_calling_window');
});
test('documented hours consent is scoped to number/list/time, revocable, and cannot bypass DNC',()=>{
 setup();sql(`insert into public.dialer_calling_consents values('first','list','+12125550101','2026-11-16T05:00:00Z','2026-11-16T06:00:00Z','actual offline consent record','offline legal exception scope',null)`);
 assert.equal(sql(`select public.portive_calling_hours('first','America/New_York','2026-11-16T05:30:00Z') is null`),'t');
 sql(`update public.dialer_calling_consents set revoked_at=now()`);
 assert.equal(sql(`select public.portive_calling_hours('first','America/New_York','2026-11-16T05:30:00Z')`),'outside_calling_window');
 sql('delete from public.dialer_calling_consents');
 const {work}=cloudflareReserved(),c=work.commands[0];sql(`insert into public.dial_suppressions values('${c.parameters.to}','DNC',now())`);
 assert.equal(authorize(c).reason,'destination_suppressed');
});
test('policy writes, private scheduler and eligibility reads remain unavailable to browser roles',()=>{
 setup();for(const role of ['anon','authenticated']){
 assert.throws(()=>sql(`set role ${role};insert into public.dialer_calling_rules values('ANY',0,1440,null,'fake browser override')`),/permission denied/);
 assert.throws(()=>sql(`set role ${role};select public.portive_parallel_eligibility('list',null,'UTC')`),/permission denied/);
 }
});
test('answered collision explains first, then speak-ended enqueues forced cleanup',()=>{
 setup();const s=start(),a=attempts(s);answer(s,a[0].id);answer(s,a[1].id);
 assert.equal(sql(`select count(*) from public.dial_commands where attempt_id='${a[1].id}' and action='failure_playback'`),'1');
 event(s,a[1].id,'lead','call.speak.ended',{call_control_id:a[1].id});
 assert.equal(sql(`select count(*) from public.dial_commands where attempt_id='${a[1].id}' and action='hangup' and parameters->>'force'='true'`),'1');
});

test('default policy needs no campaign row, infers only structured US address, and enforces its window',()=>{
 setup();sql("delete from public.dialer_campaign_calling_policies;update public.leads set state='Colorado',custom_fields_json='{}'");
 const hours=(at:string)=>sql(`select coalesce(public.portive_calling_hours('first','America/Denver','${at}'),'allowed')`);
 assert.equal(hours('2026-11-16T14:59:00Z'),'outside_calling_window');
 assert.equal(hours('2026-11-16T15:00:00Z'),'allowed');
 assert.equal(hours('2026-11-17T03:59:00Z'),'allowed');
 assert.equal(hours('2026-11-17T04:00:00Z'),'outside_calling_window');
 assert.equal(hours('2026-07-15T15:00:00Z'),'allowed');
 assert.equal(hours('2026-11-22T19:00:00Z'),'allowed');
 assert.equal(hours('2026-11-26T19:00:00Z'),'outside_default_calling_days');
 assert.equal(hours('2026-07-03T18:00:00Z'),'outside_default_calling_days');
 assert.equal(sql("select count(*) from public.dialer_campaign_calling_policies"),'0');
});
test('no-policy regular Start reserves four actual ledger prospects after media acknowledgement',t=>{
 setup();sql(`delete from public.dialer_campaign_calling_policies;update public.leads set state=null,custom_fields_json='{"countryCode":"US"}'`);
 const reason=sql(`select coalesce(public.portive_calling_hours('first','${zone}'),'')`);
 if(reason==='outside_default_calling_days'){t.skip('Default is correctly closed today; fixed-date policy cases run separately');return;}
 const s=start();assert.equal(attempts(s).length,4);
 assert.equal(sql('select count(*) from public.dialer_campaign_calling_policies'),'0');
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='dial_lead'`),'4');
});
test('missing optional policy never implies business-line status, consent or inferred geography from list labels',()=>{
 setup();sql(`delete from public.dialer_campaign_calling_policies;update public.leads set state=null,custom_fields_json='{"countryCode":"US","businessLandline":true,"consent":true}'`);
 assert.equal(sql("select public.portive_calling_hours('first','America/Denver','2026-11-16T10:00:00Z')"),'outside_calling_window');
 sql("update public.leads set custom_fields_json='{}';update public.lead_lists set name='Colorado businesses' where id='list'");
 assert.equal(sql("select public.portive_calling_hours('first','America/Denver','2026-11-16T19:00:00Z')"),'destination_country_unknown');
 sql(`update public.leads set state='Colorado',custom_fields_json='{"countryCode":"CA"}'`);
 assert.equal(sql("select public.portive_calling_hours('first','America/Denver','2026-11-16T19:00:00Z')"),'unsupported_destination_country');
});
test('automatic address state restrictions intersect optional wider campaigns and documented exceptions remain revocable',()=>{
 setup();sql("update public.leads set state='Pennsylvania'");
 assert.equal(sql("select public.portive_calling_hours('first','America/New_York','2026-11-22T19:00:00Z')"),'outside_jurisdiction_calling_days');
 sql(`insert into public.dialer_calling_consents values('first','list','+12125550101','2026-11-22T19:00:00Z','2026-11-22T20:00:00Z','offline invitation record','offline lawful exception scope',null)`);
 assert.equal(sql("select public.portive_calling_hours('first','America/New_York','2026-11-22T19:30:00Z') is null"),'t');
 sql('update public.dialer_calling_consents set revoked_at=now()');
 assert.equal(sql("select public.portive_calling_hours('first','America/New_York','2026-11-22T19:30:00Z')"),'outside_jurisdiction_calling_days');
});
test('fallback is rechecked immediately before provider I/O, preserving late DNC and closed-window cancellation',()=>{
 const {session,work}=cloudflareReserved(),c=work.commands[0];
 sql(`delete from public.dialer_campaign_calling_policies;update public.leads set state='Colorado',custom_fields_json=jsonb_build_object('timeZone','${zoneAtHour(22)}') where id='${c.attempt.lead_id}'`);
 assert.equal(authorize(c).reason,'outside_calling_window');
 assert.equal(sql(`select state from public.dial_commands where id='${c.id}'`),'canceled');
 assert.equal(sql(`select count(*) from public.dial_session_targets where session_id='${session}'`),'4');
});

test('Colorado address corrects the session timezone default, explicit recipient timezone wins, and null time fails closed',()=>{
 setup();sql("delete from public.dialer_campaign_calling_policies;update public.leads set state='Colorado'");
 assert.equal(sql("select public.portive_calling_hours('first','America/New_York','2026-11-16T13:00:00Z')"),'outside_calling_window');
 assert.equal(sql("select public.portive_calling_hours('first','America/New_York','2026-11-17T03:30:00Z') is null"),'t');
 sql(`update public.leads set custom_fields_json='{"timeZone":"America/New_York"}'`);
 assert.equal(sql("select public.portive_calling_hours('first','America/Denver','2026-11-16T13:00:00Z') is null"),'t');
 assert.equal(sql("select public.portive_calling_hours('first','America/Denver',null)"),'invalid_calling_time');
});

test('SQL and application agree on independently funded operator and all four failure caps',()=>{
 setup();const s=start();
 assert.equal(sql(`select reserved_cost_cents from public.dial_sessions where id='${s}'`),'30');
 assert.equal(sql(`select count(*)||':'||sum(cap_cents) from public.dialer_cost_holds where session_id='${s}'`),'5:30');
 for(const seconds of [60,120,300]){
  const o={...options,maxCallSeconds:seconds,sessionSeconds:seconds+75,ringTimeout:15};
  const expected=seconds===60?14:seconds===120?19:29;
  assert.equal(Number(sql(`select public.portive_leg_cap('${JSON.stringify(o)}','operator')+4*public.portive_leg_cap('${JSON.stringify(o)}','prospect')`)),expected);
 }
});
test('incomplete billing and terminal events do not release funded loser exposure',()=>{
 setup();const s=start(),a=attempts(s)[0];
 event(s,a.id,'lead','call.initiated',{call_control_id:a.id,call_leg_id:'billing-leg'});
 event(s,a.id,'lead','call.hangup');
 const record={id:'invoice-record-1',product:'sip-trunking',callLegId:'billing-leg',currency:'USD',costMicros:5000};
 sql(`select public.portive_reconcile_cost('${a.id}','${JSON.stringify([record])}')`);
 assert.equal(sql(`select state||':'||cap_cents||':'||billed_micros from public.dialer_cost_holds where id='${a.id}'`),'held:6:5000');
 assert.throws(()=>sql(`select public.portive_reconcile_cost('${a.id}','[]',true,'complete invoice reference')`),/settled commands/);
 assert.throws(()=>sql(`select public.portive_reconcile_cost('${a.id}','${JSON.stringify([{...record,id:'foreign',callLegId:'wrong-leg'}])}')`),/Invalid provider billing/);
 sql(`update public.dial_commands set state='confirmed' where session_id='${s}';select public.portive_reconcile_cost('${a.id}','[]',true,'actual complete invoice reference')`);
 assert.equal(sql(`select state||':'||billed_micros from public.dialer_cost_holds where id='${a.id}'`),'reconciled:5000');
 assert.equal(sql(`select reserved_cost_cents from public.dial_sessions where id='${s}'`),'25');
 sql(`select public.portive_reconcile_cost('${a.id}','${JSON.stringify([record])}',true,'actual complete invoice reference')`);
 assert.equal(sql(`select count(*) from public.dialer_billing_records where hold_id='${a.id}'`),'1');
});
test('session hard deadline stops dispatch and forces all already answered legs to end',()=>{
 setup();const s=start(),a=attempts(s)[0];answer(s,a.id);
 sql(`update public.dial_sessions set parallel_options=jsonb_set(parallel_options,'{deadlineAt}',to_jsonb((now()-interval '1 second')::text)) where id='${s}'`);
 invoke('tick',s);
 assert.equal(sql(`select browser_media_ready from public.dial_sessions where id='${s}'`),'f');
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s}' and action='hangup' and parameters->>'force'='true'`),'4');
 assert.equal(sql(`select count(*) from public.dialer_cost_holds where session_id='${s}' and state='held'`),'5');
});
test('subsequent batches stop atomically at the maximum without releasing incomplete first-batch bills',()=>{
 setup();const s=start({maxSpendCents:30});
 sql("insert into public.leads(id,lead_list_id,phone_number,business_name) values('fifth','list','+12125550105','Fifth')");
 for(const a of attempts(s))event(s,a.id,'lead','call.hangup',{hangup_cause:'timeout'});
 invoke('tick',s);assert.equal(attempts(s).length,4);
 assert.equal(sql(`select reserved_cost_cents from public.dial_sessions where id='${s}'`),'30');
});
test('a proven unsent final denial releases only that hold and retains duplicate protection',()=>{
 const {session,work}=cloudflareReserved(),c=work.commands[0];
 sql(`update public.leads set custom_fields_json='{"doNotCall":"true"}' where id='${c.attempt.lead_id}'`);assert.equal(authorize(c).allowed,false);
 cloudflareWork(session);
 assert.equal(sql(`select state||':'||cap_cents from public.dialer_cost_holds where id='${c.attempt_id}'`),'canceled:0');
 assert.equal(sql(`select count(*) from public.dial_session_targets where session_id='${session}'`),'4');
});
test('next allowed Colorado window uses the actual Denver clock and honors suppression',()=>{
 setup();sql("delete from public.dialer_campaign_calling_policies;update public.leads set state='Colorado'");
 assert.equal(sql("select public.portive_next_calling_time('first','America/New_York','2026-11-16T13:00:00Z')"),'2026-11-16 15:00:00+00');
 assert.equal(sql("select public.portive_next_calling_time('first','America/New_York','2026-07-15T12:00:00Z')"),'2026-07-15 14:00:00+00');
 sql("update public.leads set custom_fields_json='{"+'"doNotCall":true'+"}'");
 assert.equal(sql("select public.portive_next_calling_window('list','America/Denver')->>'at' is null"),'t');
});

test('provisional migration requires spending approval and keeps stale pricing dispatchable within funded caps',()=>{
 setup();sql(readFileSync('supabase/migrations/202611160004_provisional_parallel_pricing.sql','utf8'));
 costProfileSchema.parse(JSON.parse(sql("select value_json from public.app_settings where key='dialer_cost_profile'")));
 const p={...costProfile,pricingMode:'owner-provisional',reviewedAt:'2020-01-01T00:00:00Z',expiresAt:'2020-01-08T00:00:00Z'};
 sql(`update public.app_settings set value_json='${JSON.stringify(p)}' where key='dialer_cost_profile'`);
 assert.throws(()=>invoke('start',null,{costProfile:p}),/Accept the bounded/);
 const s=start({costProfile:p,spendingApproved:true});assert.equal(attempts(s).length,4);
 assert.equal(invoke('tick',s).status,'running');
 assert.equal(sql(`select reserved_cost_cents from public.dial_sessions where id='${s}'`),'30');
 assert.throws(()=>sql(`set role anon; select public.portive_validate_cost('{}',4)`),/permission denied/);
});

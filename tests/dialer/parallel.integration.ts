import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";

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
    delete from public.dial_suppressions;
    insert into public.app_settings(key,value_json) values('dialer_watchdog_heartbeat',jsonb_build_object('at',now()))
      on conflict(key) do update set value_json=excluded.value_json;
    insert into public.lead_lists(id,name,source_file_name) values('list','Test list','test.csv');
    insert into public.leads(id,lead_list_id,phone_number,business_name,created_at) values
      ('first','list','+12125550101','First',now()),('second','list','+12125550102','Second',now()-interval '1 day'),
      ('third','list','+12125550103','Third',now()-interval '2 days');`);
}

const verificationId = "33333333-3333-4333-8333-333333333333";
const options = { verificationId, fingerprint: "controlled-fixture", operatorSipUri: "sip:test@sip.telnyx.com", ringTimeout: 30,
  maxCallSeconds: 300, batchDelaySeconds: 0, attemptLimit: 100, maxSpendCents: 5000, autoContinue: true, autoRefill: false };
function invoke(action: string, session: string | null = null, extra: Record<string, unknown> = {}) {
  return JSON.parse(sql(`select public.portive_parallel_command(${session ? `'${session}'` : "null"},'${controller}','${action}',true,'list',null,4,'${zone}',true,'${JSON.stringify({ ...options,...extra })}')`));
}
function setup() {
  fixture(); sql(`insert into public.leads(id,lead_list_id,phone_number,business_name,created_at) values('fourth','list','+12125550104','Fourth',now()-interval '3 days');
    insert into public.dialer_provider_verifications(id,config_fingerprint,connection_id,profile_id,account_channels,overflow_slots,rate_ceiling_cents,evidence,expires_at)
    values('${verificationId}','controlled-fixture','connection','profile',9,3,1,'{"suite":"portive-parallel-v1","passed":true}',now()+interval '1 day') on conflict(id) do nothing;`);
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

test("new parallel migration applies on top of the Power schema", () => {
  sql(`create database ${dbName}`,"postgres");
  for (const file of ["202604260001_colcaller_workstation.sql","202606240001_lead_locations.sql","202611130001_dial_sessions.sql","202611130002_parallel_engine.sql"]) {
    sql(readFileSync(`supabase/migrations/${file}`,"utf8"));
  }
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
test("carrier answer and voicemail never claim the primary operator", () => {
  setup(); const s=start(); const a=attempts(s); answer(s,a[0].id,"machine");
  assert.equal(sql(`select active_call_id is null from public.dial_sessions where id='${s}'`),"t");
  assert.equal(sql(`select outcome from public.call_attempts where id='${a[0].id}'`),"voicemail");
  answer(s,a[1].id); assert.equal(sql(`select active_call_id from public.dial_sessions where id='${s}'`),a[1].id);
});
test("two near-simultaneous human events produce exactly one bridge and staffed collision handling", async () => {
  setup(); const s=start(); const a=attempts(s);
  for (const item of a.slice(0,2)) event(s,item.id,"lead","call.answered",{call_control_id:item.id});
  const run=promisify(execFile);
  await Promise.all(a.slice(0,2).map((item: { id: string }) => run("docker",["exec",container,"psql","-X","-qAt","-U","postgres","-d",dbName,"-v","ON_ERROR_STOP=1","-c",
    `select public.portive_parallel_event('${s}','${item.id}','lead','call.machine.premium.detection.ended','{"result":"human_business"}',now(),'${crypto.randomUUID()}')`])));
  assert.equal(sql("select count(*) from public.dial_commands where action='bridge'"),"1");
  assert.equal(sql("select count(*) from public.dial_commands where action='overflow'"),"1");
  assert.equal(sql("select count(*) from public.call_attempts where technical_state='answer_collision'"),"1");
});
test("duplicate human events do not duplicate bridge commands", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id); const key=crypto.randomUUID();
  event(s,a[0].id,"lead","call.machine.premium.detection.ended",{result:"human_business"},key);
  event(s,a[0].id,"lead","call.machine.premium.detection.ended",{result:"human_business"},key);
  assert.equal(sql("select count(*) from public.dial_commands where action='bridge'"),"1");
});
test("unknown AMD routes to overflow immediately without inventing human or voicemail", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id,"not_sure");
  const row=attempts(s)[0]; assert.equal(row.answer_classification,"unknown"); assert.equal(row.outcome,null);
  assert.equal(row.overflow_state,"requested");
});
test("classification deadline is enforced by the server worker", () => {
  setup(); const s=start(), a=attempts(s); event(s,a[0].id,"lead","call.answered",{call_control_id:a[0].id});
  sql(`update public.call_attempts set classification_deadline_at=now()-interval '1 second' where id='${a[0].id}'`); invoke("tick",s);
  assert.equal(sql(`select overflow_state from public.call_attempts where id='${a[0].id}'`),"requested");
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
test("late human evidence on a canceled non-winner is audited as a collision", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id); event(s,a[1].id,"lead","call.hangup");
  event(s,a[1].id,"lead","call.answered"); assert.equal(attempts(s)[1].technical_state,"answer_collision");
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),"unsafe");
});
test("browser expiry stops new reservations and routes answered legs to overflow", () => {
  setup(); const s=start(), a=attempts(s); answer(s,a[0].id); sql(`update public.dial_sessions set heartbeat_at=now()-interval '11 seconds' where id='${s}'`); invoke("tick",s);
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),"unsafe"); assert.equal(attempts(s).length,4);
});
test("one known business cannot occupy multiple concurrent lines", () => {
  setup(); sql("update public.leads set website='https://same-company.example/location' where id in ('first','second')");
  assert.equal(attempts(start()).length,3);
});
test("suppression and future callbacks exclude destinations", () => {
  setup(); sql("insert into public.dial_suppressions values('+12125550101','DNC',now()); insert into public.follow_ups(lead_id,due_at,status,channel) values('second',now()+interval '1 day','open','call')");
  assert.equal(attempts(start()).length,2);
});
test("verified channel and spend limits are enforced inside the database", () => {
  setup(); sql(`update public.dialer_provider_verifications set account_channels=5 where id='${verificationId}'`);
  assert.throws(() => invoke("start"),/capacity/); sql(`update public.dialer_provider_verifications set account_channels=9 where id='${verificationId}'`);
  const s=start({maxSpendCents:31}); assert.equal(attempts(s),null);
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

test("failed transfer leg never falsely ends the original answered leg", () => {
  setup(); const s=start(),a=attempts(s); answer(s,a[0].id,"not_sure");
  event(s,a[0].id,"overflow","call.hangup",{hangup_cause:"user_busy"});
  assert.equal(sql(`select ended_at is null from public.call_attempts where id='${a[0].id}'`),"t");
  assert.equal(sql("select count(*) from public.dial_commands where action='failure_playback'"),"1");
  event(s,a[0].id,"lead","call.playback.ended");
  assert.equal(sql(`select count(*) from public.dial_commands where command_key='${a[0].id}:failure-cleanup'`),"1");
});
test("overflow failure pauses further dialing while preserving the primary conversation", () => {
  setup(); const s=start(),a=attempts(s);
  event(s,a[1].id,"lead","call.answered",{call_control_id:a[1].id});
  answer(s,a[0].id);event(s,a[0].id,"lead","call.bridged");
  event(s,a[1].id,"overflow","call.hangup",{hangup_cause:"timeout"});invoke("tick",s);
  assert.equal(sql(`select overflow_state is null from public.call_attempts where id='${a[0].id}'`),"t");
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),"unsafe");
});
test("Realtime failure pauses the scheduler without interrupting healthy operator audio", () => {
  setup();const s=start(),a=attempts(s);answer(s,a[0].id);event(s,a[0].id,"lead","call.bridged");
  invoke("heartbeat",s,{transportReady:false});invoke("tick",s);
  assert.equal(sql(`select status from public.dial_sessions where id='${s}'`),"paused");
  assert.equal(sql(`select overflow_state is null from public.call_attempts where id='${a[0].id}'`),"t");
});

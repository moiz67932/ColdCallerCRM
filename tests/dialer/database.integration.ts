import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";

// Explicitly targets a disposable local container. Never reads production DB credentials.
const container = "portive-dialer-test-20261113";
const dbName = `portive_suite_${process.pid}`;
const controller = "11111111-1111-4111-8111-111111111111";
const offset = 12 - new Date().getUTCHours();
const zone = `Etc/GMT${offset >= 0 ? "-" : "+"}${Math.abs(offset)}`;
function sql(query: string, database = dbName) {
  return execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], {
    input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function command(action: string, sessionId: string | null = null, ready = true, extra = "") {
  return `select public.portive_session_command(${sessionId ? `'${sessionId}'` : "null"},'${controller}','${action}',${ready},'list',null,100,'power',1,'${zone}',true${extra});`;
}
function cmd(action: string, sessionId?: string | null, ready = true) { return JSON.parse(sql(command(action, sessionId, ready))); }
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
function finish(id: string, answered = false) {
  sql(`update public.call_attempts set ended_at=now(),status='${answered ? "completed" : "failed"}',
    answered_at=${answered ? "now()" : "null"},outcome=${answered ? "null" : "'no_answer'"} where id='${id}';`);
}

test("migrations apply to the existing workstation schema", () => {
  sql(`create database ${dbName}`, "postgres");
  sql(readFileSync("supabase/migrations/202604260001_colcaller_workstation.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202606240001_lead_locations.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611130001_dial_sessions.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611130002_parallel_engine.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611140001_single_operator_collisions.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611140002_cloudflare_orchestration.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611150001_parallel_dispatch_safety.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611150002_parallel_acceptance.sql", "utf8"));
  sql(readFileSync("supabase/migrations/202611160001_regular_parallel.sql", "utf8"));
  assert.equal(sql("select count(*) from public.dial_sessions"), "0");
});
test("Power selects by existing priority and advances unanswered calls once", () => {
  fixture(); const s = cmd("start").session.id;
  const first = cmd("next", s); assert.equal(first.lead.id, "first"); assert.equal(first.dispatch, true);
  assert.equal(cmd("next", s).dispatch, false);
  finish(first.attempt.id);
  const second = cmd("next", s); assert.equal(second.lead.id, "second");
  assert.notEqual(second.attempt.id, first.attempt.id);
});
test("human and ambiguous carrier answers hold the queue until saved disposition or explicit skip", () => {
  fixture(); const s = cmd("start").session.id; const first = cmd("next", s);
  finish(first.attempt.id, true);
  assert.equal(cmd("next", s).session.phase, "awaiting_disposition");
  assert.equal(cmd("next", s).dispatch, false);
  sql(`update public.call_attempts set outcome='gatekeeper',disposition_saved_at=now(),operator_notes='Manager will call back' where id='${first.attempt.id}'`);
  assert.equal(cmd("next", s).lead.id, "second");
  assert.equal(sql(`select outcome from public.call_attempts where id='${first.attempt.id}'`), "gatekeeper");
});
test("pause preserves an active call; resume never dispatches it twice", () => {
  fixture(); const s = cmd("start").session.id; const first = cmd("next", s);
  assert.equal(cmd("pause", s).session.status, "paused");
  assert.equal(cmd("next", s).dispatch, false);
  assert.equal(sql(`select ended_at is null from public.call_attempts where id='${first.attempt.id}'`), "t");
  assert.equal(cmd("resume", s).session.status, "running");
  assert.equal(cmd("next", s).dispatch, false);
});
test("microphone denial and disconnected softphone block new reservations", () => {
  fixture(); assert.throws(() => cmd("start", null, false), /microphone|softphone/);
  const s = cmd("start").session.id;
  assert.equal(cmd("next", s, false).session.status, "paused");
  assert.equal(sql("select count(*) from public.call_attempts"), "0");
});
test("suppressed numbers, bad numbers, hidden leads and future callbacks are not dialed", () => {
  fixture();
  sql(`insert into public.dial_suppressions values('+12125550101','DNC',now());
    update public.leads set derived_status='bad_number' where id='second';
    insert into public.follow_ups(lead_id,due_at,status,channel) values('third',now()+interval '1 day','open','call');`);
  const s = cmd("start").session.id;
  assert.equal(cmd("next", s).session.status, "completed");
  assert.equal(sql("select count(*) from public.call_attempts"), "0");
});
test("same number under different leads is never dialed twice per session", () => {
  fixture(); sql("update public.leads set phone_number='(212) 555-0101' where id='second'");
  const s = cmd("start").session.id; const first = cmd("next", s); finish(first.attempt.id);
  assert.equal(cmd("next", s).lead.id, "third");
});
test("wrong browser ownership cannot pause or dispatch the session", () => {
  fixture(); const s = cmd("start").session.id;
  assert.throws(() => sql(command("next", s).replace(controller,"22222222-2222-4222-8222-222222222222")), /another browser/);
});
test("two simultaneous dispatch requests yield one durable attempt", async () => {
  fixture(); const s = cmd("start").session.id;
  const run = promisify(execFile);
  const results = await Promise.all([1,2].map(() => run("docker", ["exec", container,"psql","-X","-qAt","-U","postgres","-d",dbName,"-v","ON_ERROR_STOP=1","-c",command("next",s)])));
  assert.equal(results.filter((r) => JSON.parse(r.stdout).dispatch).length, 1);
  assert.equal(sql("select count(*) from public.call_attempts"), "1");
});
test("manual calls remain allowed without a session and cannot overlap an active session", () => {
  fixture();
  sql("insert into public.call_attempts(id,lead_id,status) values('manual','first','dialing')");
  assert.throws(() => cmd("start"), /active call/);
  finish("manual"); const s = cmd("start").session.id;
  assert.throws(() => sql("insert into public.call_attempts(lead_id,status) values('second','dialing')"), /dial session/);
  assert.equal(cmd("stop", s).session.status, "stopping");
  assert.equal(cmd("next", s).dispatch, false);
});
test("answered manual conversation never becomes canceled, even with a stale browser update", () => {
  fixture(); sql("insert into public.call_attempts(id,lead_id,status,answered_at) values('conversation','first','connected',now()); update public.call_attempts set status='canceled',ended_at=now() where id='conversation';");
  assert.equal(sql("select status from public.call_attempts where id='conversation'"), "completed");
  sql("update public.call_attempts set status='dialing',raw_summary_json='{\"progressState\":\"lead_ringing\"}' where id='conversation'");
  assert.equal(sql("select status from public.call_attempts where id='conversation'"), "completed");
});

test("late browser ringing progress cannot replace an established operator bridge", () => {
  fixture(); sql("insert into public.call_attempts(id,lead_id,status,was_bridged_to_operator,raw_summary_json) values('bridged','first','connected',true,'{\"progressState\":\"bridged\"}'); update public.call_attempts set raw_summary_json='{\"progressState\":\"lead_ringing\"}' where id='bridged'");
  assert.equal(sql("select raw_summary_json->>'progressState' from public.call_attempts where id='bridged'"),"bridged");
});
test("notes and callbacks cannot reference another lead's attempt", () => {
  fixture(); sql("insert into public.call_attempts(id,lead_id,status) values('attempt','first','completed')");
  assert.throws(() => sql("insert into public.lead_notes(lead_id,call_attempt_id,body) values('second','attempt','wrong')"), /does not belong/);
  assert.throws(() => sql("insert into public.follow_ups(lead_id,call_attempt_id,due_at,channel) values('second','attempt',now(),'call')"), /does not belong/);
  sql("insert into public.lead_notes(lead_id,call_attempt_id,body) values('first','attempt','correct'); insert into public.follow_ups(lead_id,call_attempt_id,due_at,channel) values('first','attempt',now(),'call')");
  assert.equal(sql("select body from public.lead_notes"), "correct");
});
test("duplicate webhook processing is serialized; unsuccessful events can retry", () => {
  fixture(); sql("insert into public.workstation_telnyx_webhook_events(event_id,event_type,payload_json,signature_verified) values('event','call.hangup','{}',true)");
  assert.equal(sql("select public.portive_claim_voice_event('event','attempt')"), "claimed");
  assert.equal(sql("select public.portive_claim_voice_event('event','attempt')"), "busy");
  sql("update public.workstation_telnyx_webhook_events set processing_started_at=null,processing_error='timeout' where event_id='event'");
  assert.equal(sql("select public.portive_claim_voice_event('event','attempt')"), "claimed");
  sql("update public.workstation_telnyx_webhook_events set processing_started_at=null,processing_error=null,processed_at=now() where event_id='event'");
  assert.equal(sql("select public.portive_claim_voice_event('event','attempt')"), "processed");
});
test("parallel cannot bypass the database release gate for 2, 3 or 4 lines", () => {
  fixture(); for (const n of [2,3,4]) {
    assert.throws(() => sql(command("start").replace("'power',1",`'parallel',${n}`)), /not released/);
  }
  assert.equal(sql("select count(*) from public.call_attempts"), "0");
});
test("stale browser heartbeat pauses; stale watchdog blocks dispatch", () => {
  fixture(); const s = cmd("start").session.id;
  sql(`update public.dial_sessions set heartbeat_at=now()-interval '1 minute' where id='${s}'`);
  assert.equal(cmd("next",s).session.status,"paused");
  sql("update public.app_settings set value_json=jsonb_build_object('at',now()-interval '1 minute') where key='dialer_watchdog_heartbeat'");
  assert.throws(() => cmd("resume",s),/watchdog/);
});
test("recorded human classification cannot be overwritten by delayed AMD", () => {
  fixture(); sql("insert into public.call_attempts(id,lead_id,status,answer_classification) values('human','first','connected','human'); update public.call_attempts set answer_classification='machine' where id='human'");
  assert.equal(sql("select answer_classification from public.call_attempts where id='human'"),"human");
});
test("local-time window fails closed and excludes invalid timezones", () => {
  fixture(); sql("update public.leads set custom_fields_json='{\"timeZone\":\"Invalid/Zone\"}'");
  const s = cmd("start").session.id; assert.equal(cmd("next",s).session.status,"completed");
});

test("late answer evidence repairs an earlier cancellation without reopening the call", () => {
  fixture(); sql("insert into public.call_attempts(id,lead_id,status,ended_at) values('late','first','canceled',now()); update public.call_attempts set answered_at=now()-interval '5 seconds',status='connected' where id='late'");
  assert.equal(sql("select status from public.call_attempts where id='late'"),"completed");
  assert.equal(sql("select ended_at is not null from public.call_attempts where id='late'"),"t");
});
test("positive voicemail evidence permits progression; explicit skip is audited", () => {
  fixture(); const s = cmd("start").session.id; const first = cmd("next",s);
  sql(`update public.call_attempts set status='voicemail_detected',outcome='voicemail',answer_classification='machine',answered_at=now(),ended_at=now() where id='${first.attempt.id}'`);
  const second = cmd("next",s); assert.equal(second.lead.id,"second");
  finish(second.attempt.id,true);
  assert.equal(cmd("skip",s).lead.id,"third");
  assert.equal(sql("select count(*) from public.dial_audit_events where event_type='disposition_explicitly_skipped'"),"1");
});
test("an uncertain call-control command cannot be claimed again after provider deduplication expires", () => {
  fixture(); sql("insert into public.call_attempts(id,lead_id,status) values('command-attempt','first','completed'); insert into public.dial_provider_commands(command_key,attempt_id,state,created_at) values('durable-dial','command-attempt','uncertain',now()-interval '1 day')");
  assert.throws(() => sql("insert into public.dial_provider_commands(command_key,attempt_id,state) values('durable-dial','command-attempt','executing')"),/duplicate key/);
  assert.equal(sql("select state from public.dial_provider_commands where command_key='durable-dial'"),"uncertain");
});
test("anonymous callers cannot invoke orchestration or read suppression records", () => {
  fixture();
  assert.throws(() => sql(`set role anon; ${command("start")}`),/permission denied/);
  assert.throws(() => sql("set role anon; select * from public.dial_suppressions"),/permission denied/);
});

test("unexplained terminal failures pause before any further destination is reserved", () => {
  fixture(); const s = cmd("start").session.id; const first = cmd("next",s);
  sql(`update public.call_attempts set status='failed',ended_at=now() where id='${first.attempt.id}'`);
  assert.equal(cmd("next",s).session.status,"paused");
  assert.equal(sql("select count(*) from public.call_attempts"),"1");
  assert.equal(cmd("skip",s).dispatch,false);
  cmd("resume",s); assert.equal(cmd("next",s).lead.id,"second");
});

test("callback wrap-up commits notes and one scheduled callback atomically, including retries", () => {
  fixture(); sql("insert into public.call_attempts(id,lead_id,status,answered_at,ended_at) values('wrap','first','completed',now(),now())");
  const query = "select public.portive_save_disposition('wrap','first','callback','Receptionist said manager will call','2030-01-01T15:00:00Z','manager_callback_pending')";
  sql(query); sql(query);
  assert.equal(sql("select count(*) from public.follow_ups where call_attempt_id='wrap'"),"1");
  assert.equal(sql("select outcome from public.call_attempts where id='wrap'"),"callback");
  assert.equal(sql("select notes from public.leads where id='first'"),"Receptionist said manager will call");
  assert.equal(sql("select disposition_saved_at is not null from public.call_attempts where id='wrap'"),"t");
  assert.equal(sql("select derived_status from public.leads where id='first'"),"follow_up");
});
test("callback persistence failure rolls back the saved-disposition marker and notes", () => {
  fixture(); sql("insert into public.call_attempts(id,lead_id,status,answered_at,ended_at) values('rollback','first','completed',now(),now())");
  assert.throws(() => sql(`begin;
    create function pg_temp.reject_callback() returns trigger language plpgsql as $$ begin raise exception 'simulated callback failure'; end $$;
    create trigger reject_callback before insert on public.follow_ups for each row execute function pg_temp.reject_callback();
    select public.portive_save_disposition('rollback','first','callback','must not partially commit',now()+interval '1 day',null);
    commit;`), /simulated callback failure/);
  assert.equal(sql("select disposition_saved_at is null and outcome is null from public.call_attempts where id='rollback'"),"t");
  assert.equal(sql("select notes is null from public.leads where id='first'"),"t");
});

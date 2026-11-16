import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test, {after} from 'node:test';
const container='portive-dialer-test-20261113',dbName=`acceptance_suite_${process.pid}`;
const controller='11111111-1111-4111-8111-111111111111';
const offset=12-new Date().getUTCHours(),zone=`Etc/GMT${offset>=0?'-':'+'}${Math.abs(offset)}`;
const literal=(v:unknown):string=>v===null?'null':typeof v==='boolean'||typeof v==='number'?String(v):`'${(typeof v==='string'?v:JSON.stringify(v)).replaceAll("'","''")}'${typeof v==='string'?'':'::jsonb'}`;
function sql(q:string,db=dbName){return execFileSync('docker',['exec','-i',container,'psql','-X','-qAt','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}
function rpc(name:string,args:Record<string,unknown>){return JSON.parse(sql(`select public.${name}(${Object.entries(args).map(([k,v])=>`${k}=>${literal(v)}`).join(',')})`)||'null');}
const env={DIALER_PARALLEL_ENABLED:'false',DIALER_ACCEPTANCE_ENABLED:'true',TELNYX_PARALLEL_CONNECTION_ID:'fixture-app',TELNYX_TELEPHONY_CREDENTIAL_ID:'fixture-credential',TELNYX_FROM_NUMBER:'+12125550100',VERCEL_VOICE_WEBHOOK_URL:'https://fixture.invalid/api/webhooks/telnyx/voice'};
const load=createRequire(`${process.cwd()}/package.json`);
const {executeCommand}=load(`${process.cwd()}/cloudflare/portive-dialer/src/executor.ts`);
const {fingerprint}=load(`${process.cwd()}/cloudflare/portive-dialer/src/types.ts`);
let fp:string;
function fixture(){sql(`truncate public.dial_audit_events,public.dial_session_targets,public.dial_sessions,public.lead_lists cascade;
 delete from public.dial_suppressions;
 select public.portive_set_orchestration_backend('cloudflare',true);select public.portive_orchestration_prepare('cloudflare');
 insert into public.lead_lists(id,name,source_file_name) values('controlled','Consenting fixtures','fixture.csv');
 insert into public.dialer_campaign_calling_policies(list_id,jurisdictions,legal_basis) values('controlled',array['US'],'Offline federal-only fixture jurisdiction');
 insert into public.leads(id,lead_list_id,phone_number,business_name) values('one','controlled','+12125550101','One'),('two','controlled','+12125550102','Two'),('three','controlled','+12125550103','Three'),('four','controlled','+12125550104','Four'),('unapproved','controlled','+12125550105','Unapproved');`);}
function manifest(n=1){return {controller_id:controller,list_id:'controlled',time_zone:zone,config_fingerprint:fp,profile_id:'fixture-profile',operator_sip_uri:'sip:fixture@sip.telnyx.com',account_channels:5,rate_ceiling_cents:1,max_spend_cents:50,remaining_daily_cents:100,approval_reference:'offline-explicit-approval',capacity_reference:'offline-provider-capacity',rate_reference:'offline-all-inclusive-rate',reviewed_at:new Date().toISOString(),destinations:['one','two','three','four'].slice(0,n).map((id,i)=>({lead_id:id,phone_number:`+1212555010${i+1}`,time_zone:zone,consent_reference:`offline-consent-${id}`}))};}
function issue(m=manifest()){return sql(`select public.portive_acceptance_issue(${literal(m)})`);}
function command(action:string,session:string|null,opts:Record<string,unknown>={},ready=true){return rpc('portive_parallel_command',{p_session:session,p_controller:controller,p_action:action,p_ready:ready,p_reviewed:true,p_options:opts});}
function begin(grant:string){return command('start',null,{acceptanceGrantId:grant,fingerprint:fp,maxSpendCents:999999,attemptLimit:500,operatorSipUri:'sip:other@sip.telnyx.com',autoContinue:true});}
function event(s:string,a:string|null,role:string,type:string,payload:Record<string,unknown>){rpc('portive_parallel_event',{p_session:s,p_attempt:a,p_role:role,p_type:type,p_payload:payload,p_at:new Date().toISOString(),p_event:crypto.randomUUID()});}
function work(s:string){return rpc('portive_orchestration_work',{p_session:s});}
const db={async rpc(name:string,args:Record<string,unknown>){return rpc(name,args);}};
const requests:Array<{path:string;body:Record<string,unknown>}>=[];
const provider={async request(path:string,body:Record<string,unknown>){requests.push({path,body});return {data:{call_control_id:JSON.parse(Buffer.from(String(body.client_state),'base64').toString()).role==='operator'?'operator':JSON.parse(Buffer.from(String(body.client_state),'base64').toString()).attemptId}};},async action(id:string,action:string,body:Record<string,unknown>){requests.push({path:`calls/${id}/actions/${action}`,body});return {data:{}};}};
async function mediaSession(n=1){const g=issue(manifest(n)),s=begin(g);const w=work(s.id);await executeCommand(w.commands[0],env,db,provider);event(s.id,null,'operator','call.answered',{call_control_id:'operator'});command('operator_ready',s.id,{callControlId:'operator'});return {g,s};}

test('acceptance migration applies twice without manufacturing verification evidence',async()=>{
 sql(`create database ${dbName}`,'postgres');
 for(const file of ['202604260001_colcaller_workstation.sql','202606240001_lead_locations.sql','202611130001_dial_sessions.sql','202611130002_parallel_engine.sql','202611140001_single_operator_collisions.sql','202611140002_cloudflare_orchestration.sql','202611150001_parallel_dispatch_safety.sql','202611150002_parallel_acceptance.sql','202611160001_regular_parallel.sql'])sql(readFileSync(`supabase/migrations/${file}`,'utf8'));
 sql(readFileSync('supabase/migrations/202611160001_regular_parallel.sql','utf8'));
 assert.equal(sql('select count(*) from public.dialer_provider_verifications'),'0');fp=await fingerprint(env);
});
test('issuance rejects missing consent, duplicate/non-US destinations, stale review and unsafe budgets',()=>{
 fixture();const m=manifest();
 for(const bad of [{...m,destinations:[{...m.destinations[0],consent_reference:''}]},{...m,destinations:[{...m.destinations[0],phone_number:'+442071234567'}]},{...m,destinations:Array(4).fill(m.destinations[0])},{...m,reviewed_at:new Date(0).toISOString()},{...m,max_spend_cents:201},{...m,max_spend_cents:5},{...m,account_channels:4}])assert.throws(()=>issue(bad));
 assert.equal(sql('select count(*) from public.dialer_acceptance_grants'),'0');
});
test('browser role cannot issue grants, change allowlists or invoke private scheduler',()=>{
 fixture();assert.throws(()=>sql(`set role authenticated;select public.portive_acceptance_issue(${literal(manifest())});`),/permission denied/);
 assert.throws(()=>sql(`set role service_role;insert into public.dialer_acceptance_grants(id) values(gen_random_uuid());`),/permission denied/);
 assert.throws(()=>sql(`set role service_role;select public.portive_parallel_acceptance_engine(null,'${controller}','start');`),/permission denied/);
});
test('one-use authorization binds browser/configuration and clamps all caller-supplied options',()=>{
 fixture();const g=issue();assert.throws(()=>command('start',null,{acceptanceGrantId:g,fingerprint:'wrong'}));
 assert.throws(()=>rpc('portive_parallel_command',{p_session:null,p_controller:crypto.randomUUID(),p_action:'start',p_ready:true,p_reviewed:true,p_options:{acceptanceGrantId:g,fingerprint:fp}}));
 const s=begin(g);assert.equal(s.attempt_limit,1);assert.equal(s.parallel_options.maxCallSeconds,60);assert.equal(s.parallel_options.maxSpendCents,50);assert.equal(s.parallel_options.autoContinue,false);assert.equal(s.verification_id,null);
 assert.throws(()=>begin(g));assert.equal(sql('select count(*) from public.dial_commands'), '1');
 command('tick',s.id);assert.equal(sql('select count(*) from public.call_attempts'),'0');
});
test('real SQL -> Worker path dials only one approved prospect after explicit media acknowledgement',async()=>{
 fixture();requests.length=0;const {s}=await mediaSession();const w=work(s.id);assert.equal(w.commands.length,1);await executeCommand(w.commands[0],env,db,provider);
 const dials=requests.filter(x=>x.path==='calls');assert.equal(dials.length,2);assert.equal(dials[0].body.time_limit_secs,120);assert.equal(dials[1].body.to,'+12125550101');assert.equal(dials[1].body.time_limit_secs,60);assert.equal(dials[1].body.answering_machine_detection,'premium');
 assert.equal(sql('select count(*) from public.dial_session_targets'),'1');assert.throws(()=>command('continue',s.id));assert.throws(()=>command('resume',s.id));
 assert.equal(sql('select count(*) from public.dialer_provider_verifications'),'0');
});
test('four-destination grant queues exactly four approved real-ledger commands and no fifth lead',async()=>{
 fixture();requests.length=0;const {s}=await mediaSession(4);const w=work(s.id);assert.equal(w.commands.length,4);await Promise.all(w.commands.map((c:unknown)=>executeCommand(c,env,db,provider)));
 assert.equal(requests.filter(x=>x.path==='calls').length,5);assert.equal(requests.filter(x=>x.path==='calls'&&x.body.to==='+12125550105').length,0);
 assert.equal(work(s.id).commands.length,0);
});
test('late DNC, closed calling hours, changed destination and revocation cancel before provider I/O',async()=>{
 for(const failure of ['dnc','hours','destination','revoke']){
  fixture();requests.length=0;const {s,g}=await mediaSession();const w=work(s.id),c=w.commands[0];
  if(failure==='dnc')sql(`insert into public.dial_suppressions values('+12125550101','DNC',now())`);
  if(failure==='hours'){const off=22-new Date().getUTCHours(),closed=`Etc/GMT${off>=0?'-':'+'}${Math.abs(off)}`;sql(`update public.leads set custom_fields_json=jsonb_build_object('timeZone','${closed}') where id='one'`);}
  if(failure==='destination')sql(`update public.dial_commands set parameters='{"to":"+12125550105"}' where id='${c.id}'`);
  if(failure==='revoke')rpc('portive_acceptance_revoke',{p_grant:g});
  c.parameters=JSON.parse(sql(`select parameters from public.dial_commands where id='${c.id}'`));
  await executeCommand(c,env,db,provider);
  assert.equal(requests.filter(x=>x.path==='calls').length,1,failure);
  assert.equal(sql(`select state from public.dial_commands where id='${c.id}'`),'canceled',failure);
  assert.equal(sql(`select count(*) from public.dial_session_targets where session_id='${s.id}'`),'1');
 }
});
test('denial with provider identity remains uncertain, never terminal or redialed',async()=>{
 fixture();requests.length=0;const {s,g}=await mediaSession();const c=work(s.id).commands[0];sql(`update public.call_attempts set telnyx_call_control_id='possibly-submitted' where id='${c.attempt_id}'`);rpc('portive_acceptance_revoke',{p_grant:g});await executeCommand(c,env,db,provider);
 assert.equal(sql(`select state from public.dial_commands where id='${c.id}'`),'uncertain');assert.equal(sql(`select ended_at is null from public.call_attempts where id='${c.attempt_id}'`),'t');
 assert.equal(requests.filter(x=>x.path==='calls').length,1);
});
test('duplicate operator command retains provider uncertainty without another dial',async()=>{
 fixture();requests.length=0;const {s}=await mediaSession();
 sql(`select public.portive_enqueue('${s.id}',null,'dial_operator','${s.id}:duplicate-operator')`);
 const c=work(s.id).commands.find((x:{action:string})=>x.action==='dial_operator');assert(c);
 await executeCommand(c,env,db,provider);
 assert.equal(sql(`select state from public.dial_commands where id='${c.id}'`),'uncertain');
 assert.equal(sql(`select operator_terminal_at is null from public.dial_sessions where id='${s.id}'`),'t');
 assert.equal(requests.filter(x=>x.path==='calls').length,1);
});
test('revocation before operator submission closes only proven-unsent work without invented terminal evidence',async()=>{
 fixture();requests.length=0;const g=issue(),s=begin(g);rpc('portive_acceptance_revoke',{p_grant:g});
 const pending=work(s.id);for(const c of pending.commands)await executeCommand(c,env,db,provider);
 const reconciled=work(s.id);assert.equal(reconciled.session.status,'stopped');
 assert.equal(sql(`select operator_terminal_at is null from public.dial_sessions where id='${s.id}'`),'t');
 assert.equal(sql(`select count(*) from public.dial_commands where session_id='${s.id}' and state in ('pending','executing','uncertain')`),'0');
 assert.equal(requests.length,0);
});
test('expired acceptance with active winner survives stale positives and ends winner once',async()=>{
 fixture();requests.length=0;const {s}=await mediaSession();const c=work(s.id).commands[0];await executeCommand(c,env,db,provider);
 event(s.id,c.attempt_id,'lead','call.answered',{call_control_id:c.attempt_id});event(s.id,c.attempt_id,'lead','call.machine.premium.detection.ended',{result:'human_business'});
 sql(`update public.dial_sessions set started_at=now()-interval '121 seconds' where id='${s.id}'`);
 command('heartbeat',s.id,{},true);command('operator_ready',s.id,{callControlId:'operator'},true);command('tick',s.id);command('tick',s.id);
 assert.equal(sql(`select browser_media_ready from public.dial_sessions where id='${s.id}'`),'f');assert.equal(sql(`select status from public.dial_sessions where id='${s.id}'`),'unsafe');
 assert.equal(sql(`select count(*) from public.dial_commands where attempt_id='${c.attempt_id}' and parameters->>'force'='true' and action='hangup'`),'1');
 assert.equal(requests.filter(x=>x.path==='calls').length,2);
 for(const cleanup of work(s.id).commands)await executeCommand(cleanup,env,db,provider);
 event(s.id,c.attempt_id,'lead','call.hangup',{call_control_id:c.attempt_id,hangup_cause:'normal_clearing'});
 event(s.id,null,'operator','call.hangup',{call_control_id:'operator',hangup_cause:'normal_clearing'});
 assert.equal(work(s.id).session.status,'stopped');
 assert.equal(command('heartbeat',s.id,{},true).status,'stopped');
 assert.equal(requests.filter(x=>x.path==='calls').length,2);
});
after(()=>{sql(`drop database if exists ${dbName} with (force)`,'postgres');});

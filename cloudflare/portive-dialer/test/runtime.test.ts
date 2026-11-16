import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject,runDurableObjectAlarm,evictDurableObject } from 'cloudflare:test';
import worker,{earliestDeadline} from '../src/index';
import {type Env,type Work,type Command,fingerprint} from '../src/types';
import {Database,TelnyxApi,verifyProvider} from '../src/adapters';
import {executeCommand} from '../src/executor';
import {signInternal,verifyInternal} from '../../../lib/dialer/internal-auth';
const e=env as unknown as Env;
let calls:Array<{url:string,body:any}>,work:Work,commands:Command[],spy:ReturnType<typeof vi.spyOn>;
const id=()=>crypto.randomUUID();
function attempt(){return {id:id(),ended_at:null as string|null,answered_at:null as string|null,termination_reason:null as string|null,answer_classification:'unknown',telnyx_call_control_id:'prospect' as string|null,telnyx_agent_call_control_id:null as string|null};}
function cmd(action:string,a=attempt()):Command{return {id:id(),session_id:work.session.id,attempt_id:a.id,action,parameters:{to:'+12125550101'},session:work.session,attempt:a};}
async function request(body:any,headers?:Record<string,string>){const path=`/internal/session/${work.session.id}`,raw=JSON.stringify(body);return worker.fetch(new Request('https://worker.example'+path,{method:'POST',body:raw,headers:headers??await signInternal(e.DIALER_CLOUDFLARE_SECRET,path,raw)}),e) as Promise<Response>;}
async function delivery(){
 const rawBody=JSON.stringify({data:{id:id(),event_type:'call.machine.premium.detection.ended',occurred_at:new Date().toISOString(),payload:{result:'human_business'}}});
 const pkcs=Uint8Array.from(('302e020100300506032b657004220420'+'9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60').match(/../g)!,b=>parseInt(b,16));
 const key=await crypto.subtle.importKey('pkcs8',pkcs,{name:'Ed25519'},false,['sign']),timestamp=String(Math.floor(Date.now()/1000));
 const sig=new Uint8Array(await crypto.subtle.sign('Ed25519',key,new TextEncoder().encode(timestamp+'|'+rawBody)));
 return {kind:'event',eventId:JSON.parse(rawBody).data.id,delivery:{rawBody,signature:btoa(String.fromCharCode(...sig)),timestamp,sessionId:work.session.id,attemptId:id(),role:'lead',vercelArrival:Date.now(),vercelAuthenticated:Date.now()}};
}
beforeEach(async()=>{
 calls=[];commands=[];work={session:{id:id(),mode:'parallel',status:'running',controller_id:id(),active_call_id:null,operator_call_control_id:'operator',browser_media_ready:true,orchestration_backend:'cloudflare',parallel_options:{fingerprint:await fingerprint(e),operatorSipUri:'sip:operator@sip.telnyx.com',ringTimeout:30,maxCallSeconds:300,budgetVersion:"exposure-v1",sessionSeconds:600,deadlineAt:new Date(Date.now()+600000).toISOString()}},commands:[],deadlines:[new Date(Date.now()+10000).toISOString()]};
 spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input:any,init:any)=>{const url=String(input),body=init?.body?JSON.parse(init.body):{};calls.push({url,body});if(url.endsWith('portive_orchestration_work')||url.endsWith('portive_cloudflare_event')){const r={...work,commands};commands=[];return Response.json(r);}if(url.endsWith('portive_orchestration_authorize'))return Response.json({allowed:true});if(url.includes('/rest/v1/'))return Response.json(null);if(url.includes('/v2/'))return Response.json({data:{call_control_id:id(),is_alive:true}});throw Error('Unexpected network');});
});
afterEach(()=>vi.restoreAllMocks());
it('rejects unsigned requests before database or telephony',async()=>{expect((await request({kind:'wake'},{})).status).toBe(401);expect(calls).toHaveLength(0);});
it('rejects repeated authenticated wakes in a live object',async()=>{const b={kind:'wake'},h=await signInternal(e.DIALER_CLOUDFLARE_SECRET,`/internal/session/${work.session.id}`,JSON.stringify(b));expect((await request(b,h)).status).toBe(200);expect((await request(b,h)).status).toBe(409);});
it('binds HMAC to path, body, and request freshness',async()=>{const h=new Headers(await signInternal(e.DIALER_CLOUDFLARE_SECRET,'/one','{}'));expect(await verifyInternal(e.DIALER_CLOUDFLARE_SECRET,'/two','{}',h)).toBe(false);expect(await verifyInternal(e.DIALER_CLOUDFLARE_SECRET,'/one','changed',h)).toBe(false);expect(await verifyInternal(e.DIALER_CLOUDFLARE_SECRET,'/one','{}',h,Date.now()+120000)).toBe(false);});
it('verifies original provider signature and preserves exact raw body',async()=>{const b=await delivery();expect((await request(b)).status).toBe(200);expect(calls.find(c=>c.url.endsWith('portive_cloudflare_event'))?.body.p_raw).toBe(b.delivery.rawBody);});
it('rejects tampered provider payload despite valid internal HMAC',async()=>{const b=await delivery();b.delivery.rawBody+=' ';expect((await request(b)).status).toBe(401);expect(calls).toHaveLength(0);});
it('rejects expired provider signatures',async()=>{expect(await verifyProvider('{}','invalid','1',e.TELNYX_PUBLIC_KEY)).toBe(false);});
it('keeps secrets out of public responses',async()=>{const r=await worker.fetch(new Request('https://worker.example/health'),e);const b=await r.text();expect(b).not.toContain(e.DIALER_CLOUDFLARE_SECRET);expect(b).not.toContain(e.TELNYX_API_KEY);});
it('launches four prospect requests concurrently',async()=>{let active=0,peak=0;const releases:Array<()=>void>=[];spy.mockImplementation(async(input:any)=>{if(String(input).endsWith('/v2/calls')){active++;peak=Math.max(peak,active);await new Promise<void>(r=>releases.push(r));active--;return Response.json({data:{call_control_id:id()}});}return Response.json({allowed:true});});const result=Promise.all([1,2,3,4].map(()=>executeCommand(cmd('dial_lead'),e,new Database(e),new TelnyxApi(e))));await vi.waitFor(()=>expect(peak).toBe(4));releases.forEach(r=>r());await result;});
it('bridges the claimed live winner with provider duplicate-bridge protection',async()=>{const a=attempt();work.session.active_call_id=a.id;commands=[cmd('bridge',a)];expect((await request(await delivery())).status).toBe(200);const b=calls.find(c=>c.url.endsWith('/actions/bridge'))!;expect(b.body.prevent_double_bridge).toBe(true);expect(b.body.park_after_unbridge).toBe('self');expect(b.body.call_control_id_to_bridge_with).toBe('prospect');});
it('rejects a bridge for a losing attempt',async()=>{await executeCommand(cmd('bridge'),e,new Database(e),new TelnyxApi(e));expect(calls.some(c=>c.url.endsWith('/actions/bridge'))).toBe(false);expect(calls.some(c=>c.body.p_ok===false)).toBe(true);});
it('routes collision to explanation without disconnecting operator',async()=>{const a=attempt();a.answered_at=new Date().toISOString();a.termination_reason='answer_collision';a.answer_classification='human';work.session.active_call_id='winner';await executeCommand(cmd('hangup',a),e,new Database(e),new TelnyxApi(e));expect(calls.some(c=>c.url.endsWith('portive_answer_collision'))).toBe(true);expect(calls.some(c=>c.url.endsWith('/prospect/actions/hangup'))).toBe(false);expect(calls.some(c=>c.url.endsWith('/operator/actions/hangup'))).toBe(false);});
it('hangs up voicemail independently without claiming the operator',async()=>{const a=attempt();a.answer_classification='machine';a.answered_at=new Date().toISOString();a.termination_reason='machine_detected';await executeCommand(cmd('hangup',a),e,new Database(e),new TelnyxApi(e));expect(calls.some(c=>c.url.endsWith('portive_answer_collision'))).toBe(false);expect(calls.some(c=>c.url.endsWith('/actions/hangup'))).toBe(true);});
it('defers unresolved identity without replacement dial',async()=>{const a=attempt();a.telnyx_call_control_id=null;await executeCommand(cmd('hangup',a),e,new Database(e),new TelnyxApi(e));expect(calls.some(c=>c.body.p_defer===true)).toBe(true);expect(calls.some(c=>c.url.includes('/v2/'))).toBe(false);});
it('marks provider timeouts uncertain without retrying dial',async()=>{spy.mockImplementation(async(input:any,init:any)=>{calls.push({url:String(input),body:init?.body?JSON.parse(init.body):{}});if(String(input).includes('/v2/'))throw new DOMException('timeout','TimeoutError');return Response.json({allowed:true});});await executeCommand(cmd('dial_lead'),e,new Database(e),new TelnyxApi(e));expect(calls.filter(c=>c.url.endsWith('/v2/calls'))).toHaveLength(1);expect(calls.some(c=>c.body.p_ok===false&&c.body.p_status===0)).toBe(true);});
it('reports bridge failure to SQL cleanup without replacement call',async()=>{const a=attempt();work.session.active_call_id=a.id;spy.mockImplementation(async(input:any,init:any)=>{calls.push({url:String(input),body:init?.body?JSON.parse(init.body):{}});return String(input).includes('/v2/')?new Response('',{status:422}):Response.json({allowed:true});});await executeCommand(cmd('bridge',a),e,new Database(e),new TelnyxApi(e));expect(calls.some(c=>c.body.p_ok===false&&c.body.p_status===422)).toBe(true);});
it('blocks stale configuration before provider request',async()=>{work.session.parallel_options.fingerprint='stale';await executeCommand(cmd('dial_lead'),e,new Database(e),new TelnyxApi(e));expect(calls.some(c=>c.url.includes('/v2/'))).toBe(false);});
it('preserves Power cleanup of both original legs',async()=>{work.session.mode='power';const a=attempt();a.telnyx_agent_call_control_id='browser';await executeCommand(cmd('hangup',a),e,new Database(e),new TelnyxApi(e));expect(calls.filter(c=>c.url.endsWith('/actions/hangup'))).toHaveLength(2);});
it('uses one earliest deadline without repeating expired timers',()=>{const n=Date.now();expect(earliestDeadline([new Date(n-1).toISOString(),new Date(n+200).toISOString(),new Date(n+100).toISOString()],n)).toBe(n+100);expect(earliestDeadline([],n)).toBe(null);});
it('recovers stored session and alarm after Worker object eviction',async()=>{const sid=work.session.id;await (await request({kind:'wake'})).text();const stub=e.SESSIONS.get(e.SESSIONS.idFromName(sid));await evictDurableObject(stub);expect(await runDurableObjectAlarm(stub)).toBe(true);expect(await runInDurableObject(stub,async(_,state)=>state.storage.get('sessionId'))).toBe(sid);},30000);
it('rearms alarm with backoff during Supabase outage',async()=>{const sid=work.session.id;await request({kind:'wake'});spy.mockImplementation(async()=>new Response('',{status:503}));const stub=e.SESSIONS.get(e.SESSIONS.idFromName(sid));await runDurableObjectAlarm(stub);const result=await runInDurableObject(stub,async(_,state)=>({alarm:await state.storage.getAlarm(),failures:await state.storage.get('failures')}));expect(result.failures).toBe(1);expect(result.alarm).toBeGreaterThan(Date.now());});
it('fails closed and retains recovery for quota-like errors',async()=>{spy.mockImplementation(async()=>new Response('',{status:429}));expect((await request({kind:'wake'})).status).toBe(503);const stub=e.SESSIONS.get(e.SESSIONS.idFromName(work.session.id));expect(await runInDurableObject(stub,async(_,state)=>state.storage.getAlarm())).not.toBe(null);});
it('removes alarm when session is completed and idle',async()=>{work.session.status='completed';work.deadlines=[];await request({kind:'wake'});const stub=e.SESSIONS.get(e.SESSIONS.idFromName(work.session.id));expect(await runInDurableObject(stub,async(_,state)=>state.storage.getAlarm())).toBe(null);});
it('keeps duplicate events inside PostgreSQL idempotency boundary',async()=>{const b=await delivery();await request(b);await request(b);expect(calls.filter(c=>c.url.endsWith('portive_cloudflare_event'))).toHaveLength(2);expect(calls.some(c=>c.url.includes('/v2/'))).toBe(false);});
it('retains control-request replay protection across object eviction',async()=>{
 const path='/internal/prepare',raw='{}',headers=await signInternal(e.DIALER_CLOUDFLARE_SECRET,path,raw);
 const send=()=>worker.fetch(new Request('https://worker.example'+path,{method:'POST',body:raw,headers}),e) as Promise<Response>;
 const first=await send();expect(first.status).toBe(200);await first.text();
 const stub=e.SESSIONS.get(e.SESSIONS.idFromName('control'));await evictDurableObject(stub);
 const second=await send();expect(second.status).toBe(409);await second.text();
},30000);
it('does not send a dial if final PostgreSQL authorization cancels it',async()=>{
 spy.mockImplementation(async(input:any)=>Response.json(String(input).endsWith('portive_orchestration_authorize')?{allowed:false}:null));
 await executeCommand(cmd('dial_lead'),e,new Database(e),new TelnyxApi(e));
 expect(spy.mock.calls.some(([url])=>String(url).includes('/v2/'))).toBe(false);
});
it('inspects configuration without preparing SQL work or calling a provider',async()=>{
 const path='/internal/inspect',body='{}';
 const r=await worker.fetch(new Request('https://worker.example'+path,{method:'POST',body,headers:await signInternal(e.DIALER_CLOUDFLARE_SECRET,path,body)}),e);
 expect(r.status).toBe(200);expect((await r.json() as any).fingerprint).toBe(await fingerprint(e));
 expect(calls).toHaveLength(0);
});
it.each(['disabled','expired','wrong-grant','unapproved-destination','missing-proof','unrestricted-enabled'])('restricted acceptance fails closed for %s',async(failure)=>{
 const grant=id();work.session.acceptance_grant_id=grant;work.session.parallel_options.ringTimeout=15;work.session.parallel_options.maxCallSeconds=60;
 const config={...e,DIALER_PARALLEL_ENABLED:'false',DIALER_ACCEPTANCE_ENABLED:'true'};
 const proof={id:grant,expiresAt:new Date(Date.now()+60000).toISOString(),destinations:[{phone_number:'+12125550101'}],operatorSipUri:work.session.parallel_options.operatorSipUri,maxSpendCents:50};
 if(failure==='disabled')config.DIALER_ACCEPTANCE_ENABLED='false';
 if(failure==='expired')proof.expiresAt=new Date(0).toISOString();
 if(failure==='wrong-grant')proof.id=id();
 if(failure==='unapproved-destination')proof.destinations[0].phone_number='+12125550102';
 if(failure==='unrestricted-enabled')config.DIALER_PARALLEL_ENABLED='true';
 spy.mockImplementation(async(input:any,init:any)=>{const url=String(input);calls.push({url,body:init?.body?JSON.parse(init.body):{}});return Response.json(url.endsWith('portive_orchestration_authorize')?{allowed:true,session:work.session,acceptance:failure==='missing-proof'?null:proof}:null);});
 await executeCommand(cmd('dial_lead'),config,new Database(config),new TelnyxApi(config));
 expect(calls.some(c=>c.url.includes('/v2/'))).toBe(false);
});
it('acceptance flag alone cannot release an ordinary Parallel session',async()=>{
 const config={...e,DIALER_PARALLEL_ENABLED:'false',DIALER_ACCEPTANCE_ENABLED:'true'};
 await executeCommand(cmd('dial_lead'),config,new Database(config),new TelnyxApi(config));
 expect(calls.some(c=>c.url.includes('/v2/'))).toBe(false);
});
it.each(['destination_suppressed','outside_calling_window','invalid_timezone','session_not_dispatchable'])('denied %s dispatch never reaches Telnyx or overwrites the SQL cancellation',async(reason)=>{
 spy.mockImplementation(async(input:any,init:any)=>{
  const url=String(input);calls.push({url,body:init?.body?JSON.parse(init.body):{}});
  if(url.endsWith('portive_orchestration_authorize'))return Response.json({allowed:false,reason});
  throw Error('Unexpected request after denied authorization');
 });
 await executeCommand(cmd('dial_lead'),e,new Database(e),new TelnyxApi(e));
 expect(calls).toHaveLength(1);
 expect(calls[0].url).toContain('/rpc/portive_orchestration_authorize');
});
it('handles an authenticated late request after completed-object storage cleanup',async()=>{
 work.session.status='completed';work.deadlines=[];
 await (await request({kind:'wake'})).text();
 const second=await request({kind:'wake'});expect(second.status).toBe(200);await second.text();
});
it('stops recovery alarms after the database retires the Cloudflare backend',async()=>{
 const sid=work.session.id;await (await request({kind:'wake'})).text();
 spy.mockImplementation(async()=>Response.json({message:'Orchestration backend mismatch'},{status:400}));
 const stub=e.SESSIONS.get(e.SESSIONS.idFromName(sid));await runDurableObjectAlarm(stub);
 expect(await runInDurableObject(stub,async(_,state)=>state.storage.getAlarm())).toBe(null);
});
it('does not hang up an operator whose terminal evidence is already recorded',async()=>{
 work.session.operator_terminal_at=new Date().toISOString();
 await executeCommand(cmd('hangup_operator'),e,new Database(e),new TelnyxApi(e));
 expect(calls.some(c=>c.url.includes('/v2/'))).toBe(false);
 expect(calls.some(c=>c.body.p_ok===true)).toBe(true);
});

it('explains an answered collision using provider speech before terminal cleanup',async()=>{const a=attempt();await executeCommand(cmd('failure_playback',a),e,new Database(e),new TelnyxApi(e));const speech=calls.find(c=>c.url.endsWith('/prospect/actions/speak'));expect(speech?.body.payload).toContain('Fixture Business');expect(speech?.body.payload).toContain('telemarketing');expect(calls.some(c=>c.url.endsWith('/actions/hangup'))).toBe(false);});
it('never explains a collision to the winning prospect',async()=>{const a=attempt();work.session.active_call_id=a.id;await executeCommand(cmd('failure_playback',a),e,new Database(e),new TelnyxApi(e));expect(calls.some(c=>c.url.includes('/v2/'))).toBe(false);expect(calls.some(c=>c.body.p_ok===false)).toBe(true);});
it('never speaks an undefined caller identity',async()=>{await executeCommand(cmd('failure_playback'),{...e,DIALER_CALLER_NAME:undefined},new Database(e),new TelnyxApi(e));expect(calls.some(c=>c.url.includes('/v2/'))).toBe(false);});

it('funds each prospect provider hard cap including cleanup grace',async()=>{
 await executeCommand(cmd('dial_lead'),e,new Database(e),new TelnyxApi(e));
 const call=calls.find(c=>c.url.endsWith('/v2/calls'));expect(call?.body.time_limit_secs).toBe(315);
});
it('caps the operator from the immutable remaining session deadline',async()=>{
 await executeCommand(cmd('dial_operator'),e,new Database(e),new TelnyxApi(e));
 const limit=calls.find(c=>c.url.endsWith('/v2/calls'))?.body.time_limit_secs;
 expect(limit).toBeGreaterThanOrEqual(570);expect(limit).toBeLessThanOrEqual(572);
});
it('does not start an unfunded call near the deadline even after SQL authorization',async()=>{
 work.session.parallel_options.deadlineAt=new Date(Date.now()+100000).toISOString();
 await executeCommand(cmd('dial_lead'),e,new Database(e),new TelnyxApi(e));expect(calls.some(c=>c.url.includes('/v2/'))).toBe(false);
});
it('does not reinterpret legacy sessions as funded under the new tariff',async()=>{
 delete work.session.parallel_options.budgetVersion;await executeCommand(cmd('dial_lead'),e,new Database(e),new TelnyxApi(e));expect(calls.some(c=>c.url.includes('/v2/'))).toBe(false);
});
it('collision TTS cannot exceed its reserved text length',async()=>{
 const a=attempt();work.session.active_call_id='other';await executeCommand(cmd('failure_playback',a),{...e,DIALER_CALLER_NAME:'Company'.repeat(200)},new Database(e),new TelnyxApi(e));
 expect(calls.find(c=>c.url.endsWith('/actions/speak'))?.body.payload.length).toBeLessThanOrEqual(400);
});

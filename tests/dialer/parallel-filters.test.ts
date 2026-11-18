import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {parallelLeadFilters} from '../../lib/dialer/parallel-filters';
import {defaultParallelOptions} from '../../lib/dialer/parallel-policy';
import {safeDiagnostic} from '../../lib/dialer/diagnostics';

const listId='e0a75bf6-654c-4918-a46c-c7b0b33d3acb';
const controllerId='9fb31be0-6677-4490-b9f0-1471129f585d';
const lead={lead_list_id:listId,location:'Greenwood_Village_Colorado'};

function load<T>(path:string,modules:Record<string,unknown>):T{
 const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const result={};
 new Function('require','exports',code)((name:string)=>{assert(name in modules,`Unexpected import ${name}`);return modules[name];},result);
 return result as T;
}

function fixture(legacy=false,wakeDown=false,terminal=false){
 const calls:Array<{name:string;args:Record<string,unknown>}>=[];
 const db={rpc:async(name:string,args:Record<string,unknown>)=>{
  calls.push({name,args});
  const matches=args.p_list===lead.lead_list_id&&(args.p_location===null||args.p_location===lead.location);
  if(name==='portive_parallel_eligibility')return {data:{eligible:matches?18:0,reasons:{}}};
  if(name==='portive_parallel_command')return args.p_action==='stop'?{data:{id:'fixture-session',mode:'parallel',status:'stopping'}}:matches?{data:{id:'fixture-session',mode:'parallel',status:'running'}}:{error:{message:'Selected list/location has no leads'}};
  if(name==='portive_session_command')return {data:{session:{id:'power-session',mode:'power'},dispatch:false}};
  return {data:null};
 },from:()=>{const query:Record<string,unknown>={};for(const name of ['select','eq','in','order','limit'])query[name]=()=>query;query.maybeSingle=async()=>({data:{id:'fixture-session',mode:'parallel',status:terminal?'stopped':'stopping',controller_id:controllerId}});return query;}};
 const readiness={enabled:true,channels:5,blockers:[],availableCreditCents:500,dailyLimitCents:500,budget:{profile:null,heldCents:0,dailyHeldCents:0}};
 const modules:Record<string,unknown>={
  '@/lib/env':{env:{DIALER_PARALLEL_ENABLED:'true',TELNYX_PUBLIC_KEY:'fixture',TELNYX_SKIP_SIGNATURE_VERIFICATION:'false'}},
  '@/lib/supabase-admin':{getSupabaseAdmin:()=>db},
  '@/lib/telnyx/helpers':{getTelnyxManualDialFlow:()=> 'browser_first',getOutboundCallerId:()=>'+12025550123'},
  '@/lib/telnyx/call-flow':{},
  './parallel-readiness':{parallelReadiness:async()=>readiness},
  './orchestration':{assertOrchestrationBackend:async()=>{},prepareOrchestration:async()=>{},wakeOrchestration:async()=>{if(wakeDown)throw Error('Worker unavailable');},orchestrationBackend:()=> 'cloudflare'},
  './budget':{budgetQuote:()=>null},'./parallel-fingerprint':{},
  './funding':{dailyHeadroom:async()=>({cents:500})},'./acceptance':{},
  './parallel-filters':{parallelLeadFilters:legacy?(input:{listId:string;location:string})=>({p_list:input.listId,p_location:input.location??null}):parallelLeadFilters},
 };
 const service=load<typeof import('../../lib/dialer/service')>('lib/dialer/service.ts',modules);
 const route=load<typeof import('../../app/api/dial-sessions/route')>('app/api/dial-sessions/route.ts',{
  '@/lib/logger':{logInfo:()=>{}},'next/server':{NextResponse},zod:{z},
  '@/lib/api-auth':{requireApiAuth:async()=>null},
  '@/lib/dialer/service':service,
  '@/lib/http':{jsonError:(error:string,status:number)=>NextResponse.json({error},{status}),formatUnknownError:(e:Error)=>e.message},
  '@/lib/telnyx/call-flow':{ensureTelnyxConfigured:()=>true,canReceiveTelnyxVoiceWebhooks:()=>true},
  '@/lib/telnyx/helpers':{checkVoiceWebhookReachability:async()=>({reachable:true})},
  '@/lib/supabase-admin':modules['@/lib/supabase-admin'],
  '@/lib/dialer/parallel-readiness':modules['./parallel-readiness'],
  '@/lib/dialer/parallel-policy':{defaultParallelOptions},'@/lib/env':modules['@/lib/env'],
 });
 const quote=load<typeof import('../../app/api/dial-sessions/quote/route')>('app/api/dial-sessions/quote/route.ts',{
  '@/lib/logger':{logInfo:()=>{}},'next/server':{NextResponse},zod:{z},
  '@/lib/api-auth':{requireApiAuth:async()=>null},
  '@/lib/supabase-admin':modules['@/lib/supabase-admin'],
  '@/lib/dialer/parallel-readiness':modules['./parallel-readiness'],
  '@/lib/dialer/budget':modules['./budget'],'@/lib/dialer/funding':modules['./funding'],
  '@/lib/dialer/parallel-filters':{parallelLeadFilters},
  '@/lib/dialer/diagnostics':{safeDiagnostic},
 });
 return {calls,service,readiness,post:(location:string,parallelLocation?:string,mode='parallel')=>route.POST(new NextRequest('https://fixture.invalid/api/dial-sessions',{
  method:'POST',body:JSON.stringify({action:'start',controllerId,listId,location,parallelLocation,mode,ready:true,reviewed:true,timeZone:'America/New_York',maxLines:4,options:defaultParallelOptions}),
 })),quote:(parallelLocation?:string)=>quote.GET(new NextRequest('https://fixture.invalid/api/dial-sessions/quote?'+new URLSearchParams({listId,timeZone:'America/New_York',lines:'4',maxCallSeconds:'60',sessionSeconds:'180',ringTimeout:'15',maxSpendCents:'500',...(parallelLocation?{parallelLocation}:{})})))};
}

test('reproduces exact production 409 for empty and unrelated workspace locations with legacy wiring',async()=>{
 for(const location of ['', 'Round_Rock_Texas']){
  const response=await fixture(true).post(location);
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'Selected list/location has no leads'});
 }
});

test('Greenwood list starts four lines with identical quote/SQL filters regardless of workspace selection',async()=>{
 for(const location of ['', 'Round_Rock_Texas']){
  const f=fixture();
  const quote=await f.quote();assert.equal(quote.status,200);assert.equal((await quote.json()).eligibility.eligible,18);
  const response=await f.post(location);assert.equal(response.status,200);assert.equal((await response.json()).session.mode,'parallel');
  const eligibility=f.calls.find(c=>c.name==='portive_parallel_eligibility')!.args;
  const start=f.calls.find(c=>c.name==='portive_parallel_command')!.args;
  assert.deepEqual({list:start.p_list,location:start.p_location,timeZone:start.p_timezone},{list:eligibility.p_list,location:eligibility.p_location,timeZone:eligibility.p_timezone});
  assert.equal(start.p_location,null);assert.equal(start.p_lines,4);assert.equal(start.p_ready,true);assert.equal(start.p_reviewed,true);
 }
});

test('only an explicit Parallel location restricts both quote and Start; blank means all list locations',async()=>{
 for(const parallelLocation of ['Greenwood_Village_Colorado','Round_Rock_Texas','   ']){
  const f=fixture();const expected=parallelLocation.trim()||null;
  const quote=await f.quote(parallelLocation);const eligible=(await quote.json()).eligibility.eligible;
  const response=await f.post('Round_Rock_Texas',parallelLocation);
  assert.equal(response.status,expected==='Round_Rock_Texas'?409:200);
  assert.equal(eligible,expected==='Round_Rock_Texas'?0:18);
  for(const c of f.calls.filter(c=>['portive_parallel_command','portive_parallel_eligibility'].includes(c.name)))assert.equal(c.args.p_location,expected);
 }
});

test('Power still receives the original workspace location',async()=>{
 const f=fixture();assert.equal((await f.post('Round_Rock_Texas',undefined,'power')).status,200);
 assert.equal(f.calls.find(c=>c.name==='portive_session_command')!.args.p_location,'Round_Rock_Texas');
});

test('committed Stop returns durable stopping state and recovery warning when Worker wake fails',async()=>{
 const f=fixture(false,true);
 const result=await f.service.sessionCommand({action:'stop',sessionId:'fixture-session',controllerId,ready:false});
 assert.equal(result.session.status,'stopping');assert.equal(result.dispatch,false);
 assert.equal(result.recoveryPending,true);assert.match(result.warning??'',/command saved/);
 assert.equal(f.calls.filter(c=>c.name==='portive_parallel_command').length,1);
});
test('late Stop and heartbeat after Parallel termination return terminal state without a Power fallback',async()=>{
 const f=fixture(false,false,true);
 for(const action of ['stop','heartbeat','operator_ready']){
  const result=await f.service.sessionCommand({action,sessionId:'fixture-session',controllerId,ready:false});
  assert.equal(result.session.status,'stopped');assert.equal(result.dispatch,false);
 }
 assert(!f.calls.some(c=>['portive_session_command','portive_parallel_command'].includes(c.name)));
 await assert.rejects(f.service.sessionCommand({action:'continue',sessionId:'fixture-session',controllerId,ready:true}),/session has ended/);
 await assert.rejects(f.service.sessionCommand({action:'stop',sessionId:'fixture-session',controllerId:'other',ready:false}),/another browser/);
});
test('quote separates prior credit holds from exposure that can consume today daily headroom',async()=>{
 const f=fixture();f.readiness.availableCreditCents=1000;f.readiness.budget.heldCents=400;f.readiness.budget.dailyHeldCents=50;
 const response=await f.quote();assert.equal(response.status,200);const body=await response.json();
 assert.equal(body.authorizedCents,450);assert.equal(body.heldCreditCents,400);assert.equal(body.dailyHeldCents,50);
});

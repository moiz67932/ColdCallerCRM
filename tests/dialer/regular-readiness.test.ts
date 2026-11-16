import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {usdCentsFloor} from '../../lib/dialer/budget';

// Exercise the real readiness function with offline provider/database boundaries.
// A report-table lookup or a provider mutation is an unexpected operation.
function fixture(patch:Record<string,unknown>={},limits:{application:number|null;profile:number|null}={application:5,profile:5}) {
 const calls:string[]=[];
 const env={DIALER_PARALLEL_ENABLED:'true',DIALER_CLOUDFLARE_ENABLED:'true',DIALER_CLOUDFLARE_URL:'https://worker.invalid',
 DIALER_CLOUDFLARE_SECRET:'fixture',TELNYX_API_KEY:'fixture',TELNYX_TELEPHONY_CREDENTIAL_ID:'credential',TELNYX_FROM_NUMBER:'+12125550100',
 TELNYX_PUBLIC_KEY:'fixture',TELNYX_PARALLEL_CONNECTION_ID:'app',SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture',
 DIALER_RATE_CEILING_CENTS:2,DIALER_CALLER_NAME:'Fixture Company',...patch};
 const retrieve=(name:string,data:unknown)=>({retrieve:async()=>{calls.push(name);return {data};}});
 const modules:Record<string,unknown>={
 '@/lib/env':{env},
 '@/lib/supabase-admin':{getSupabaseAdmin:()=>({rpc:async(name:string)=>{if(name==='portive_regular_parallel_status')return {data:{schemaVersion:'202611160001',hoursPolicyVersion:'202611160002',reportRequired:false}};assert.equal(name,'portive_parallel_transport_ready');return {data:true};}})},
 '@/lib/telnyx/client':{getTelnyxClient:()=>({
 callControlApplications:retrieve('application',{active:true,webhook_event_url:'https://app.invalid/voice',outbound:{outbound_voice_profile_id:'profile',channel_limit:limits.application}}),
 telephonyCredentials:retrieve('credential',{sip_username:'operator',resource_id:'connection:sip-connection'}),balance:retrieve('balance',{currency:'USD',available_credit:'4.02'}),
 credentialConnections:retrieve('sip-connection',{active:true,sip_uri_calling_preference:patch.sipPreference??'internal'}),
 outboundVoiceProfiles:retrieve('profile',{enabled:true,concurrent_call_limit:limits.profile}),})},
 '@/lib/telnyx/helpers':{getVoiceWebhookUrl:()=> 'https://app.invalid/voice'},
 './orchestration':{orchestrationBackend:()=> 'cloudflare',cloudflareRequest:async(path:string)=>{assert.equal(path,'/internal/inspect');calls.push(path);return {parallelEnabled:true,fingerprint:'fp',callerName:'Fixture Company'};}},
 './parallel-fingerprint':{parallelFingerprint:()=> 'fp'},
 './budget':{usdCentsFloor},
 './budget-settings':{getBudgetConfiguration:async()=>({profile:{source:'fixture'},availableChannels:10,heldCents:0,blockers:patch.budgetMissing?['Account-specific component pricing is missing.']:[]})},
 };
 const code=ts.transpileModule(readFileSync('lib/dialer/parallel-readiness.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const exports:Record<string,any>={};
 new Function('require','exports',code)((name:string)=>{assert(name in modules,`Unexpected import ${name}`);return modules[name];},exports);
 return {ready:exports.parallelReadiness as (live?:boolean)=>Promise<any>,calls};
}
test('normal readiness passes without report or grant, using only live provider reads',async()=>{
 const f=fixture(),r=await f.ready(true);assert.equal(r.enabled,true);assert.equal(r.channels,5);assert.equal(r.budget.profile.source,"fixture");
 assert.equal(r.availableCreditCents,402);assert.equal(r.sipUri,'sip:operator@sip.telnyx.com');
 assert.deepEqual(f.calls,['/internal/inspect','application','credential','balance','profile','sip-connection']);
});
test('registered credentials cannot authorize Start while inbound operator SIP calls are disabled',async()=>{
 const r=await fixture({sipPreference:''}).ready(true);
 assert.equal(r.enabled,false);assert(r.blockers.some((v:string)=>v.includes('Receive SIP URI calls')));
});
test('missing component tariff or caller identity explains the actual configuration problem',async()=>{
 for(const patch of [{budgetMissing:true},{DIALER_CALLER_NAME:''}]){
 const f=fixture(patch),r=await f.ready(true);assert.equal(r.enabled,false);if(!patch.budgetMissing)assert.equal(f.calls.length,0);
 assert(!r.blockers.some((s:string)=>/report|acceptance/.test(s)));
 }
});
test('ordinary flag and signature verification still fail closed',async()=>{
 for(const patch of [{DIALER_PARALLEL_ENABLED:'false'},{TELNYX_SKIP_SIGNATURE_VERIFICATION:'true'}]){
 const r=await fixture(patch).ready(true);assert.equal(r.enabled,false);
 }
});

test('application/profile limits of ten pass their scoped live check without claiming account-wide headroom',async()=>{
 const r=await fixture({}, {application:10,profile:10}).ready(true);assert.equal(r.enabled,true);assert.equal(r.channels,10);
});
test('an unset application limit identifies the exact field even when the profile has ten',async()=>{
 const r=await fixture({}, {application:null,profile:10}).ready(true);assert.equal(r.enabled,false);assert(r.blockers.some((v:string)=>v.includes('outbound.channel_limit=unset')&&v.includes('concurrent_call_limit=10')));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as crypto from 'node:crypto';
import {fundedProspectLimit} from '../../lib/dialer/funded-call';
function fixture(){
 let cached:{observedCents:number;observedAt:string}|null=null,calls=0,limited=false,cooldown=0;
 const db={rpc:async(name:string,p:Record<string,unknown>)=>{
  if(name==='portive_usage_claim')return {data:cached?{cached:true,...cached}:cooldown?{retryAfterSeconds:cooldown}:{claimed:true,failures:0}};
  if(name==='portive_usage_finish'){if(p.p_observed!==undefined){cached={observedCents:Number(p.p_observed),observedAt:new Date().toISOString()};}else cooldown=Number(p.p_retry);return {data:null};}
  throw Error('Unexpected RPC');
 }};
 const modules:Record<string,unknown>={'node:crypto':crypto,'@/lib/supabase-admin':{getSupabaseAdmin:()=>db},'@/lib/telnyx/client':{getTelnyxClient:()=>({usageReports:{list:async()=>{calls++;if(limited)throw Object.assign(Error('private provider body'),{status:429,headers:new Headers({'retry-after':'60'})});return {data:[{cost:'0.002',currency:'USD'}],meta:{total_pages:1}};}}})}};
 const code=ts.transpileModule(readFileSync('lib/dialer/funding.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports:{dailyHeadroom?:(l:number|null,o?:{fresh?:boolean})=>Promise<{cents:number;observedCents:number}>;retryDelay?:(h:Headers,f:number,n:number,r:()=>number)=>number}={};
 new Function('require','exports',code)((n:string)=>{assert(n in modules,n);return modules[n];},exports);
 return {headroom:exports.dailyHeadroom!,delay:exports.retryDelay!,calls:()=>calls,rateLimit:()=>{limited=true;}};
}
test('concurrent quotes coalesce five product reads and subsequent quote uses shared observation',async()=>{
 const f=fixture();const r=await Promise.all(Array.from({length:12},()=>f.headroom(200)));
 assert.equal(f.calls(),5);assert(r.every(x=>x.observedCents===1&&x.cents===199));
 await f.headroom(200);assert.equal(f.calls(),5);
});
test('429 honors Retry-After and shared cooldown never treats missing evidence as zero',async()=>{
 const f=fixture();f.rateLimit();
 await assert.rejects(f.headroom(200),(e:unknown)=>{const x=e as Error&{status:number;retryAfterSeconds:number};return x.status===429&&x.retryAfterSeconds>=60&&!x.message.includes('private');});
 await assert.rejects(f.headroom(200));assert.equal(f.calls(),1);
 const now=Date.now();assert(f.delay(new Headers({'retry-after':new Date(now+90000).toUTCString()}),0,now,()=>0)>=89);
});
test('funded deadline trims maximum duration while keeping a 30s minimum and cleanup allowance',()=>{
 const now=Date.now(),deadline=new Date(now+352000).toISOString();
 assert.equal(fundedProspectLimit(deadline,300,30,now),314);
 assert.throws(()=>fundedProspectLimit(new Date(now+67000).toISOString(),300,30,now),/deadline/);
 assert.equal(fundedProspectLimit(new Date(now+68000).toISOString(),300,30,now),30);
});

test('CDR identity mapping rejects shared or conflicting identifiers rather than guessing by number',async()=>{
 const {matchCdr}=await import('../../lib/dialer/billing-identities');
 const index=new Map([['control:one',new Set(['hold-one'])],['session:shared',new Set(['hold-one','hold-two'])],['browserCall:rtc',new Set(['operator'])]]);
 assert.equal(matchCdr({call_control_id:'one'},index),'hold-one');
 assert.equal(matchCdr({call_id:'rtc'},index),'operator');
 assert.equal(matchCdr({telnyx_session_id:'shared'},index),null);
 assert.equal(matchCdr({call_control_id:'one',telnyx_session_id:'shared'},index),null);
 assert.equal(matchCdr({to:'+13030000000',cost:'0'},index),null);
});

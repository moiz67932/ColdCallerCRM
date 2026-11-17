import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';

function fixture(authenticated=true) {
 const diagnostics:boolean[]=[];
 const modules:Record<string,unknown>={
 'next/server':{NextResponse},zod:{z}, '@/lib/logger':{logInfo:()=>{}},
 '@/lib/api-auth':{requireApiAuth:async()=>authenticated?null:NextResponse.json({error:'Unauthorized'},{status:401})},
 '@/lib/dialer/service':{getCurrentSession:async()=>null,dialerCapabilities:()=>({parallel:true,acceptance:false}),sessionCommand:()=>{throw Error('GET must never create a session');}},
 '@/lib/http':{jsonError:(error:string,status:number)=>NextResponse.json({error},{status}),formatUnknownError:String},
 '@/lib/telnyx/call-flow':{},'@/lib/telnyx/helpers':{},
 '@/lib/supabase-admin':{getSupabaseAdmin:()=>({from:(table:string)=>{assert.equal(table,'lead_lists');return {select:()=>({order:async()=>({data:[]})})};}})},
 '@/lib/dialer/parallel-readiness':{parallelReadiness:async(live:boolean)=>{diagnostics.push(live);return {enabled:true,blockers:[],channels:5,availableCreditCents:400,fingerprint:'fixture',budget:{availableChannels:5,capacity:{verification:'manual'}}};}},
 '@/lib/dialer/parallel-policy':{defaultParallelOptions:{}},'@/lib/env':{env:{DIALER_ACCEPTANCE_ENABLED:'false'}},
 };
 const code=ts.transpileModule(readFileSync('app/api/dial-sessions/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const result:{GET?:(r:NextRequest)=>Promise<NextResponse>}={};
 new Function('require','exports',code)((name:string)=>{assert(name in modules,`Unexpected import ${name}`);return modules[name];},result);
 return {get:result.GET!,diagnostics};
}
test('authenticated live readiness GET returns diagnostics without creating work',async()=>{
 const f=fixture();const r=await f.get(new NextRequest('https://fixture.invalid/api/dial-sessions?verifyProvider=true'));
 assert.equal(r.status,200);const body=await r.json();assert.equal(body.session,null);
 assert.equal(body.providerReadiness.channels,5);assert.equal(body.capabilities.parallel,true);assert.deepEqual(f.diagnostics,[true]);
});
test('ordinary GET remains inexpensive and unauthenticated diagnostics remain denied',async()=>{
 const f=fixture();const r=await f.get(new NextRequest('https://fixture.invalid/api/dial-sessions'));
 assert.equal((await r.json()).providerReadiness,undefined);assert.deepEqual(f.diagnostics,[false]);
 const denied=fixture(false);assert.equal((await denied.get(new NextRequest('https://fixture.invalid/api/dial-sessions?verifyProvider=true'))).status,401);
 assert.deepEqual(denied.diagnostics,[]);
});

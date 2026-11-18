import assert from 'node:assert/strict';
import test from 'node:test';
import Telnyx from 'telnyx';
import {createRequire} from 'node:module';
// The Worker owns its platform types; load its real runtime code without pulling
// DurableObject globals into the Next.js TypeScript program.
const load=createRequire(`${process.cwd()}/package.json`);
const {executeCommand}=load(`${process.cwd()}/cloudflare/portive-dialer/src/executor.ts`) as {
 executeCommand:(command:unknown,env:unknown,db:unknown,api:unknown)=>Promise<void>;
};
const {Database,TelnyxApi}=load(`${process.cwd()}/cloudflare/portive-dialer/src/adapters.ts`) as {
 Database:new(env:Record<string,string>)=>unknown;TelnyxApi:new(env:Record<string,string>)=>unknown;
};

test('Worker bridge HTTP body matches the installed Telnyx SDK wire contract, not its argument alias',async()=>{
 const outgoing:Array<{url:string;body:Record<string,unknown>}> = [];
 const sdk = new Telnyx({apiKey:'offline-fixture',maxRetries:0,fetch:async(input,init)=>{
  outgoing.push({url:String(input),body:JSON.parse(String(init?.body))});
  return Response.json({data:{result:'ok'}});
 }});
 const commandId='11111111-1111-4111-8111-111111111111';
 await sdk.calls.actions.bridge('operator',{call_control_id_to_bridge_with:'prospect',command_id:commandId,park_after_unbridge:'self',prevent_double_bridge:true});
 assert.equal(outgoing[0].body.call_control_id,'prospect');
 assert(!('call_control_id_to_bridge_with' in outgoing[0].body));
 const original=globalThis.fetch;
 const command={id:commandId,action:'bridge',session_id:'session',attempt_id:'attempt',parameters:{},
  session:{id:'session',mode:'parallel',status:'running',controller_id:commandId,active_call_id:'attempt',operator_call_control_id:'operator',browser_media_ready:true,orchestration_backend:'cloudflare',parallel_options:{answerPolicy:'first_answer',fingerprint:'fixture',operatorSipUri:'sip:fixture',ringTimeout:15,maxCallSeconds:60}},
  attempt:{id:'attempt',ended_at:null,answered_at:new Date().toISOString(),termination_reason:null,answer_classification:'unknown',telnyx_call_control_id:'prospect',telnyx_agent_call_control_id:null}};
 const env={SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'offline-database',TELNYX_API_KEY:'offline-provider'};
 const calls:Array<{url:string;body:Record<string,unknown>}>=[];
 try{
  globalThis.fetch=async(input,init)=>{
   const url=String(input),body=JSON.parse(String(init?.body));calls.push({url,body});
   if(url.endsWith('portive_orchestration_authorize'))return Response.json({allowed:true});
   if(url.includes('api.telnyx.com')){
    // Enforce the SDK-derived provider contract; reject the old alias with 422.
    return body.call_control_id==='prospect'&&!('call_control_id_to_bridge_with' in body)
     ?Response.json({data:{result:'ok'}}):Response.json({errors:[{code:'10004',detail:'call_control_id is required'}]},{status:422});
   }
   if(url.endsWith('portive_orchestration_complete'))return Response.json(null);
   throw Error('Unexpected fixture request');
  };
  await executeCommand(command,env,new Database(env),new TelnyxApi(env));
 }finally{globalThis.fetch=original;}
 const bridge=calls.find(c=>c.url.includes('api.telnyx.com'));
 assert(bridge);assert.deepEqual(bridge.body,outgoing[0].body);
 assert.equal(calls.filter(c=>c.url.includes('api.telnyx.com')).length,1);
 assert.equal(calls.find(c=>c.url.endsWith('portive_orchestration_complete'))?.body.p_ok,true);
});

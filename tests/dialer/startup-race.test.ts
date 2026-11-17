import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Execute the production notification handler. Any fall-through into Manual
// processing fails, including the historical-attempt write in the incident.
const source=readFileSync('app/(protected)/queue/page.tsx','utf8');
const file=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let handler='';
function visit(n:ts.Node){if(ts.isFunctionDeclaration(n)&&n.name?.text==='handleWebRtcNotification')handler=n.getText(file);ts.forEachChild(n,visit);}
visit(file);assert(handler);
function fixture(){
 const ref=<T>(current:T)=>({current});
 const state={webRtcClientGenerationRef:ref(1),callingModeRef:ref('parallel'),parkedOperatorCallIdRef:ref<string|null>(null),
 dialSessionRef:ref<null|{operator_call_control_id:string}>(null),answeredWebRtcCallIdsRef:ref(new Set()),webRtcCallRef:ref<unknown>(null),
 refreshParallelMediaRef:ref(()=>{refreshes++;}),setError:(s:string)=>{errors.push(s);},setWebrtcStatus:()=>{},
 getWebRtcCallControlId:(call:{telnyxIDs?:{telnyxCallControlId:string}})=>call?.telnyxIDs?.telnyxCallControlId??null,
 finishedWebRtcCallsRef:ref(new Set()),remoteAudioRef:ref(null),logBrowserWebRtcEvent:()=>{throw Error('Operator event entered Manual history');}};
 let refreshes=0;const errors:string[]=[];
 const code=ts.transpileModule(handler,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const run=new Function(...Object.keys(state),`${code};return handleWebRtcNotification;`)(...Object.values(state));
 return {state,run,errors,refreshes:()=>refreshes};
}
test('operator INVITE before Start returns answers once and never updates an old Manual attempt',async()=>{
 const f=fixture();let answers=0;
 const call={id:'operator-browser',direction:'inbound',state:'new',telnyxIDs:{telnyxCallControlId:'operator-control'},answer:async()=>{answers++;}};
 for(const state of ['new','ringing','ringing','active']){call.state=state;await f.run({type:'callUpdate',call},1);}
 assert.equal(answers,1);assert.equal(f.state.webRtcCallRef.current,call);assert.equal(f.refreshes(),1);
 f.state.dialSessionRef.current={operator_call_control_id:'operator-control'};
 call.state='active';await f.run({type:'callUpdate',call},1);assert.equal(f.refreshes(),2);
 await f.run({type:'callUpdate',call:{...call,telnyxIDs:{telnyxCallControlId:'another-call'}}},1);
 assert.equal(f.state.webRtcCallRef.current,call);
 call.state='destroy';await f.run({type:'callUpdate',call},1);assert.equal(f.state.webRtcCallRef.current,null);
 assert.deepEqual(f.errors,[]);
});
test('obsolete SDK generation cannot answer or restore a parked connection',async()=>{
 const f=fixture();await f.run({type:'callUpdate',call:{state:'ringing',direction:'inbound',answer:()=>{throw Error('stale answer');}}},0);
 assert.equal(f.state.webRtcCallRef.current,null);assert.equal(f.refreshes(),0);
});

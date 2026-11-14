import test from 'node:test';
import assert from 'node:assert/strict';
import {signInternal,verifyInternal} from '../../lib/dialer/internal-auth';
import {controlledScenarios,cloudflareScenarios,evidenceBlockers} from '../../lib/dialer/parallel-policy';
const secret='fixture-at-least-32-character-secret';
test('internal orchestration HMAC authenticates exact body and route',async()=>{
 const headers=new Headers(await signInternal(secret,'/internal/prepare','{}'));
 assert(await verifyInternal(secret,'/internal/prepare','{}',headers));
 assert.equal(await verifyInternal(secret,'/internal/prepare','{"changed":true}',headers),false);
 assert.equal(await verifyInternal(secret,'/internal/session/other','{}',headers),false);
 assert.equal(await verifyInternal('wrong-secret','/internal/prepare','{}',headers),false);
});
test('expired and malformed orchestration signatures fail closed',async()=>{
 const headers=new Headers(await signInternal(secret,'/route','{}',String(Date.now()-120000)));
 assert.equal(await verifyInternal(secret,'/route','{}',headers),false);
 assert.equal(await verifyInternal(secret,'/route','{}',new Headers()),false);
});
const evidence={suite:'portive-parallel-v1',passed:true,scenarios:Object.fromEntries(controlledScenarios.map(s=>[s,true])),max_answer_to_audio_ms:1000,provider_call_ids:['a','b','c','d']};
test('existing Node verification cannot authorize a new Cloudflare runtime',()=>{assert.deepEqual(evidenceBlockers(evidence),[]);assert(evidenceBlockers(evidence,'cloudflare').length>0);});
test('Cloudflare release needs provider tests plus measured p50 p95 and maximum',()=>{
 const report={...evidence,orchestration_backend:'cloudflare',scenarios:{...evidence.scenarios,...Object.fromEntries(cloudflareScenarios.map(s=>[s,true]))},cloudflare_latency:{p50_ms:500,p95_ms:900,max_ms:1200}};
 assert.deepEqual(evidenceBlockers(report,'cloudflare'),[]);
 assert(evidenceBlockers({...report,cloudflare_latency:{p50_ms:500,p95_ms:900,max_ms:2000}},'cloudflare').length>0);
});
test('invalid negative, unordered or nonfinite latency cannot release Cloudflare calling',()=>{
 const report={...evidence,orchestration_backend:'cloudflare',scenarios:{...evidence.scenarios,...Object.fromEntries(cloudflareScenarios.map(s=>[s,true]))}};
 for(const latency of [{p50_ms:100,p95_ms:50,max_ms:900},{p50_ms:NaN,p95_ms:100,max_ms:500},{p50_ms:-1,p95_ms:100,max_ms:200}])assert(evidenceBlockers({...report,cloudflare_latency:latency},'cloudflare').length>0);
});

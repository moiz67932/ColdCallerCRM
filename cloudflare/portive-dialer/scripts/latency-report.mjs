// Use measured, correlated samples from the controlled provider/media run.
// Input: [{attemptId, providerAnswerAt, operatorAudioAt, ...stage timestamps}].
import { readFileSync } from 'node:fs';
const samples=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(!Array.isArray(samples)||!samples.length)throw new Error('No controlled latency samples; live latency remains unverified');
const values=samples.map(s=>{const n=Date.parse(s.operatorAudioAt)-Date.parse(s.providerAnswerAt);if(!s.attemptId||!Number.isFinite(n)||n<0)throw new Error('Invalid or uncorrelated timestamps');return n;}).sort((a,b)=>a-b);
const percentile=p=>values[Math.max(0,Math.ceil(values.length*p)-1)];
console.log(JSON.stringify({samples:values.length,p50_ms:percentile(.5),p95_ms:percentile(.95),max_ms:values.at(-1),meets1500msTarget:values.at(-1)<=1500,source:'user-supplied controlled measurements; no certification implied'},null,2));

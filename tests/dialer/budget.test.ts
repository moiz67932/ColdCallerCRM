import assert from 'node:assert/strict';
import test from 'node:test';
import {usdCentsFloor,budgetQuote,chargeMicros,costProfileSchema,pricingProblems,confirmedCapacity} from '../../lib/dialer/budget';
// Synthetic arithmetic fixture, never a production tariff or billing assertion.
export const profile=costProfileSchema.parse({version:'exposure-v1',currency:'USD',source:'Synthetic arithmetic fixture only',reviewedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),destinationPrefixes:['+1212'],sipPerMinuteMicros:5000,operatorSipPerMinuteMicros:2000,callControlPerMinuteMicros:2000,webrtcPerMinuteMicros:2000,bridgePerMinuteMicros:0,recordingPerMinuteMicros:0,otherPerMinuteMicros:0,amdPerCallMicros:6500,ttsPerCharacterMicros:9,operatorFixedMicros:0,prospectFixedMicros:0,minimumSeconds:60,incrementSeconds:60});
test('component-priced four-leg failure caps and normal winner estimate are separate',()=>{
 for(const [duration,required,expected] of [[60,14,11],[120,19,13],[300,29,17]]){
  const q=budgetQuote(profile,{maxCallSeconds:duration,ringTimeout:15,maxSpendCents:100},4);
  assert.equal(q.requiredCents,required);assert.equal(q.expectedCents,expected);
  assert.equal(q.requiredCents,q.operatorCents+4*q.prospectCents);
 }
});
test('duration is explicitly bounded and cannot leave an unfunded conversation',()=>{
 assert.throws(()=>budgetQuote(profile,{maxCallSeconds:300,sessionSeconds:180,ringTimeout:15,maxSpendCents:100},4),/Session duration/);
 assert.throws(()=>budgetQuote(profile,{maxCallSeconds:60,sessionSeconds:3601,ringTimeout:15,maxSpendCents:100},4));
 const q=budgetQuote(profile,{maxCallSeconds:300,ringTimeout:15,maxSpendCents:20},4);assert.equal(q.shortfallCents,9);
});
test('minimum/increment boundaries and fixed AMD/TTS are reserved on every possible loser',()=>{
 assert.equal(chargeMicros(61,7000,10100,profile),24100);
 assert.equal(chargeMicros(1,7000,10100,profile),17100);
 const p={...profile,amdPerCallMicros:200000};assert(budgetQuote(p,{maxCallSeconds:60,ringTimeout:15,maxSpendCents:100},4).requiredCents>80);
});
test('unknown, fractional and stale tariff components cannot authorize a quote profile',()=>{
 assert.equal(costProfileSchema.safeParse({...profile,sipPerMinuteMicros:undefined}).success,false);
 assert.equal(costProfileSchema.safeParse({...profile,sipPerMinuteMicros:0.1}).success,false);
 assert(pricingProblems({...profile,expiresAt:new Date(Date.now()-1).toISOString()}).length);
 assert(pricingProblems({...profile,expiresAt:new Date(Date.now()+8*86400000).toISOString()}).length);
});
test('account capacity is explicitly manual and expires within four hours',()=>{
 const c={totalChannels:10,availableChannels:5,reference:'Mission Control screenshot reference',confirmedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),verification:'manual' as const};
 assert.equal(confirmedCapacity(c),5);assert.equal(confirmedCapacity({...c,expiresAt:new Date(Date.now()-1).toISOString()}),0);
 assert.equal(confirmedCapacity({...c,availableChannels:11}),0);
 assert.equal(confirmedCapacity({...c,expiresAt:new Date(Date.now()+5*3600000).toISOString()}),0);
});

test('provider credit uses exact decimal cents without the 4.02 to 4.01 float truncation',()=>{assert.equal(usdCentsFloor('4.02'),402);assert.equal(usdCentsFloor('0.019'),1);assert.throws(()=>usdCentsFloor('-1'));});

test('owner provisional pricing warns rather than expires; verified mode still expires',()=>{
 const stale={...profile,expiresAt:'2020-01-01T00:00:00Z'};
 assert(pricingProblems(stale).length);
 assert.deepEqual(pricingProblems({...stale,pricingMode:'owner-provisional'}),[]);
});

test('owner provisional expiry warns without blocking; verified expiry still blocks',async()=>{
 const {pricingWarnings}=await import('../../lib/dialer/budget');
 const stale={...profile,pricingMode:'owner-provisional' as const,expiresAt:new Date(Date.now()-1000).toISOString()};
 assert.deepEqual(pricingProblems(stale),[]);assert(pricingWarnings(stale).some(w=>w.includes('stale')));
 assert(pricingProblems({...stale,pricingMode:'verified'}).length);
});
test('owner padded allowances fund four full failure caps within the default dollar',()=>{
 const p={...profile,sipPerMinuteMicros:10000,operatorSipPerMinuteMicros:3000,callControlPerMinuteMicros:3000,webrtcPerMinuteMicros:3000,recordingPerMinuteMicros:3000,bridgePerMinuteMicros:2000,otherPerMinuteMicros:3000,amdPerCallMicros:10000,ttsPerCharacterMicros:48,operatorFixedMicros:10000,prospectFixedMicros:10000};
 for(const [duration,cents]of [[60,42],[120,51],[300,80]])assert.equal(budgetQuote(p,{maxCallSeconds:duration,ringTimeout:15,maxSpendCents:100},4).requiredCents,cents);
});

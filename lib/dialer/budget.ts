import {z} from 'zod';

// All monetary arithmetic uses integer millionths of USD; round up only when
// reserving a leg in the existing whole-cent ledger. No published starting rate
// is used as an authorization tariff.
const money=z.number().int().min(0).max(100_000_000);
export const costProfileSchema=z.object({
  version:z.literal('exposure-v1'),currency:z.literal('USD'),
  source:z.string().min(8),reviewedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),
  destinationPrefixes:z.array(z.string().regex(/^\+1\d{2,13}$/)).min(1),
  sipPerMinuteMicros:money,operatorSipPerMinuteMicros:money,callControlPerMinuteMicros:money,webrtcPerMinuteMicros:money,
  bridgePerMinuteMicros:money,recordingPerMinuteMicros:money,otherPerMinuteMicros:money,
  amdPerCallMicros:money,ttsPerCharacterMicros:money,
  operatorFixedMicros:money,prospectFixedMicros:money,
  minimumSeconds:z.number().int().min(1).max(300),incrementSeconds:z.number().int().min(1).max(60),
}).strict();
export type CostProfile=z.infer<typeof costProfileSchema>;
export const SESSION_GRACE_SECONDS=15;
export const MAX_COLLISION_CHARACTERS=400;
export type BudgetOptions={maxCallSeconds:number;sessionSeconds?:number;ringTimeout:number;maxSpendCents:number};
const cents=(micros:number)=>Math.ceil(micros/10_000);
export function chargeMicros(seconds:number,perMinute:number,fixed:number,p:CostProfile){
  const billable=Math.max(p.minimumSeconds,Math.ceil(seconds/p.incrementSeconds)*p.incrementSeconds);
  return Math.ceil(billable*perMinute/60+fixed);
}
export function budgetQuote(p:CostProfile,o:BudgetOptions,lines:number){
  if(!Number.isInteger(lines)||lines<1||lines>4||!Number.isInteger(o.maxCallSeconds)||o.maxCallSeconds<30||o.maxCallSeconds>1800)throw Error('Invalid duration or line count');
  const sessionSeconds=o.sessionSeconds??o.maxCallSeconds+o.ringTimeout+60;
  if(!Number.isInteger(sessionSeconds)||sessionSeconds<o.maxCallSeconds+o.ringTimeout+60||sessionSeconds>3600)throw Error('Session duration must cover ringing, conversation and 60 seconds for setup/cleanup (maximum one hour)');
  const operatorRate=p.callControlPerMinuteMicros+p.webrtcPerMinuteMicros+p.operatorSipPerMinuteMicros+p.recordingPerMinuteMicros+p.otherPerMinuteMicros;
  const prospectRate=p.sipPerMinuteMicros+p.callControlPerMinuteMicros+p.bridgePerMinuteMicros+p.recordingPerMinuteMicros+p.otherPerMinuteMicros;
  const fixed=p.amdPerCallMicros+p.prospectFixedMicros+MAX_COLLISION_CHARACTERS*p.ttsPerCharacterMicros;
  const operatorCents=cents(chargeMicros(sessionSeconds,operatorRate,p.operatorFixedMicros,p));
  const prospectCents=cents(chargeMicros(o.maxCallSeconds+SESSION_GRACE_SECONDS,prospectRate,fixed,p));
  const loserCents=cents(chargeMicros(Math.min(o.maxCallSeconds+SESSION_GRACE_SECONDS,30),prospectRate,fixed,p));
  const requiredCents=operatorCents+lines*prospectCents;
  return {sessionSeconds,operatorCents,prospectCents,loserCents,
    expectedCents:operatorCents+prospectCents+Math.max(0,lines-1)*loserCents,
    requiredCents,shortfallCents:Math.max(0,requiredCents-o.maxSpendCents),
    explanation:'Expected assumes one winner and prompt loser cleanup. Maximum funds every provider hard cap, including delayed/failed loser hangups. Uncertain charges stay reserved.'};
}
export function pricingProblems(p:CostProfile,now=Date.now()){
  return Date.parse(p.reviewedAt)>now||Date.parse(p.expiresAt)<=now||Date.parse(p.expiresAt)>Date.parse(p.reviewedAt)+7*86400000
    ?['Refresh the account tariff components and source reference (maximum seven-day freshness).']:[];
}
export const capacityConfirmationSchema=z.object({totalChannels:z.number().int().min(1).max(100000),availableChannels:z.number().int().min(1).max(100000),reference:z.string().min(8).max(500)}).refine(v=>v.availableChannels<=v.totalChannels,'Available channels cannot exceed the account ceiling');
export type CapacityConfirmation=z.infer<typeof capacityConfirmationSchema>&{confirmedAt:string;expiresAt:string;verification:'manual'};
export function confirmedCapacity(v:CapacityConfirmation|null,now=Date.now()){
  return v&&v.verification==='manual'&&capacityConfirmationSchema.safeParse(v).success&&Date.parse(v.confirmedAt)<=now&&Date.parse(v.expiresAt)>now&&Date.parse(v.expiresAt)<=Date.parse(v.confirmedAt)+4*3600000?v.availableChannels:0;
}

// Provider decimal strings must not lose a cent through binary floating point.
export function usdCentsFloor(value:string){
 const match=/^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
 if(!match)throw Error('Invalid nonnegative USD amount');
 const cents=Number(match[1])*100+Number((match[2]??'').padEnd(2,'0').slice(0,2));
 if(!Number.isSafeInteger(cents))throw Error('USD amount exceeds safe ledger range');return cents;
}

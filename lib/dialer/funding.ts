import {createHash,randomUUID} from 'node:crypto';
import {getTelnyxClient} from '@/lib/telnyx/client';
import {getSupabaseAdmin} from '@/lib/supabase-admin';

export class FundingUnavailable extends Error {
 constructor(public retryAfterSeconds:number, public status=503) {
  super(status===429?'Telnyx usage reports are rate limited. Waiting for fresh spending evidence; retry after the indicated delay.':'Fresh daily spending evidence is unavailable; dialing remains blocked until it refreshes.');
 }
}
export function retryDelay(headers:Headers|undefined,failures:number,now=Date.now(),random=Math.random) {
 const value=headers?.get('retry-after');
 const provider=value ? (/^\d+(\.\d+)?$/.test(value)?Number(value):Math.max(0,(Date.parse(value)-now)/1000)) : 0;
 return Math.min(86400,Math.max(Number.isFinite(provider)?Math.ceil(provider):0,Math.ceil(Math.min(300,5*2**Math.min(failures,6))*(1+random()*0.25))));
}
type Observation={observedCents:number;observedAt:string};
const pending=new Map<string,Promise<Observation>>();
async function observe(key:string,maxAge:number):Promise<Observation>{
 const db=getSupabaseAdmin(),owner=randomUUID();
 for(let i=0;i<10;i++){
  const r=await db.rpc('portive_usage_claim',{p_key:key,p_owner:owner,p_max_age:maxAge});
  if(r.error)throw new FundingUnavailable(30);
  if(r.data.cached)return r.data;
  if(r.data.retryAfterSeconds)throw new FundingUnavailable(r.data.retryAfterSeconds,429);
  if(r.data.claimed){
   try {
    let usd=0;
    // One shared refresh per account/day. Disable SDK retries: a 429 creates a
    // shared cooldown instead of another burst from each Vercel instance.
    for(const product of ['sip-trunking','call-control','webrtc','amd','call-control-features']){
     const page=await getTelnyxClient().usageReports.list({product,dimensions:['currency'],metrics:['cost'],date_range:'today','page[size]':50},{maxRetries:0,timeout:5000});
     if((page.meta?.total_pages??1)>1)throw Error('Incomplete usage report');
     for(const row of page.data){const cost=Number(row.cost);if(!Number.isFinite(cost)||cost<0||row.currency!=='USD')throw Error('Unusable USD usage evidence');usd+=cost;}
    }
    const observedCents=Math.ceil(usd*100);
    const saved=await db.rpc('portive_usage_finish',{p_key:key,p_owner:owner,p_observed:observedCents});if(saved.error)throw Error('Usage observation persistence failed');
    return {observedCents,observedAt:new Date().toISOString()};
   }catch(error){
    const e=error as {status?:number;headers?:Headers};const delay=retryDelay(e.headers,r.data.failures??0);
    await db.rpc('portive_usage_finish',{p_key:key,p_owner:owner,p_retry:delay});
    throw new FundingUnavailable(delay,e.status===429?429:503);
   }
  }
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 throw new FundingUnavailable(3);
}
// Quote snapshots may be cached for 60s. Start always requires a <=5s snapshot,
// and still reserves every app leg in SQL; unavailable evidence never means zero.
export async function dailyHeadroom(limitCents:number|null,options:{fresh?:boolean}={}){
 if(limitCents===null)return {cents:2147483647,observedCents:0,scope:'no_profile_daily_limit'};
 const account=createHash('sha256').update(process.env.TELNYX_API_KEY??'missing').digest('hex').slice(0,16);
 const key=`voice-usage:${account}:${new Date().toISOString().slice(0,10)}`,maxAge=options.fresh?5:60;
 const scopeKey=key+':'+maxAge;
 let request=pending.get(scopeKey);
 if(!request){request=observe(key,maxAge);pending.set(scopeKey,request);void request.finally(()=>pending.delete(scopeKey)).catch(()=>{});}
 const o=await request;
 return {cents:Math.max(0,limitCents-o.observedCents),observedCents:o.observedCents,observedAt:o.observedAt,scope:'account_voice_products_conservative'};
}

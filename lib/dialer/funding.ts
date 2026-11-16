import {getTelnyxClient} from '@/lib/telnyx/client';
// A conservative lower bound: subtract account-wide voice charges, rather than
// claiming that an application/profile limit reserves any account balance.
export async function dailyHeadroom(limitCents:number|null){
 if(limitCents===null)return {cents:2147483647,observedCents:0,scope:'no_profile_daily_limit'};
 const c=getTelnyxClient();
 const pages=await Promise.all(['sip-trunking','call-control','webrtc','amd','call-control-features'].map(product=>c.usageReports.list({product,dimensions:['currency'],metrics:['cost'],date_range:'today','page[size]':50})));
 let usd=0;
 for(const page of pages)for(const row of page.data){
  const cost=Number(row.cost);if(!Number.isFinite(cost)||cost<0||row.currency!=='USD')throw Error('Current USD usage is unavailable; cannot establish remaining daily headroom');usd+=cost;
 }
 const observedCents=Math.ceil(usd*100);
 return {cents:Math.max(0,limitCents-observedCents),observedCents,scope:'account_voice_products_conservative'};
}

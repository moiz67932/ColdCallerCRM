"use client";
import {useEffect,useState} from 'react';
import type {ParallelOptions} from '@/lib/dialer/parallel-policy';
import type {budgetQuote,CapacityConfirmation} from '@/lib/dialer/budget';
import {Button} from '@/components/ui/button';
type Quote=ReturnType<typeof budgetQuote>;
type Data={warnings?:string[];pricingMode?:string;quote:Quote|null;presets:Array<Quote&{maxCallSeconds:number}>;authorizedCents:number;shortfallCents:number|null;availableCreditCents:number;dailyHeadroomCents:number;pricingSource:string|null;capacity:CapacityConfirmation|null;blockers:string[];eligibility:{eligible:number;reasons:Record<string,number>}|null;nextWindow:{at:string|null;timeZone:string}|null;billing:{heldCents:number;actualObservedMicros:number;reconciledCents:number;billingComplete:boolean}|null};
export function BudgetPreflight(p:{listId:string;parallelLocation?:string;timeZone:string;lines:number;options:ParallelOptions;sessionId?:string;onOptions:(v:ParallelOptions)=>void;onReady:(v:boolean)=>void;onBlockers:(v:string[])=>void}){
 const [data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[nonce,setNonce]=useState(0),[capacityExpired,setCapacityExpired]=useState(true);
 const [total,setTotal]=useState(''),[available,setAvailable]=useState(''),[reference,setReference]=useState(''),[saving,setSaving]=useState(false);
 const {listId,parallelLocation,timeZone,lines,options,sessionId,onReady,onBlockers}=p;
 useEffect(()=>{
  if(!listId){onReady(false);return;}
  let closed=false,next:ReturnType<typeof setTimeout>|undefined,poll:ReturnType<typeof setTimeout>|undefined,failures=0,retryAfterMs=0;const abort=new AbortController();
  onReady(false);
  async function refresh(){try{
   const params=new URLSearchParams({listId,...(parallelLocation?{parallelLocation}:{}),timeZone,lines:String(lines),maxCallSeconds:String(options.maxCallSeconds),sessionSeconds:String(options.sessionSeconds??options.maxCallSeconds+options.ringTimeout+60),ringTimeout:String(options.ringTimeout),maxSpendCents:String(options.maxSpendCents),...(sessionId?{sessionId}:{}),...(nonce?{fresh:'true'}:{})});
   const response=await fetch('/api/dial-sessions/quote?'+params,{cache:'no-store',signal:abort.signal});const d=await response.json();if(closed)return;if(!response.ok){retryAfterMs=Math.max(0,Number(response.headers.get('Retry-After')??d.retryAfterSeconds??0)*1000);throw Error(d.error);}
   failures=0;retryAfterMs=0;setData(d);setCapacityExpired(!d.capacity||Date.parse(d.capacity.expiresAt)<=Date.now());setError('');onBlockers(d.blockers);onReady(Boolean(d.quote)&&d.shortfallCents===0&&d.blockers.length===0&&d.eligibility?.eligible>0&&(d.pricingMode!=='owner-provisional'||options.spendingApproved===true));
   if(next)clearTimeout(next);
   if(d.eligibility?.eligible===0&&d.nextWindow?.at){const delay=Date.parse(d.nextWindow.at)-Date.now()+300;if(delay>0&&delay<2147483647)next=setTimeout(refresh,delay);}
  }catch(e){if(!closed){failures++;setError(e instanceof Error?e.message:'Cost preflight unavailable');onReady(false);}}
  finally{if(!closed){if(poll)clearTimeout(poll);poll=setTimeout(refresh,Math.max(retryAfterMs,Math.min(120000,45000*2**Math.min(failures,2)))*(1+Math.random()*0.1));}}}
  const debounce=setTimeout(refresh,350);
  return()=>{closed=true;abort.abort();clearTimeout(debounce);if(poll)clearTimeout(poll);if(next)clearTimeout(next);};
 },[listId,parallelLocation,timeZone,lines,options,sessionId,nonce,onReady,onBlockers]);
 const dollars=(c:number)=>'$'+(c/100).toFixed(2);
 async function confirm(){setSaving(true);try{
  const r=await fetch('/api/dial-sessions/capacity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({totalChannels:Number(total),availableChannels:Number(available),reference})});const d=await r.json();if(!r.ok)throw Error(d.error);setNonce(Date.now());
 }catch(e){setError(e instanceof Error?e.message:'Capacity confirmation failed');}finally{setSaving(false);}}
 return <div className="space-y-2 rounded border border-slate-500/30 p-3 text-sm" aria-label="Parallel cost preflight">
  {data?.warnings?.map(w=><p key={w} role="status">{w}</p>)}
  {data?.pricingMode==='owner-provisional'?<label><input type="checkbox" checked={options.spendingApproved===true} disabled={Boolean(sessionId)} onChange={e=>p.onOptions({...options,spendingApproved:e.target.checked})}/> I approve a session spending limit of {dollars(options.maxSpendCents)} using the disclosed provisional estimates. Actual charges may differ.</label>:null}
  <div className="flex flex-wrap gap-2">{[60,120,300].map(seconds=><Button key={seconds} size="sm" variant="outline" disabled={Boolean(sessionId)} onClick={()=>p.onOptions({...options,maxCallSeconds:seconds,sessionSeconds:seconds+options.ringTimeout+60})}>{seconds/60}-minute conversation</Button>)}
   <label>Session hard limit (seconds) <input aria-label="Session hard limit" type="number" min={60} max={3600} className="w-24 rounded border bg-background p-1" disabled={Boolean(sessionId)} value={options.sessionSeconds??options.maxCallSeconds+options.ringTimeout+60} onChange={e=>p.onOptions({...options,sessionSeconds:Number(e.target.value)})}/></label>
  </div>
  {data?.quote?<>
   <p>Estimated normal batch: <strong>{dollars(data.quote.expectedCents)}</strong> · Maximum initial exposure: <strong>{dollars(data.quote.requiredCents)}</strong> · Authorized session ceiling: {dollars(data.authorizedCents)}</p>
   <p>Operator reserve {dollars(data.quote.operatorCents)} · Prospect hard-cap reserve {dollars(data.quote.prospectCents)} each · Available credit {dollars(data.availableCreditCents)} · Daily headroom {dollars(data.dailyHeadroomCents)}</p>
   <p className="text-xs text-slate-500">{data.quote.explanation} Pricing source: {data.pricingSource}</p>
   {Boolean(data.shortfallCents)&&<p role="alert">Shortfall: {dollars(data.shortfallCents!)}. Lower-cost settings that fit: {data.presets.filter(v=>v.requiredCents<=data.authorizedCents).map(v=>`${v.maxCallSeconds}s (${dollars(v.requiredCents)})`).join(', ')||'none for this line count; reduce lines or revise the funded duration.'}</p>}
  </>:<p>Account-specific tariff components are required for a priced quote. Missing billing data is not treated as zero cost.</p>}
  {data?.billing&&sessionId?<p>Provider charges observed: {dollars(data.billing.actualObservedMicros/10000)} ({data.billing.billingComplete?'finalized':'partial; awaiting complete bills'}) · Outstanding reserved exposure: {dollars(data.billing.heldCents)} · Uncommitted session budget: {dollars(Math.max(0,options.maxSpendCents-data.billing.heldCents-data.billing.reconciledCents))}</p>:null}
  {data?.eligibility?<p>Currently eligible: {data.eligibility.eligible}. {data.eligibility.eligible===0?Object.entries(data.eligibility.reasons).map(([k,n])=>`${n} ${k.replaceAll('_',' ')}`).join('; '):''}</p>:null}
  {data?.nextWindow?.at&&data.eligibility?.eligible===0?<p>Next recipient-local policy window: {new Intl.DateTimeFormat(undefined,{timeZone:data.nextWindow.timeZone,dateStyle:'medium',timeStyle:'long'}).format(new Date(data.nextWindow.at))}. Eligibility refreshes automatically when it opens.</p>:null}
  {data?.capacity?<p>Account capacity: manually confirmed {data.capacity.availableChannels} available / {data.capacity.totalChannels} ceiling at {data.capacity.confirmedAt}; expires {data.capacity.expiresAt}. This is not API verification.</p>:null}
  {!data?.capacity||capacityExpired?<div className="flex flex-wrap items-end gap-2">
   <p className="w-full">Mission Control → Voice → Outbound Voice Profiles → Account Level Outbound Concurrent Call Limit. Confirm actual free headroom after other calls. No calling is initiated here.</p>
   <label>Account ceiling <input aria-label="Account channel ceiling" type="number" min={1} className="w-20 rounded border bg-background p-1" value={total} onChange={e=>setTotal(e.target.value)}/></label>
   <label>Available channels <input aria-label="Available account channels" type="number" min={1} className="w-20 rounded border bg-background p-1" value={available} onChange={e=>setAvailable(e.target.value)}/></label>
   <label>Portal/support reference <input aria-label="Capacity evidence reference" className="rounded border bg-background p-1" value={reference} onChange={e=>setReference(e.target.value)}/></label>
   <Button size="sm" disabled={saving||!total||!available||reference.length<8} onClick={()=>void confirm()}>Record manual capacity confirmation</Button>
  </div>:null}
  {error?<p role="alert" className="text-red-600">{error}</p>:null}
 </div>;
}

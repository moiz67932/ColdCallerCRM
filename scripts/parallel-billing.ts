import {readFileSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
import Telnyx from 'telnyx';
import {costProfileSchema,pricingProblems,budgetQuote} from '../lib/dialer/budget';

// No dialing methods. Rates are explicitly imported; published starting prices
// are never silently installed. Reconciliation defaults to partial/hold retained.
async function main(){
 const required=(key:string)=>{const value=process.env[key];if(!value)throw Error(`Missing ${key}`);return value;};
 const [action,file,reference]=process.argv.slice(2);
 if(!['quote','configure','sync','finalize'].includes(action))throw Error('Usage: parallel-billing.ts quote|configure PROFILE.json | sync | finalize INVOICE_RECORDS.json INVOICE_REFERENCE');
 if(action==='quote'||action==='configure'){
  const profile=costProfileSchema.parse(JSON.parse(readFileSync(file,'utf8')));
  const problems=pricingProblems(profile);if(problems.length)throw Error(problems.join(' '));
  console.table([60,120,300].map(seconds=>({conversationSeconds:seconds,...budgetQuote(profile,{maxCallSeconds:seconds,ringTimeout:15,maxSpendCents:100},4)})));
  if(action==='quote')return;
  const db=createClient(required('SUPABASE_URL'),required('SUPABASE_SERVICE_ROLE_KEY'));
  const {error}=await db.from('app_settings').upsert({key:'dialer_cost_profile',value_json:profile},{onConflict:'key'});if(error)throw Error(error.message);
  console.log('Tariff components configured. No session or acceptance grant created.');return;
 }
 const db=createClient(required('SUPABASE_URL'),required('SUPABASE_SERVICE_ROLE_KEY'));
 if(action==='finalize'){
  if(!reference||reference.length<8)throw Error('An actual complete invoice reference is required; partial usage scans cannot release exposure');
  // The operator must verify this file contains ALL invoice products for each
  // terminal leg, not merely a single SIP CDR or an empty usage search.
  const invoice=JSON.parse(readFileSync(file,'utf8')) as Array<{holdId:string;records:unknown[]}>;
  for(const entry of invoice){const {error}=await db.rpc('portive_reconcile_cost',{p_hold:entry.holdId,p_records:entry.records,p_complete:true,p_reference:reference});if(error)throw Error(error.message);}
  console.log('Terminal holds reconciled to the supplied complete invoice. No calls initiated.');return;
 }
 const client=new Telnyx({apiKey:required('TELNYX_API_KEY'),maxRetries:0});
 const holds=await db.from('dialer_cost_holds').select('id,session_id,attempt_id,role').eq('state','held');if(holds.error)throw Error(holds.error.message);
 const legHolds=new Map<string,string>();
 for(const h of holds.data){
  if(h.attempt_id){const a=await db.from('call_attempts').select('telnyx_call_leg_id').eq('id',h.attempt_id).single();if(a.error)throw Error(a.error.message);if(a.data.telnyx_call_leg_id)legHolds.set(a.data.telnyx_call_leg_id,h.id);}
  else {const events=await db.from('dial_audit_events').select('details').eq('session_id',h.session_id).is('attempt_id',null);if(events.error)throw Error(events.error.message);for(const e of events.data){const leg=e.details?.call_leg_id;if(leg)legHolds.set(leg,h.id);}}
 }
 const batches=new Map<string,unknown[]>();
 for(const product of ['sip-trunking','call-control','webrtc','amd','tts','recording'] as const){
  // SDK pagination is automatic. A monthly scan is PARTIAL even if every page is
  // read: late bills and previous-month legs remain held for invoice completion.
  for await(const raw of client.detailRecords.list({filter:{record_type:product,date_range:'this_month'},'page[size]':100})){
   const r=raw as unknown as Record<string,unknown>,leg=String(r.call_leg_id??''),holdId=legHolds.get(leg);if(!holdId)continue;
   const cost=Number(r.cost),id=r.id??r.uuid;if(!id||r.currency!=='USD'||!Number.isFinite(cost)||cost<0)throw Error(`Unusable USD ${product} billing record for a held leg`);
   const records=batches.get(holdId)??[];records.push({id:`${product}:${id}`,product,callLegId:leg,currency:'USD',costMicros:Math.ceil(cost*1e6),providerRecordId:String(id)});batches.set(holdId,records);
  }
 }
 for(const [holdId,records] of batches){const {error}=await db.rpc('portive_reconcile_cost',{p_hold:holdId,p_records:records,p_complete:false});if(error)throw Error(error.message);}
 console.log(JSON.stringify({holdsObserved:batches.size,billingComplete:false,reservationsReleased:false}));
}
void main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;});

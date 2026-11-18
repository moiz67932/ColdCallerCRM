import 'server-only';
import {getSupabaseAdmin} from '@/lib/supabase-admin';
import {costProfileSchema,pricingProblems,pricingWarnings,confirmedCapacity,type CapacityConfirmation} from './budget';

export async function getBudgetConfiguration(){
 const db=getSupabaseAdmin();
 const bounded=await db.rpc("portive_bound_terminal_costs");
 if(bounded.error)throw Error("Apply migration 202611170004_usage_cache_and_operator_recovery.sql before refreshing terminal exposure.");
 const [settings,status,firstAnswer]=await Promise.all([
  db.from('app_settings').select('key,value_json').in('key',['dialer_cost_profile','dialer_account_capacity']),
  db.rpc('portive_budget_status',{p_session:null}),
  db.rpc('portive_first_answer_ready'),
 ]);
 const blockers:string[]=[];
 if(firstAnswer.error||firstAnswer.data!==true)blockers.push("Apply migration 202611170005_parallel_first_answer.sql before starting first-answer Parallel calls.");
 if(settings.error)throw Error(settings.error.message);
 const values=Object.fromEntries((settings.data??[]).map(r=>[r.key,r.value_json]));
 const parsed=costProfileSchema.safeParse(values.dialer_cost_profile);
 const profile=parsed.success?parsed.data:null;
 if(!profile)blockers.push('Cost configuration is missing. Apply migration 202611160004_provisional_parallel_pricing.sql to install the owner-approved padded estimates.');
 else blockers.push(...pricingProblems(profile));
 const capacity=(values.dialer_account_capacity??null) as CapacityConfirmation|null;
 const availableChannels=confirmedCapacity(capacity);
 if(!availableChannels)blockers.push('Confirm available account-wide channels from Mission Control → Voice → Outbound Voice Profiles → Account Level Outbound Concurrent Call Limit (manual confirmation lasts four hours).');
 if(status.error)blockers.push('Apply migration 202611160003_parallel_exposure_budget.sql before funded sessions.');
 if(!status.error&&status.data?.queueVersion!=='202611180002')blockers.push('Apply migration 202611180002_parallel_queue_and_daily_exposure.sql before starting Parallel sessions.');
 return {warnings:profile?pricingWarnings(profile):[],profile,capacity,availableChannels,heldCents:Number(status.data?.heldCents??0),dailyHeldCents:Number(status.data?.dailyHeldCents??status.data?.heldCents??0),blockers};
}

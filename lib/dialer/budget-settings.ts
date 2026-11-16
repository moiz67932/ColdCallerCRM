import 'server-only';
import {getSupabaseAdmin} from '@/lib/supabase-admin';
import {costProfileSchema,pricingProblems,confirmedCapacity,type CapacityConfirmation} from './budget';

export async function getBudgetConfiguration(){
 const db=getSupabaseAdmin();
 const [settings,status]=await Promise.all([
  db.from('app_settings').select('key,value_json').in('key',['dialer_cost_profile','dialer_account_capacity']),
  db.rpc('portive_budget_status',{p_session:null}),
 ]);
 const blockers:string[]=[];
 if(settings.error)throw Error(settings.error.message);
 const values=Object.fromEntries((settings.data??[]).map(r=>[r.key,r.value_json]));
 const parsed=costProfileSchema.safeParse(values.dialer_cost_profile);
 const profile=parsed.success?parsed.data:null;
 if(!profile)blockers.push('Account-specific component pricing is missing. Import the destination tariff and actual feature charges; published starting prices and the old 12-cent illustration cannot authorize calls.');
 else blockers.push(...pricingProblems(profile));
 const capacity=(values.dialer_account_capacity??null) as CapacityConfirmation|null;
 const availableChannels=confirmedCapacity(capacity);
 if(!availableChannels)blockers.push('Confirm available account-wide channels from Mission Control → Voice → Outbound Voice Profiles → Account Level Outbound Concurrent Call Limit (manual confirmation lasts four hours).');
 if(status.error)blockers.push('Apply migration 202611160003_parallel_exposure_budget.sql before funded sessions.');
 return {profile,capacity,availableChannels,heldCents:Number(status.data?.heldCents??0),blockers};
}

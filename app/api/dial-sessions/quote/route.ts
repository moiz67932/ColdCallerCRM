import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {requireApiAuth} from '@/lib/api-auth';
import {getSupabaseAdmin} from '@/lib/supabase-admin';
import {parallelReadiness} from '@/lib/dialer/parallel-readiness';
import {budgetQuote} from '@/lib/dialer/budget';
import {dailyHeadroom} from '@/lib/dialer/funding';

const schema=z.object({listId:z.string().min(1),timeZone:z.string().min(1),lines:z.coerce.number().int().min(2).max(4),maxCallSeconds:z.coerce.number().int().min(30).max(1800),sessionSeconds:z.coerce.number().int().min(60).max(3600),ringTimeout:z.coerce.number().int().min(15).max(120),maxSpendCents:z.coerce.number().int().min(1).max(100000)});
let live:{at:number;promise:ReturnType<typeof parallelReadiness>}|null=null;
export async function GET(request:NextRequest){
 const auth=await requireApiAuth(request);if(auth)return auth;
 const parsed=schema.safeParse(Object.fromEntries(request.nextUrl.searchParams));if(!parsed.success)return NextResponse.json({error:'Choose a list, timezone and valid session limits.'},{status:400});
 try{
  const q=parsed.data;if(request.nextUrl.searchParams.get('fresh')==='true'||!live||Date.now()-live.at>15000)live={at:Date.now(),promise:parallelReadiness(true)};
  const r=await live.promise;const db=getSupabaseAdmin();
  const [eligibility,next,billing,funding]=await Promise.all([
   db.rpc('portive_parallel_eligibility',{p_list:q.listId,p_location:null,p_timezone:q.timeZone}),
   db.rpc('portive_next_calling_window',{p_list:q.listId,p_timezone:q.timeZone}),
   db.rpc('portive_budget_status',{p_session:request.nextUrl.searchParams.get('sessionId')??null}),
   r.availableCreditCents>0?dailyHeadroom(r.dailyLimitCents):Promise.resolve({cents:0,observedCents:0,scope:'unavailable'}),
  ]);
  const blockers=[...r.blockers];if(eligibility.error)blockers.push(eligibility.error.message);if(next.error)blockers.push('Apply exposure-budget migration for next-window predictions.');
  const quote=r.budget.profile?budgetQuote(r.budget.profile,q,q.lines):null;
  const authorizedCents=Math.max(0,Math.min(q.maxSpendCents,r.availableCreditCents-r.budget.heldCents,funding.cents-r.budget.heldCents));
  const presets=r.budget.profile?[60,120,300].map(maxCallSeconds=>({maxCallSeconds,...budgetQuote(r.budget.profile!,{...q,maxCallSeconds,sessionSeconds:maxCallSeconds+q.ringTimeout+60},q.lines)})):[];
  return NextResponse.json({quote,presets,authorizedCents,shortfallCents:quote?Math.max(0,quote.requiredCents-authorizedCents):null,
   availableCreditCents:r.availableCreditCents,dailyHeadroomCents:funding.cents,dailyUsageScope:funding.scope,
   eligibility:eligibility.data,nextWindow:next.data,billing:billing.data,
   warnings:r.budget.warnings??[],pricingMode:r.budget.profile?.pricingMode??'verified',pricingSource:r.budget.profile?.source??null,capacity:r.budget.capacity,blockers});
 }catch(e){live=null;return NextResponse.json({error:e instanceof Error?e.message:'Preflight unavailable'},{status:503});}
}

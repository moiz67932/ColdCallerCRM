import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiAuth } from '@/lib/api-auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
const schema=z.object({controllerId:z.uuid(),attemptId:z.string(),clientAt:z.number().finite(),event:z.literal('operator_audio_available')});
export async function POST(request: NextRequest, context: {params:Promise<{id:string}>}) {
  const auth=await requireApiAuth(request,{mutation:true});if(auth)return auth;
  const receivedAt=Date.now();
  const parsed=schema.safeParse(await request.json());if(!parsed.success)return NextResponse.json({error:'Invalid telemetry'},{status:400});
  const {id}=await context.params, input=parsed.data,db=getSupabaseAdmin();
  const {data:s}=await db.from('dial_sessions').select('controller_id,active_call_id').eq('id',id).maybeSingle();
  const {data:a}=await db.from('call_attempts').select('was_bridged_to_operator').eq('id',input.attemptId).eq('dial_session_id',id).maybeSingle();
  if(s?.controller_id!==input.controllerId||s?.active_call_id!==input.attemptId||!a?.was_bridged_to_operator)return NextResponse.json({error:'Telemetry does not match active bridge'},{status:409});
  const {error}=await db.from('dial_audit_events').insert({session_id:id,attempt_id:input.attemptId,event_type:input.event,details:{clientAt:input.clientAt,serverReceivedAt:receivedAt,source:'browser_playing_media_indicator'}});
  if(error)return NextResponse.json({error:'Telemetry persistence failed'},{status:503});
  return NextResponse.json({saved:true});
}

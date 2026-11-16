import { Database, TelnyxApi } from './adapters';
import { fingerprint, HttpError, type Command, type Env } from './types';
export async function executeCommand(command: Command, env: Env, db: Database, api: TelnyxApi) {
  let s=command.session,a=command.attempt;
  const complete=(ok: boolean,response: unknown={},status=0,defer=false)=>db.rpc('portive_orchestration_complete',{p_command:command.id,p_ok:ok,p_response:response,p_status:status,p_defer:defer});
  let providerSent=false;
  try {
    if(s.orchestration_backend!=='cloudflare') throw new Error('Backend ownership mismatch');
    // A database guard on every claim and completion fences a stale process during rollback.
    const authorization=await db.rpc<{allowed:boolean;session?:typeof s;attempt?:typeof a;acceptance?:{id:string;expiresAt:string;destinations:Array<{phone_number:string}>;operatorSipUri:string;maxSpendCents:number}}>('portive_orchestration_authorize',{p_command:command.id});
    if(!authorization?.allowed)return;
    s=authorization.session??s;a=authorization.attempt??a;
    if(command.action==='dial_operator'||command.action==='dial_lead') {
      const acceptance=s.acceptance_grant_id ? authorization.acceptance : undefined;
      if(s.acceptance_grant_id) {
        if(env.DIALER_ACCEPTANCE_ENABLED!=='true'||env.DIALER_PARALLEL_ENABLED!=='false'||!acceptance||acceptance.id!==s.acceptance_grant_id||
          !Number.isFinite(Date.parse(acceptance.expiresAt))||Date.parse(acceptance.expiresAt)<=Date.now()||
          ![1,4].includes(acceptance.destinations.length)||acceptance.maxSpendCents<1||acceptance.maxSpendCents>200||
          s.parallel_options.ringTimeout!==15||s.parallel_options.maxCallSeconds!==60||
          (command.action==='dial_operator'?s.parallel_options.operatorSipUri!==acceptance.operatorSipUri:
            !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(command.parameters.to)||!acceptance.destinations.some(d=>d.phone_number===command.parameters.to))) throw new Error('Restricted acceptance not authorized');
      } else if(env.DIALER_PARALLEL_ENABLED!=='true') throw new Error('Parallel dialing disabled');
      if(s.parallel_options.fingerprint!==await fingerprint(env)) throw new Error('Parallel configuration changed');
      if(command.action==='dial_operator'&&s.status!=='running') throw new Error('Operator dialing suspended');
      if(command.action==='dial_lead'&&(s.status!=='running'||s.active_call_id||!s.browser_media_ready||a?.termination_reason)) return complete(true,{canceledBeforeDispatch:true});
      const operator=command.action==='dial_operator';
      const state=btoa(JSON.stringify({sessionId:s.id,attemptId:command.attempt_id,role:operator?'operator':'lead'}));
      providerSent=true;
      const response=await api.request('calls',{
        connection_id:env.TELNYX_PARALLEL_CONNECTION_ID,from:env.TELNYX_FROM_NUMBER,
        to:operator?s.parallel_options.operatorSipUri:command.parameters.to,
        webhook_url:env.VERCEL_VOICE_WEBHOOK_URL,client_state:state,command_id:command.id,
        timeout_secs:operator?20:s.parallel_options.ringTimeout,time_limit_secs:operator?(acceptance?120:1800):s.parallel_options.maxCallSeconds,
        ...(operator?{}:{answering_machine_detection:'premium'})
      });
      if(!response.data?.call_control_id) throw new Error('Provider omitted call identity');
      return complete(true,response);
    }
    if(command.action==='bridge') {
      if(!a?.telnyx_call_control_id||!s.operator_call_control_id||s.active_call_id!==a.id||a.ended_at) throw new Error('Bridge does not target the live winner');
      console.log(JSON.stringify({event:'bridge_command_sent',sessionId:s.id,attemptId:a.id,at:Date.now(),commandId:command.id}));
      providerSent=true;
      return complete(true,await api.action(s.operator_call_control_id,'bridge',{call_control_id_to_bridge_with:a.telnyx_call_control_id,command_id:command.id,park_after_unbridge:'self',prevent_double_bridge:true}));
    }
    if(command.action==='failure_playback') {
      if(a?.ended_at) return complete(true,{alreadyEnded:true});
      if(!a?.telnyx_call_control_id) return complete(false,{},0,true);
      if(a.id===s.active_call_id) throw new Error('Collision explanation cannot target the winner');
      if(!env.DIALER_CALLER_NAME?.trim()) throw new Error('Calling business name is required for collision explanation');
      providerSent=true;
      return complete(true,await api.action(a.telnyx_call_control_id,'speak',{
        payload:`This is ${env.DIALER_CALLER_NAME}. This call was for telemarketing purposes. No operator is available. You can reach us at ${env.TELNYX_FROM_NUMBER.split('').join(' ')}. Goodbye.`,
        payload_type:'text',voice:'female',language:'en-US',command_id:command.id,
      }));
    }
    if(command.action==='hangup'||command.action==='hangup_operator') {
      if(command.action==='hangup_operator' && s.operator_terminal_at)return complete(true,{alreadyEnded:true});
      if(a?.ended_at) return complete(true,{alreadyEnded:true});
      if(command.action==='hangup'&&a?.answered_at&&a.answer_classification!=='machine'&&a.termination_reason&&command.parameters.force!=='true'&&s.mode==='parallel') {
        await db.rpc('portive_answer_collision',{p_session:s.id,p_attempt:a.id});
        return complete(true,{supersededByCollisionExplanation:true});
      }
      const targets=command.action==='hangup_operator'?[s.operator_call_control_id]:s.mode==='power'?[a?.telnyx_call_control_id,a?.telnyx_agent_call_control_id]:[a?.telnyx_call_control_id];
      const ids=[...new Set(targets.filter((id):id is string=>Boolean(id)))];
      if(!ids.length) return complete(false,{},0,true);
      providerSent=true;
      const responses=await Promise.all(ids.map((id,i)=>api.action(id,'hangup',{command_id:ids.length===1?command.id:`${command.id}:${i}`})));
      return complete(true,{responses});
    }
    // Legacy overflow commands must be drained before cutover; never invent a destination.
    throw new Error(`Unsupported command on Cloudflare: ${command.action}`);
  } catch(error) {
    const status=error instanceof HttpError?error.status:0;
    console.log(JSON.stringify({event:'command_failed',sessionId:s.id,commandId:command.id,status,providerSent}));
    await complete(false,{},status);
  }
}

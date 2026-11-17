import { DurableObject } from 'cloudflare:workers';
import { verifyInternal } from '../../../lib/dialer/internal-auth';
import { Database, TelnyxApi, verifyProvider } from './adapters';
import { executeCommand } from './executor';
import { HttpError, fingerprint, validateEnv, type Env, type Work, type Delivery } from './types';
import { safeDiagnostic } from '../../../lib/dialer/diagnostics';

export function earliestDeadline(deadlines: string[], now=Date.now()) {
  const times=deadlines.map(Date.parse).filter(Number.isFinite).filter(t=>t>now);
  return times.length?Math.min(...times):null;
}
export class SessionCoordinator extends DurableObject<Env> {
  private db: Database;
  private api: TelnyxApi;
  private wakeNonces = new Map<string,number>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx,env); this.db=new Database(env);this.api=new TelnyxApi(env);

  }
  async fetch(request: Request): Promise<Response> {
    const arrival=Number(request.headers.get('x-portive-cf-arrival'))||Date.now();
    let operation='environment_validation';
    const sessionId=new URL(request.url).pathname.match(/\/session\/([a-f0-9-]{36})$/)?.[1];
    try {
      validateEnv(this.env);
      const path=new URL(request.url).pathname;
      const reader=request.body?.getReader(),decoder=new TextDecoder();let raw='',size=0;
      if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>256_000){await reader.cancel();return Response.json({error:'Payload too large'},{status:413});}raw+=decoder.decode(chunk.value,{stream:true});}
      raw+=decoder.decode();
      if(raw.length>256_000) return Response.json({error:'Payload too large'},{status:413});
      if(!await verifyInternal(this.env.DIALER_CLOUDFLARE_SECRET,path,raw,request.headers)) return Response.json({error:'Unauthorized'},{status:401});
      operation='storage_nonce';
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
      const authenticated=Date.now(), nonce=request.headers.get('x-portive-nonce')!;
      const body=JSON.parse(raw),sql=this.ctx.storage.sql;
      if(body.kind==='wake') {
        // Wakes carry no browser command or lease extension. Replays after eviction are
        // harmless SQL ticks; avoid charging durable writes for 1.5s media heartbeats.
        for(const [key,expiry] of this.wakeNonces) if(expiry<Date.now())this.wakeNonces.delete(key);
        if(this.wakeNonces.has(nonce))return Response.json({error:'Replay rejected'},{status:409});
        this.wakeNonces.set(nonce,Date.now()+120_000);
      } else {
        sql.exec('DELETE FROM nonces WHERE expires < ?',Date.now());
        if([...sql.exec('SELECT nonce FROM nonces WHERE nonce = ?',nonce)].length) return Response.json({error:'Replay rejected'},{status:409});
        sql.exec('INSERT INTO nonces VALUES (?, ?)',nonce,Date.now()+120_000);
      }
      if(path==='/internal/inspect') {
        // Read-only configuration comparison: no activation, tick or provider I/O.
        return Response.json({backend:'cloudflare',fingerprint:await fingerprint(this.env),parallelEnabled:this.env.DIALER_PARALLEL_ENABLED==='true',acceptanceEnabled:this.env.DIALER_ACCEPTANCE_ENABLED==='true',callerName:this.env.DIALER_CALLER_NAME??null});
      }
      if(path==='/internal/prepare') {
        operation='prepare';
        // Rescue an activation lost between Vercel creating a session and delivering its wake.
        await this.arm(Date.now()+60_000);
        await this.db.rpc('portive_orchestration_prepare',{p_backend:'cloudflare'});
        return Response.json({backend:'cloudflare',fingerprint:await fingerprint(this.env),parallelEnabled:this.env.DIALER_PARALLEL_ENABLED==='true'});
      }
      if(!sessionId)return Response.json({error:'Invalid session'},{status:400});
      operation='storage_session';
      const bound=await this.ctx.storage.get<string>('sessionId');
      if(bound && bound!==sessionId)return Response.json({error:'Object session mismatch'},{status:409});
      if(!bound) await this.ctx.storage.put('sessionId',sessionId);
      await this.arm(Date.now()+60_000); // Crash recovery is persisted before network side effects.
      let work: Work;
      operation=body.kind==='event'?'event_rpc':'work_rpc';
      if(body.kind==='event') {
        const d=body.delivery as Delivery;
        if(d.sessionId!==sessionId||!await verifyProvider(d.rawBody,d.signature,d.timestamp,this.env.TELNYX_PUBLIC_KEY)) return Response.json({error:'Invalid provider signature'},{status:401});
        const event=JSON.parse(d.rawBody);
        if (event.data.id && event.data.id!==body.eventId) return Response.json({error:'Provider event identity mismatch'},{status:400});
        if (!event.data.id) {
          const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(d.rawBody));
          const expected='raw-'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
          if(body.eventId!==expected)return Response.json({error:'Invalid fallback identity'},{status:400});
          event.data.id=expected;
        }
        const providerAuthenticated=Date.now();
        work=await this.db.rpc<Work>('portive_cloudflare_event',{p_session:sessionId,p_attempt:d.attemptId??null,p_role:d.role,p_event:event,p_raw:d.rawBody,
          p_timing:{providerEventAt:event.data.occurred_at,cloudflareArrival:arrival,cloudflareAuthenticated:providerAuthenticated,internalAuthenticated:authenticated,vercelArrival:d.vercelArrival,vercelAuthenticated:d.vercelAuthenticated}});
        console.log(JSON.stringify({event:'state_transition_committed',sessionId,eventId:event.data.id,winner:work.session.active_call_id,at:Date.now(),providerEventAt:event.data.occurred_at}));
      } else if(body.kind==='wake') work=await this.db.rpc<Work>('portive_orchestration_work',{p_session:sessionId});
      else return Response.json({error:'Unknown operation'},{status:400});
      if(body.kind==='event') {
        const event=JSON.parse((body.delivery as Delivery).rawBody);
        if(event.data.event_type==='call.bridged') console.log(JSON.stringify({event:'bridge_confirmed',sessionId,attemptId:body.delivery.attemptId,providerAt:event.data.occurred_at,at:Date.now()}));
        if(work.session.active_call_id===body.delivery.attemptId && (event.data.event_type==='call.answered'||event.data.event_type.startsWith('call.machine.'))) console.log(JSON.stringify({event:'winner_claimed',sessionId,attemptId:work.session.active_call_id,at:Date.now()}));
      }
      operation='execute_or_reconcile';
      await this.run(work);
      return Response.json({accepted:true});
    } catch(error) {
      console.log(JSON.stringify({event:'orchestration_request_failed',sessionId,operation,at:Date.now(),...safeDiagnostic(error,Object.values(this.env).filter((v):v is string=>typeof v==='string'))}));
      return Response.json({error:'Orchestration unavailable; dialing remains reserved'},{status:503});
    }
  }
  private async arm(at: number) {
    // Hold only storage scheduling in the input gate, never provider HTTP calls.
    await this.ctx.blockConcurrencyWhile(async()=>{
      const current=await this.ctx.storage.getAlarm();
      if(current===null||at<current) await this.ctx.storage.setAlarm(at);
    });
  }
  private async run(initial: Work) {
    let work=initial;
    for(let round=0;round<3;round++) {
      const next=earliestDeadline(work.deadlines);
      if(next) await this.arm(next);
      if(!work.commands.length) break;
      const results=await Promise.allSettled(work.commands.map(c=>executeCommand(c,this.env,this.db,this.api)));
      if(results.some(r=>r.status==='rejected')) throw new Error('Command persistence failed; recovery required');
      work=await this.db.rpc<Work>('portive_orchestration_work',{p_session:work.session.id});
    }
    if(await this.reconcile(work)) {
      await this.arm(Date.now()+60_000);
      await this.run(await this.db.rpc<Work>('portive_orchestration_work',{p_session:work.session.id}));
      return;
    }
    const next=earliestDeadline(work.deadlines);
    if(next) await this.arm(next);
    if(['completed','stopped'].includes(work.session.status)&&!work.commands.length&&!next) {
      await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll();
    }
  }
  private async reconcile(work: Work) {
    // GET status is read-only. Unknown identities are never replaced by a new dial.
    let reconciled=false;
    if(work.operator_reconcile && work.session.operator_call_control_id) {
      const response=await this.api.request(`calls/${encodeURIComponent(work.session.operator_call_control_id)}`);
      if(typeof response.data?.is_alive!=='boolean')throw new Error('Operator status unavailable');
      await this.db.rpc('portive_orchestration_operator',{p_session:work.session.id,p_control:work.session.operator_call_control_id,p_alive:response.data.is_alive});
      reconciled=true;
    }
    for(const a of work.reconcile??[]) {
      if(!a.telnyx_call_control_id) continue;
      const response=await this.api.request(`calls/${encodeURIComponent(a.telnyx_call_control_id)}`);
      if(typeof response.data?.is_alive!=='boolean') throw new Error('Provider did not supply terminal evidence');
      await this.db.rpc('portive_orchestration_reconcile',{p_session:work.session.id,p_attempt:a.id,p_alive:response.data.is_alive,p_control:a.telnyx_call_control_id});
      reconciled=true;
    }
    return reconciled;
  }
  async alarm() {
    try {
      validateEnv(this.env);
      const id=await this.ctx.storage.get<string>('sessionId');
      if(!id) { await this.recover(); return; }
      await this.run(await this.db.rpc<Work>('portive_orchestration_work',{p_session:id}));
      if(await this.ctx.storage.get('failures')!==undefined)await this.ctx.storage.delete('failures');
    } catch(error) {
      if(error instanceof HttpError && error.code==='backend_inactive') {await this.ctx.storage.deleteAlarm();return;}
      const failures=(await this.ctx.storage.get<number>('failures')??0)+1;
      await this.ctx.storage.put('failures',failures);
      // Bounded backoff continues past the platform's six automatic alarm retries.
      await this.ctx.storage.setAlarm(Date.now()+Math.min(300_000,5000*2**Math.min(failures,6)));
      console.log(JSON.stringify({event:'alarm_recovery_scheduled',sessionId:await this.ctx.storage.get('sessionId'),failures,at:Date.now(),...safeDiagnostic(error,Object.values(this.env).filter((v):v is string=>typeof v==='string'))}));
    }
  }
  async recover() {
    validateEnv(this.env);
    await this.db.rpc('portive_orchestration_guard',{p_backend:'cloudflare'});
    const sessions=await this.db.rows<{id:string}>('dial_sessions','select=id&orchestration_backend=eq.cloudflare&status=in.(running,paused,stopping,unsafe)&limit=2');
    // Single-operator invariant limits this to one active session. Cron is only a recovery net.
    await Promise.all(sessions.map(s=>this.env.SESSIONS.get(this.env.SESSIONS.idFromName(s.id)).recoverSession(s.id)));
  }
  async recoverSession(id: string) {
    if(!await this.ctx.storage.get('sessionId'))await this.ctx.storage.put('sessionId',id);
    await this.arm(Date.now()+60_000);
    await this.run(await this.db.rpc<Work>('portive_orchestration_work',{p_session:id}));
  }
}
export default {
  fetch(request: Request, env: Env): Promise<Response>|Response {
    const path=new URL(request.url).pathname;
    if(request.method==='GET'&&path==='/health') return Response.json({service:'portive-dialer',environment:env.DEPLOYMENT_ENV});
    if(request.method!=='POST'||!/^\/internal\/(prepare|inspect|session\/[a-f0-9-]{36})$/.test(path)) return Response.json({error:'Not found'},{status:404});
    if(!request.headers.has('x-portive-signature'))return Response.json({error:'Unauthorized'},{status:401});
    // No JSON parsing, crypto, or provider SDK on the ordinary Worker's 10 ms CPU budget.
    const name=['/internal/prepare','/internal/inspect'].includes(path)?'control':path.split('/').pop()!;
    if(Number(request.headers.get('content-length')??0)>256_000) return Response.json({error:'Payload too large'},{status:413});
    const headers=new Headers(request.headers);headers.set('x-portive-cf-arrival',String(Date.now()));
    return env.SESSIONS.get(env.SESSIONS.idFromName(name)).fetch(new Request(request,{headers}));
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(env.SESSIONS.get(env.SESSIONS.idFromName('control')).recover().catch(error=>console.log(JSON.stringify({event:'recovery_scan_unavailable',operation:'recovery_scan',...safeDiagnostic(error,Object.values(env).filter((v):v is string=>typeof v==='string'))}))));
  }
} satisfies ExportedHandler<Env>;

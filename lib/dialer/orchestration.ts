import 'server-only';
import { env } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { signInternal } from './internal-auth';

export const orchestrationBackend = () => env.DIALER_ORCHESTRATION_BACKEND;
export async function assertOrchestrationBackend(sessionId?: string) {
  const {error}=await getSupabaseAdmin().rpc('portive_orchestration_guard',{p_backend:orchestrationBackend(),p_session:sessionId??null});
  if(error) throw new Error(`Orchestration unavailable: ${error.message}`);
}
export async function cloudflareRequest(path: string, payload: unknown) {
  if(env.DIALER_CLOUDFLARE_ENABLED!=='true'||!env.DIALER_CLOUDFLARE_URL||!env.DIALER_CLOUDFLARE_SECRET||env.DIALER_CLOUDFLARE_SECRET.length<32) throw new Error('Configure Cloudflare URL, secret and enablement before selecting the Cloudflare backend');
  const base=new URL(env.DIALER_CLOUDFLARE_URL);
  if(base.protocol!=='https:' && !(env.NODE_ENV!=='production' && ['localhost','127.0.0.1'].includes(base.hostname))) throw new Error('Cloudflare URL must use HTTPS');
  const body=JSON.stringify(payload);
  const response=await fetch(new URL(path,base),{method:'POST',headers:await signInternal(env.DIALER_CLOUDFLARE_SECRET,path,body),body,signal:AbortSignal.timeout(25_000),cache:'no-store'});
  if(!response.ok) throw new Error(`Cloudflare orchestration HTTP ${response.status}; session remains reserved for recovery`);
  return response.json();
}
export async function prepareOrchestration() {
  await assertOrchestrationBackend();
  if(orchestrationBackend()==='cloudflare') return cloudflareRequest('/internal/prepare',{});
}
export async function wakeOrchestration(sessionId: string) {
  if(orchestrationBackend()!=='cloudflare') return;
  try { await cloudflareRequest(`/internal/session/${sessionId}`,{kind:'wake'}); }
  catch(error) {
    await getSupabaseAdmin().from('dial_sessions').update({status:'paused',reason:'Cloudflare orchestration unavailable; no new dialing until recovery'}).eq('id',sessionId).in('status',['running']);
    throw error;
  }
}

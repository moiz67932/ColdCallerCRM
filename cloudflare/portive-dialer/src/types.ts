import type { SessionCoordinator } from './index';
export interface Env {
  SESSIONS: DurableObjectNamespace<SessionCoordinator>;
  DEPLOYMENT_ENV: string;
  DIALER_CLOUDFLARE_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
  TELNYX_PARALLEL_CONNECTION_ID: string;
  TELNYX_TELEPHONY_CREDENTIAL_ID: string;
  TELNYX_FROM_NUMBER: string;
  VERCEL_VOICE_WEBHOOK_URL: string;
  DIALER_PARALLEL_ENABLED: string;
  DIALER_ACCEPTANCE_ENABLED?: string;
  DIALER_CALLER_NAME?: string;
}
export type Session = {
  id: string; mode: 'parallel'|'power'; status: string; controller_id: string;
  active_call_id: string|null; operator_terminal_at?: string|null; operator_call_control_id: string|null;
  browser_media_ready: boolean; orchestration_backend: string;
  acceptance_grant_id?: string|null;
  parallel_options: { fingerprint: string; operatorSipUri: string; ringTimeout: number; maxCallSeconds: number; budgetVersion?:string; sessionSeconds?:number; deadlineAt?:string };
};
export type Attempt = {
  id: string; ended_at: string|null; answered_at: string|null; termination_reason: string|null;
  answer_classification: string; telnyx_call_control_id: string|null; telnyx_agent_call_control_id: string|null;
};
export type Command = { id: string; session_id: string; attempt_id: string|null; action: string; parameters: Record<string,string>; session: Session; attempt: Attempt|null };
export type Work = { session: Session; commands: Command[]; deadlines: string[]; operator_reconcile?: boolean; reconcile?: Attempt[] };
export type Delivery = { rawBody: string; signature: string; timestamp: string; vercelArrival: number; vercelAuthenticated: number; sessionId: string; attemptId?: string; role: string };
export class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
export function validateEnv(env: Env) {
  for (const name of ['DIALER_CLOUDFLARE_SECRET','SUPABASE_SERVICE_ROLE_KEY','TELNYX_API_KEY','TELNYX_PUBLIC_KEY','TELNYX_FROM_NUMBER'] as const) {
    if (!env[name] || (name === 'DIALER_CLOUDFLARE_SECRET' && env[name].length < 32)) throw new Error(`Missing or invalid ${name}`);
  }
  if((env.DIALER_PARALLEL_ENABLED==='true'||env.DIALER_ACCEPTANCE_ENABLED==='true')&&(!env.TELNYX_PARALLEL_CONNECTION_ID||!env.TELNYX_TELEPHONY_CREDENTIAL_ID))throw new Error('Parallel application and WebRTC credential are required');
  if(env.DIALER_PARALLEL_ENABLED==='true'&&!env.DIALER_CALLER_NAME?.trim())throw new Error('DIALER_CALLER_NAME is required for answered-collision identification');
  for (const name of ['SUPABASE_URL','VERCEL_VOICE_WEBHOOK_URL'] as const) if (new URL(env[name]).protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
  if (!/^\+[1-9]\d{7,14}$/.test(env.TELNYX_FROM_NUMBER)) throw new Error('Invalid caller ID');
}
export async function fingerprint(env: Env) {
  const config={connection:env.TELNYX_PARALLEL_CONNECTION_ID,credential:env.TELNYX_TELEPHONY_CREDENTIAL_ID,callerId:env.TELNYX_FROM_NUMBER,webhook:env.VERCEL_VOICE_WEBHOOK_URL,amd:'premium',deadlineMs:1000,orchestrationBackend:'cloudflare'};
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(Object.entries(config).sort(([a],[b])=>a.localeCompare(b)))));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}

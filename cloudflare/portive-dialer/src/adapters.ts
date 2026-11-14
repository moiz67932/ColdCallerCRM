import { HttpError, type Env } from './types';
export class Database {
  constructor(private env: Env) {}
  async rpc<T = unknown>(name: string, args: Record<string,unknown>): Promise<T> {
    return this.request<T>(`rpc/${name}`, {method:'POST',body:JSON.stringify(args)});
  }
  async rows<T>(table: string, query: string): Promise<T[]> { return this.request<T[]>(`${table}?${query}`); }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response=await fetch(`${this.env.SUPABASE_URL.replace(/\/$/,'')}/rest/v1/${path}`, {
      ...init, headers:{apikey:this.env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,'content-type':'application/json'}, signal:AbortSignal.timeout(8000)
    });
    if(!response.ok) {
      const errorBody=await response.text();
      const inactive=errorBody.includes('Orchestration backend mismatch')||errorBody.includes('Cloudflare orchestration is disabled');
      throw new HttpError(response.status,'Supabase request failed',inactive?'backend_inactive':undefined);
    }
    const text=await response.text(); return (text?JSON.parse(text):null) as T;
  }
}
export class TelnyxApi {
  constructor(private env: Env) {}
  async request(path: string, body?: Record<string,unknown>): Promise<{data?: Record<string,unknown>}> {
    const response=await fetch(`https://api.telnyx.com/v2/${path}`, {method:body?'POST':'GET',headers:{authorization:`Bearer ${this.env.TELNYX_API_KEY}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});
    if(!response.ok) { await response.body?.cancel(); throw new HttpError(response.status,'Telnyx request failed'); }
    return response.json();
  }
  action(id: string, action: string, body: Record<string,unknown>) { return this.request(`calls/${encodeURIComponent(id)}/actions/${action}`,body); }
}
export async function verifyProvider(raw: string, signature: string, timestamp: string, publicKey: string) {
  if(!/^\d+$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300) return false;
  try {
    const pem=publicKey.includes('BEGIN PUBLIC KEY');
    const bytes=Uint8Array.from(atob(pem?publicKey.replace(/-----[^-]+-----|\s/g,''):publicKey),c=>c.charCodeAt(0));
    const key=await crypto.subtle.importKey(pem?'spki':'raw',bytes,{name:'Ed25519'},false,['verify']);
    return crypto.subtle.verify('Ed25519',key,Uint8Array.from(atob(signature.split(',')[0].trim()),c=>c.charCodeAt(0)),new TextEncoder().encode(`${timestamp}|${raw}`));
  } catch { return false; }
}

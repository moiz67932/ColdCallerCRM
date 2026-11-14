// Portable Web Crypto only. Never import this module's secret from a client component.
const encoder = new TextEncoder();
export async function signInternal(secret: string, path: string, body: string, timestamp = String(Date.now()), nonce = crypto.randomUUID()) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}\n${nonce}\n${path}\n${body}`));
  return { 'content-type': 'application/json', 'x-portive-time': timestamp, 'x-portive-nonce': nonce, 'x-portive-signature': Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('') };
}
export async function verifyInternal(secret: string, path: string, body: string, headers: Headers, now = Date.now()) {
  const timestamp = headers.get('x-portive-time') ?? '', nonce = headers.get('x-portive-nonce') ?? '', signature = headers.get('x-portive-signature') ?? '';
  if (secret.length < 32 || !/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000 || !/^[a-zA-Z0-9-]{16,80}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(signature.match(/../g)!, b => parseInt(b, 16)), encoder.encode(`${timestamp}\n${nonce}\n${path}\n${body}`));
}

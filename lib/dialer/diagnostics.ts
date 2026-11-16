// Log messages only, never request bodies, headers, provider responses or stacks.
export function safeDiagnostic(error: unknown, secrets: Array<string | undefined> = []) {
  const value = error as { message?: unknown; name?: unknown; code?: unknown; status?: unknown } | null;
  let message = typeof value?.message === 'string' ? value.message : 'Unknown error';
  for (const secret of secrets) if (secret && secret.length >= 4) message = message.split(secret).join('[redacted]');
  message = message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sips?:[^\s,"'}]+/gi, '[redacted SIP URI]')
    .replace(/gencred[A-Za-z0-9_-]+/g, '[redacted SIP username]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '[redacted JWT]')
    .replace(/(api[_-]?key|token|password|secret|credential|authorization)\s*[=:]\s*["']?[^\s,"'}]+/gi, '$1=[redacted]')
    .replace(/\+\d{8,15}/g, '[redacted phone]');
  const safe = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(v) ? v : undefined;
  return { message: message.slice(0, 500), name: safe(value?.name), code: safe(value?.code), status: typeof value?.status === 'number' ? value.status : undefined };
}

export function getBearerTokenFromHeaders(headers: Headers) {
  const authorization = headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export function hasValidElevenLabsToolBearerAuth(headers: Headers, expectedToken: string) {
  const token = getBearerTokenFromHeaders(headers);
  return Boolean(token && token === expectedToken);
}

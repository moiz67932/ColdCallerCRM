import { env, requireEnv } from "@/lib/env";

function normalizeOptionalValue(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isPrivateIpv4Hostname(hostname: string) {
  if (/^10\./.test(hostname)) {
    return true;
  }

  if (/^127\./.test(hostname)) {
    return true;
  }

  if (/^192\.168\./.test(hostname)) {
    return true;
  }

  const match = hostname.match(/^172\.(\d{1,3})\./);

  if (!match) {
    return false;
  }

  const secondOctet = Number(match[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}

function getTelnyxErrorStatus(error: unknown) {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }

  return (error as { status?: number }).status;
}

function getTelnyxErrorBody(error: unknown) {
  if (typeof error !== "object" || error === null || !("error" in error)) {
    return undefined;
  }

  return (error as { error?: unknown }).error;
}

function getTelnyxRequestId(error: unknown) {
  if (typeof error !== "object" || error === null || !("headers" in error)) {
    return undefined;
  }

  const headers = (error as { headers?: unknown }).headers;

  if (!headers || typeof headers !== "object" || !("get" in headers)) {
    return undefined;
  }

  const getHeader = (headers as { get: (name: string) => string | null }).get.bind(headers);

  return getHeader("x-request-id") ?? getHeader("telnyx-request-id") ?? undefined;
}

function getTelnyxErrorSummary(error: unknown) {
  const body = getTelnyxErrorBody(error);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const errors = (body as { errors?: unknown }).errors;

  if (!Array.isArray(errors)) {
    return body;
  }

  return errors.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }

    const typed = entry as Record<string, unknown>;

    return {
      code: typed.code,
      title: typed.title,
      detail: typed.detail,
      source: typed.source,
      meta: typed.meta,
    };
  });
}

export function getTelnyxErrorDiagnostics(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : "Unknown Telnyx error",
    telnyxStatus: getTelnyxErrorStatus(error),
    telnyxRequestId: getTelnyxRequestId(error),
    telnyxError: getTelnyxErrorSummary(error),
  };
}

export function getVoiceWebhookUrl() {
  if (!env.APP_BASE_URL) {
    return undefined;
  }

  return `${env.APP_BASE_URL.replace(/\/$/, "")}/api/webhooks/telnyx/voice`;
}

function formatReachabilityError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return "timed out";
  }

  return error instanceof Error ? error.message : "request failed";
}

export async function checkVoiceWebhookReachability(timeoutMs = 5_000) {
  const webhookUrl = getVoiceWebhookUrl();

  if (!webhookUrl) {
    return {
      reachable: false,
      reason: "APP_BASE_URL is missing, so the Telnyx voice webhook URL cannot be resolved.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(webhookUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    // The route only accepts POST, so 405 still confirms public reachability.
    if (response.status >= 500) {
      return {
        reachable: false,
        reason: `Webhook URL returned HTTP ${response.status}.`,
      };
    }

    return {
      reachable: true,
      reason: null,
    };
  } catch (error) {
    return {
      reachable: false,
      reason: `Webhook URL is unreachable (${formatReachabilityError(error)}).`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function getMessagingWebhookUrl() {
  if (!env.APP_BASE_URL) {
    return undefined;
  }

  return `${env.APP_BASE_URL.replace(/\/$/, "")}/api/webhooks/telnyx/messaging`;
}

export function getTelnyxConnectionId() {
  return requireEnv("TELNYX_CONNECTION_ID");
}

export function getTelnyxTelephonyCredentialId() {
  return requireEnv("TELNYX_TELEPHONY_CREDENTIAL_ID");
}

export function isPublicWebhookBaseUrlConfigured() {
  const baseUrl = normalizeOptionalValue(env.APP_BASE_URL);

  if (!baseUrl) {
    return false;
  }

  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname === "localhost" || hostname.endsWith(".local")) {
      return false;
    }

    if (hostname === "::1" || hostname === "[::1]") {
      return false;
    }

    if (isPrivateIpv4Hostname(hostname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function getWebhookBaseUrlIssue() {
  const baseUrl = normalizeOptionalValue(env.APP_BASE_URL);

  if (!baseUrl) {
    return "APP_BASE_URL is missing. Telnyx voice webhooks need a public URL.";
  }

  if (!isPublicWebhookBaseUrlConfigured()) {
    return `APP_BASE_URL is set to ${baseUrl}, which Telnyx cannot reach from the public internet. Use a public tunnel or deployed URL.`;
  }

  return null;
}

export function getOutboundCallerId() {
  return requireEnv("TELNYX_FROM_NUMBER");
}

export function getTelnyxManualDialFlow() {
  return env.TELNYX_MANUAL_DIAL_FLOW === "pstn_first" ? "pstn_first" : "browser_first";
}

import { env, requireEnv } from "@/lib/env";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { getTelnyxClient } from "@/lib/telnyx/client";

let cachedWebRtcTelephonyCredentialId: string | null = null;
let invalidConfiguredTelephonyCredentialId: string | null = null;
let cachedWebhookSyncKey: string | null = null;

const WEBRTC_CREDENTIAL_TAG = "coldcaller-webrtc";
const TELNYX_FAST_REQUEST_OPTIONS = {
  maxRetries: 0,
  timeout: 8_000,
};

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

function logTelnyxOperationError(message: string, error: unknown, context: Record<string, unknown> = {}) {
  logError(message, {
    ...context,
    ...getTelnyxErrorDiagnostics(error),
  });
}

function isTelnyxCredentialTokenError(error: unknown) {
  const status = getTelnyxErrorStatus(error);
  return status === 400 || status === 404 || status === 422;
}

function credentialBelongsToConnection(resourceId: string | null | undefined, connectionId: string) {
  return resourceId === connectionId || resourceId === `connection:${connectionId}`;
}

function credentialIdLooksLikeConnectionId(credentialId: string, connectionId: string) {
  return credentialId === connectionId || credentialId === `connection:${connectionId}`;
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

export function getTelnyxTelephonyCredentialId() {
  return requireEnv("TELNYX_TELEPHONY_CREDENTIAL_ID");
}

async function findExistingWebRtcTelephonyCredentialId(connectionId: string) {
  const matches: Array<{ id: string; rank: number }> = [];
  const resourceIds = [connectionId, `connection:${connectionId}`];

  async function scanCredentials(resourceId: string, tag?: string) {
    logInfo("Scanning Telnyx telephony credentials for WebRTC", {
      connectionId,
      resourceId,
      tag: tag ?? null,
    });

    const credentialPages = getTelnyxClient().telephonyCredentials.list(
      {
        filter: {
          resource_id: resourceId,
          ...(tag ? { tag } : {}),
        },
      },
      TELNYX_FAST_REQUEST_OPTIONS,
    );

    for await (const credential of credentialPages) {
      const belongsToConnection = credentialBelongsToConnection(credential.resource_id, connectionId);

      if (!credential.id || !belongsToConnection || credential.expired) {
        continue;
      }

      const rank = Date.parse(credential.updated_at ?? credential.created_at ?? "");
      const normalizedRank = Number.isFinite(rank) ? rank : 0;

      matches.push({
        id: credential.id,
        rank: normalizedRank,
      });
    }
  }

  for (const resourceId of resourceIds) {
    await scanCredentials(resourceId, WEBRTC_CREDENTIAL_TAG);
  }

  if (matches.length === 0) {
    for (const resourceId of resourceIds) {
      await scanCredentials(resourceId);
    }
  }

  const bestMatch = matches.sort((left, right) => right.rank - left.rank)[0];

  logInfo("Finished Telnyx telephony credential scan", {
    connectionId,
    matchCount: matches.length,
    selectedCredentialId: bestMatch?.id ?? null,
  });

  return bestMatch?.id ?? null;
}

async function createWebRtcTelephonyCredential(connectionId: string) {
  logInfo("Creating Telnyx telephony credential for WebRTC", {
    connectionId,
    tag: WEBRTC_CREDENTIAL_TAG,
  });

  const response = await getTelnyxClient().telephonyCredentials.create(
    {
      connection_id: connectionId,
      name: `${env.NEXT_PUBLIC_APP_NAME} Browser WebRTC`,
      tag: WEBRTC_CREDENTIAL_TAG,
    },
    TELNYX_FAST_REQUEST_OPTIONS,
  );

  const credentialId = response.data?.id;

  if (!credentialId) {
    throw new Error("Telnyx did not return a telephony credential id");
  }

  logInfo("Created Telnyx telephony credential for WebRTC", {
    connectionId,
    credentialId,
  });

  return credentialId;
}

async function resolveWebRtcTelephonyCredentialId() {
  const connectionId = getTelnyxConnectionId();
  const existingCredentialId = await findExistingWebRtcTelephonyCredentialId(connectionId);

  if (existingCredentialId) {
    return existingCredentialId;
  }

  return createWebRtcTelephonyCredential(connectionId);
}

export async function createTelnyxWebRtcToken() {
  const configuredCredentialId = normalizeOptionalValue(env.TELNYX_TELEPHONY_CREDENTIAL_ID);
  const connectionId = getTelnyxConnectionId();

  logInfo("Starting Telnyx WebRTC token creation", {
    connectionId,
    hasConfiguredCredentialId: Boolean(configuredCredentialId),
    cachedCredentialId: cachedWebRtcTelephonyCredentialId,
  });

  if (configuredCredentialId && credentialIdLooksLikeConnectionId(configuredCredentialId, connectionId)) {
    invalidConfiguredTelephonyCredentialId = configuredCredentialId;
    logWarn(
      "TELNYX_TELEPHONY_CREDENTIAL_ID is set to the Telnyx connection id. Using an auto-managed WebRTC credential instead.",
      { connectionId },
    );
  }

  const candidateIds = [cachedWebRtcTelephonyCredentialId, configuredCredentialId].filter(
    (value, index, values): value is string =>
      Boolean(value) &&
      values.indexOf(value) === index &&
      value !== invalidConfiguredTelephonyCredentialId,
  );

  for (const credentialId of candidateIds) {
    try {
      logInfo("Minting Telnyx WebRTC token with candidate credential", {
        connectionId,
        credentialId,
        source:
          credentialId === cachedWebRtcTelephonyCredentialId
            ? "cache"
            : credentialId === configuredCredentialId
              ? "env"
              : "candidate",
      });

      const token = await getTelnyxClient().telephonyCredentials.createToken(
        credentialId,
        TELNYX_FAST_REQUEST_OPTIONS,
      );
      cachedWebRtcTelephonyCredentialId = credentialId;
      logInfo("Minted Telnyx WebRTC token with candidate credential", {
        connectionId,
        credentialId,
      });
      return token;
    } catch (error) {
      if (!isTelnyxCredentialTokenError(error)) {
        logTelnyxOperationError("Unexpected Telnyx error while minting WebRTC token", error, {
          connectionId,
          credentialId,
        });
        throw error;
      }

      if (credentialId === configuredCredentialId) {
        invalidConfiguredTelephonyCredentialId = credentialId;
      }

      logWarn("Telnyx telephony credential could not mint a WebRTC token. Falling back to connection lookup.", {
        credentialId,
        connectionId,
        ...getTelnyxErrorDiagnostics(error),
      });
    }
  }

  const resolvedCredentialId = await resolveWebRtcTelephonyCredentialId();

  logInfo("Minting Telnyx WebRTC token with resolved credential", {
    connectionId,
    credentialId: resolvedCredentialId,
  });

  let token: string;

  try {
    token = await getTelnyxClient().telephonyCredentials.createToken(
      resolvedCredentialId,
      TELNYX_FAST_REQUEST_OPTIONS,
    );
  } catch (error) {
    logTelnyxOperationError("Failed to mint Telnyx WebRTC token with resolved credential", error, {
      connectionId,
      credentialId: resolvedCredentialId,
    });
    throw error;
  }

  cachedWebRtcTelephonyCredentialId = resolvedCredentialId;

  logInfo("Minted Telnyx WebRTC token with resolved credential", {
    connectionId,
    credentialId: resolvedCredentialId,
  });

  return token;
}

export function getOutboundCallerId() {
  return requireEnv("TELNYX_FROM_NUMBER");
}

export async function getTelnyxConnectionWebhookConfig() {
  const connectionId = normalizeOptionalValue(env.TELNYX_CONNECTION_ID);

  if (!connectionId || !env.TELNYX_API_KEY) {
    return null;
  }

  const response = await getTelnyxClient().credentialConnections.retrieve(connectionId);
  const data = response.data;

  if (!data) {
    return null;
  }

  return {
    connectionId: data.id ?? connectionId,
    webhookEventUrl: normalizeOptionalValue(data.webhook_event_url),
    webhookApiVersion: data.webhook_api_version ?? null,
  };
}

export async function ensureTelnyxConnectionWebhookConfigured() {
  const expectedWebhookUrl = getVoiceWebhookUrl();
  const connectionId = normalizeOptionalValue(env.TELNYX_CONNECTION_ID);

  if (!expectedWebhookUrl || !connectionId || !isPublicWebhookBaseUrlConfigured()) {
    return null;
  }

  const cacheKey = `${connectionId}:${expectedWebhookUrl}`;

  if (cachedWebhookSyncKey === cacheKey) {
    return {
      webhookEventUrl: expectedWebhookUrl,
      updated: false,
    };
  }

  let current: Awaited<ReturnType<typeof getTelnyxConnectionWebhookConfig>>;

  try {
    logInfo("Checking Telnyx credential connection webhook config", {
      connectionId,
      expectedWebhookUrl,
    });

    current = await getTelnyxConnectionWebhookConfig();
  } catch (error) {
    logTelnyxOperationError("Failed to retrieve Telnyx credential connection webhook config", error, {
      connectionId,
      expectedWebhookUrl,
    });
    throw error;
  }

  if (current?.webhookEventUrl === expectedWebhookUrl && current.webhookApiVersion === "2") {
    cachedWebhookSyncKey = cacheKey;
    return {
      webhookEventUrl: expectedWebhookUrl,
      updated: false,
    };
  }

  try {
    await getTelnyxClient().credentialConnections.update(connectionId, {
      webhook_event_url: expectedWebhookUrl,
      webhook_api_version: "2",
    });
  } catch (error) {
    logTelnyxOperationError("Failed to update Telnyx credential connection webhook config", error, {
      connectionId,
      expectedWebhookUrl,
      currentWebhookUrl: current?.webhookEventUrl ?? null,
      currentWebhookApiVersion: current?.webhookApiVersion ?? null,
    });
    throw error;
  }

  cachedWebhookSyncKey = cacheKey;

  logInfo("Updated Telnyx connection webhook URL", {
    connectionId,
    webhookEventUrl: expectedWebhookUrl,
  });

  return {
    webhookEventUrl: expectedWebhookUrl,
    updated: true,
  };
}

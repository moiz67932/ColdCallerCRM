import "server-only";

import { env, requireEnv } from "@/lib/env";
import { logSquareRequest, logSquareResponse, logWorkflowError } from "@/lib/logging/workflow-logger";

export const DEFAULT_SQUARE_ENV = "sandbox";
export const DEFAULT_SQUARE_BASE_URL = "https://connect.squareupsandbox.com";
export const DEFAULT_SQUARE_API_VERSION = "2026-05-20";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

export type SquareRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type SquareRequestArgs = {
  method: SquareRequestMethod;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  appointmentIntentId?: string;
  operationName?: string;
  timeoutMs?: number;
};

type SquareRequestLogContext = Pick<SquareRequestArgs, "appointmentIntentId" | "operationName"> & {
  method: SquareRequestMethod;
  path: string;
  status?: number;
  durationMs?: number;
  attempt?: number;
};

export function getSquareConfig() {
  const accessToken = requireEnv("SQUARE_ACCESS_TOKEN").trim();

  return {
    environment: env.SQUARE_ENV || DEFAULT_SQUARE_ENV,
    baseUrl: env.SQUARE_BASE_URL?.trim() || DEFAULT_SQUARE_BASE_URL,
    apiVersion: env.SQUARE_API_VERSION?.trim() || DEFAULT_SQUARE_API_VERSION,
    accessToken,
  };
}

export class SquareApiError extends Error {
  status: number;
  endpoint: string;
  method: SquareRequestMethod;
  errorBody: unknown;

  constructor(args: {
    status: number;
    endpoint: string;
    method: SquareRequestMethod;
    errorBody: unknown;
    message?: string;
  }) {
    super(args.message ?? `Square API request failed: ${args.method} ${args.endpoint} (${args.status})`);
    this.name = "SquareApiError";
    this.status = args.status;
    this.endpoint = args.endpoint;
    this.method = args.method;
    this.errorBody = args.errorBody;
    Object.setPrototypeOf(this, SquareApiError.prototype);
  }
}

export async function squareRequest<T>(args: SquareRequestArgs): Promise<T> {
  return withSquareRetry(() => sendSquareRequest<T>(args), {
    method: args.method,
    path: args.path,
    appointmentIntentId: args.appointmentIntentId,
    operationName: args.operationName,
  });
}

export async function withSquareRetry<T>(
  operation: () => Promise<T>,
  logContext?: Omit<SquareRequestLogContext, "status" | "durationMs" | "attempt">,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!shouldRetrySquareError(error) || attempt === MAX_RETRIES) {
        throw error;
      }

      logWorkflowError("square.request.retry", {
        operation: logContext?.operationName,
        step: "retry",
        appointment_intent_id: logContext?.appointmentIntentId,
        method: logContext?.method,
        path: logContext?.path,
        attempt: attempt + 1,
        status: error instanceof SquareApiError ? error.status : undefined,
        error_code: "SQUARE_RETRYABLE_ERROR",
        reason: getSquareRetryReason(error),
        safe_message: "Retrying Square request after retryable failure.",
      });

      await sleep(getBackoffMs(attempt));
    }
  }

  throw lastError;
}

async function sendSquareRequest<T>(args: SquareRequestArgs): Promise<T> {
  const config = getSquareConfig();
  const url = getSquareUrl(config.baseUrl, args.path);
  const startedAt = Date.now();
  const abortController = args.timeoutMs ? new AbortController() : null;
  const timeout = abortController
    ? setTimeout(() => abortController.abort(), args.timeoutMs)
    : null;

  logSquareRequest({
    operation: args.operationName,
    step: "request_start",
    appointment_intent_id: args.appointmentIntentId,
    method: args.method,
    path: args.path,
  });

  try {
    const response = await fetch(url, {
      method: args.method,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Square-Version": config.apiVersion,
        "Content-Type": "application/json",
      },
      body: buildSquareRequestBody(args),
      signal: abortController?.signal,
    });
    if (timeout) clearTimeout(timeout);
    const durationMs = Date.now() - startedAt;

    logSquareResponse({
      operation: args.operationName,
      step: response.ok ? "request_complete" : "request_failed",
      appointment_intent_id: args.appointmentIntentId,
      method: args.method,
      path: args.path,
      status: response.status,
      duration_ms: durationMs,
    });

    if (!response.ok) {
      const errorBody = await parseSquareResponseBody(response);

      logSquareResponse({
        operation: args.operationName,
        step: "error_body",
        appointment_intent_id: args.appointmentIntentId,
        method: args.method,
        path: args.path,
        status: response.status,
        duration_ms: durationMs,
        error_code: "SQUARE_API_ERROR",
        square_error_body: errorBody,
        safe_message: "Square API returned an error response.",
      });

      throw new SquareApiError({
        status: response.status,
        endpoint: args.path,
        method: args.method,
        errorBody,
      });
    }

    return (await parseSquareResponseBody(response)) as T;
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    const durationMs = Date.now() - startedAt;

    logSquareResponse({
      operation: args.operationName,
      step: "request_failed",
      appointment_intent_id: args.appointmentIntentId,
      method: args.method,
      path: args.path,
      status: error instanceof SquareApiError ? error.status : undefined,
      duration_ms: durationMs,
      error_code: error instanceof SquareApiError ? "SQUARE_API_ERROR" : "SQUARE_NETWORK_ERROR",
      square_error_body: error instanceof SquareApiError ? error.errorBody : undefined,
      safe_message: error instanceof Error ? error.message : "Square request failed.",
    });

    throw error;
  }
}

function getSquareUrl(baseUrl: string, path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return new URL(normalizedPath, baseUrl).toString();
}

function buildSquareRequestBody(args: SquareRequestArgs) {
  if (args.body === undefined && !args.idempotencyKey) {
    return undefined;
  }

  if (args.body && typeof args.body === "object" && !Array.isArray(args.body)) {
    const body = { ...(args.body as Record<string, unknown>) };

    if (args.idempotencyKey && body.idempotency_key === undefined) {
      body.idempotency_key = args.idempotencyKey;
    }

    return JSON.stringify(body);
  }

  if (args.idempotencyKey) {
    return JSON.stringify({ idempotency_key: args.idempotencyKey });
  }

  return JSON.stringify(args.body);
}

async function parseSquareResponseBody(response: Response) {
  if (response.status === 204) {
    return undefined;
  }

  const text = await response.text();

  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function shouldRetrySquareError(error: unknown) {
  if (error instanceof SquareApiError) {
    return RETRYABLE_STATUSES.has(error.status);
  }

  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

function getBackoffMs(attempt: number) {
  return 150 * 2 ** attempt + Math.floor(Math.random() * 75);
}

function getSquareRetryReason(error: unknown) {
  if (error instanceof SquareApiError) {
    return `http_${error.status}`;
  }

  if (error instanceof Error) {
    return error.name || "network_error";
  }

  return "unknown_retryable_error";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

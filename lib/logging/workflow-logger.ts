import "server-only";

import { logError, logInfo, logWarn } from "@/lib/logger";

type WorkflowLogLevel = "info" | "warn" | "error";

export type WorkflowLogContext = {
  request_id?: string | null;
  debug_id?: string | null;
  operation?: string | null;
  step?: string | null;
  appointment_intent_id?: string | null;
  appointmentIntentId?: string | null;
  conversation_id?: string | null;
  conversationId?: string | null;
  square_order_id?: string | null;
  squareOrderId?: string | null;
  square_payment_id?: string | null;
  squarePaymentId?: string | null;
  square_booking_id?: string | null;
  squareBookingId?: string | null;
  telnyx_message_id?: string | null;
  telnyxMessageId?: string | null;
  method?: string | null;
  path?: string | null;
  status?: number | string | null;
  duration_ms?: number | null;
  durationMs?: number | null;
  error_code?: string | null;
  errorCode?: string | null;
  message?: string | null;
  safe_message?: string | null;
  template_name?: string | null;
  templateName?: string | null;
  message_type?: string | null;
  messageType?: string | null;
  to_phone?: string | null;
  to?: string | null;
  square_error_body?: unknown;
  error_body?: unknown;
  payload?: unknown;
  [key: string]: unknown;
};

const REDACTED_KEYS = new Set([
  "authorization",
  "access_token",
  "api_key",
  "signature_key",
  "signature",
  "card",
  "card_details",
  "source",
  "token",
]);

export function logWorkflowInfo(event: string, context: WorkflowLogContext = {}) {
  writeWorkflowLog("info", event, context);
}

export function logWorkflowError(event: string, context: WorkflowLogContext = {}) {
  writeWorkflowLog("error", event, context);
}

export function logSquareRequest(context: WorkflowLogContext) {
  logWorkflowInfo("square.request.start", {
    ...context,
    operation: context.operation ?? "square_request",
    step: context.step ?? "request_start",
  });
}

export function logSquareResponse(context: WorkflowLogContext) {
  const status = Number(context.status);
  const isErrorStatus = Number.isFinite(status) && status >= 400;

  writeWorkflowLog(isErrorStatus ? "error" : "info", isErrorStatus ? "square.request.failed" : "square.request.complete", {
    ...context,
    operation: context.operation ?? "square_request",
    step: context.step ?? (isErrorStatus ? "request_failed" : "request_complete"),
  });
}

export function logTelnyxRequest(context: WorkflowLogContext) {
  logWorkflowInfo("telnyx.whatsapp.request.start", {
    ...context,
    operation: context.operation ?? "telnyx_whatsapp_send",
    step: context.step ?? "request_start",
  });
}

export function logTelnyxResponse(context: WorkflowLogContext) {
  const status = Number(context.status);
  const isErrorStatus = Number.isFinite(status) && status >= 400;

  writeWorkflowLog(
    isErrorStatus ? "error" : "info",
    isErrorStatus ? "telnyx.whatsapp.request.failed" : "telnyx.whatsapp.request.complete",
    {
      ...context,
      operation: context.operation ?? "telnyx_whatsapp_send",
      step: context.step ?? (isErrorStatus ? "request_failed" : "request_complete"),
    },
  );
}

export function logSupabaseWorkflowEvent(context: WorkflowLogContext) {
  const status = typeof context.status === "string" ? context.status : undefined;

  writeWorkflowLog(status === "failed" ? "warn" : "info", "supabase.workflow_event", {
    ...context,
    operation: context.operation ?? "appointment_workflow_event",
    step: context.step ?? "insert_workflow_event",
  });
}

export function createDebugId(prefix = "wf") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function maskPhoneNumber(phone: string | null | undefined) {
  if (!phone) {
    return undefined;
  }

  const trimmed = phone.trim();

  if (trimmed.length <= 5) {
    return "***";
  }

  return `${trimmed.slice(0, 2)}***${trimmed.slice(-4)}`;
}

export function sanitizeForWorkflowLog(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitizeForWorkflowLog(item));
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();

    if (normalizedKey.includes("phone") && typeof nestedValue === "string") {
      sanitized[key] = maskPhoneNumber(nestedValue);
      continue;
    }

    if ([...REDACTED_KEYS].some((redactedKey) => normalizedKey.includes(redactedKey))) {
      sanitized[key] = "[redacted]";
      continue;
    }

    sanitized[key] = sanitizeForWorkflowLog(nestedValue);
  }

  return sanitized;
}

function writeWorkflowLog(level: WorkflowLogLevel, event: string, context: WorkflowLogContext) {
  const normalized = normalizeContext(context);
  const message = normalized.safe_message ?? normalized.message ?? event;
  const payload = {
    event,
    request_id: normalized.request_id,
    debug_id: normalized.debug_id,
    operation: normalized.operation,
    step: normalized.step,
    appointment_intent_id: normalized.appointment_intent_id,
    conversation_id: normalized.conversation_id,
    square_order_id: normalized.square_order_id,
    square_payment_id: normalized.square_payment_id,
    square_booking_id: normalized.square_booking_id,
    telnyx_message_id: normalized.telnyx_message_id,
    method: normalized.method,
    path: normalized.path,
    status: normalized.status,
    duration_ms: normalized.duration_ms,
    error_code: normalized.error_code,
    safe_message: message,
    ...normalized.extra,
  };

  if (level === "error") {
    logError(event, compact(payload));
    return;
  }

  if (level === "warn") {
    logWarn(event, compact(payload));
    return;
  }

  logInfo(event, compact(payload));
}

function normalizeContext(context: WorkflowLogContext) {
  const {
    request_id,
    debug_id,
    operation,
    step,
    appointment_intent_id,
    appointmentIntentId,
    conversation_id,
    conversationId,
    square_order_id,
    squareOrderId,
    square_payment_id,
    squarePaymentId,
    square_booking_id,
    squareBookingId,
    telnyx_message_id,
    telnyxMessageId,
    method,
    path,
    status,
    duration_ms,
    durationMs,
    error_code,
    errorCode,
    message,
    safe_message,
    to,
    to_phone,
    template_name,
    templateName,
    message_type,
    messageType,
    square_error_body,
    error_body,
    payload,
    ...rest
  } = context;

  return {
    request_id: stringOrUndefined(request_id),
    debug_id: stringOrUndefined(debug_id),
    operation: stringOrUndefined(operation),
    step: stringOrUndefined(step),
    appointment_intent_id: stringOrUndefined(appointment_intent_id ?? appointmentIntentId),
    conversation_id: stringOrUndefined(conversation_id ?? conversationId),
    square_order_id: stringOrUndefined(square_order_id ?? squareOrderId),
    square_payment_id: stringOrUndefined(square_payment_id ?? squarePaymentId),
    square_booking_id: stringOrUndefined(square_booking_id ?? squareBookingId),
    telnyx_message_id: stringOrUndefined(telnyx_message_id ?? telnyxMessageId),
    method: stringOrUndefined(method),
    path: stringOrUndefined(path),
    status: status ?? undefined,
    duration_ms: typeof duration_ms === "number" ? duration_ms : durationMs,
    error_code: stringOrUndefined(error_code ?? errorCode),
    message: stringOrUndefined(message),
    safe_message: stringOrUndefined(safe_message),
    extra: compact({
      ...rest,
      template_name: template_name ?? templateName,
      message_type: message_type ?? messageType,
      to_phone_masked: maskPhoneNumber(to_phone ?? to),
      square_error_body: sanitizeForWorkflowLog(square_error_body),
      error_body: sanitizeForWorkflowLog(error_body),
      payload: sanitizeForWorkflowLog(payload),
    }),
  };
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined && entryValue !== null));
}

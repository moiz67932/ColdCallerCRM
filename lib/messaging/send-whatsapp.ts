import "server-only";

import { env, requireEnv } from "@/lib/env";
import {
  logWorkflowInfo,
  logSupabaseWorkflowEvent,
  logTelnyxRequest,
  logTelnyxResponse,
  logWorkflowError,
  maskPhoneNumber,
} from "@/lib/logging/workflow-logger";
import { createPayToken } from "@/lib/payments/pay-token";

const TELNYX_WHATSAPP_MESSAGES_URL = "https://api.telnyx.com/v2/messages/whatsapp";
const DEFAULT_PAY_TOKEN_EXPIRY_MINUTES = 60 * 24 * 14;
const RETRYABLE_TELNYX_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_TELNYX_RETRIES = 2;

export type TelnyxWhatsAppMessageType = "payment_link" | "confirmation" | "reminder" | "manual_review";

export type TelnyxWhatsAppConfig = {
  apiKey: string;
  fromNumber: string;
  paymentLinkTemplate?: string;
  confirmationTemplate?: string;
  reminderTemplate?: string;
  manualReviewTemplate?: string;
  webhookUrl?: string;
};

export type TelnyxWhatsAppSendResult = {
  provider: "telnyx";
  providerMessageId: string | null;
  status: string | null;
  raw: unknown;
};

export type SendPaymentLinkWhatsAppInput = {
  appointmentIntentId: string;
  toPhoneE164: string;
  patientName: string;
  serviceName: string;
  clinicName: string;
  paymentLinkUrl?: string;
  paymentButtonToken?: string;
  selectedTimeDisplay?: string;
};

export type SendAppointmentConfirmedWhatsAppInput = {
  appointmentIntentId: string;
  toPhoneE164: string;
  patientName: string;
  serviceName: string;
  clinicName: string;
  selectedTimeDisplay: string;
};

export type SendAppointmentReminderWhatsAppInput = SendAppointmentConfirmedWhatsAppInput;
export type SendAppointmentConfirmationWhatsAppInput = SendAppointmentConfirmedWhatsAppInput;

export type SendManualReviewWhatsAppInput = {
  appointmentIntentId: string;
  toPhoneE164: string;
  patientName: string;
  serviceName: string;
  clinicName: string;
  selectedTimeDisplay?: string;
};

type TelnyxWhatsAppRequestArgs = {
  messageType: TelnyxWhatsAppMessageType;
  appointmentIntentId: string;
  to: string;
  templateName: string;
  bodyParameters: string[];
  buttonUrlParameter?: string;
};

type TelnyxWhatsAppResponse = {
  data?: {
    id?: string;
    status?: string;
  };
};

type TelnyxTemplateTextParameter = {
  type: "text";
  text: string;
};

type TelnyxTemplateBodyComponent = {
  type: "body";
  parameters: TelnyxTemplateTextParameter[];
};

type TelnyxTemplateButtonComponent = {
  type: "button";
  sub_type: "url";
  index: number;
  parameters: TelnyxTemplateTextParameter[];
};

type TelnyxTemplateComponent = TelnyxTemplateBodyComponent | TelnyxTemplateButtonComponent;

type TelnyxTemplateMessagePayload = {
  from: string;
  to: string;
  webhook_url?: string;
  whatsapp_message: {
    type: "template";
    template: {
      name: string;
      language: {
        code: string;
        policy: "deterministic";
      };
      components: TelnyxTemplateComponent[];
    };
  };
};

export function getTelnyxWhatsAppConfig(): TelnyxWhatsAppConfig {
  return {
    apiKey: requireEnv("TELNYX_API_KEY").trim(),
    fromNumber: requireEnv("TELNYX_WHATSAPP_FROM_NUMBER").trim(),
    paymentLinkTemplate:
      env.TELNYX_WHATSAPP_PAYMENT_LINK_TEMPLATE?.trim() ||
      env.TELNYX_WHATSAPP_PAYMENT_LINK_TEMPLATE_ID?.trim() ||
      undefined,
    confirmationTemplate:
      env.TELNYX_WHATSAPP_CONFIRMATION_TEMPLATE?.trim() ||
      env.TELNYX_WHATSAPP_CONFIRMATION_TEMPLATE_ID?.trim() ||
      undefined,
    reminderTemplate: env.TELNYX_WHATSAPP_REMINDER_TEMPLATE?.trim() || undefined,
    manualReviewTemplate: env.TELNYX_WHATSAPP_MANUAL_REVIEW_TEMPLATE_ID?.trim() || undefined,
    webhookUrl: env.TELNYX_WHATSAPP_WEBHOOK_URL?.trim() || undefined,
  };
}

export async function telnyxWhatsAppRequest<T>(args: TelnyxWhatsAppRequestArgs): Promise<T> {
  return withTelnyxRetry(() => sendTelnyxWhatsAppRequest<T>(args), args);
}

async function withTelnyxRetry<T>(operation: () => Promise<T>, args: TelnyxWhatsAppRequestArgs): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_TELNYX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!shouldRetryTelnyxError(error) || attempt === MAX_TELNYX_RETRIES) {
        throw error;
      }

      logWorkflowError("telnyx.whatsapp.request.retry", {
        operation: "telnyx_whatsapp_send",
        step: "retry",
        appointment_intent_id: args.appointmentIntentId,
        message_type: args.messageType,
        template_name: args.templateName,
        to_phone: args.to,
        attempt: attempt + 1,
        status: error instanceof TelnyxWhatsAppError ? error.status : undefined,
        error_code: "TELNYX_RETRYABLE_ERROR",
        reason: getTelnyxRetryReason(error),
        safe_message: "Retrying Telnyx WhatsApp request after temporary failure.",
      });

      await sleep(getTelnyxBackoffMs(attempt));
    }
  }

  throw lastError;
}

async function sendTelnyxWhatsAppRequest<T>(args: TelnyxWhatsAppRequestArgs): Promise<T> {
  const config = getTelnyxWhatsAppConfig();
  const startedAt = Date.now();
  const payload = buildTelnyxTemplateMessagePayload({
    from: config.fromNumber,
    to: args.to,
    webhookUrl: config.webhookUrl,
    templateName: args.templateName,
    bodyParameters: args.bodyParameters,
    buttonUrlParameter: args.buttonUrlParameter,
  });
  validateTelnyxTemplateMessagePayload(payload);

  logTelnyxRequest({
    operation: "telnyx_whatsapp_send",
    step: "request_start",
    appointment_intent_id: args.appointmentIntentId,
    messageType: args.messageType,
    templateName: args.templateName,
    to: args.to,
  });
  logWorkflowInfo("telnyx.whatsapp.request.payload", {
    operation: "telnyx_whatsapp_send",
    step: "request_payload",
    appointment_intent_id: args.appointmentIntentId,
    message_type: args.messageType,
    template_name: args.templateName,
    to_phone: args.to,
    payload,
    parameter_types: describeTelnyxPayloadTypes(payload),
    template_components: payload.whatsapp_message.template.components,
    variable_substitutions: describeTemplateVariableSubstitutions(payload),
    schema_audit: describeTelnyxTemplateSchemaAudit(payload),
  });

  try {
    const response = await fetch(TELNYX_WHATSAPP_MESSAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const durationMs = Date.now() - startedAt;

    logTelnyxResponse({
      operation: "telnyx_whatsapp_send",
      step: response.ok ? "request_complete" : "request_failed",
      appointment_intent_id: args.appointmentIntentId,
      messageType: args.messageType,
      templateName: args.templateName,
      to: args.to,
      status: response.status,
      duration_ms: durationMs,
    });

    const responseBody = await parseTelnyxResponseBody(response);

    if (!response.ok) {
      logTelnyxResponse({
        operation: "telnyx_whatsapp_send",
        step: "error_body",
        appointment_intent_id: args.appointmentIntentId,
        messageType: args.messageType,
        templateName: args.templateName,
        to: args.to,
        status: response.status,
        duration_ms: durationMs,
        error_code: "TELNYX_WHATSAPP_ERROR",
        error_body: responseBody,
        safe_message: "Telnyx WhatsApp request returned an error response.",
      });

      throw new TelnyxWhatsAppError({
        status: response.status,
        messageType: args.messageType,
        to: args.to,
        errorBody: responseBody,
      });
    }

    return responseBody as T;
  } catch (error) {
    const durationMs = Date.now() - startedAt;

    logTelnyxResponse({
      operation: "telnyx_whatsapp_send",
      step: "request_failed",
      appointment_intent_id: args.appointmentIntentId,
      messageType: args.messageType,
      templateName: args.templateName,
      to: args.to,
      status: error instanceof TelnyxWhatsAppError ? error.status : undefined,
      duration_ms: durationMs,
      error_code: error instanceof TelnyxWhatsAppError ? "TELNYX_WHATSAPP_ERROR" : "TELNYX_WHATSAPP_NETWORK_ERROR",
      error_body: error instanceof TelnyxWhatsAppError ? error.errorBody : undefined,
      safe_message: error instanceof Error ? error.message : "Telnyx WhatsApp request failed.",
    });

    throw error;
  }
}

export function sendPaymentLinkWhatsApp(
  input: SendPaymentLinkWhatsAppInput,
): Promise<TelnyxWhatsAppSendResult> {
  validateCommonMessageInput(input);
  const payToken =
    input.paymentButtonToken?.trim() ||
    createPayToken({
      appointmentIntentId: input.appointmentIntentId,
      expiresInMinutes: DEFAULT_PAY_TOKEN_EXPIRY_MINUTES,
    });

  return sendTemplateWhatsApp({
    messageType: "payment_link",
    appointmentIntentId: input.appointmentIntentId,
    to: input.toPhoneE164,
    templateName: requireTemplateName(
      "TELNYX_WHATSAPP_PAYMENT_LINK_TEMPLATE",
      "TELNYX_WHATSAPP_PAYMENT_LINK_TEMPLATE_ID",
    ),
    bodyParameters: [input.patientName, input.serviceName, input.clinicName],
    buttonUrlParameter: payToken,
  });
}

export function sendAppointmentConfirmedWhatsApp(
  input: SendAppointmentConfirmedWhatsAppInput,
): Promise<TelnyxWhatsAppSendResult> {
  validateCommonMessageInput(input);

  if (!input.selectedTimeDisplay.trim()) {
    throw new Error("Missing appointment time for WhatsApp confirmation message.");
  }

  return sendTemplateWhatsApp({
    messageType: "confirmation",
    appointmentIntentId: input.appointmentIntentId,
    to: input.toPhoneE164,
    templateName: requireTemplateName(
      "TELNYX_WHATSAPP_CONFIRMATION_TEMPLATE",
      "TELNYX_WHATSAPP_CONFIRMATION_TEMPLATE_ID",
    ),
    bodyParameters: [input.patientName, input.serviceName, input.clinicName, input.selectedTimeDisplay],
  });
}

export function sendAppointmentConfirmationWhatsApp(
  input: SendAppointmentConfirmationWhatsAppInput,
): Promise<TelnyxWhatsAppSendResult> {
  return sendAppointmentConfirmedWhatsApp(input);
}

export function sendAppointmentReminderWhatsApp(
  input: SendAppointmentReminderWhatsAppInput,
): Promise<TelnyxWhatsAppSendResult> {
  validateCommonMessageInput(input);

  if (!input.selectedTimeDisplay.trim()) {
    throw new Error("Missing appointment time for WhatsApp reminder message.");
  }

  return sendTemplateWhatsApp({
    messageType: "reminder",
    appointmentIntentId: input.appointmentIntentId,
    to: input.toPhoneE164,
    templateName: requireTemplateName("TELNYX_WHATSAPP_REMINDER_TEMPLATE"),
    bodyParameters: [input.patientName, input.serviceName, input.clinicName, input.selectedTimeDisplay],
  });
}

export function sendManualReviewWhatsApp(
  input: SendManualReviewWhatsAppInput,
): Promise<TelnyxWhatsAppSendResult> {
  validateCommonMessageInput(input);

  return sendTemplateWhatsApp({
    messageType: "manual_review",
    appointmentIntentId: input.appointmentIntentId,
    to: input.toPhoneE164,
    templateName: requireTemplateName("TELNYX_WHATSAPP_MANUAL_REVIEW_TEMPLATE_ID"),
    bodyParameters: [
      input.patientName,
      input.serviceName,
      input.clinicName,
      input.selectedTimeDisplay?.trim() || "the selected appointment time",
    ],
  });
}

async function sendTemplateWhatsApp(args: TelnyxWhatsAppRequestArgs): Promise<TelnyxWhatsAppSendResult> {
  const response = await telnyxWhatsAppRequest<TelnyxWhatsAppResponse>({
    ...args,
    bodyParameters: args.bodyParameters.map((parameter) => parameter.trim()),
  });
  const providerMessageId = response.data?.id ?? null;
  const status = response.data?.status ?? null;

  logSupabaseWorkflowEvent({
    operation: "telnyx_whatsapp_send",
    step: "whatsapp_sent",
    appointment_intent_id: args.appointmentIntentId,
    telnyx_message_id: providerMessageId,
    status: status ?? "sent",
    message_type: args.messageType,
    template_name: args.templateName,
    to_phone: args.to,
    safe_message: `Telnyx WhatsApp ${args.messageType} sent to ${maskPhoneNumber(args.to)}.`,
  });

  return {
    provider: "telnyx",
    providerMessageId,
    status,
    raw: response,
  };
}

export function buildTelnyxTemplateMessagePayload(input: {
  from: string;
  to: string;
  webhookUrl?: string;
  templateName: string;
  bodyParameters: string[];
  buttonUrlParameter?: string;
}): TelnyxTemplateMessagePayload {
  return {
    from: input.from,
    to: input.to,
    webhook_url: input.webhookUrl,
    whatsapp_message: {
      type: "template",
      template: {
        name: input.templateName,
        language: {
          code: "en",
          policy: "deterministic",
        },
        components: [
          {
            type: "body",
            // Body parameters fill template body variables in order: {{1}}, {{2}}, {{3}}, etc.
            parameters: input.bodyParameters.map((parameter) => ({
              type: "text",
              text: parameter,
            })),
          },
          ...(input.buttonUrlParameter
            ? [
                {
                  type: "button",
                  sub_type: "url",
                  index: 0,
                  // Dynamic URL button parameters fill the button suffix only.
                  // For /pay/{{1}}, pass the secure pay token, never the full Square checkout URL.
                  parameters: [
                    {
                      type: "text",
                      text: input.buttonUrlParameter,
                    },
                  ],
                },
              ]
            : []),
        ],
      },
    },
  };
}

export function validateTelnyxTemplateMessagePayload(payload: TelnyxTemplateMessagePayload) {
  assertNonEmptyString(payload.from, "from");
  assertNonEmptyString(payload.to, "to");

  if (payload.webhook_url !== undefined) {
    assertNonEmptyString(payload.webhook_url, "webhook_url");
  }

  if (payload.whatsapp_message.type !== "template") {
    throw new Error("Telnyx WhatsApp payload whatsapp_message.type must be \"template\".");
  }

  const template = payload.whatsapp_message.template;
  assertNonEmptyString(template.name, "whatsapp_message.template.name");
  assertNonEmptyString(template.language.code, "whatsapp_message.template.language.code");

  if (template.language.policy !== "deterministic") {
    throw new Error("whatsapp_message.template.language.policy must be \"deterministic\".");
  }

  if (!Array.isArray(template.components) || template.components.length === 0) {
    throw new Error("Telnyx WhatsApp template components must be a non-empty array.");
  }

  template.components.forEach((component, componentIndex) => {
    const path = `whatsapp_message.template.components[${componentIndex}]`;

    assertNonEmptyString(component.type, `${path}.type`);

    if (component.type === "body") {
      assertTextParameters(component.parameters, `${path}.parameters`);
      return;
    }

    if (component.type === "button") {
      if (component.sub_type !== "url") {
        throw new Error(`${path}.sub_type must be "url".`);
      }

      if (!Number.isInteger(component.index)) {
        throw new Error(`${path}.index must be an integer number, not ${typeof component.index}.`);
      }

      assertTextParameters(component.parameters, `${path}.parameters`);
      return;
    }

    throw new Error(`${path}.type is not supported by this WhatsApp template sender.`);
  });
}

function assertTextParameters(parameters: TelnyxTemplateTextParameter[], path: string) {
  if (!Array.isArray(parameters)) {
    throw new Error(`${path} must be an array.`);
  }

  parameters.forEach((parameter, parameterIndex) => {
    const parameterPath = `${path}[${parameterIndex}]`;

    if (parameter.type !== "text") {
      throw new Error(`${parameterPath}.type must be "text".`);
    }

    assertNonEmptyString(parameter.text, `${parameterPath}.text`);
  });
}

function assertNonEmptyString(value: unknown, path: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

function describeTelnyxPayloadTypes(payload: TelnyxTemplateMessagePayload) {
  return {
    from: typeof payload.from,
    to: typeof payload.to,
    webhook_url: payload.webhook_url === undefined ? "undefined" : typeof payload.webhook_url,
    whatsapp_message_type: typeof payload.whatsapp_message.type,
    template_name: typeof payload.whatsapp_message.template.name,
    language_code: typeof payload.whatsapp_message.template.language.code,
    language_policy: typeof payload.whatsapp_message.template.language.policy,
    components: payload.whatsapp_message.template.components.map((component, componentIndex) => ({
      component_index: componentIndex,
      type: component.type,
      type_typeof: typeof component.type,
      sub_type: component.type === "button" ? component.sub_type : undefined,
      sub_type_typeof: component.type === "button" ? typeof component.sub_type : undefined,
      index: component.type === "button" ? component.index : undefined,
      index_typeof: component.type === "button" ? typeof component.index : undefined,
      parameters: component.parameters.map((parameter, parameterIndex) => ({
        parameter_index: parameterIndex,
        type: parameter.type,
        type_typeof: typeof parameter.type,
        text_typeof: typeof parameter.text,
        text_length: parameter.text.length,
      })),
    })),
  };
}

function describeTemplateVariableSubstitutions(payload: TelnyxTemplateMessagePayload) {
  return payload.whatsapp_message.template.components.map((component, componentIndex) => ({
    component_index: componentIndex,
    component_type: component.type,
    button_index: component.type === "button" ? component.index : undefined,
    substitutions: component.parameters.map((parameter, parameterIndex) => ({
      variable_position: parameterIndex + 1,
      parameter_type: parameter.type,
      text: parameter.text,
    })),
  }));
}

function describeTelnyxTemplateSchemaAudit(payload: TelnyxTemplateMessagePayload) {
  return {
    integer_fields: payload.whatsapp_message.template.components.flatMap((component, componentIndex) =>
      component.type === "button"
        ? [
            {
              path: `whatsapp_message.template.components[${componentIndex}].index`,
              value: component.index,
              typeof: typeof component.index,
            },
          ]
        : [],
    ),
    absent_fields: {
      currency: true,
      media: true,
      media_indexes: true,
      expiration: true,
    },
  };
}

function validateCommonMessageInput(input: {
  appointmentIntentId: string;
  toPhoneE164: string;
  patientName: string;
  serviceName: string;
  clinicName: string;
}) {
  if (!input.appointmentIntentId.trim()) {
    throw new Error("Missing appointment intent ID for WhatsApp message.");
  }

  if (!input.toPhoneE164.trim()) {
    throw new Error("Missing destination phone number for WhatsApp message.");
  }

  if (!input.patientName.trim()) {
    throw new Error("Missing patient name for WhatsApp message.");
  }

  if (!input.serviceName.trim()) {
    throw new Error("Missing service name for WhatsApp message.");
  }

  if (!input.clinicName.trim()) {
    throw new Error("Missing clinic name for WhatsApp message.");
  }
}

function requireTemplateName(primaryName: keyof typeof env, fallbackName?: keyof typeof env) {
  const primaryValue = env[primaryName];

  if (typeof primaryValue === "string" && primaryValue.trim()) {
    return primaryValue.trim();
  }

  if (fallbackName) {
    const fallbackValue = env[fallbackName];

    if (typeof fallbackValue === "string" && fallbackValue.trim()) {
      return fallbackValue.trim();
    }
  }

  return requireEnv(primaryName).trim();
}

async function parseTelnyxResponseBody(response: Response) {
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

function shouldRetryTelnyxError(error: unknown) {
  if (error instanceof TelnyxWhatsAppError) {
    return RETRYABLE_TELNYX_STATUSES.has(error.status);
  }

  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

function getTelnyxBackoffMs(attempt: number) {
  return 150 * 2 ** attempt + Math.floor(Math.random() * 75);
}

function getTelnyxRetryReason(error: unknown) {
  if (error instanceof TelnyxWhatsAppError) {
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

class TelnyxWhatsAppError extends Error {
  status: number;
  messageType: TelnyxWhatsAppMessageType;
  to: string;
  errorBody: unknown;

  constructor(args: {
    status: number;
    messageType: TelnyxWhatsAppMessageType;
    to: string;
    errorBody: unknown;
  }) {
    super(`Telnyx WhatsApp request failed: ${args.messageType} to ${args.to} (${args.status})`);
    this.name = "TelnyxWhatsAppError";
    this.status = args.status;
    this.messageType = args.messageType;
    this.to = args.to;
    this.errorBody = args.errorBody;
    Object.setPrototypeOf(this, TelnyxWhatsAppError.prototype);
  }
}

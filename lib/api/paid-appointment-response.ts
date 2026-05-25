import { NextResponse } from "next/server";
import type { ZodError } from "zod";

import { formatZodFieldErrors } from "@/lib/validation/paid-appointment";

type JsonOptions = {
  status?: number;
  step?: string;
  message?: string;
  debugId?: string;
  appointmentIntentId?: string | null;
  say?: string;
};

type FailInput = {
  errorCode: string;
  step: string;
  message: string;
  debugId?: string;
  appointmentIntentId?: string | null;
  safeDetails?: Record<string, unknown>;
  say?: string;
};

// Paid appointment endpoints use this response contract so voice tools,
// dashboard debugging, and Vercel logs can all rely on the same top-level keys.
export function okJson(data: Record<string, unknown> = {}, options: JsonOptions = {}) {
  return NextResponse.json(
    {
      success: true,
      step: options.step ?? "completed",
      message: options.message ?? "Request completed.",
      debug_id: options.debugId ?? null,
      appointment_intent_id: options.appointmentIntentId ?? stringOrNull(data.appointment_intent_id),
      data,
      say: options.say ?? null,
    },
    { status: options.status ?? 200 },
  );
}

export function failJson(error: FailInput, options: { status?: number } = {}) {
  return NextResponse.json(
    {
      success: false,
      error_code: error.errorCode,
      step: error.step,
      message: error.message,
      debug_id: error.debugId ?? null,
      appointment_intent_id: error.appointmentIntentId ?? null,
      safe_details: error.safeDetails ?? null,
      say: error.say ?? null,
    },
    { status: options.status ?? 400 },
  );
}

export function validationFailJson(args: {
  step: string;
  error?: ZodError;
  message?: string;
  debugId?: string;
  appointmentIntentId?: string | null;
  say?: string;
}) {
  return NextResponse.json(
    {
      success: false,
      error_code: "VALIDATION_FAILED",
      step: args.step,
      message: args.message ?? "Request validation failed.",
      debug_id: args.debugId ?? null,
      appointment_intent_id: args.appointmentIntentId ?? null,
      safe_details: {
        field_errors: args.error ? formatZodFieldErrors(args.error) : [],
      },
      field_errors: args.error ? formatZodFieldErrors(args.error) : [],
      say: args.say ?? null,
    },
    { status: 400 },
  );
}

export function squareFailJson(args: Omit<FailInput, "errorCode">, options: { status?: number } = {}) {
  return failJson({ ...args, errorCode: "SQUARE_REQUEST_FAILED" }, { status: options.status ?? 502 });
}

export function telnyxFailJson(args: Omit<FailInput, "errorCode">, options: { status?: number } = {}) {
  return failJson({ ...args, errorCode: "TELNYX_REQUEST_FAILED" }, { status: options.status ?? 502 });
}

export function manualReviewJson(data: Record<string, unknown>, options: JsonOptions = {}) {
  return okJson(data, {
    ...options,
    step: options.step ?? "manual_review_needed",
    message: options.message ?? "Manual review is needed.",
  });
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

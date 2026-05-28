import { z, type ZodError } from "zod";

import { normalizePhoneNumber } from "@/lib/phone";

const e164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "Phone number must be E.164 format, for example +13103318914.");

const optionalTextSchema = z.string().trim().min(1).max(500).optional();
const optionalDateSchema = z.string().trim().min(1).max(80).optional();
const squareIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Square ID has an invalid format.");
const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter uppercase code."))
  .default("USD");

export const AppointmentIntentIdSchema = z.string().trim().uuid("appointment_intent_id must be a UUID.");
export const OptionalUuidSchema = z.string().trim().uuid().optional();
export const PayTokenParamSchema = z
  .string()
  .trim()
  .min(20, "Pay token is too short.")
  .max(2048, "Pay token is too long.")
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "Pay token format is invalid.");

export const CreatePaidAppointmentIntentSchema = z.object({
  organization_id: OptionalUuidSchema,
  clinic_id: OptionalUuidSchema,
  lead_id: optionalTextSchema,
  lead_demo_profile_id: OptionalUuidSchema,
  conversation_id: optionalTextSchema,
  caller_name: z.string().trim().min(1, "Caller name is required.").max(160),
  caller_phone: z
    .string()
    .trim()
    .min(1, "Caller phone is required.")
    .transform((value, context) => {
      const normalized = normalizePhoneNumber(value);

      if (!normalized || !e164PhoneSchema.safeParse(normalized).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Caller phone must be a valid phone number that can be normalized to E.164.",
        });
        return z.NEVER;
      }

      return normalized;
    }),
  caller_phone_e164: e164PhoneSchema.optional(),
  caller_email: z.string().trim().email().optional(),
  service_name: z.string().trim().min(1, "Service name is required.").max(160),
  preferred_date: optionalDateSchema,
  preferred_time: optionalTextSchema,
  selected_start_at: optionalTextSchema,
  selected_timezone: optionalTextSchema,
  clinic_timezone: optionalTextSchema,
  selected_time_display: optionalTextSchema,
  notes: z.string().trim().min(1).max(2000).optional(),
  deposit_amount_cents: z.coerce.number().int().min(0).optional(),
  currency: currencySchema,
  square_location_id: squareIdSchema.optional(),
  square_team_member_id: squareIdSchema.optional(),
  square_service_variation_id: squareIdSchema.optional(),
  square_service_variation_version: z.coerce.number().int().positive().optional(),
}).refine(
  (value) => Boolean(value.selected_start_at || (value.preferred_date && value.preferred_time)),
  {
    message: "Either selected_start_at or both preferred_date and preferred_time are required.",
    path: ["selected_start_at"],
  },
);

export const CreatePaymentLinkSchema = z.object({
  appointment_intent_id: AppointmentIntentIdSchema,
  send_message: z.boolean().optional().default(false),
});

export const SendLinkAgainSchema = z.object({
  to_phone_e164: e164PhoneSchema.optional(),
  force_new_link: z.boolean().optional().default(false),
});

export const ManualConfirmSchema = z.object({
  create_square_booking: z.boolean().optional().default(false),
  send_confirmation: z.boolean().optional().default(false),
  override_slot_unavailable: z.boolean().optional().default(false),
  note: z.string().trim().min(1).max(2000).optional(),
});

export const AppointmentIdParamSchema = z.object({
  id: AppointmentIntentIdSchema,
});

export const PayTokenRouteParamSchema = z.object({
  token: PayTokenParamSchema,
});

export const SquareWebhookEventSchema = z
  .object({
    event_id: z.string().optional(),
    type: z.string().optional(),
    merchant_id: z.string().optional(),
    created_at: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export const TelnyxWebhookEventSchema = z
  .object({
    data: z.unknown().optional(),
  })
  .passthrough();

export type CreatePaidAppointmentIntentInput = z.infer<typeof CreatePaidAppointmentIntentSchema>;
export type CreatePaymentLinkInput = z.infer<typeof CreatePaymentLinkSchema>;
export type SendLinkAgainInput = z.infer<typeof SendLinkAgainSchema>;
export type ManualConfirmInput = z.infer<typeof ManualConfirmSchema>;

export function isValidE164Phone(value: string) {
  return e164PhoneSchema.safeParse(value).success;
}

export function normalizeE164Phone(value: string) {
  const parsed = e164PhoneSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function safeParseSquareWebhookEvent(event: unknown) {
  return SquareWebhookEventSchema.safeParse(event);
}

export function safeParseTelnyxWebhookEvent(event: unknown) {
  return TelnyxWebhookEventSchema.safeParse(event);
}

export function formatZodFieldErrors(error: ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "body",
    message: issue.message,
  }));
}

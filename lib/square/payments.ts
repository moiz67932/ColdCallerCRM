import "server-only";

import { buildPaymentLinkIdempotencyKey } from "@/lib/appointments/idempotency";
import { squareRequest } from "@/lib/square/client";

export type InternalSquarePaymentStatus = "completed" | "pending" | "failed" | "refunded" | "expired";

export type CreateAppointmentPaymentLinkInput = {
  appointmentIntentId: string;
  locationId: string;
  serviceName: string;
  clinicName?: string;
  callerName?: string;
  callerPhone?: string;
  callerEmail?: string;
  amountCents: number;
  currency: string;
  depositPercentText?: string;
  selectedStartAt?: string;
  idempotencyKey?: string;
};

export type CreateAppointmentPaymentLinkResult = {
  paymentLinkId: string;
  orderId: string | null;
  checkoutUrl: string;
  raw: unknown;
};

type SquarePaymentLinkResponse = {
  payment_link?: {
    id?: string;
    order_id?: string;
    url?: string;
  };
};

type SquarePaymentResponse = {
  payment?: unknown;
};

export async function createAppointmentPaymentLink(
  input: CreateAppointmentPaymentLinkInput,
): Promise<CreateAppointmentPaymentLinkResult> {
  validatePaymentLinkInput(input);

  const response = await squareRequest<SquarePaymentLinkResponse>({
    method: "POST",
    path: "/v2/online-checkout/payment-links",
    idempotencyKey: input.idempotencyKey?.trim() || buildPaymentLinkIdempotencyKey(input.appointmentIntentId),
    appointmentIntentId: input.appointmentIntentId,
    operationName: "square.create_appointment_payment_link",
    body: buildSquarePaymentLinkRequestBody(input),
  });

  const paymentLink = response.payment_link;

  if (!paymentLink?.id || !paymentLink.url) {
    throw new Error("Square CreatePaymentLink response did not include a payment link id and checkout URL.");
  }

  return {
    paymentLinkId: paymentLink.id,
    orderId: paymentLink.order_id ?? null,
    checkoutUrl: paymentLink.url,
    raw: response,
  };
}

export function retrieveSquarePayment(paymentId: string) {
  const trimmedPaymentId = paymentId.trim();

  if (!trimmedPaymentId) {
    throw new Error("Missing required Square payment ID.");
  }

  return squareRequest<SquarePaymentResponse>({
    method: "GET",
    path: `/v2/payments/${encodeURIComponent(trimmedPaymentId)}`,
    operationName: "square.retrieve_payment",
  });
}

export function buildSquarePaymentLinkRequestBody(input: CreateAppointmentPaymentLinkInput) {
  return {
    description: buildPaymentLinkDescription(input),
    payment_note: buildPaymentNote(input),
    quick_pay: {
      name: `${input.serviceName} Deposit`,
      price_money: {
        amount: input.amountCents,
        currency: input.currency,
      },
      location_id: input.locationId,
    },
    checkout_options: {
      ask_for_shipping_address: false,
    },
    pre_populated_data: buildPrePopulatedData(input),
  };
}

export function mapSquarePaymentStatus(squareStatus: string | null | undefined): InternalSquarePaymentStatus {
  switch (squareStatus?.trim().toUpperCase()) {
    case "COMPLETED":
      return "completed";
    case "APPROVED":
    case "PENDING":
      return "pending";
    case "CANCELED":
    case "CANCELLED":
    case "FAILED":
      return "failed";
    case "REFUNDED":
      return "refunded";
    case "EXPIRED":
      return "expired";
    default:
      return "pending";
  }
}

function validatePaymentLinkInput(input: CreateAppointmentPaymentLinkInput) {
  if (!input.appointmentIntentId.trim()) {
    throw new Error("Missing required appointment intent ID for Square payment link.");
  }

  if (!input.locationId.trim()) {
    throw new Error("Missing required Square location ID for payment link.");
  }

  if (!input.serviceName.trim()) {
    throw new Error("Missing required service name for Square payment link.");
  }

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Square payment link amountCents must be a positive integer.");
  }

  if (!input.currency.trim()) {
    throw new Error("Missing required currency for Square payment link.");
  }
}

function buildPrePopulatedData(input: CreateAppointmentPaymentLinkInput) {
  const prePopulatedData: Record<string, string> = {};

  if (input.callerEmail?.trim()) {
    prePopulatedData.buyer_email = input.callerEmail.trim();
  }

  if (input.callerPhone?.trim()) {
    prePopulatedData.buyer_phone_number = input.callerPhone.trim();
  }

  return Object.keys(prePopulatedData).length > 0 ? prePopulatedData : undefined;
}

function buildPaymentLinkDescription(input: CreateAppointmentPaymentLinkInput) {
  return [
    buildDepositDescription(input),
    input.clinicName?.trim(),
    input.callerName?.trim() ? `Caller: ${input.callerName.trim()}` : undefined,
    input.selectedStartAt?.trim() ? `Selected start: ${input.selectedStartAt.trim()}` : undefined,
    `Appointment intent: ${input.appointmentIntentId.trim()}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

function buildPaymentNote(input: CreateAppointmentPaymentLinkInput) {
  return [buildDepositDescription(input), `appointment_intent_id:${input.appointmentIntentId.trim()}`]
    .filter(Boolean)
    .join(" | ");
}

function buildDepositDescription(input: CreateAppointmentPaymentLinkInput) {
  const serviceName = input.serviceName.trim();
  const depositPercentText = input.depositPercentText?.trim();

  if (!serviceName) {
    return undefined;
  }

  return depositPercentText ? `${depositPercentText} deposit for ${serviceName}` : `Deposit for ${serviceName}`;
}

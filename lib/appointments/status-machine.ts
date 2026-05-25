export type PaymentStatus = "not_required" | "pending" | "completed" | "failed" | "expired" | "refunded";

export type AppointmentStatus =
  | "details_collected"
  | "payment_link_created"
  | "payment_link_sent"
  | "payment_pending"
  | "payment_completed"
  | "square_booking_created"
  | "confirmed"
  | "failed"
  | "manual_review_needed"
  | "cancelled";

export type AppointmentTransitionResult = {
  allowed: true;
  from: AppointmentStatus;
  to: AppointmentStatus;
  reason?: string;
};

export type AppointmentStatusPatch = {
  appointment_status: AppointmentStatus;
  payment_status?: PaymentStatus;
  paid_at?: string;
  confirmed_at?: string;
  cancelled_at?: string;
  failed_at?: string;
};

type TransitionAppointmentStatusInput = {
  currentStatus: AppointmentStatus;
  nextStatus: AppointmentStatus;
  reason?: string;
};

const FINAL_APPOINTMENT_STATUSES = new Set<AppointmentStatus>(["confirmed", "cancelled", "failed"]);

const ALLOWED_APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  details_collected: ["payment_link_created", "failed", "cancelled"],
  payment_link_created: ["payment_link_sent", "failed", "cancelled"],
  payment_link_sent: ["payment_pending", "failed", "cancelled"],
  payment_pending: ["payment_completed", "failed", "cancelled"],
  payment_completed: ["square_booking_created", "manual_review_needed", "failed", "cancelled"],
  square_booking_created: ["confirmed", "cancelled"],
  manual_review_needed: ["confirmed", "cancelled"],
  confirmed: [],
  cancelled: [],
  failed: [],
};

const ALLOWED_PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  not_required: [],
  pending: ["completed", "failed", "expired", "refunded"],
  completed: ["refunded"],
  failed: [],
  expired: [],
  refunded: [],
};

export function assertAllowedAppointmentTransition(from: AppointmentStatus, to: AppointmentStatus): void {
  if (from === to) {
    return;
  }

  if (!ALLOWED_APPOINTMENT_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Invalid appointment status transition: ${from} -> ${to}`);
  }
}

export function transitionAppointmentStatus(
  input: TransitionAppointmentStatusInput,
): AppointmentTransitionResult {
  assertAllowedAppointmentTransition(input.currentStatus, input.nextStatus);

  return {
    allowed: true,
    from: input.currentStatus,
    to: input.nextStatus,
    reason: input.reason,
  };
}

export function assertAllowedPaymentStatusTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (from === to) {
    return;
  }

  if (!ALLOWED_PAYMENT_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Invalid payment status transition: ${from} -> ${to}`);
  }
}

export function isFinalAppointmentStatus(status: AppointmentStatus): boolean {
  return FINAL_APPOINTMENT_STATUSES.has(status);
}

export function markPaymentLinkCreated(): AppointmentStatusPatch {
  return {
    appointment_status: "payment_link_created",
    payment_status: "pending",
  };
}

export function markPaymentLinkSent(): AppointmentStatusPatch {
  return {
    appointment_status: "payment_link_sent",
    payment_status: "pending",
  };
}

export function markPaymentPending(): AppointmentStatusPatch {
  return {
    appointment_status: "payment_pending",
    payment_status: "pending",
  };
}

export function markPaymentCompleted(now = new Date()): AppointmentStatusPatch {
  return {
    appointment_status: "payment_completed",
    payment_status: "completed",
    paid_at: now.toISOString(),
  };
}

export function markSquareBookingCreated(): AppointmentStatusPatch {
  return {
    appointment_status: "square_booking_created",
    payment_status: "completed",
  };
}

export function markConfirmed(now = new Date()): AppointmentStatusPatch {
  return {
    appointment_status: "confirmed",
    confirmed_at: now.toISOString(),
  };
}

export function markManualReviewNeeded(): AppointmentStatusPatch {
  return {
    appointment_status: "manual_review_needed",
    payment_status: "completed",
  };
}

export function markFailed(now = new Date(), paymentStatus: PaymentStatus = "failed"): AppointmentStatusPatch {
  return {
    appointment_status: "failed",
    payment_status: paymentStatus,
    failed_at: now.toISOString(),
  };
}

export function markCancelled(now = new Date()): AppointmentStatusPatch {
  return {
    appointment_status: "cancelled",
    cancelled_at: now.toISOString(),
  };
}

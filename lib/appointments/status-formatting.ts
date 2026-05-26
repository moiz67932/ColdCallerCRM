import { cn } from "@/lib/utils";

export type DashboardAppointmentFilter = "all" | "pending" | "completed" | "confirmed" | "manual_review" | "failed";

const paymentStatusLabels: Record<string, string> = {
  not_required: "Not required",
  pending: "Pending",
  payment_link_created: "Link created",
  payment_link_sent: "Link sent",
  completed: "Completed",
  failed: "Failed",
  expired: "Expired",
  refunded: "Refunded",
};

const appointmentStatusLabels: Record<string, string> = {
  details_collected: "Details collected",
  payment_link_created: "Link created",
  payment_link_sent: "Link sent",
  payment_pending: "Payment pending",
  payment_completed: "Payment completed",
  square_booking_created: "Square booking",
  confirmed: "Confirmed",
  manual_review_needed: "Manual review",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function formatStatusLabel(status: string | null | undefined) {
  if (!status) return "-";
  return paymentStatusLabels[status] ?? appointmentStatusLabels[status] ?? status.replaceAll("_", " ");
}

export function getPaymentStatusClass(status: string | null | undefined) {
  return cn(
    "border-transparent",
    status === "completed" && "bg-emerald-100 text-emerald-800",
    status === "failed" && "bg-red-100 text-red-800",
    status === "refunded" && "bg-amber-100 text-amber-800",
    status === "payment_link_sent" && "bg-cyan-100 text-cyan-800",
    status === "payment_link_created" && "bg-sky-100 text-sky-800",
    (!status || status === "pending" || status === "not_required" || status === "expired") && "bg-slate-100 text-slate-700",
  );
}

export function getAppointmentStatusClass(status: string | null | undefined) {
  return cn(
    "border-transparent",
    status === "confirmed" && "bg-emerald-100 text-emerald-800",
    status === "square_booking_created" && "bg-teal-100 text-teal-800",
    status === "payment_completed" && "bg-lime-100 text-lime-800",
    status === "manual_review_needed" && "bg-amber-100 text-amber-800",
    status === "failed" && "bg-red-100 text-red-800",
    status === "payment_link_sent" && "bg-cyan-100 text-cyan-800",
    status === "payment_link_created" && "bg-sky-100 text-sky-800",
    (!status || status === "details_collected" || status === "payment_pending" || status === "cancelled") &&
      "bg-slate-100 text-slate-700",
  );
}

export function maskPhoneNumber(phone: string | null | undefined) {
  if (!phone) return "-";
  const digits = phone.replace(/\D/g, "");

  if (digits.length < 4) {
    return "****";
  }

  return `*** ${digits.slice(-4)}`;
}

export function formatClinicDateTime(input: {
  selectedStartAt?: string | null;
  selectedTimeDisplay?: string | null;
  timeZone?: string | null;
}) {
  const timeZone = getValidTimeZone(input.timeZone);
  const date = parseDate(input.selectedStartAt);

  if (!date) {
    const fallback = input.selectedTimeDisplay?.trim();
    return fallback && !looksLikeIsoDateTime(fallback) ? fallback : "the selected appointment time";
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}

export function formatDateTime(value: string | null | undefined, timeZone?: string | null) {
  const date = parseDate(value);
  if (!date) return "-";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone ? getValidTimeZone(timeZone) : undefined,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: timeZone ? "short" : undefined,
  }).format(date);
}

export function stringifyPayload(value: unknown) {
  if (value === null || value === undefined) return "{}";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseDate(value: string | null | undefined) {
  if (!value?.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getValidTimeZone(value: string | null | undefined) {
  const candidate = value?.trim() || "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

function looksLikeIsoDateTime(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

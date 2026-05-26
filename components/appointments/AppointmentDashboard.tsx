"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { AlertTriangle, Clipboard, ExternalLink, RefreshCw, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppointmentStatusBadge } from "@/components/appointments/AppointmentStatusBadge";
import { PaymentStatusBadge } from "@/components/appointments/PaymentStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  type DashboardAppointmentFilter,
  formatClinicDateTime,
  formatDateTime,
  maskPhoneNumber,
  stringifyPayload,
} from "@/lib/appointments/status-formatting";
import { cn } from "@/lib/utils";

type AppointmentRow = {
  id: string;
  caller_name: string | null;
  caller_phone: string | null;
  caller_phone_e164: string | null;
  service_name: string | null;
  selected_start_at: string | null;
  selected_timezone: string | null;
  selected_time_display: string | null;
  payment_status: string | null;
  appointment_status: string | null;
  created_at: string | null;
  last_error: string | null;
  square_order_id: string | null;
  square_payment_id: string | null;
  square_booking_id: string | null;
};

type AppointmentDetail = {
  appointment_intent: Record<string, unknown>;
  appointment_payments: Array<Record<string, unknown>>;
  message_events: Array<Record<string, unknown>>;
  workflow_events: Array<Record<string, unknown>>;
};

type ApiEnvelope<T> = {
  success?: boolean;
  message?: string;
  error?: string;
  data?: T;
};

const filters: Array<{ value: DashboardAppointmentFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending payment" },
  { value: "completed", label: "Payment completed" },
  { value: "confirmed", label: "Confirmed" },
  { value: "manual_review", label: "Manual review needed" },
  { value: "failed", label: "Failed/error" },
];

const pendingStatuses = new Set(["details_collected", "payment_link_created", "payment_link_sent", "payment_pending", "manual_review_needed"]);

export function AppointmentDashboard() {
  const [appointments, setAppointments] = useState<AppointmentRow[]>([]);
  const [filter, setFilter] = useState<DashboardAppointmentFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AppointmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const shouldPoll = useMemo(
    () =>
      appointments.some(
        (appointment) =>
          appointment.payment_status === "pending" || pendingStatuses.has(appointment.appointment_status ?? "") || Boolean(appointment.last_error),
      ),
    [appointments],
  );

  const loadAppointments = useCallback(async () => {
    setLoading(true);
    setMessage(null);

    try {
      const params = new URLSearchParams({ filter, limit: "100" });
      if (search.trim()) params.set("q", search.trim());

      const response = await fetch(`/api/appointments?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as ApiEnvelope<{ appointments?: AppointmentRow[] }>;

      if (!response.ok || payload.success === false) {
        throw new Error(payload.message ?? payload.error ?? "Failed to load appointments.");
      }

      setAppointments(payload.data?.appointments ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load appointments.");
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  const loadDetail = useCallback(async (appointmentId: string) => {
    setDetailLoading(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/appointments/${appointmentId}`, { cache: "no-store" });
      const payload = (await response.json()) as ApiEnvelope<AppointmentDetail>;

      if (!response.ok || payload.success === false || !payload.data) {
        throw new Error(payload.message ?? payload.error ?? "Failed to load appointment details.");
      }

      setDetail(payload.data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load appointment details.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAppointments();
  }, [loadAppointments]);

  useEffect(() => {
    if (!selectedId) return;
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  useEffect(() => {
    if (!shouldPoll) return;
    const interval = window.setInterval(() => void loadAppointments(), 20_000);
    return () => window.clearInterval(interval);
  }, [loadAppointments, shouldPoll]);

  async function refreshAll() {
    await loadAppointments();
    if (selectedId) {
      await loadDetail(selectedId);
    }
  }

  function openDetail(appointmentId: string) {
    setSelectedId(appointmentId);
    setDetail(null);
  }

  function closeDetail() {
    setSelectedId(null);
    setDetail(null);
  }

  async function copyValue(label: string, value: string | null) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setMessage(`${label} copied.`);
  }

  async function runAction(action: "resend" | "manual-confirm") {
    if (!selectedId) return;
    setActionLoading(action);
    setMessage(null);

    try {
      const response = await fetch(
        action === "resend"
          ? `/api/appointments/${selectedId}/resend-payment-link`
          : `/api/appointments/${selectedId}/manual-confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            action === "manual-confirm"
              ? { send_confirmation: false, note: "Manual confirmation from appointment dashboard." }
              : {},
          ),
        },
      );
      const payload = (await response.json()) as ApiEnvelope<Record<string, unknown>>;

      if (!response.ok || payload.success === false) {
        throw new Error(payload.message ?? payload.error ?? "Action failed.");
      }

      setMessage(payload.message ?? "Action completed.");
      await refreshAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="p-5 pb-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle>Appointment Payments</CardTitle>
              <CardDescription>AI receptionist payment links, Square payments, booking confirmations, and recovery state.</CardDescription>
            </div>
            <Button className="gap-2" loading={loading} onClick={() => void refreshAll()} variant="outline">
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 px-5 pb-5">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap gap-2">
              {filters.map((item) => (
                <button
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                    filter === item.value
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                  )}
                  key={item.value}
                  onClick={() => setFilter(item.value)}
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </div>
            <Input
              className="h-9 xl:max-w-md"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, phone, service, Square IDs"
              value={search}
            />
          </div>

          {message ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{message}</div>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-9 px-3">Caller</TableHead>
                <TableHead className="h-9 px-3">Service</TableHead>
                <TableHead className="h-9 px-3">Appointment</TableHead>
                <TableHead className="h-9 px-3">Payment</TableHead>
                <TableHead className="h-9 px-3">Status</TableHead>
                <TableHead className="h-9 px-3">Created</TableHead>
                <TableHead className="h-9 px-3">Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {appointments.length === 0 ? (
                <TableRow>
                  <TableCell className="px-3 py-8 text-center text-sm text-slate-500" colSpan={7}>
                    {loading ? "Loading appointment workflows..." : "No appointment workflows match this view."}
                  </TableCell>
                </TableRow>
              ) : (
                appointments.map((appointment) => (
                  <TableRow
                    className="cursor-pointer"
                    key={appointment.id}
                    onClick={() => openDetail(appointment.id)}
                    tabIndex={0}
                  >
                    <TableCell className="px-3 py-2">
                      <p className="font-medium">{appointment.caller_name ?? "Unknown caller"}</p>
                      <p className="text-xs text-slate-500">{maskPhoneNumber(appointment.caller_phone_e164 ?? appointment.caller_phone)}</p>
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate px-3 py-2">{appointment.service_name ?? "-"}</TableCell>
                    <TableCell className="px-3 py-2 text-xs text-slate-700">
                      {formatClinicDateTime({
                        selectedStartAt: appointment.selected_start_at,
                        selectedTimeDisplay: appointment.selected_time_display,
                        timeZone: appointment.selected_timezone,
                      })}
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      <PaymentStatusBadge status={appointment.payment_status} />
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      <AppointmentStatusBadge status={appointment.appointment_status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                      {formatDateTime(appointment.created_at)}
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      {appointment.last_error ? (
                        <Badge className="border-transparent bg-red-100 text-red-800">Error</Badge>
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selectedId ? (
        <AppointmentDetailDrawer
          actionLoading={actionLoading}
          copyValue={copyValue}
          detail={detail}
          detailLoading={detailLoading}
          onClose={closeDetail}
          onManualConfirm={() => void runAction("manual-confirm")}
          onRefresh={() => void refreshAll()}
          onResend={() => void runAction("resend")}
        />
      ) : null}
    </div>
  );
}

function AppointmentDetailDrawer({
  actionLoading,
  copyValue,
  detail,
  detailLoading,
  onClose,
  onManualConfirm,
  onRefresh,
  onResend,
}: {
  actionLoading: string | null;
  copyValue: (label: string, value: string | null) => Promise<void>;
  detail: AppointmentDetail | null;
  detailLoading: boolean;
  onClose: () => void;
  onManualConfirm: () => void;
  onRefresh: () => void;
  onResend: () => void;
}) {
  const intent = detail?.appointment_intent ?? null;
  const timeZone = getString(intent, "selected_timezone");
  const checkoutUrl = getString(intent, "square_payment_link_url") ?? firstString(detail?.appointment_payments, "square_checkout_url");
  const receiptUrl = firstString(detail?.appointment_payments, "square_receipt_url");
  const squareOrderId = getString(intent, "square_order_id");
  const squarePaymentId = getString(intent, "square_payment_id") ?? firstString(detail?.appointment_payments, "square_payment_id");
  const squareBookingId = getString(intent, "square_booking_id");
  const paymentCompleted = getString(intent, "payment_status") === "completed";
  const alreadyConfirmed = getString(intent, "appointment_status") === "confirmed";
  const canManualConfirm = paymentCompleted && Boolean(squareBookingId) && !alreadyConfirmed;
  const manualConfirmTitle = canManualConfirm
    ? "Manually mark this paid and booked appointment confirmed."
    : "Manual confirm requires completed payment, an existing Square booking ID, and an unconfirmed appointment.";

  return (
    <div className="fixed inset-0 z-50">
      <button aria-label="Close appointment details" className="absolute inset-0 bg-slate-900/30" onClick={onClose} type="button" />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-3xl flex-col border-l border-slate-200 bg-white shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-cyan-700">Appointment workflow</p>
            <h2 className="mt-1 text-lg font-semibold">{getString(intent, "caller_name") ?? "Loading appointment"}</h2>
            <p className="text-sm text-slate-500">{getString(intent, "service_name") ?? "-"}</p>
          </div>
          <div className="flex gap-2">
            <Button aria-label="Refresh appointment details" onClick={onRefresh} size="icon" variant="outline">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button aria-label="Close appointment details" onClick={onClose} size="icon" variant="ghost">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {detailLoading || !intent ? (
            <p className="text-sm text-slate-500">Loading details...</p>
          ) : (
            <>
              {getString(intent, "last_error") ? (
                <div className="flex gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">Last error</p>
                    <p>{getString(intent, "last_error")}</p>
                  </div>
                </div>
              ) : null}

              <section className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <LinkButton disabled={!checkoutUrl} href={checkoutUrl} label="Open Square Checkout URL" />
                  <LinkButton disabled={!receiptUrl} href={receiptUrl} label="Open Square receipt URL" />
                  <Button
                    className="gap-2"
                    disabled={alreadyConfirmed}
                    loading={actionLoading === "resend"}
                    onClick={onResend}
                    title={alreadyConfirmed ? "Confirmed appointments do not need another payment link." : undefined}
                    variant="outline"
                  >
                    <RotateCw className="h-4 w-4" />
                    Resend payment link
                  </Button>
                  <Button disabled={!canManualConfirm} loading={actionLoading === "manual-confirm"} onClick={onManualConfirm} title={manualConfirmTitle}>
                    Manual confirm
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <CopyIdButton label="Square Order ID" onCopy={copyValue} value={squareOrderId} />
                  <CopyIdButton label="Square Payment ID" onCopy={copyValue} value={squarePaymentId} />
                  <CopyIdButton label="Square Booking ID" onCopy={copyValue} value={squareBookingId} />
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-2">
                <DetailField label="Caller name" value={getString(intent, "caller_name")} />
                <DetailField label="Caller phone" value={getString(intent, "caller_phone_e164") ?? getString(intent, "caller_phone")} />
                <DetailField label="Service" value={getString(intent, "service_name")} />
                <DetailField
                  label="Selected appointment time"
                  value={formatClinicDateTime({
                    selectedStartAt: getString(intent, "selected_start_at"),
                    selectedTimeDisplay: getString(intent, "selected_time_display"),
                    timeZone,
                  })}
                />
                <StatusField label="Payment status" status={getString(intent, "payment_status")} type="payment" />
                <StatusField label="Appointment status" status={getString(intent, "appointment_status")} type="appointment" />
                <DetailField label="Square payment link ID" value={getString(intent, "square_payment_link_id")} />
                <DetailField label="Square order ID" value={squareOrderId} />
                <DetailField label="Square payment ID" value={squarePaymentId} />
                <DetailField label="Square booking ID" value={squareBookingId} />
                <DetailField label="Square checkout URL" value={checkoutUrl} />
                <DetailField label="Square receipt URL" value={receiptUrl} />
                <DetailField label="Paid at" value={formatDateTime(getString(intent, "paid_at"), timeZone)} />
                <DetailField label="Confirmed at" value={formatDateTime(getString(intent, "confirmed_at"), timeZone)} />
              </section>

              <Timeline events={detail.workflow_events} timeZone={timeZone} />
              <MessageEventsPanel events={detail.message_events} timeZone={timeZone} />
              <PaymentRows payments={detail.appointment_payments} timeZone={timeZone} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function LinkButton({ disabled, href, label }: { disabled: boolean; href: string | null; label: string }) {
  return (
    <Button
      className="gap-2"
      disabled={disabled}
      onClick={() => {
        if (href) window.open(href, "_blank", "noopener,noreferrer");
      }}
      variant="outline"
    >
      <ExternalLink className="h-4 w-4" />
      {label}
    </Button>
  );
}

function CopyIdButton({
  label,
  onCopy,
  value,
}: {
  label: string;
  onCopy: (label: string, value: string | null) => Promise<void>;
  value: string | null;
}) {
  return (
    <Button className="gap-2" disabled={!value} onClick={() => void onCopy(label, value)} variant="secondary">
      <Clipboard className="h-4 w-4" />
      Copy {label}
    </Button>
  );
}

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0 rounded-md border border-slate-200 px-3 py-2">
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-1 break-words text-sm text-slate-900">{value || "-"}</p>
    </div>
  );
}

function StatusField({ label, status, type }: { label: string; status: string | null; type: "payment" | "appointment" }) {
  return (
    <div className="rounded-md border border-slate-200 px-3 py-2">
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <div className="mt-1">{type === "payment" ? <PaymentStatusBadge status={status} /> : <AppointmentStatusBadge status={status} />}</div>
    </div>
  );
}

function Timeline({ events, timeZone }: { events: Array<Record<string, unknown>>; timeZone: string | null }) {
  const sortedEvents = [...events].sort((a, b) => dateValue(getString(a, "created_at")) - dateValue(getString(b, "created_at")));
  const failedEvents = sortedEvents.filter((event) => getString(event, "event_status") === "failed" || getString(event, "event_type") === "failed");

  return (
    <section className="space-y-2">
      <SectionHeading title="Timeline" subtitle={`${sortedEvents.length} workflow event${sortedEvents.length === 1 ? "" : "s"}`} />
      {failedEvents.length > 0 ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {failedEvents.length} failed workflow event{failedEvents.length === 1 ? "" : "s"} found.
        </div>
      ) : null}
      <div className="space-y-2">
        {sortedEvents.length === 0 ? (
          <p className="text-sm text-slate-500">No workflow events logged.</p>
        ) : (
          sortedEvents.map((event) => (
            <div
              className={cn(
                "rounded-md border border-slate-200 px-3 py-2",
                (getString(event, "event_status") === "failed" || getString(event, "event_type") === "failed") && "border-red-200 bg-red-50",
              )}
              key={getString(event, "id") ?? `${getString(event, "event_type")}-${getString(event, "created_at")}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{getString(event, "event_type") ?? "-"}</p>
                  <Badge variant="outline">{getString(event, "event_status") ?? "-"}</Badge>
                </div>
                <p className="text-xs text-slate-500">{formatDateTime(getString(event, "created_at"), timeZone)}</p>
              </div>
              {getString(event, "message") || getString(event, "error_message") ? (
                <p className="mt-1 text-sm text-slate-700">{getString(event, "error_message") ?? getString(event, "message")}</p>
              ) : null}
              <CollapsedPayload value={event.payload} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function MessageEventsPanel({ events, timeZone }: { events: Array<Record<string, unknown>>; timeZone: string | null }) {
  const sortedEvents = [...events].sort((a, b) => dateValue(getString(b, "created_at")) - dateValue(getString(a, "created_at")));
  const failedEvents = sortedEvents.filter((event) => getString(event, "status") === "failed");

  return (
    <section className="space-y-2">
      <SectionHeading title="Message events" subtitle={`${sortedEvents.length} message event${sortedEvents.length === 1 ? "" : "s"}`} />
      {failedEvents.length > 0 ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {failedEvents.length} failed message event{failedEvents.length === 1 ? "" : "s"} found.
        </div>
      ) : null}
      <div className="space-y-2">
        {sortedEvents.length === 0 ? (
          <p className="text-sm text-slate-500">No message events logged.</p>
        ) : (
          sortedEvents.map((event) => (
            <div className={cn("rounded-md border border-slate-200 px-3 py-2", getString(event, "status") === "failed" && "border-red-200 bg-red-50")} key={getString(event, "id") ?? `${getString(event, "message_type")}-${getString(event, "created_at")}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{getString(event, "message_type") ?? "message"}</p>
                  <Badge variant="outline">{getString(event, "channel") ?? "-"}</Badge>
                  <Badge variant="secondary">{getString(event, "status") ?? "-"}</Badge>
                </div>
                <p className="text-xs text-slate-500">{formatDateTime(getString(event, "created_at"), timeZone)}</p>
              </div>
              <div className="mt-2 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
                <p>Provider message ID: {getString(event, "provider_message_id") ?? "-"}</p>
                <p>Provider status: {getString(event, "provider_status") ?? "-"}</p>
                <p>Sent at: {formatDateTime(getString(event, "sent_at"), timeZone)}</p>
                <p>Failed at: {formatDateTime(getString(event, "failed_at"), timeZone)}</p>
              </div>
              {getString(event, "error_message") ? <p className="mt-2 text-sm text-red-800">{getString(event, "error_message")}</p> : null}
              <CollapsedPayload value={event.payload} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function PaymentRows({ payments, timeZone }: { payments: Array<Record<string, unknown>>; timeZone: string | null }) {
  return (
    <section className="space-y-2">
      <SectionHeading title="Payment rows" subtitle={`${payments.length} appointment payment row${payments.length === 1 ? "" : "s"}`} />
      {payments.length === 0 ? (
        <p className="text-sm text-slate-500">No appointment payment rows logged.</p>
      ) : (
        <div className="space-y-2">
          {payments.map((payment) => (
            <div className="rounded-md border border-slate-200 px-3 py-2" key={getString(payment, "id") ?? getString(payment, "square_payment_id") ?? getString(payment, "created_at")}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <PaymentStatusBadge status={getString(payment, "status")} />
                  <p className="text-sm text-slate-700">{formatMoney(payment.amount_cents, getString(payment, "currency"))}</p>
                </div>
                <p className="text-xs text-slate-500">{formatDateTime(getString(payment, "created_at"), timeZone)}</p>
              </div>
              <div className="mt-2 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
                <p>Order ID: {getString(payment, "square_order_id") ?? "-"}</p>
                <p>Payment ID: {getString(payment, "square_payment_id") ?? "-"}</p>
                <p>Receipt: {getString(payment, "square_receipt_url") ?? "-"}</p>
                <p>Paid at: {formatDateTime(getString(payment, "paid_at"), timeZone)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-end justify-between gap-3 border-b border-slate-200 pb-1">
      <h3 className="font-semibold">{title}</h3>
      <p className="text-xs text-slate-500">{subtitle}</p>
    </div>
  );
}

function CollapsedPayload({ value }: { value: unknown }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-slate-500">Payload/debug info</summary>
      <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-slate-950 p-2 text-xs text-slate-100">{stringifyPayload(value)}</pre>
    </details>
  );
}

function getString(row: Record<string, unknown> | null | undefined, key: string) {
  const value = row?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(rows: Array<Record<string, unknown>> | undefined, key: string) {
  return rows?.map((row) => getString(row, key)).find(Boolean) ?? null;
}

function dateValue(value: string | null) {
  return value ? new Date(value).getTime() || 0 : 0;
}

function formatMoney(amount: unknown, currency: string | null) {
  const cents = Number(amount);
  if (!Number.isFinite(cents)) return "-";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency ?? "USD",
  }).format(cents / 100);
}

import Link from "next/link";

import { createDebugId, logWorkflowError, logWorkflowInfo } from "@/lib/logging/workflow-logger";
import { verifyPayToken } from "@/lib/payments/pay-token";
import { normalizePayTokenRouteParam } from "@/lib/payments/pay-token-route";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { PayTokenRouteParamSchema } from "@/lib/validation/paid-appointment";

type PayPageProps = {
  params: Promise<{ token: string }>;
};

type AppointmentIntent = Record<string, unknown>;

export default async function PayDepositPage({ params }: PayPageProps) {
  const debugId = createDebugId("pay_page");
  const routeParams = await params;
  const normalizedParams = normalizePayTokenRouteParam(routeParams.token);

  if (normalizedParams.placeholderPrefixStripped) {
    logWorkflowInfo("pay.deposit.placeholder_prefix_stripped", {
      debug_id: debugId,
      operation: "pay_deposit_page",
      step: "normalize_token_param",
      prefix_variant: normalizedParams.prefixVariant,
    });
  }

  const parsedParams = PayTokenRouteParamSchema.safeParse({ token: normalizedParams.token });

  if (!parsedParams.success) {
    logWorkflowError("pay.deposit.invalid_token_param", {
      debug_id: debugId,
      operation: "pay_deposit_page",
      step: "validate_token_param",
      error_code: "VALIDATION_FAILED",
      safe_message: "Pay token route parameter failed validation.",
    });
    return (
      <PayMessage
        title="This payment link is invalid"
        message="Please contact the clinic or ask the receptionist to send a new secure deposit link."
      />
    );
  }
  const { token } = parsedParams.data;
  const payload = verifyPayToken(token);

  if (!payload) {
    logWorkflowError("pay.deposit.invalid_token", {
      debug_id: debugId,
      operation: "pay_deposit_page",
      step: "verify_pay_token",
      error_code: "INVALID_OR_EXPIRED_PAY_TOKEN",
      safe_message: "Invalid or expired pay token.",
    });
    return (
      <PayMessage
        title="This payment link has expired"
        message="Please contact the clinic or ask the receptionist to send a new secure deposit link."
      />
    );
  }

  const appointmentIntent = await loadAppointmentIntent(payload.appointment_intent_id);

  if (!appointmentIntent) {
    logWorkflowError("pay.deposit.intent_not_found", {
      debug_id: debugId,
      operation: "pay_deposit_page",
      step: "load_appointment_intent",
      appointment_intent_id: payload.appointment_intent_id,
      error_code: "APPOINTMENT_INTENT_NOT_FOUND",
    });
    return (
      <PayMessage
        title="Payment details not found"
        message="We could not find this appointment deposit request. Please ask the clinic to resend the link."
      />
    );
  }

  if (getString(appointmentIntent, "payment_status") === "completed") {
    logWorkflowInfo("pay.deposit.already_completed", {
      debug_id: debugId,
      operation: "pay_deposit_page",
      step: "render_already_completed",
      appointment_intent_id: payload.appointment_intent_id,
      status: 200,
    });
    return (
      <PayMessage
        title="Payment already completed"
        message="Your deposit has already been received. The clinic will confirm your appointment details."
      />
    );
  }

  const checkoutUrl = getString(appointmentIntent, "square_payment_link_url");

  if (!checkoutUrl) {
    logWorkflowError("pay.deposit.checkout_not_ready", {
      debug_id: debugId,
      operation: "pay_deposit_page",
      step: "load_checkout_url",
      appointment_intent_id: payload.appointment_intent_id,
      error_code: "CHECKOUT_URL_MISSING",
    });
    return (
      <PayMessage
        title="Checkout is not ready"
        message="The secure checkout link is not available yet. Please ask the clinic to resend your deposit link."
      />
    );
  }

  logWorkflowInfo("pay.deposit.render_checkout", {
    debug_id: debugId,
    operation: "pay_deposit_page",
    step: "render_checkout",
    appointment_intent_id: payload.appointment_intent_id,
    square_order_id: getString(appointmentIntent, "square_order_id"),
    status: 200,
  });

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#dbeafe,transparent_34%),linear-gradient(135deg,#f8fafc,#ecfeff)] px-5 py-8 text-slate-950">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-xl items-center">
        <div className="w-full overflow-hidden rounded-[2rem] border border-white/70 bg-white/90 shadow-2xl shadow-slate-200/80 backdrop-blur">
          <div className="bg-slate-950 px-6 py-7 text-white">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-cyan-200">Portive secure deposit</p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">Review your appointment deposit</h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              You will continue to Square for secure payment. Portive never handles your card details.
            </p>
          </div>

          <div className="space-y-5 px-6 py-7">
            <Detail label="Clinic" value={getString(appointmentIntent, "clinic_name") ?? "Portive clinic"} />
            <Detail label="Service" value={getString(appointmentIntent, "service_name") ?? "Appointment"} />
            <Detail
              label="Appointment time"
              value={getString(appointmentIntent, "selected_time_display") ?? formatDate(getString(appointmentIntent, "selected_start_at"))}
            />
            <Detail
              label="Deposit"
              value={formatMoney(getNumber(appointmentIntent, "deposit_amount_cents"), getString(appointmentIntent, "currency") ?? "USD")}
            />

            <a
              className="mt-7 flex w-full items-center justify-center rounded-2xl bg-cyan-500 px-5 py-4 text-base font-bold text-slate-950 shadow-lg shadow-cyan-200 transition hover:bg-cyan-400"
              href={checkoutUrl}
              rel="noreferrer"
            >
              Continue to secure checkout
            </a>

            <p className="text-center text-xs leading-5 text-slate-500">Powered by Portive. Secure checkout is processed by Square.</p>
          </div>
        </div>
      </section>
    </main>
  );
}

async function loadAppointmentIntent(id: string) {
  const { data, error } = await getSupabaseAdmin().from("appointment_intents").select("*").eq("id", id).maybeSingle();

  if (error) {
    return null;
  }

  return data as AppointmentIntent | null;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-950">{value}</p>
    </div>
  );
}

function PayMessage({ title, message }: { title: string; message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-5 py-8 text-white">
      <section className="max-w-md rounded-[2rem] border border-white/10 bg-white/10 p-7 text-center shadow-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-cyan-200">Portive payments</p>
        <h1 className="mt-4 text-3xl font-semibold">{title}</h1>
        <p className="mt-4 text-sm leading-6 text-slate-300">{message}</p>
        <Link className="mt-7 inline-flex rounded-full bg-white px-5 py-3 text-sm font-bold text-slate-950" href="/">
          Return to Portive
        </Link>
      </section>
    </main>
  );
}

function getString(row: AppointmentIntent, key: string) {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(row: AppointmentIntent, key: string) {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}

function formatMoney(amountCents: number | null, currency: string) {
  if (amountCents === null) {
    return "Deposit pending";
  }

  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountCents / 100);
}

function formatDate(value: string | null) {
  if (!value) {
    return "Time selected";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

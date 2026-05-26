import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { okJson } from "@/lib/api/paid-appointment-response";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

type SupabaseRow = Record<string, unknown>;

const LIST_COLUMNS = [
  "id",
  "caller_name",
  "caller_phone",
  "caller_phone_e164",
  "service_name",
  "selected_start_at",
  "selected_timezone",
  "selected_time_display",
  "payment_status",
  "appointment_status",
  "created_at",
  "last_error",
  "square_order_id",
  "square_payment_id",
  "square_booking_id",
].join(",");

const SEARCH_COLUMNS = [
  "caller_name",
  "caller_phone",
  "caller_phone_e164",
  "service_name",
  "square_order_id",
  "square_payment_id",
  "square_booking_id",
];

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  const { searchParams } = new URL(request.url);
  const filter = searchParams.get("filter") ?? "all";
  const search = searchParams.get("q")?.trim().toLowerCase() ?? "";
  const limit = clampLimit(searchParams.get("limit"));

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("appointment_intents")
      .select(LIST_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(search ? Math.max(limit, 300) : limit);

    if (error) {
      throw new Error(error.message);
    }

    const rows = ((data ?? []) as SupabaseRow[]).filter((row) => matchesFilter(row, filter)).filter((row) => matchesSearch(row, search));

    return okJson(
      {
        appointments: rows.slice(0, limit),
        filter,
        q: search,
        limit,
      },
      { step: "appointments_loaded", message: "Appointments loaded." },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unable to load appointments.",
      },
      { status: 500 },
    );
  }
}

function clampLimit(value: string | null) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 100;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 500);
}

function matchesFilter(row: SupabaseRow, filter: string) {
  const paymentStatus = getString(row, "payment_status");
  const appointmentStatus = getString(row, "appointment_status");
  const hasError = Boolean(getString(row, "last_error"));

  if (filter === "pending") {
    return paymentStatus === "pending" || ["details_collected", "payment_link_created", "payment_link_sent", "payment_pending"].includes(appointmentStatus ?? "");
  }

  if (filter === "completed") {
    return paymentStatus === "completed";
  }

  if (filter === "confirmed") {
    return appointmentStatus === "confirmed";
  }

  if (filter === "manual_review") {
    return appointmentStatus === "manual_review_needed";
  }

  if (filter === "failed") {
    return hasError || paymentStatus === "failed" || appointmentStatus === "failed";
  }

  return true;
}

function matchesSearch(row: SupabaseRow, search: string) {
  if (!search) {
    return true;
  }

  return SEARCH_COLUMNS.some((column) => getString(row, column)?.toLowerCase().includes(search));
}

function getString(row: SupabaseRow, key: string) {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { listSquareBookings } from "@/lib/square/bookings";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  const searchParams = request.nextUrl.searchParams;
  const locationId = requiredParam(searchParams, "location_id");
  const startAtMin = requiredParam(searchParams, "start_at_min");
  const startAtMax = requiredParam(searchParams, "start_at_max");
  const teamMemberId = searchParams.get("team_member_id");
  const serviceVariationId = searchParams.get("service_variation_id")?.trim() || null;

  if (!locationId || !startAtMin || !startAtMax) {
    return NextResponse.json(
      { error: "location_id, start_at_min, and start_at_max are required." },
      { status: 400 },
    );
  }

  const bookings = await listSquareBookings({
    locationId,
    teamMemberId,
    startAtMin,
    startAtMax,
  });
  const filteredBookings = serviceVariationId
    ? bookings.filter((booking) => bookingHasServiceVariation(booking, serviceVariationId))
    : bookings;

  return NextResponse.json({
    count: filteredBookings.length,
    bookings: filteredBookings,
  });
}

function requiredParam(searchParams: URLSearchParams, key: string) {
  return searchParams.get(key)?.trim() || null;
}

function bookingHasServiceVariation(booking: unknown, serviceVariationId: string) {
  if (!isRecord(booking)) return false;
  const segments = booking.appointment_segments;

  return Array.isArray(segments) && segments.some((segment) => (
    isRecord(segment) && segment.service_variation_id === serviceVariationId
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

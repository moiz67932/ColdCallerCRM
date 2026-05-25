import "server-only";

import { buildSquareBookingIdempotencyKey } from "@/lib/appointments/idempotency";
import { squareRequest } from "@/lib/square/client";

export type SearchSquareAvailabilityInput = {
  locationId: string;
  teamMemberId: string;
  serviceVariationId: string;
  startAt: string;
  endAt: string;
};

export type SquareAvailabilitySlot = {
  startAt: string;
  locationId: string;
  durationMinutes: number;
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: number;
  raw: unknown;
};

export type FindExactAvailableSlotInput = {
  desiredStartAt: string;
  availability: SquareAvailabilitySlot[];
};

export type CreateSquareBookingInput = {
  appointmentIntentId: string;
  locationId: string;
  customerId: string;
  startAt: string;
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: number;
  durationMinutes: number;
  customerNote?: string;
  idempotencyKey?: string;
};

export type CreateSquareBookingResult = {
  bookingId: string;
  status: string | null;
  startAt: string;
  raw: unknown;
};

type SquareAppointmentSegment = {
  duration_minutes?: number;
  service_variation_id?: string;
  service_variation_version?: number;
  team_member_id?: string;
};

type SquareAvailability = {
  start_at?: string;
  location_id?: string;
  appointment_segments?: SquareAppointmentSegment[];
};

type SearchAvailabilityResponse = {
  availabilities?: SquareAvailability[];
};

type SquareBooking = {
  id?: string;
  status?: string;
  start_at?: string;
};

type CreateBookingResponse = {
  booking?: SquareBooking;
};

type RetrieveBookingResponse = {
  booking?: unknown;
};

export async function searchSquareAvailability(
  input: SearchSquareAvailabilityInput,
): Promise<SquareAvailabilitySlot[]> {
  validateSearchAvailabilityInput(input);

  const response = await squareRequest<SearchAvailabilityResponse>({
    method: "POST",
    path: "/v2/bookings/availability/search",
    operationName: "square.search_availability",
    body: {
      query: {
        filter: {
          start_at_range: {
            start_at: input.startAt,
            end_at: input.endAt,
          },
          location_id: input.locationId,
          segment_filters: [
            {
              service_variation_id: input.serviceVariationId,
              team_member_id_filter: {
                any: [input.teamMemberId],
              },
            },
          ],
        },
      },
    },
  });

  return (response.availabilities ?? []).flatMap(normalizeAvailability);
}

export function findExactAvailableSlot(input: FindExactAvailableSlotInput): SquareAvailabilitySlot | null {
  const desiredStartAt = input.desiredStartAt.trim();

  if (!desiredStartAt) {
    throw new Error("Missing desired start time for Square availability match.");
  }

  return input.availability.find((slot) => slot.startAt === desiredStartAt) ?? null;
}

export async function createSquareBooking(input: CreateSquareBookingInput): Promise<CreateSquareBookingResult> {
  validateCreateBookingInput(input);

  const response = await squareRequest<CreateBookingResponse>({
    method: "POST",
    path: "/v2/bookings",
    idempotencyKey: input.idempotencyKey?.trim() || buildSquareBookingIdempotencyKey(input.appointmentIntentId),
    appointmentIntentId: input.appointmentIntentId,
    operationName: "square.create_booking",
    body: {
      booking: {
        customer_id: input.customerId,
        customer_note: input.customerNote?.trim() || undefined,
        start_at: input.startAt,
        location_id: input.locationId,
        appointment_segments: [
          {
            duration_minutes: input.durationMinutes,
            team_member_id: input.teamMemberId,
            service_variation_id: input.serviceVariationId,
            service_variation_version: input.serviceVariationVersion,
          },
        ],
      },
    },
  });

  const booking = response.booking;

  if (!booking?.id || !booking.start_at) {
    throw new Error("Square CreateBooking response did not include a booking id and start time.");
  }

  return {
    bookingId: booking.id,
    status: booking.status ?? null,
    startAt: booking.start_at,
    raw: response,
  };
}

export function retrieveSquareBooking(bookingId: string) {
  const trimmedBookingId = bookingId.trim();

  if (!trimmedBookingId) {
    throw new Error("Missing required Square booking ID.");
  }

  return squareRequest<RetrieveBookingResponse>({
    method: "GET",
    path: `/v2/bookings/${encodeURIComponent(trimmedBookingId)}`,
    operationName: "square.retrieve_booking",
  });
}

function normalizeAvailability(availability: SquareAvailability): SquareAvailabilitySlot[] {
  const startAt = availability.start_at;
  const locationId = availability.location_id;

  if (!startAt || !locationId) {
    return [];
  }

  return (availability.appointment_segments ?? []).flatMap((segment) => {
    if (
      !segment.duration_minutes ||
      !segment.team_member_id ||
      !segment.service_variation_id ||
      !segment.service_variation_version
    ) {
      return [];
    }

    return [
      {
        startAt,
        locationId,
        durationMinutes: segment.duration_minutes,
        teamMemberId: segment.team_member_id,
        serviceVariationId: segment.service_variation_id,
        serviceVariationVersion: segment.service_variation_version,
        raw: availability,
      },
    ];
  });
}

function validateSearchAvailabilityInput(input: SearchSquareAvailabilityInput) {
  if (!input.locationId.trim()) {
    throw new Error("Missing required Square location ID for availability search.");
  }

  if (!input.teamMemberId.trim()) {
    throw new Error("Missing required Square team member ID for availability search.");
  }

  if (!input.serviceVariationId.trim()) {
    throw new Error("Missing required Square service variation ID for availability search.");
  }

  if (!input.startAt.trim()) {
    throw new Error("Missing required start time for Square availability search.");
  }

  if (!input.endAt.trim()) {
    throw new Error("Missing required end time for Square availability search.");
  }
}

function validateCreateBookingInput(input: CreateSquareBookingInput) {
  if (!input.appointmentIntentId.trim()) {
    throw new Error("Missing appointment intent ID for Square booking.");
  }

  if (!input.locationId.trim()) {
    throw new Error("Missing required Square location ID for booking.");
  }

  if (!input.customerId.trim()) {
    throw new Error("Missing required Square customer ID for booking.");
  }

  if (!input.startAt.trim()) {
    throw new Error("Missing required start time for Square booking.");
  }

  if (!input.teamMemberId.trim()) {
    throw new Error("Missing required Square team member ID for booking.");
  }

  if (!input.serviceVariationId.trim()) {
    throw new Error("Missing required Square service variation ID for booking.");
  }

  if (!Number.isInteger(input.serviceVariationVersion) || input.serviceVariationVersion <= 0) {
    throw new Error("Square serviceVariationVersion must be a positive integer.");
  }

  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0) {
    throw new Error("Square durationMinutes must be a positive integer.");
  }
}

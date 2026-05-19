export type BookingProviderRequest = {
  appointmentRequestId: string;
};

export type BookingProviderResult = {
  status: "pending" | "confirmed" | "failed";
  providerBookingId?: string | null;
};

export interface BookingProviderAdapter {
  createBooking(request: BookingProviderRequest): Promise<BookingProviderResult>;
}

export class ManualProvider implements BookingProviderAdapter {
  async createBooking(): Promise<BookingProviderResult> {
    return { status: "pending", providerBookingId: null };
  }
}

// TODO: Implement Cal.com confirmation outside the voice-critical path.
export class CalComProvider implements BookingProviderAdapter {
  async createBooking(): Promise<BookingProviderResult> {
    throw new Error("CalComProvider is not implemented yet.");
  }
}

// TODO: Implement Google Calendar confirmation outside the voice-critical path.
export class GoogleCalendarProvider implements BookingProviderAdapter {
  async createBooking(): Promise<BookingProviderResult> {
    throw new Error("GoogleCalendarProvider is not implemented yet.");
  }
}

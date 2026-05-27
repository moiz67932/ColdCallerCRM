import "server-only";

import { squareRequest } from "@/lib/square/client";

export type NormalizedCustomerName = {
  givenName?: string;
  familyName?: string;
};

export type CreateSquareCustomerInput = {
  fullName?: string;
  phoneE164: string;
  email?: string;
  appointmentIntentId?: string;
  timeoutMs?: number;
};

export type SquareCustomer = {
  customerId: string;
  givenName?: string;
  familyName?: string;
  phoneNumber?: string;
  emailAddress?: string;
  raw: unknown;
};

type SquareCustomerRecord = {
  id?: string;
  given_name?: string;
  family_name?: string;
  phone_number?: string;
  email_address?: string;
};

type SearchCustomersResponse = {
  customers?: SquareCustomerRecord[];
};

type CreateCustomerResponse = {
  customer?: SquareCustomerRecord;
};

export function normalizeCustomerName(fullName: string | null | undefined): NormalizedCustomerName {
  const parts = fullName?.trim().split(/\s+/).filter(Boolean) ?? [];

  if (parts.length === 0) {
    return {};
  }

  if (parts.length === 1) {
    return { givenName: parts[0] };
  }

  return {
    givenName: parts[0],
    familyName: parts.slice(1).join(" "),
  };
}

export async function searchSquareCustomerByPhone(phoneE164: string, timeoutMs?: number): Promise<SquareCustomer | null> {
  const phoneNumber = normalizePhoneInput(phoneE164);

  if (!phoneNumber) {
    throw new Error("Missing required phone number for Square customer search.");
  }

  const response = await squareRequest<SearchCustomersResponse>({
    method: "POST",
    path: "/v2/customers/search",
    operationName: "square.search_customer_by_phone",
    timeoutMs,
    body: {
      query: {
        filter: {
          phone_number: {
            exact: phoneNumber,
          },
        },
      },
      limit: 10,
    },
  });

  const normalizedInput = normalizePhoneForComparison(phoneNumber);
  const exactMatch = (response.customers ?? []).find(
    (customer) => normalizePhoneForComparison(customer.phone_number) === normalizedInput,
  );
  const customer = exactMatch ?? response.customers?.[0];

  return customer ? normalizeSquareCustomer(customer) : null;
}

export async function createSquareCustomer(input: CreateSquareCustomerInput): Promise<SquareCustomer> {
  const phoneNumber = normalizePhoneInput(input.phoneE164);

  if (!phoneNumber) {
    throw new Error("Missing required phone number for Square customer creation.");
  }

  const { givenName, familyName } = normalizeCustomerName(input.fullName);
  const appointmentIntentId = input.appointmentIntentId?.trim();
  const response = await squareRequest<CreateCustomerResponse>({
    method: "POST",
    path: "/v2/customers",
    appointmentIntentId,
    operationName: "square.create_customer",
    timeoutMs: input.timeoutMs,
    body: {
      given_name: givenName,
      family_name: familyName,
      phone_number: phoneNumber,
      email_address: input.email?.trim() || undefined,
      reference_id: appointmentIntentId || undefined,
      note: appointmentIntentId ? `Created for appointment intent ${appointmentIntentId}` : undefined,
    },
  });

  if (!response.customer?.id) {
    throw new Error("Square CreateCustomer response did not include a customer ID.");
  }

  return normalizeSquareCustomer(response.customer);
}

export async function getOrCreateSquareCustomer(input: CreateSquareCustomerInput): Promise<SquareCustomer> {
  const existingCustomer = await searchSquareCustomerByPhone(input.phoneE164, input.timeoutMs);

  if (existingCustomer) {
    return existingCustomer;
  }

  return createSquareCustomer(input);
}

function normalizeSquareCustomer(customer: SquareCustomerRecord): SquareCustomer {
  if (!customer.id) {
    throw new Error("Square customer record did not include a customer ID.");
  }

  return {
    customerId: customer.id,
    givenName: customer.given_name,
    familyName: customer.family_name,
    phoneNumber: customer.phone_number,
    emailAddress: customer.email_address,
    raw: customer,
  };
}

function normalizePhoneInput(phoneE164: string) {
  return phoneE164.trim();
}

function normalizePhoneForComparison(phoneNumber: string | null | undefined) {
  return phoneNumber?.replace(/[^\d+]/g, "") ?? "";
}

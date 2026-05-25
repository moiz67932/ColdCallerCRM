import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { squareRequest } from "@/lib/square/client";

export type SquareServiceMapping = {
  organizationId: string;
  internalServiceName: string;
  square_location_id: string;
  square_team_member_id: string;
  square_service_variation_id: string;
  square_service_variation_version: number;
  duration_minutes: number;
  deposit_amount_cents: number;
  currency: string;
  raw: unknown;
};

export type SearchSquareCatalogServicesInput = {
  textFilter: string;
  locationId: string;
};

export type SquareCatalogService = {
  itemId: string;
  itemName: string;
  productType: string | null;
  variationId: string;
  variationName: string;
  serviceVariationVersion: number;
  durationMinutes: number | null;
  priceAmountCents: number | null;
  currency: string | null;
  raw: unknown;
};

export type ResolvedSquareServiceForBooking = {
  organizationId: string;
  serviceName: string;
  locationId: string;
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: number;
  durationMinutes: number;
  depositAmountCents: number;
  currency: string;
  source: "clinic_services_square_map";
  rawMapping: unknown;
};

export type GetSquareServiceMappingInput = {
  organizationId: string;
  serviceName: string;
};

export type ResolveServiceForBookingInput = GetSquareServiceMappingInput & {
  locationId?: string;
};

type ClinicServicesSquareMapRow = {
  organization_id?: string;
  internal_service_name?: string;
  square_location_id?: string;
  square_team_member_id?: string;
  square_service_variation_id?: string;
  square_service_variation_version?: number | string;
  duration_minutes?: number | string;
  deposit_amount_cents?: number | string;
  currency?: string;
};

type CatalogMoney = {
  amount?: number;
  currency?: string;
};

type CatalogObject = {
  id?: string;
  version?: number;
  item_data?: {
    name?: string;
    product_type?: string;
    variations?: CatalogObject[];
  };
  item_variation_data?: {
    name?: string;
    service_duration?: number;
    price_money?: CatalogMoney;
  };
};

type SearchCatalogItemsResponse = {
  items?: CatalogObject[];
};

export async function searchSquareCatalogServices(
  input: SearchSquareCatalogServicesInput,
): Promise<SquareCatalogService[]> {
  validateCatalogSearchInput(input);

  const response = await squareRequest<SearchCatalogItemsResponse>({
    method: "POST",
    path: "/v2/catalog/search-catalog-items",
    operationName: "square.search_catalog_services",
    body: {
      text_filter: input.textFilter.trim(),
      product_types: ["APPOINTMENTS_SERVICE"],
      enabled_location_ids: [input.locationId.trim()],
      archived_state: "ARCHIVED_STATE_NOT_ARCHIVED",
    },
  });

  return (response.items ?? []).flatMap(normalizeCatalogItem);
}

export async function getSquareServiceMapping(
  input: GetSquareServiceMappingInput,
): Promise<SquareServiceMapping | null> {
  validateServiceMappingInput(input);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("clinic_services_square_map")
    .select(
      [
        "organization_id",
        "internal_service_name",
        "square_location_id",
        "square_team_member_id",
        "square_service_variation_id",
        "square_service_variation_version",
        "duration_minutes",
        "deposit_amount_cents",
        "currency",
      ].join(","),
    )
    .eq("organization_id", input.organizationId.trim())
    .ilike("internal_service_name", input.serviceName.trim())
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read Square service mapping: ${error.message}`);
  }

  return data ? normalizeServiceMapping(data as ClinicServicesSquareMapRow) : null;
}

export async function resolveServiceForBooking(
  input: ResolveServiceForBookingInput,
): Promise<ResolvedSquareServiceForBooking> {
  const mapping = await getSquareServiceMapping(input);

  if (!mapping) {
    // MVP behavior is intentionally mapping-first. Catalog search can surface
    // candidates, but it should not silently choose booking/payment settings.
    throw new Error(
      `No Square service mapping found for service "${input.serviceName}" in organization ${input.organizationId}.`,
    );
  }

  return {
    organizationId: mapping.organizationId,
    serviceName: mapping.internalServiceName,
    locationId: mapping.square_location_id,
    teamMemberId: mapping.square_team_member_id,
    serviceVariationId: mapping.square_service_variation_id,
    serviceVariationVersion: mapping.square_service_variation_version,
    durationMinutes: mapping.duration_minutes,
    depositAmountCents: mapping.deposit_amount_cents,
    currency: mapping.currency,
    source: "clinic_services_square_map",
    rawMapping: mapping.raw,
  };
}

function normalizeCatalogItem(item: CatalogObject): SquareCatalogService[] {
  const itemId = item.id;
  const itemName = item.item_data?.name;

  if (!itemId || !itemName) {
    return [];
  }

  return (item.item_data?.variations ?? []).flatMap((variation) => {
    const variationId = variation.id;
    const variationName = variation.item_variation_data?.name;
    const serviceVariationVersion = variation.version;

    if (!variationId || !variationName || !serviceVariationVersion) {
      return [];
    }

    return [
      {
        itemId,
        itemName,
        productType: item.item_data?.product_type ?? null,
        variationId,
        variationName,
        serviceVariationVersion,
        durationMinutes: millisecondsToMinutes(variation.item_variation_data?.service_duration),
        priceAmountCents: variation.item_variation_data?.price_money?.amount ?? null,
        currency: variation.item_variation_data?.price_money?.currency ?? null,
        raw: { item, variation },
      },
    ];
  });
}

function normalizeServiceMapping(row: ClinicServicesSquareMapRow): SquareServiceMapping {
  return {
    organizationId: requireString(row.organization_id, "organization_id"),
    internalServiceName: requireString(row.internal_service_name, "internal_service_name"),
    square_location_id: requireString(row.square_location_id, "square_location_id"),
    square_team_member_id: requireString(row.square_team_member_id, "square_team_member_id"),
    square_service_variation_id: requireString(row.square_service_variation_id, "square_service_variation_id"),
    square_service_variation_version: requirePositiveInteger(
      row.square_service_variation_version,
      "square_service_variation_version",
    ),
    duration_minutes: requirePositiveInteger(row.duration_minutes, "duration_minutes"),
    deposit_amount_cents: requireNonNegativeInteger(row.deposit_amount_cents, "deposit_amount_cents"),
    currency: requireString(row.currency, "currency"),
    raw: row,
  };
}

function millisecondsToMinutes(milliseconds: number | undefined) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return null;
  }

  return Math.round(milliseconds / 60_000);
}

function validateCatalogSearchInput(input: SearchSquareCatalogServicesInput) {
  if (!input.textFilter.trim()) {
    throw new Error("Missing text filter for Square catalog service search.");
  }

  if (!input.locationId.trim()) {
    throw new Error("Missing Square location ID for catalog service search.");
  }
}

function validateServiceMappingInput(input: GetSquareServiceMappingInput) {
  if (!input.organizationId.trim()) {
    throw new Error("Missing organization ID for Square service mapping lookup.");
  }

  if (!input.serviceName.trim()) {
    throw new Error("Missing service name for Square service mapping lookup.");
  }
}

function requireString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Square service mapping is missing required field: ${fieldName}`);
  }

  return value.trim();
}

function requirePositiveInteger(value: unknown, fieldName: string) {
  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`Square service mapping field must be a positive integer: ${fieldName}`);
  }

  return numberValue;
}

function requireNonNegativeInteger(value: unknown, fieldName: string) {
  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new Error(`Square service mapping field must be a non-negative integer: ${fieldName}`);
  }

  return numberValue;
}

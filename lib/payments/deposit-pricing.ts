export const DEFAULT_DEPOSIT_PERCENT_BPS = 2000;
export const DEFAULT_DEPOSIT_PRICING_SOURCE = "clinic_services_square_map";

export type DepositPricingDetailsInput = {
  serviceName: string;
  servicePriceCents: number | null;
  depositPercentBps?: number | null;
  depositAmountCents: number | null;
  currency?: string | null;
};

export type DepositPricingDetails = {
  service_price_cents: number | null;
  deposit_percent: number;
  deposit_percent_bps: number;
  deposit_amount_cents: number | null;
  currency: string;
  service_price_text: string | null;
  deposit_amount_text: string | null;
  deposit_percent_text: string;
  deposit_policy_text: string;
  deposit_policy_sentence: string;
  human_deposit_sentence: string | null;
  pricing_incomplete: boolean;
};

export function calculateDepositAmountCents(servicePriceCents: number | null | undefined, depositPercentBps = DEFAULT_DEPOSIT_PERCENT_BPS) {
  if (!Number.isInteger(servicePriceCents) || Number(servicePriceCents) <= 0) {
    return null;
  }

  if (!Number.isInteger(depositPercentBps) || depositPercentBps <= 0) {
    return null;
  }

  return Math.round((Number(servicePriceCents) * depositPercentBps) / 10_000);
}

export function normalizeDepositPercentBps(value: number | null | undefined) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : DEFAULT_DEPOSIT_PERCENT_BPS;
}

export function depositPercentFromBps(depositPercentBps: number) {
  return depositPercentBps / 100;
}

export function formatDepositPercentFromBps(depositPercentBps: number) {
  const percent = depositPercentFromBps(depositPercentBps);
  return Number.isInteger(percent) ? `${percent}%` : `${trimTrailingZeros(percent.toFixed(2))}%`;
}

export function formatMoneyFromCents(amountCents: number | null | undefined, currency = "USD", options: { trimTrailingZeroCents?: boolean } = {}) {
  if (typeof amountCents !== "number" || !Number.isFinite(amountCents)) {
    return null;
  }

  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: options.trimTrailingZeroCents ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(Number(amountCents) / 100);

  return formatted;
}

export function formatCompactMoneyFromCents(amountCents: number | null | undefined, currency = "USD") {
  return formatMoneyFromCents(amountCents, currency, { trimTrailingZeroCents: true });
}

export function buildDepositPolicyText(depositPercentBps = DEFAULT_DEPOSIT_PERCENT_BPS) {
  return `Appointments use a ${formatDepositPercentFromBps(depositPercentBps)} deposit. The appointment is confirmed after the deposit is paid and the booking is created.`;
}

export function buildDepositPolicySentence(depositPercentBps = DEFAULT_DEPOSIT_PERCENT_BPS) {
  return `The deposit is ${formatDepositPercentFromBps(depositPercentBps)} of the service price.`;
}

export function buildDepositPricingDetails(input: DepositPricingDetailsInput): DepositPricingDetails {
  const currency = input.currency?.trim() || "USD";
  const depositPercentBps = normalizeDepositPercentBps(input.depositPercentBps);
  const calculatedDepositAmountCents = calculateDepositAmountCents(input.servicePriceCents, depositPercentBps);
  const depositAmountCents = calculatedDepositAmountCents ?? input.depositAmountCents ?? null;
  const servicePriceText = formatCompactMoneyFromCents(input.servicePriceCents, currency);
  const depositAmountText = formatCompactMoneyFromCents(depositAmountCents, currency);
  const depositPercentText = formatDepositPercentFromBps(depositPercentBps);

  return {
    service_price_cents: input.servicePriceCents,
    deposit_percent: depositPercentFromBps(depositPercentBps),
    deposit_percent_bps: depositPercentBps,
    deposit_amount_cents: depositAmountCents,
    currency,
    service_price_text: servicePriceText,
    deposit_amount_text: depositAmountText,
    deposit_percent_text: depositPercentText,
    deposit_policy_text: buildDepositPolicyText(depositPercentBps),
    deposit_policy_sentence: buildDepositPolicySentence(depositPercentBps),
    human_deposit_sentence: servicePriceText && depositAmountText
      ? `The ${input.serviceName} is ${servicePriceText} and the ${depositPercentText} deposit is ${depositAmountText}.`
      : null,
    pricing_incomplete: !servicePriceText || !depositAmountText,
  };
}

function trimTrailingZeros(value: string) {
  return value.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

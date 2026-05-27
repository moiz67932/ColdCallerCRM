import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDepositPricingDetails,
  calculateDepositAmountCents,
  formatMoneyFromCents,
} from "@/lib/payments/deposit-pricing";
import { servicesWithPricingAndDepositsText } from "@/lib/elevenlabs/shared-demo-context";
import { buildSquarePaymentLinkRequestBody } from "@/lib/square/payments";

test("deposit pricing calculates a 20 percent deposit from total service price", () => {
  assert.equal(calculateDepositAmountCents(25000, 2000), 5000);

  const pricing = buildDepositPricingDetails({
    serviceName: "Botox Consultation",
    servicePriceCents: 25000,
    depositPercentBps: 2000,
    depositAmountCents: 1234,
    currency: "USD",
  });

  assert.equal(pricing.service_price_cents, 25000);
  assert.equal(pricing.deposit_percent, 20);
  assert.equal(pricing.deposit_percent_bps, 2000);
  assert.equal(pricing.deposit_amount_cents, 5000);
  assert.equal(pricing.service_price_text, "$250");
  assert.equal(pricing.deposit_amount_text, "$50");
  assert.equal(pricing.deposit_policy_sentence, "The deposit is 20% of the service price.");
  assert.equal(pricing.human_deposit_sentence, "The Botox Consultation is $250 and the 20% deposit is $50.");
});

test("deposit pricing keeps existing deposit when service price is incomplete", () => {
  const pricing = buildDepositPricingDetails({
    serviceName: "Mapped Service",
    servicePriceCents: null,
    depositPercentBps: 2000,
    depositAmountCents: 5000,
    currency: "USD",
  });

  assert.equal(pricing.service_price_cents, null);
  assert.equal(pricing.deposit_amount_cents, 5000);
  assert.equal(pricing.deposit_amount_text, "$50");
  assert.equal(pricing.pricing_incomplete, true);
});

test("money formatter supports UI currency output", () => {
  assert.equal(formatMoneyFromCents(5000, "USD"), "$50.00");
});

test("shared demo context includes services with pricing and deposits text", () => {
  const text = servicesWithPricingAndDepositsText([
    {
      name: "Botox Consultation",
      durationMinutes: 30,
      servicePriceCents: 25000,
      depositPercentBps: 2000,
      depositAmountCents: 5000,
      currency: "USD",
    },
  ]);

  assert.match(text, /Botox Consultation: 30 minutes, total price \$250, 20% deposit \$50/);
});

test("Square payment link quick pay uses the deposit amount and deposit wording", () => {
  const body = buildSquarePaymentLinkRequestBody({
    appointmentIntentId: "intent-1",
    locationId: "location-1",
    serviceName: "Botox Consultation",
    amountCents: 5000,
    currency: "USD",
    depositPercentText: "20%",
  });

  assert.equal(body.quick_pay.name, "Botox Consultation Deposit");
  assert.equal(body.quick_pay.price_money.amount, 5000);
  assert.match(body.description, /20% deposit for Botox Consultation/);
  assert.match(body.payment_note, /20% deposit for Botox Consultation/);
});

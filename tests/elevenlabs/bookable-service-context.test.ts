import test from "node:test";
import assert from "node:assert/strict";

import { getSharedDemoVoiceContext } from "@/lib/elevenlabs/shared-demo-context";

const services = [
  service("Botox Consultation", "Injectables"),
  service("Chemical Peel Consultation", "Skin Treatments"),
  service("Custom Medical Facial", "Facials"),
  service("Hydrafacial", "Facials"),
  service("IV Therapy Consultation", "Wellness"),
  service("Laser Hair Removal Consultation", "Laser"),
  service("Microneedling Consultation", "Skin Treatments"),
  service("PRP Consultation", "Skin Treatments"),
];
const expectedNames = [
  "Botox Consultation",
  "Hydrafacial",
  "Custom Medical Facial",
  "Laser Hair Removal Consultation",
  "Chemical Peel Consultation",
  "Microneedling Consultation",
  "PRP Consultation",
  "IV Therapy Consultation",
];

function service(name: string, category: string) {
  return {
    name,
    category,
    durationMinutes: 30,
    servicePriceCents: 25000,
    depositPercentBps: 2000,
    depositAmountCents: 5000,
    currency: "USD",
  };
}

test("shared demo voice context only exposes Square-mapped bookable services", () => {
  const context = getSharedDemoVoiceContext(services);
  const serialized = JSON.stringify({
    safe_service_names_text: context.safe_service_names_text,
    bookable_service_names_text: context.bookable_service_names_text,
    services_by_category_text: context.services_by_category_text,
    injectables_list_text: context.injectables_list_text,
    injectables_list_spoken_short: context.injectables_list_spoken_short,
    laser_list_text: context.laser_list_text,
    laser_list_spoken_short: context.laser_list_spoken_short,
    skin_list_text: context.skin_list_text,
    wellness_list_text: context.wellness_list_text,
    body_list_text: context.body_list_text,
  });

  assert.deepEqual(context.safe_service_names, expectedNames);
  assert.equal(context.bookable_service_names_text, expectedNames.join(", "));
  assert.equal(context.injectables_list_text, "Botox Consultation");
  assert.equal(context.facials_list_text, "Hydrafacial, Custom Medical Facial");
  assert.equal(context.laser_list_text, "Laser Hair Removal Consultation");
  assert.equal(context.skin_list_text, "Chemical Peel Consultation, Microneedling Consultation, PRP Consultation");
  assert.equal(context.wellness_list_text, "IV Therapy Consultation");
  assert.equal(context.body_list_text, "");
  assert.doesNotMatch(context.service_categories_short, /Body Treatments/);

  assert.doesNotMatch(serialized, /Botox and Dysport|Dermal Fillers|Lip Filler|Kybella|IPL Photofacial|RF Skin Tightening|Body Contouring|Wellness Shot|GLP-1/i);
});

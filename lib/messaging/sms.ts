import { normalizePhoneNumber } from "@/lib/phone";

export type SmsTemplateKey = "live_demo_number" | "booking_demo_link" | "owner_follow_up" | "custom";

export type SmsTemplateValues = {
  name?: string | null;
  clinic_name?: string | null;
  demo_number?: string | null;
  booking_link?: string | null;
};

export const smsTemplates: Array<{ key: SmsTemplateKey; name: string; body: string }> = [
  {
    key: "live_demo_number",
    name: "Live demo number",
    body:
      "Hi {{name}}, this is Moiz from Portive. Here's the live AI receptionist demo number we just spoke about: {{demo_number}}\n\n" +
      "You can call it like a patient and test services, pricing, and booking.\n\n" +
      "Reply STOP to opt out.",
  },
  {
    key: "booking_demo_link",
    name: "8-minute demo link",
    body:
      "Hi {{name}}, this is Moiz from Portive. Here's the quick 8-minute demo link we discussed: {{booking_link}}\n\n" +
      "Once you pick a time, it'll send the calendar invite automatically.\n\n" +
      "Reply STOP to opt out.",
  },
  {
    key: "owner_follow_up",
    name: "Owner follow-up",
    body:
      "Hi {{name}}, this is Moiz from Portive. I called about helping med spas answer after-hours and overflow patient calls.\n\n" +
      "Here's the live demo number if you want to test it like a patient: {{demo_number}}\n\n" +
      "Reply STOP to opt out.",
  },
  {
    key: "custom",
    name: "Custom",
    body: "",
  },
];

const obviouslyFakeNationalNumbers = new Set([
  "0000000000",
  "1111111111",
  "2222222222",
  "3333333333",
  "4444444444",
  "5555555555",
  "6666666666",
  "7777777777",
  "8888888888",
  "9999999999",
  "1234567890",
]);

export function renderSmsTemplate(templateKey: SmsTemplateKey, values: SmsTemplateValues) {
  const template = smsTemplates.find((item) => item.key === templateKey);

  if (!template || template.key === "custom") {
    return "";
  }

  return template.body.replace(/\{\{(name|clinic_name|demo_number|booking_link)\}\}/g, (_match, key: keyof SmsTemplateValues) =>
    String(values[key] ?? ""),
  );
}

export function getSmsTemplateName(templateKey?: string | null) {
  return smsTemplates.find((item) => item.key === templateKey)?.name ?? "Custom";
}

export function normalizeAndValidateSmsNumber(rawValue: string, defaultCountry: "US" | "CA" = "US") {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return { ok: false as const, error: "Enter a mobile number before sending." };
  }

  const normalized = normalizePhoneNumber(trimmed, defaultCountry);

  if (!normalized) {
    return { ok: false as const, error: "Enter a valid phone number, preferably in +1 E.164 format." };
  }

  const nationalNumber = normalized.startsWith("+1") ? normalized.slice(2) : normalized.replace(/\D/g, "");

  if (
    obviouslyFakeNationalNumbers.has(nationalNumber) ||
    /^(\d)\1{9}$/.test(nationalNumber) ||
    /^[2-9]\d{2}55501\d{2}$/.test(nationalNumber)
  ) {
    return { ok: false as const, error: "That phone number looks like a placeholder. Enter the lead's real mobile number." };
  }

  return { ok: true as const, number: normalized };
}

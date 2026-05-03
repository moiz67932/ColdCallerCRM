import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizePhoneNumber(rawValue: string, defaultCountry: "US" | "CA" = "US") {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = trimmed.startsWith("+")
    ? parsePhoneNumberFromString(trimmed)
    : parsePhoneNumberFromString(trimmed, defaultCountry);

  if (!parsed || !parsed.isValid()) {
    return null;
  }

  return parsed.number;
}

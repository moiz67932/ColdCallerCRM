import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizePhoneDigits(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\D/g, "");
}

export function normalizePhoneNumber(rawValue: string, defaultCountry: "US" | "CA" = "US") {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = (() => {
    try {
      return trimmed.startsWith("+")
        ? parsePhoneNumberFromString(trimmed)
        : parsePhoneNumberFromString(trimmed, defaultCountry);
    } catch {
      return null;
    }
  })();

  if (!parsed || !parsed.isValid()) {
    const digits = trimmed.replace(/\D/g, "");
    if (defaultCountry === "US" && digits.length === 10) return `+1${digits}`;
    if ((defaultCountry === "US" || defaultCountry === "CA") && digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  }

  return parsed.number;
}

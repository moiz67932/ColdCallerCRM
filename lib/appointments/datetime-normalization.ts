type NormalizeHumanAppointmentDateTimeInput = {
  preferredDate?: string | null;
  preferredTime?: string | null;
  selectedStartAt?: string | null;
  timezone: string;
  now?: Date;
};

export type NormalizedHumanAppointmentDateTime = {
  selectedStartAt: string | null;
  selectedStartAtReceived: string | null;
  selectedStartAtReceivedIsValid: boolean;
  preferredDateRaw: string | null;
  preferredDateNormalized: string | null;
  preferredTimeRaw: string | null;
  preferredTimeNormalized: string | null;
  fallbackUsed: string | null;
  validationError: string | null;
  mismatch: boolean;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
  six: 6,
  sixth: 6,
  seven: 7,
  seventh: 7,
  eight: 8,
  eighth: 8,
  nine: 9,
  ninth: 9,
  ten: 10,
  tenth: 10,
  eleven: 11,
  eleventh: 11,
  twelve: 12,
  twelfth: 12,
  thirteen: 13,
  thirteenth: 13,
  fourteen: 14,
  fourteenth: 14,
  fifteen: 15,
  fifteenth: 15,
  sixteen: 16,
  sixteenth: 16,
  seventeen: 17,
  seventeenth: 17,
  eighteen: 18,
  eighteenth: 18,
  nineteen: 19,
  nineteenth: 19,
  twenty: 20,
  twentieth: 20,
  thirty: 30,
  thirtieth: 30,
};

export function normalizeHumanAppointmentDateTime(input: NormalizeHumanAppointmentDateTimeInput): NormalizedHumanAppointmentDateTime {
  const now = input.now ?? new Date();
  const selectedStartAtReceived = clean(input.selectedStartAt);
  const selectedStartAtDate = selectedStartAtReceived ? new Date(selectedStartAtReceived) : null;
  const selectedStartAtReceivedIsValid = Boolean(selectedStartAtDate && Number.isFinite(selectedStartAtDate.getTime()));
  const selectedStartAtReceivedIsFuture = Boolean(selectedStartAtDate && selectedStartAtDate.getTime() > now.getTime());
  const preferredDateRaw = clean(input.preferredDate);
  const preferredTimeRaw = clean(input.preferredTime);

  const base = {
    selectedStartAtReceived,
    selectedStartAtReceivedIsValid,
    preferredDateRaw,
    preferredDateNormalized: null,
    preferredTimeRaw,
    preferredTimeNormalized: null,
    fallbackUsed: null,
    validationError: null,
    mismatch: false,
  };

  if (!isValidTimeZone(input.timezone)) {
    return { ...base, selectedStartAt: null, validationError: "clinic_timezone is not a valid IANA timezone." };
  }

  if (preferredDateRaw && preferredTimeRaw) {
    const preferredDateNormalized = normalizePreferredDate(preferredDateRaw, input.timezone, now);
    const preferredTimeNormalized = normalizePreferredTime(preferredTimeRaw);

    if (preferredDateNormalized && preferredTimeNormalized) {
      const [year, month, day] = preferredDateNormalized.split("-").map(Number);
      const [hour, minute] = preferredTimeNormalized.split(":").map(Number);
      const selectedStartAt = zonedLocalTimeToUtcIso({ year, month, day, hour, minute, timezone: input.timezone });
      const mismatch = Boolean(
        selectedStartAtReceived &&
        (!selectedStartAtReceivedIsValid ||
          Math.abs(new Date(selectedStartAt).getTime() - new Date(selectedStartAtReceived).getTime()) > 60_000),
      );

      return {
        ...base,
        selectedStartAt,
        preferredDateNormalized,
        preferredTimeNormalized,
        fallbackUsed: null,
        validationError: null,
        mismatch,
      };
    }

    if (selectedStartAtReceived && selectedStartAtReceivedIsValid && selectedStartAtReceivedIsFuture) {
      return {
        ...base,
        selectedStartAt: new Date(selectedStartAtReceived).toISOString(),
        preferredDateNormalized,
        preferredTimeNormalized,
        fallbackUsed: "valid_selected_start_at",
        validationError: null,
        mismatch: false,
      };
    }

    return {
      ...base,
      selectedStartAt: null,
      preferredDateNormalized,
      preferredTimeNormalized,
      validationError: !preferredDateNormalized ? "preferred_date could not be parsed." : "preferred_time could not be parsed.",
    };
  }

  if (selectedStartAtReceived && selectedStartAtReceivedIsValid) {
    return {
      ...base,
      selectedStartAt: new Date(selectedStartAtReceived).toISOString(),
    };
  }

  return {
    ...base,
    selectedStartAt: null,
    validationError: selectedStartAtReceived ? "selected_start_at is not a valid datetime." : "missing appointment date/time.",
  };
}

export function normalizePreferredDate(value: string, timezone: string, now: Date = new Date()) {
  const normalized = normalizeOrdinalWords(value);
  const localToday = getZonedDateParts(timezone, now);

  if (/^tomorrow$/i.test(normalized)) {
    return addDaysToDateParts(localToday, 1);
  }

  const nextWeekday = /^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.exec(normalized);
  if (nextWeekday) {
    const targetWeekday = WEEKDAYS[nextWeekday[1].toLowerCase()];
    const currentUtcDate = new Date(Date.UTC(localToday.year, localToday.month - 1, localToday.day));
    const currentWeekday = currentUtcDate.getUTCDay();
    const daysUntil = ((targetWeekday - currentWeekday + 7) % 7) || 7;
    return addDaysToDateParts(localToday, daysUntil);
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized);
  if (iso) {
    const [, year, month, day] = iso.map(Number);
    return isValidCalendarDate(year, month, day) ? formatLocalDate(year, month, day) : null;
  }

  const monthPattern = Object.keys(MONTHS).join("|");
  const monthFirst = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:\\s+(\\d{4}))?\\b`, "i").exec(normalized);
  const dayFirst = new RegExp(`\\b(\\d{1,2})\\s+(${monthPattern})(?:\\s+(\\d{4}))?\\b`, "i").exec(normalized);

  if (monthFirst) {
    return resolveMonthDay({
      month: MONTHS[monthFirst[1].toLowerCase()],
      day: Number(monthFirst[2]),
      year: monthFirst[3] ? Number(monthFirst[3]) : null,
      today: localToday,
    });
  }

  if (dayFirst) {
    return resolveMonthDay({
      day: Number(dayFirst[1]),
      month: MONTHS[dayFirst[2].toLowerCase()],
      year: dayFirst[3] ? Number(dayFirst[3]) : null,
      today: localToday,
    });
  }

  return null;
}

export function normalizePreferredTime(value: string) {
  const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const period = match[3];

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (period) {
    if (hour < 1 || hour > 12) return null;
    if (period === "am" && hour === 12) hour = 0;
    if (period === "pm" && hour < 12) hour += 12;
  } else if (hour > 23) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeOrdinalWords(value: string) {
  const tokens = value
    .toLowerCase()
    .replace(/[-,]/g, " ")
    .replace(/\b(the|of|on)\b/g, " ")
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const output: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const current = NUMBER_WORDS[token];
    const next = NUMBER_WORDS[tokens[index + 1]];

    if ((current === 20 || current === 30) && next && next > 0 && next < 10) {
      output.push(String(current + next));
      index += 1;
      continue;
    }

    output.push(current ? String(current) : token);
  }

  return output.join(" ");
}

function resolveMonthDay(input: {
  month: number;
  day: number;
  year: number | null;
  today: { year: number; month: number; day: number };
}) {
  let year = input.year ?? input.today.year;
  if (!isValidCalendarDate(year, input.month, input.day)) return null;

  const candidate = formatLocalDate(year, input.month, input.day);
  const today = formatLocalDate(input.today.year, input.today.month, input.today.day);
  if (!input.year && candidate < today) year += 1;

  return isValidCalendarDate(year, input.month, input.day) ? formatLocalDate(year, input.month, input.day) : null;
}

function addDaysToDateParts(parts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return formatLocalDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function getZonedDateParts(timezone: string, date: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function zonedLocalTimeToUtcIso(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(formatter, candidate);
    const targetUtcMs = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0);
    const actualUtcMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const diffMs = targetUtcMs - actualUtcMs;

    if (diffMs === 0) break;
    candidate = new Date(candidate.getTime() + diffMs);
  }

  return candidate.toISOString();
}

function zonedParts(formatter: Intl.DateTimeFormat, date: Date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function isValidTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isValidCalendarDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formatLocalDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function clean(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

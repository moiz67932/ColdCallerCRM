import { createHash } from "node:crypto";

import { createEmptyExtractedProfile, extractedProfileSchema, type ExtractedProfile, type ScrapedPage, weekdayOrder } from "@/lib/demo-agent/contracts";

const serviceKeywords = [
  "cleaning",
  "whitening",
  "invisalign",
  "root canal",
  "veneer",
  "crown",
  "bridge",
  "implant",
  "filling",
  "exam",
  "x-ray",
  "emergency",
  "orthodontic",
  "pediatric",
  "cosmetic",
  "denture",
];

const insuranceKeywords = ["insurance", "ppo", "delta dental", "aetna", "cigna", "metlife", "guardian"];
const paymentKeywords = ["visa", "mastercard", "amex", "discover", "cash", "carecredit", "financing", "credit card"];
const policyKeywords = ["cancellation", "reschedule", "late arrival", "privacy", "after hours", "emergency"];

export function normalizeWebsiteUrl(input: string) {
  const value = input.trim();
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https websites are supported");
  }

  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function normalizeServiceName(input: string) {
  return input
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function normalizeText(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

export function contentHash(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

export function classifyPage(url: string, title?: string | null) {
  const value = `${url} ${title ?? ""}`.toLowerCase();

  if (value.includes("pricing") || value.includes("cost") || value.includes("fee")) return "pricing";
  if (value.includes("service")) return "services";
  if (value.includes("faq")) return "faq";
  if (value.includes("insurance")) return "insurance";
  if (value.includes("contact")) return "contact";
  if (value.includes("about")) return "about";
  if (value.includes("patient")) return "patient";

  return "general";
}

export function parsePriceText(input: string) {
  const text = normalizeText(input);
  const match = text.match(/\$(\d[\d,]*(?:\.\d{2})?)/);

  if (!match) {
    return { priceText: null as string | null, priceMinCents: null as number | null };
  }

  const amount = Number.parseFloat(match[1].replace(/,/g, ""));

  if (Number.isNaN(amount)) {
    return { priceText: null as string | null, priceMinCents: null as number | null };
  }

  return {
    priceText: text,
    priceMinCents: Math.round(amount * 100),
  };
}

function normalizeTime(input: string) {
  const match = input.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);

  if (!match) {
    return null;
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  const meridiem = match[3].toLowerCase();

  if (meridiem === "pm" && hours !== 12) {
    hours += 12;
  }

  if (meridiem === "am" && hours === 12) {
    hours = 0;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function parseHours(text: string) {
  const result = Object.fromEntries(
    weekdayOrder.map((day) => [day, { open: false, start: null, end: null }]),
  ) as ExtractedProfile["hours"];

  for (const day of weekdayOrder) {
    const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
    const pattern = new RegExp(`${dayLabel}\\s*[:\\-]?\\s*(Closed|\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)\\s*(?:-|to)\\s*\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM))`, "i");
    const match = text.match(pattern);

    if (!match) {
      continue;
    }

    if (/closed/i.test(match[1])) {
      result[day] = { open: false, start: null, end: null };
      continue;
    }

    const [startText, endText] = match[1].split(/\s*(?:-|to)\s*/i);
    const start = normalizeTime(startText);
    const end = normalizeTime(endText);

    if (start && end) {
      result[day] = { open: true, start, end };
    }
  }

  return result;
}

function collectUniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function extractPhone(text: string) {
  const match = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  return match ? normalizeText(match[0]) : "";
}

function extractEmail(text: string) {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : "";
}

function inferIndustry(text: string) {
  const lower = text.toLowerCase();

  if (lower.includes("med spa") || lower.includes("medical spa")) {
    return "med_spa";
  }

  return "dental";
}

function extractBusinessName(page: ScrapedPage) {
  if (page.title) {
    return page.title.split("|")[0]?.split("-")[0]?.trim() ?? "";
  }

  const headingMatch = page.html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  return headingMatch ? normalizeText(headingMatch[1].replace(/<[^>]+>/g, " ")) : "";
}

function extractAddress(text: string) {
  const match = text.match(/(\d{1,6}\s+[A-Za-z0-9.\- ]+),?\s+([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);

  if (!match) {
    return {
      line1: "",
      line2: "",
      city: "",
      state: "",
      zip: "",
      country: "US",
    };
  }

  return {
    line1: normalizeText(match[1]),
    line2: "",
    city: normalizeText(match[2]),
    state: match[3],
    zip: match[4],
    country: "US",
  };
}

function extractFaqs(page: ScrapedPage) {
  const faqs: ExtractedProfile["faqs"] = [];
  const lines = page.cleanedText.split(/\n+/).map(normalizeText).filter(Boolean);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];

    if (!current.endsWith("?") || next.endsWith("?")) {
      continue;
    }

    faqs.push({
      question: current,
      answer: next,
      category: page.pageType === "insurance" ? "Insurance" : "FAQ",
      source_url: page.url,
      confidence: 0.72,
    });
  }

  return faqs;
}

function extractPolicies(page: ScrapedPage) {
  const lines = page.cleanedText.split(/\n+/).map(normalizeText).filter(Boolean);
  const policies: ExtractedProfile["policies"] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (!policyKeywords.some((keyword) => lower.includes(keyword))) {
      continue;
    }

    policies.push({
      title: line.length > 80 ? `${line.slice(0, 77)}...` : line,
      body: line,
      source_url: page.url,
    });
  }

  return policies;
}

function extractStaff(page: ScrapedPage) {
  const staff: ExtractedProfile["staff"] = [];
  const regex = /(Dr\.\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)([^.\n]{0,80})/g;

  for (const match of page.cleanedText.matchAll(regex)) {
    staff.push({
      name: normalizeText(match[1]),
      role: match[2]?.toLowerCase().includes("orthodont") ? "Orthodontist" : "Dentist",
      bio: normalizeText(match[0]),
    });
  }

  return staff;
}

function extractServicesFromPage(page: ScrapedPage) {
  const services: ExtractedProfile["services"] = [];
  const sentences = page.cleanedText
    .split(/[\n.]/)
    .map(normalizeText)
    .filter(Boolean);

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();

    if (!serviceKeywords.some((keyword) => lower.includes(keyword))) {
      continue;
    }

    const serviceName = normalizeServiceName(
      serviceKeywords.find((keyword) => lower.includes(keyword)) ?? sentence.split(" ").slice(0, 3).join(" "),
    );

    const price = parsePriceText(sentence);
    const durationMatch = sentence.match(/(\d+)\s*(minute|min)\b/i);

    services.push({
      name: serviceName,
      aliases: [],
      description: sentence,
      duration_minutes: durationMatch ? Number(durationMatch[1]) : null,
      price_text: price.priceText,
      price_min_cents: price.priceMinCents,
      bookable: true,
      source_url: page.url,
      confidence: page.pageType === "services" ? 0.85 : 0.65,
    });
  }

  return services;
}

export function dedupeServices(services: ExtractedProfile["services"]) {
  const byName = new Map<string, ExtractedProfile["services"][number]>();

  for (const service of services) {
    const key = normalizeServiceName(service.name).toLowerCase();
    const current = byName.get(key);

    if (!current || service.confidence > current.confidence) {
      byName.set(key, {
        ...service,
        name: normalizeServiceName(service.name),
      });
      continue;
    }

    current.aliases = collectUniqueStrings([...current.aliases, ...service.aliases]);
    current.description = current.description.length >= service.description.length ? current.description : service.description;
    current.duration_minutes ??= service.duration_minutes;
    current.price_text ??= service.price_text;
    current.price_min_cents ??= service.price_min_cents;
  }

  return [...byName.values()];
}

function extractJsonLdFields(pages: ScrapedPage[]) {
  const businessNodes: Record<string, unknown>[] = [];

  for (const page of pages) {
    for (const node of page.jsonLd) {
      if (node && typeof node === "object") {
        businessNodes.push(node as Record<string, unknown>);
      }
    }
  }

  const localBusiness = businessNodes.find((node) => {
    const type = node["@type"];
    return typeof type === "string" && ["Dentist", "MedicalBusiness", "LocalBusiness"].includes(type);
  });

  if (!localBusiness) {
    return {};
  }

  return {
    name: typeof localBusiness.name === "string" ? localBusiness.name : "",
    phone: typeof localBusiness.telephone === "string" ? localBusiness.telephone : "",
    email: typeof localBusiness.email === "string" ? localBusiness.email : "",
  };
}

export function extractProfileFromPages(pages: ScrapedPage[], websiteUrl: string) {
  const profile = createEmptyExtractedProfile(websiteUrl);
  const combinedText = pages.map((page) => page.cleanedText).join("\n");
  const homePage = pages[0];
  const jsonLd = extractJsonLdFields(pages);
  const allServices = dedupeServices(pages.flatMap(extractServicesFromPage)).filter((service) => service.confidence >= 0.55);
  const faqs = pages.flatMap(extractFaqs);
  const policies = pages.flatMap(extractPolicies);
  const staff = pages.flatMap(extractStaff);

  profile.clinic.name = String(jsonLd.name || extractBusinessName(homePage) || "Unknown Clinic");
  profile.clinic.industry = inferIndustry(combinedText);
  profile.clinic.website = websiteUrl;
  profile.clinic.phone = String(jsonLd.phone || extractPhone(combinedText));
  profile.clinic.email = String(jsonLd.email || extractEmail(combinedText));
  profile.clinic.address = extractAddress(combinedText);
  profile.hours = parseHours(combinedText);
  profile.services = allServices;
  profile.faqs = faqs;
  profile.policies = policies;
  profile.payments = collectUniqueStrings(
    paymentKeywords.filter((keyword) => combinedText.toLowerCase().includes(keyword)).map((keyword) =>
      keyword === "amex" ? "American Express" : keyword === "carecredit" ? "CareCredit" : normalizeServiceName(keyword),
    ),
  );
  profile.insurance = collectUniqueStrings(
    insuranceKeywords.filter((keyword) => combinedText.toLowerCase().includes(keyword)).map(normalizeServiceName),
  );
  profile.staff = staff;
  profile.source_pages = collectUniqueStrings(pages.map((page) => page.url));

  if (!profile.faqs.length && profile.insurance.length) {
    profile.faqs.push({
      question: "Do you accept insurance?",
      answer: `The website mentions ${profile.insurance.join(", ")}. The office can confirm current coverage details.`,
      category: "Insurance",
      source_url: profile.source_pages[0] ?? websiteUrl,
      confidence: 0.7,
    });
  }

  if (!weekdayOrder.some((day) => profile.hours[day].open)) {
    profile.faqs.push({
      question: "What are your hours?",
      answer: "The website does not publish clear office hours. The office can confirm current hours.",
      category: "Hours",
      source_url: profile.source_pages[0] ?? websiteUrl,
      confidence: 0.6,
    });
  }

  return extractedProfileSchema.parse(profile);
}

export function summarizeExtractedProfile(profile: ExtractedProfile) {
  return {
    businessName: profile.clinic.name || null,
    servicesCount: profile.services.length,
    faqsCount: profile.faqs.length,
    hasHours: weekdayOrder.some((day) => profile.hours[day].open),
    hasPricing: profile.services.some((service) => Boolean(service.price_text)),
  };
}

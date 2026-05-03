import { createHash, randomUUID } from "node:crypto";

import { createEmptyExtractedProfile, type ExtractedProfile, type ScrapedPage, weekdayOrder } from "@/lib/demo-agent/contracts";
import { contentHash, normalizeServiceName, normalizeText, parseHours } from "@/lib/demo-agent/extraction";
import { env } from "@/lib/env";
import { logInfo, logWarn } from "@/lib/logger";

export const PROFILE_EXTRACTOR_VERSION = "lead-clinic-profile-v2";

type PageType =
  | "home"
  | "contact"
  | "services_index"
  | "service_detail"
  | "pricing"
  | "specials"
  | "products"
  | "team"
  | "faq"
  | "policies"
  | "booking"
  | "unknown";

type ExtractionMethod = "deterministic" | "json_ld" | "llm";

export type PipelinePage = Omit<ScrapedPage, "pageType"> & {
  id?: string | null;
  leadId?: string;
  organizationId?: string;
  pageType?: string | null;
  normalizedText?: string | null;
};

export type StructuredPrice = {
  price_label: string | null;
  price_type: "fixed" | "starting_at" | "range" | "series" | "package" | "add_on" | "per_unit" | "consultation" | "unknown";
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  amount_cents: number | null;
  currency: "USD";
  unit: string | null;
  package_quantity: number | null;
  raw_price_text: string;
  duration_min_minutes: number | null;
  duration_max_minutes: number | null;
  confidence: number;
  source_quote: string;
};

type NormalizedFact = {
  id: string;
  fact_type: string;
  fact_key: string;
  fact_value: string;
  normalized_value: string | null;
  confidence: number;
  source_url: string | null;
  source_page_id: string | null;
  source_quote: string | null;
  extraction_method: ExtractionMethod;
};

type NormalizedLocation = {
  id: string;
  location_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  phone_e164: string | null;
  phone_display: string | null;
  email: string | null;
  timezone: string | null;
  source_url: string | null;
  confidence: number;
};

type NormalizedHour = {
  id: string;
  day_of_week: number;
  opens_at: string | null;
  closes_at: string | null;
  is_closed: boolean;
  by_appointment_only: boolean;
  raw_text: string | null;
  timezone: string | null;
  source_url: string | null;
  confidence: number;
};

export type NormalizedService = {
  id: string;
  canonical_name: string;
  display_name: string;
  service_slug: string;
  category: string | null;
  subcategory: string | null;
  description_short: string | null;
  description_long: string | null;
  is_bookable: boolean;
  is_product: boolean;
  is_membership: boolean;
  is_consultation: boolean;
  duration_min_minutes: number | null;
  duration_max_minutes: number | null;
  starting_price_cents: number | null;
  price_summary: string | null;
  price_available: boolean;
  currency: "USD";
  source_url: string | null;
  source_page_id: string | null;
  source_quote: string | null;
  confidence: number;
  sort_order: number | null;
  synthetic_key: string | null;
  aliases: Array<{ alias: string; alias_type: string; confidence: number }>;
  prices: StructuredPrice[];
};

type NormalizedFaq = {
  id: string;
  service_id: string | null;
  question: string;
  answer: string;
  category: string | null;
  source_url: string | null;
  source_page_id: string | null;
  confidence: number;
  is_medical_disclaimer_needed: boolean;
};

type NormalizedOffer = {
  id: string;
  title: string;
  description: string | null;
  offer_type: string;
  related_service_id: string | null;
  price_cents: number | null;
  discount_text: string | null;
  valid_from: string | null;
  valid_until: string | null;
  raw_text: string | null;
  metadata: Record<string, unknown>;
  source_url: string | null;
  source_page_id: string | null;
  confidence: number;
};

type NormalizedStaff = {
  id: string;
  full_name: string;
  role_title: string | null;
  bio_short: string | null;
  credentials: string | null;
  specialties: string[] | null;
  source_url: string | null;
  source_page_id: string | null;
  confidence: number;
};

type NormalizedProduct = {
  id: string;
  product_name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  price_cents: number | null;
  raw_price_text: string | null;
  source_url: string | null;
  source_page_id: string | null;
  confidence: number;
};

type VoiceAnswer = {
  id: string;
  answer_type: string;
  service_id: string | null;
  question_pattern: string | null;
  answer_text: string;
  source_urls: string[] | null;
  confidence: number;
  max_age_days: number | null;
};

type KnowledgeChunk = {
  id: string;
  service_id: string | null;
  subtype: string;
  topic: string;
  chunk_text: string;
  source_url: string | null;
  confidence: number;
  price_available: boolean;
  has_structured_service: boolean;
  metadata: Record<string, unknown>;
  content_hash: string;
};

export type QualityCheck = {
  check_name: string;
  status: "pass" | "warn" | "fail";
  score: number | null;
  message: string;
  details: Record<string, unknown>;
};

export type QualityResult = {
  score: number;
  status: "demo_ready" | "warning" | "not_demo_ready";
  isDemoReady: boolean;
  blockers: string[];
  warnings: string[];
  checks: QualityCheck[];
};

export type NormalizedExtractionResult = {
  extractionRunId: string;
  modelUsed: string | null;
  pageUpdates: Array<{ id: string | null; url: string; page_type: PageType; confidence: number; evidence: string; normalized_text: string }>;
  facts: NormalizedFact[];
  locations: NormalizedLocation[];
  hours: NormalizedHour[];
  services: NormalizedService[];
  faqs: NormalizedFaq[];
  offers: NormalizedOffer[];
  staff: NormalizedStaff[];
  products: NormalizedProduct[];
  voiceAnswers: VoiceAnswer[];
  knowledgeChunks: KnowledgeChunk[];
  quality: QualityResult;
  snapshot: ExtractedProfile;
  warnings: string[];
};

type ExtractionContext = {
  extractionRunId?: string;
  leadDemoProfileId?: string;
  clinicId?: string | null;
  websiteUrl: string;
  businessNameHint?: string | null;
  timezone?: string | null;
};

type LlmService = {
  name?: string;
  description?: string;
  category?: string;
  price_text?: string;
  duration_text?: string;
  aliases?: string[];
  source_url?: string;
};

type LlmFaq = {
  question?: string;
  answer?: string;
  category?: string;
  source_url?: string;
};

type LlmStaff = {
  full_name?: string;
  role_title?: string;
  bio?: string;
  source_url?: string;
};

type LlmOffer = {
  title?: string;
  description?: string;
  discount_text?: string;
  price_text?: string;
  source_url?: string;
};

type LlmExtraction = {
  business_name?: string;
  services?: LlmService[];
  faqs?: LlmFaq[];
  staff?: LlmStaff[];
  offers?: LlmOffer[];
};

type DbExtractionOptions = {
  leadDemoProfileId: string;
  scrapeJobId?: string | null;
  dryRun?: boolean;
  force?: boolean;
};

async function getAdminClient() {
  const { getSupabaseAdmin } = await import("@/lib/supabase-admin");
  return getSupabaseAdmin();
}

const boilerplatePatterns = [
  /^skip to content$/i,
  /^book now$/i,
  /^call now$/i,
  /^menu$/i,
  /^home$/i,
  /^privacy policy$/i,
  /^terms of use$/i,
  /^all rights reserved/i,
  /^copyright/i,
  /^powered by/i,
  /^accept cookies?$/i,
  /^google map/i,
  /^keyboard shortcuts$/i,
  /^map data/i,
  /^facebook$/i,
  /^instagram$/i,
  /^cart$/i,
  /^account$/i,
  /^search$/i,
  /^subscribe$/i,
  /^filter$/i,
  /^availability$/i,
  /^sort by:?$/i,
  /^regular price$/i,
  /^sale price$/i,
  /^add to cart$/i,
  /^customer reviews?$/i,
  /^write a review$/i,
  /^verified$/i,
  /^source:/i,
];

const neverServiceLabels = new Set([
  "about",
  "about us",
  "book",
  "book now",
  "call",
  "call now",
  "contact",
  "contact us",
  "faq",
  "faqs",
  "home",
  "learn more",
  "menu",
  "new patients",
  "products",
  "shop",
  "specials",
  "team",
  "account",
  "add to cart",
  "apply",
  "articles",
  "availability",
  "blog",
  "browse",
  "cart",
  "careers",
  "connect",
  "country/region",
  "description",
  "featured",
  "filter",
  "gift cards",
  "locations",
  "more",
  "most helpful",
  "most recent",
  "press",
  "quick links",
  "regular price",
  "remove all",
  "reviews",
  "sale price",
  "search",
  "sort by",
  "subscribe",
  "terms",
  "visit",
  "write a review",
]);

const broadCategoryLabels = new Set([
  "aesthetic",
  "aesthetics",
  "cosmetic",
  "dental",
  "facial",
  "facials",
  "implant",
  "injectables",
  "services",
  "skin",
  "wellness",
]);

const medSpaSignals = [
  "botox",
  "dysport",
  "filler",
  "fillers",
  "hydrafacial",
  "hydra facial",
  "microneedling",
  "kybella",
  "sculptra",
  "pdo",
  "prp",
  "prf",
  "chemical peel",
  "dermaplaning",
  "plasma pen",
  "laser",
  "morpheus",
  "hair restoration",
  "weight loss",
  "iv therapy",
];

const dentalSignals = [
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
  "emergency dentistry",
  "orthodontic",
  "pediatric dentistry",
  "denture",
];

const productSignals = ["product", "skin health", "zo skin", "retail", "shop"];

const nonContentPathPatterns = [
  /\/(?:account|cart|checkout|login|privacy|terms|policy|policies|data-request|cookies?|accessibility)(?:\/|$)/i,
  /privacy_policy\.html$/i,
];

const junkPhrasePatterns = [
  /\b(this page does not exist|page you are looking for could not be found)\b/i,
  /\b(skip to main content|all rights reserved|site by|footer|header)\b/i,
  /\b(add to cart|shopping cart|your cart is empty|continue shopping)\b/i,
  /\b(customer reviews?|write a review|verified|most recent|highest rating|lowest rating)\b/i,
  /\b(privacy policy|terms and conditions|data deletion request|do not sell)\b/i,
  /\b(franchise book|personal data request|states? select|zipcode)\b/i,
];

const staffRejectPatterns = [
  ...junkPhrasePatterns,
  /\b(body contouring|skin rejuvenation|injectables|facials|services|locations|membership|articles|press)\b/i,
  /\b(california|texas|florida|new york|new jersey|north carolina|arizona|washington)\b/i,
];

function shouldIgnorePageForExtraction(page: Pick<PipelinePage, "url" | "httpStatus" | "cleanedText" | "title" | "pageType">) {
  const status = typeof page.httpStatus === "number" ? page.httpStatus : 200;
  if (status >= 400) return true;
  if (nonContentPathPatterns.some((pattern) => pattern.test(page.url))) return true;
  const head = `${page.title ?? ""} ${page.cleanedText.slice(0, 500)}`;
  return junkPhrasePatterns.some((pattern) => pattern.test(head));
}

function isJunkText(input: string) {
  const text = normalizeText(input);
  if (!text) return true;
  return junkPhrasePatterns.some((pattern) => pattern.test(text));
}
export function isUuid(value: string | null | undefined) {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function centsFromAmount(input: string) {
  const amount = Number.parseFloat(input.replace(/,/g, ""));
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function titleCase(input: string) {
  return normalizeText(input)
    .split(" ")
    .map((word) => {
      if (/^(PDO|PRP|PRF|IV|MD|DA)$/i.test(word)) return word.toUpperCase();
      if (/^hydrafacial$/i.test(word)) return "HydraFacial";
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function serviceSlug(input: string) {
  return normalizeText(input)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function shortQuote(input: string, limit = 220) {
  const text = normalizeText(input);
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function cleanSentence(input: string, limit = 320) {
  const text = normalizeText(input)
    .replace(/\bSource:\s*\S+/gi, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
  const trimmed = text.length > limit ? `${text.slice(0, limit - 3).trim()}...` : text;
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function asSentenceList(items: string[]) {
  const values = items.map((item) => normalizeText(item)).filter(Boolean);
  if (!values.length) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function normalizedPhone(input: string) {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return input.trim();
}

function extractPhone(text: string) {
  const match = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  return match ? normalizeText(match[0]) : null;
}

function extractEmail(text: string) {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function extractAddress(text: string) {
  const match = text.match(/(\d{1,6}\s+[A-Za-z0-9.'#\-/ ]+?),?\s+([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);
  if (!match) return null;
  return {
    line1: normalizeText(match[1]),
    city: normalizeText(match[2]),
    region: match[3],
    postalCode: match[4],
    country: "US",
    raw: normalizeText(match[0]),
  };
}

function extractBusinessNameFromJsonLd(jsonLd: unknown[]) {
  for (const node of jsonLd) {
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    const nodes = Array.isArray(record["@graph"]) ? (record["@graph"] as unknown[]) : [record];
    for (const entry of nodes) {
      if (!entry || typeof entry !== "object") continue;
      const value = entry as Record<string, unknown>;
      const name = value.name;
      const type = value["@type"];
      const typeText = Array.isArray(type) ? type.join(" ") : String(type ?? "");
      if (typeof name === "string" && /business|clinic|medical|dentist|local|spa|beauty/i.test(typeText)) {
        return name;
      }
    }
  }
  return null;
}

function businessNameFromPage(page: PipelinePage) {
  const jsonName = extractBusinessNameFromJsonLd(page.jsonLd ?? []);
  if (jsonName) return normalizeText(jsonName);
  if (page.title) {
    return normalizeText(page.title.split("|")[0]?.split(" - ")[0] ?? "");
  }
  const h1 = page.html?.match(/<h1[^>]*>(.*?)<\/h1>/i)?.[1];
  return h1 ? normalizeText(h1.replace(/<[^>]+>/g, " ")) : null;
}

export function normalizeExtractionPageText(text: string) {
  const counts = new Map<string, number>();
  const lines = text
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);

  for (const line of lines) {
    counts.set(line.toLowerCase(), (counts.get(line.toLowerCase()) ?? 0) + 1);
  }

  return lines
    .filter((line) => !boilerplatePatterns.some((pattern) => pattern.test(line)))
    .filter((line) => !isJunkText(line))
    .filter((line) => {
      const lower = line.toLowerCase();
      const repeated = counts.get(lower) ?? 0;
      return repeated <= 3 || line.length > 35 || /\$|\d{3}/.test(line);
    })
    .join("\n");
}

export function classifyClinicPage(page: Pick<PipelinePage, "url" | "title" | "cleanedText">): {
  pageType: PageType;
  confidence: number;
  evidence: string;
} {
  const value = `${page.url} ${page.title ?? ""} ${page.cleanedText.slice(0, 400)}`.toLowerCase();
  const path = new URL(page.url).pathname.toLowerCase();

  const tests: Array<[PageType, RegExp, number, string]> = [
    ["pricing", /pricing|price|cost|fees|rates/, 0.9, "pricing keyword"],
    ["specials", /special|promotion|promo|offer|deal|discount/, 0.86, "specials keyword"],
    ["products", /products|shop|skin-health|skin health|retail/, 0.84, "product keyword"],
    ["team", /team|provider|staff|doctor|about-us|about us|meet/, 0.82, "team/about keyword"],
    ["faq", /\bfaq\b|questions|frequently asked/, 0.9, "faq keyword"],
    ["contact", /contact|location|directions|hours/, 0.88, "contact keyword"],
    ["booking", /book|appointment|schedule|reservation/, 0.82, "booking keyword"],
    ["policies", /policy|policies|cancellation|privacy|insurance|payment/, 0.78, "policy keyword"],
    ["services_index", /services|treatments|procedures/, 0.82, "services keyword"],
  ];

  for (const [pageType, pattern, confidence, evidence] of tests) {
    if (pattern.test(value)) {
      if (pageType === "services_index" && path.split("/").filter(Boolean).length > 1) {
        return { pageType: "service_detail", confidence: 0.86, evidence: "nested service path" };
      }
      return { pageType, confidence, evidence };
    }
  }

  if (path === "/" || path === "") return { pageType: "home", confidence: 0.8, evidence: "root path" };
  return { pageType: "unknown", confidence: 0.45, evidence: "no strong page signal" };
}

function parseDuration(text: string) {
  const range = text.match(/(\d{1,3})\s*(?:-|to)\s*(\d{1,3})\s*(?:minutes?|mins?|min)\b/i);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const single = text.match(/(\d{1,3})\s*(?:minutes?|mins?|min)\b/i);
  if (single) return { min: Number(single[1]), max: Number(single[1]) };
  return { min: null, max: null };
}

function durationPhrase(duration: { min: number | null; max: number | null }) {
  if (duration.min === null) return null;
  if (duration.max !== null && duration.max !== duration.min) return `${duration.min} to ${duration.max} minutes`;
  return `${duration.min} minutes`;
}

export function parseStructuredPrices(input: string): StructuredPrice[] {
  const text = normalizeText(input);
  const duration = parseDuration(text);
  const rows: StructuredPrice[] = [];
  const seen = new Set<string>();
  const addRow = (row: Omit<StructuredPrice, "currency" | "duration_min_minutes" | "duration_max_minutes" | "confidence" | "source_quote">) => {
    const key = `${row.price_type}:${row.amount_cents}:${row.amount_min_cents}:${row.amount_max_cents}:${row.raw_price_text}:${row.price_label}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      ...row,
      currency: "USD",
      duration_min_minutes: duration.min,
      duration_max_minutes: duration.max,
      confidence: 0.9,
      source_quote: shortQuote(text),
    });
  };

  for (const match of text.matchAll(/\$([0-9][0-9,]*(?:\.\d{2})?)\s*(?:-|to)\s*\$?([0-9][0-9,]*(?:\.\d{2})?)/gi)) {
    addRow({
      price_label: null,
      price_type: "range",
      amount_min_cents: centsFromAmount(match[1]),
      amount_max_cents: centsFromAmount(match[2]),
      amount_cents: null,
      unit: null,
      package_quantity: null,
      raw_price_text: match[0],
    });
  }

  for (const match of text.matchAll(/(?:series\s+of\s+(\d+)|series)\s*\$([0-9][0-9,]*(?:\.\d{2})?)/gi)) {
    addRow({
      price_label: match[1] ? `Series of ${match[1]}` : "Series",
      price_type: "series",
      amount_min_cents: null,
      amount_max_cents: null,
      amount_cents: centsFromAmount(match[2]),
      unit: "series",
      package_quantity: match[1] ? Number(match[1]) : null,
      raw_price_text: match[0],
    });
  }

  for (const match of text.matchAll(/\$([0-9][0-9,]*(?:\.\d{2})?)(\+)?(?:\s*\/\s*(unit|area|session|treatment|package|series))?/gi)) {
    const before = text.slice(Math.max(0, match.index - 24), match.index).toLowerCase();
    const raw = match[0];
    if (rows.some((row) => row.raw_price_text.includes(raw) && row.price_type !== "fixed")) continue;
    const cents = centsFromAmount(match[1]);
    const isAddOn = /\badd\s*-?\s*on\b/.test(before);
    const isConsult = /\bconsult/.test(before);
    const unit = match[3]?.toLowerCase() ?? (/\bper\s+unit\b|\bunit\b/.test(before) ? "unit" : null);

    addRow({
      price_label: isAddOn ? "Add on" : isConsult ? "Consultation" : match[2] ? "Starting at" : "Standard",
      price_type: isAddOn ? "add_on" : isConsult ? "consultation" : unit === "unit" ? "per_unit" : match[2] ? "starting_at" : "fixed",
      amount_min_cents: match[2] ? cents : null,
      amount_max_cents: null,
      amount_cents: match[2] ? null : cents,
      unit,
      package_quantity: null,
      raw_price_text: raw,
    });
  }

  return rows;
}

function looksLikeServiceHeading(line: string, pageType: PageType) {
  const text = normalizeText(line).replace(/[:|]+$/, "");
  const lower = text.toLowerCase();
  if (!text || text.length < 3 || text.length > 90) return false;
  if (isJunkText(text)) return false;
  if (neverServiceLabels.has(lower)) return false;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(lower)) return false;
  if (/^(anonymous|verified|amazing|changed my life|go to top|view all)$/i.test(text)) return false;
  if (/[@]|https?:|^\d+$|^\$/.test(lower)) return false;
  if (/^\d{1,3}\s*(?:-|to)?\s*\d{0,3}\s*(?:minutes?|mins?|min)\b/i.test(lower)) return false;
  if (lower.endsWith("?")) return false;
  if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(lower)) return false;
  if (/[.!]$/.test(text) && !medSpaSignals.some((signal) => lower.includes(signal))) return false;
  if (productSignals.some((signal) => lower.includes(signal))) return false;

  const hasServiceSignal = [...medSpaSignals, ...dentalSignals].some((signal) => lower.includes(signal));
  const titleLike = /^[A-Z0-9][A-Za-z0-9+\-/&'®.™ ]+$/.test(text) && text.split(" ").length <= 7;
  const extractionPage = ["services_index", "service_detail", "pricing"].includes(pageType);
  return hasServiceSignal || (extractionPage && titleLike && !broadCategoryLabels.has(lower));
}

function isProductLine(line: string) {
  const lower = line.toLowerCase();
  return productSignals.some((signal) => lower.includes(signal)) || /\b(serum|cleanser|cream|retinol|sunscreen)\b/i.test(line);
}

function makeAliases(name: string, websiteAliases: string[] = []) {
  const aliases = new Map<string, { alias: string; alias_type: string; confidence: number }>();
  const add = (alias: string, alias_type: string, confidence: number) => {
    const clean = normalizeText(alias);
    if (!clean || clean.toLowerCase() === name.toLowerCase()) return;
    aliases.set(clean.toLowerCase(), { alias: clean, alias_type, confidence });
  };

  for (const alias of websiteAliases) add(alias, "website", 0.9);
  add(name.replace(/\bDA\b\s*/i, ""), "generated", 0.78);

  if (/hydra\s*facial|hydrafacial/i.test(name)) {
    add("Hydra Facial", "common", 0.9);
    add("Hydrafacial", "common", 0.9);
    add("HydraFacial MD", "brand", 0.82);
    add("hydro facial", "stt_phonetic", 0.68);
  }
  if (/dysport/i.test(name)) {
    add("Disport", "stt_phonetic", 0.72);
    add("Dysport injection", "common", 0.84);
  }
  if (/pdo|thread/i.test(name)) {
    add("PDO threads", "common", 0.86);
    add("thread lift", "common", 0.86);
  }
  if (/botox/i.test(name)) add("Botox injection", "common", 0.86);
  if (/prp|prf/i.test(name)) add("PRP", "abbreviation", 0.8);

  return [...aliases.values()];
}

function mergeService(target: NormalizedService, incoming: NormalizedService) {
  target.confidence = Math.max(target.confidence, incoming.confidence);
  target.description_short ||= incoming.description_short;
  if ((incoming.description_long?.length ?? 0) > (target.description_long?.length ?? 0)) target.description_long = incoming.description_long;
  target.duration_min_minutes ??= incoming.duration_min_minutes;
  target.duration_max_minutes ??= incoming.duration_max_minutes;
  if (!target.source_url && incoming.source_url) target.source_url = incoming.source_url;
  if (!target.source_page_id && incoming.source_page_id) target.source_page_id = incoming.source_page_id;
  if (!target.source_quote && incoming.source_quote) target.source_quote = incoming.source_quote;

  const aliasKeys = new Set(target.aliases.map((alias) => alias.alias.toLowerCase()));
  for (const alias of incoming.aliases) {
    if (!aliasKeys.has(alias.alias.toLowerCase())) target.aliases.push(alias);
  }

  const priceKeys = new Set(target.prices.map((price) => `${price.price_type}:${price.raw_price_text}:${price.amount_cents}:${price.amount_min_cents}`));
  for (const price of incoming.prices) {
    const key = `${price.price_type}:${price.raw_price_text}:${price.amount_cents}:${price.amount_min_cents}`;
    if (!priceKeys.has(key)) target.prices.push(price);
  }
  target.price_available = target.prices.length > 0;
  target.starting_price_cents = lowestPrice(target.prices);
  target.price_summary = summarizePrices(target.prices);
}

function lowestPrice(prices: StructuredPrice[]) {
  const values = prices
    .flatMap((price) => [price.amount_min_cents, price.amount_cents])
    .filter((value): value is number => typeof value === "number");
  return values.length ? Math.min(...values) : null;
}

function formatMoney(cents: number | null) {
  if (cents === null) return null;
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}

function summarizePrices(prices: StructuredPrice[]) {
  if (!prices.length) return null;
  const parts = prices.slice(0, 4).map((price) => {
      const amount = formatMoney(price.amount_cents ?? price.amount_min_cents);
      if (!amount) return price.raw_price_text;
      if (price.price_type === "starting_at") return `starts at ${amount}`;
      if (price.price_type === "series") return `${price.price_label ?? "series"} is ${amount}`;
      if (price.price_type === "range") return `ranges from ${formatMoney(price.amount_min_cents)} to ${formatMoney(price.amount_max_cents)}`;
      if (price.price_type === "per_unit") return `${amount} per ${price.unit ?? "unit"}`;
      if (price.price_type === "add_on") return `add-on is ${amount}`;
      return `is ${amount}`;
    });
  return cleanSentence(`Pricing ${asSentenceList(parts)}`, 260);
}

function extractServicesFromPage(page: PipelinePage, pageType: PageType): { services: NormalizedService[]; products: NormalizedProduct[]; offers: NormalizedOffer[] } {
  if (shouldIgnorePageForExtraction(page)) return { services: [], products: [], offers: [] };
  const text = page.normalizedText ?? normalizeExtractionPageText(page.cleanedText);
  const lines = text.split(/\n+/).map(normalizeText).filter(Boolean);
  const services: NormalizedService[] = [];
  const products: NormalizedProduct[] = [];
  const offers: NormalizedOffer[] = [];
  let current: NormalizedService | null = null;

  const createService = (rawName: string, evidence: string, confidence: number) => {
    const displayName = titleCase(rawName.replace(/[:|]+$/, ""));
    const canonicalName = normalizeServiceName(displayName);
    const slug = serviceSlug(canonicalName);
    if (!slug || neverServiceLabels.has(displayName.toLowerCase()) || isJunkText(displayName)) return null;
    const duration = parseDuration(evidence);
    const prices = parseStructuredPrices(evidence);
    const service: NormalizedService = {
      id: randomUUID(),
      canonical_name: canonicalName,
      display_name: displayName,
      service_slug: slug,
      category: inferServiceCategory(canonicalName),
      subcategory: null,
      description_short: evidence.length > displayName.length ? shortQuote(evidence, 180) : null,
      description_long: evidence.length > displayName.length ? evidence : null,
      is_bookable: true,
      is_product: false,
      is_membership: /\bmembership\b/i.test(canonicalName),
      is_consultation: /\bconsult/i.test(canonicalName),
      duration_min_minutes: duration.min,
      duration_max_minutes: duration.max,
      starting_price_cents: lowestPrice(prices),
      price_summary: summarizePrices(prices),
      price_available: prices.length > 0,
      currency: "USD",
      source_url: page.url,
      source_page_id: page.id ?? null,
      source_quote: shortQuote(evidence),
      confidence,
      sort_order: null,
      synthetic_key: null,
      aliases: makeAliases(displayName, rawName === displayName ? [] : [rawName]),
      prices,
    };
    services.push(service);
    return service;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lower = line.toLowerCase();
    const nextLine = lines[index + 1] ?? "";
    const joined = [line, nextLine].filter(Boolean).join(" ");

    if (isProductLine(line) && pageType === "products" && !isJunkText(line)) {
      const prices = parseStructuredPrices(line);
      products.push({
        id: randomUUID(),
        product_name: titleCase(line.replace(/\$.*/, "")),
        brand: /zo/i.test(line) ? "ZO Skin Health" : null,
        category: "Skin care",
        description: shortQuote(line),
        price_cents: prices[0]?.amount_cents ?? prices[0]?.amount_min_cents ?? null,
        raw_price_text: prices[0]?.raw_price_text ?? null,
        source_url: page.url,
        source_page_id: page.id ?? null,
        confidence: 0.78,
      });
      continue;
    }

    if (["specials", "pricing", "service_detail"].includes(pageType) && /\b(special|promo|promotion|discount|save|july|august|september|october|november|december|january|february|march|april|may|june)\b/i.test(line) && !isJunkText(line)) {
      const prices = parseStructuredPrices(line);
      offers.push({
        id: randomUUID(),
        title: shortQuote(line.replace(/\$.*/, ""), 120),
        description: prices.length ? line : nextLine || null,
        offer_type: /discount|save/i.test(line) ? "discount" : /january|february|march|april|may|june|july|august|september|october|november|december/i.test(line) ? "seasonal" : "special",
        related_service_id: null,
        price_cents: prices[0]?.amount_cents ?? prices[0]?.amount_min_cents ?? null,
        discount_text: /\b(\d+%\s*off|save\s+\$?\d+)/i.exec(line)?.[1] ?? null,
        valid_from: null,
        valid_until: null,
        raw_text: line,
        metadata: { maybe_stale: /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(line) && !/\b20\d{2}\b/.test(line) },
        source_url: page.url,
        source_page_id: page.id ?? null,
        confidence: 0.65,
      });
      continue;
    }

    if (looksLikeServiceHeading(line, pageType)) {
      current = createService(line, joined, ["service_detail", "pricing"].includes(pageType) ? 0.88 : 0.76);
      continue;
    }

    const prices = parseStructuredPrices(line);
    const activeService: NormalizedService | null = current;
    if (prices.length && activeService) {
      for (const price of prices) activeService.prices.push(price);
      activeService.price_available = true;
      activeService.starting_price_cents = lowestPrice(activeService.prices);
      activeService.price_summary = summarizePrices(activeService.prices);
      activeService.description_long = activeService.description_long ? `${activeService.description_long} ${line}` : line;
      const duration = parseDuration(line);
      activeService.duration_min_minutes ??= duration.min;
      activeService.duration_max_minutes ??= duration.max;
      continue;
    }

    if (prices.length) {
      const serviceSignal = [...medSpaSignals, ...dentalSignals].find((signal) => lower.includes(signal));
      if (serviceSignal) {
        current = createService(titleCase(serviceSignal), line, 0.74);
      }
    }
  }

  return { services, products, offers };
}

function inferServiceCategory(name: string) {
  const lower = name.toLowerCase();
  if (/botox|dysport|filler|kybella|sculptra|pdo|thread/.test(lower)) return "Injectables";
  if (/hydra|facial|peel|dermaplan|microneedl|plasma|laser/.test(lower)) return "Skin treatments";
  if (/prp|prf|hair/.test(lower)) return "Regenerative";
  if (/cleaning|whitening|crown|implant|invisalign|root canal|veneer|denture|filling/.test(lower)) return "Dental";
  return null;
}

function serviceFromLlm(entry: LlmService, sourceUrl: string | null): NormalizedService | null {
  const name = normalizeText(entry.name ?? "");
  if (!looksLikeServiceHeading(name, "service_detail")) return null;
  const description = cleanSentence(entry.description ?? name, 360);
  const priceText = normalizeText(entry.price_text ?? "");
  const durationText = normalizeText(entry.duration_text ?? "");
  const evidence = [name, description, durationText, priceText].filter(Boolean).join(" ");
  const duration = parseDuration(evidence);
  const prices = parseStructuredPrices(evidence);
  const displayName = titleCase(name);
  const canonicalName = normalizeServiceName(displayName);

  return {
    id: randomUUID(),
    canonical_name: canonicalName,
    display_name: displayName,
    service_slug: serviceSlug(canonicalName),
    category: entry.category ? titleCase(entry.category) : inferServiceCategory(canonicalName),
    subcategory: null,
    description_short: description || null,
    description_long: description || null,
    is_bookable: true,
    is_product: false,
    is_membership: /\bmembership\b/i.test(canonicalName),
    is_consultation: /\bconsult/i.test(canonicalName),
    duration_min_minutes: duration.min,
    duration_max_minutes: duration.max,
    starting_price_cents: lowestPrice(prices),
    price_summary: summarizePrices(prices),
    price_available: prices.length > 0,
    currency: "USD",
    source_url: entry.source_url ?? sourceUrl,
    source_page_id: null,
    source_quote: shortQuote(evidence),
    confidence: 0.9,
    sort_order: null,
    synthetic_key: null,
    aliases: makeAliases(displayName, entry.aliases ?? []),
    prices,
  };
}

function applyLlmExtraction(result: NormalizedExtractionResult, llm: LlmExtraction | null, context: ExtractionContext) {
  if (!llm) return result;
  const sourceUrl = result.pageUpdates[0]?.url ?? context.websiteUrl;
  const services = mergeServices([
    ...result.services,
    ...(llm.services ?? []).map((entry) => serviceFromLlm(entry, sourceUrl)).filter((service): service is NormalizedService => Boolean(service)),
  ]);
  const serviceBySlug = new Map(services.map((service) => [service.service_slug, service]));

  const faqs = [
    ...result.faqs,
    ...(llm.faqs ?? [])
      .filter((faq) => faq.question && faq.answer && !isJunkText(faq.question) && !isJunkText(faq.answer))
      .map((faq): NormalizedFaq => ({
        id: randomUUID(),
        service_id: null,
        question: faq.question!,
        answer: faq.answer!,
        category: faq.category ?? "FAQ",
        source_url: faq.source_url ?? sourceUrl,
        source_page_id: null,
        confidence: 0.84,
        is_medical_disclaimer_needed: /side effects|risks|medical|treatment/i.test(`${faq.question} ${faq.answer}`),
      })),
  ];

  const staff = [
    ...result.staff,
    ...(llm.staff ?? [])
      .filter((person) => person.full_name && !staffRejectPatterns.some((pattern) => pattern.test(`${person.full_name} ${person.role_title ?? ""}`)))
      .map((person): NormalizedStaff => ({
        id: randomUUID(),
        full_name: person.full_name!,
        role_title: person.role_title ?? null,
        bio_short: person.bio ?? person.role_title ?? null,
        credentials: /\b(MD|DO|NP|PA|RN|DDS|DMD|APRN|FNP-C)\b/.exec(`${person.full_name} ${person.role_title ?? ""}`)?.[1] ?? null,
        specialties: null,
        source_url: person.source_url ?? sourceUrl,
        source_page_id: null,
        confidence: 0.86,
      })),
  ];

  const offers = [
    ...result.offers,
    ...(llm.offers ?? [])
      .filter((offer) => offer.title && !isJunkText(offer.title))
      .map((offer): NormalizedOffer => {
        const prices = parseStructuredPrices(`${offer.title} ${offer.description ?? ""} ${offer.price_text ?? ""}`);
        return {
          id: randomUUID(),
          title: offer.title!,
          description: offer.description ?? null,
          offer_type: /discount|off|save/i.test(`${offer.discount_text ?? ""} ${offer.description ?? ""}`) ? "discount" : "special",
          related_service_id: null,
          price_cents: prices[0]?.amount_cents ?? prices[0]?.amount_min_cents ?? null,
          discount_text: offer.discount_text ?? /\b(\d+%\s*off|save\s+\$?\d+)/i.exec(`${offer.title} ${offer.description ?? ""}`)?.[1] ?? null,
          valid_from: null,
          valid_until: null,
          raw_text: cleanSentence([offer.title, offer.description, offer.price_text].filter(Boolean).join(" "), 360),
          metadata: {},
          source_url: offer.source_url ?? sourceUrl,
          source_page_id: null,
          confidence: 0.78,
        };
      }),
  ];

  const businessName = llm.business_name && !isJunkText(llm.business_name) ? llm.business_name : result.snapshot.clinic.name;
  const voiceAnswers = buildVoiceAnswers({ businessName, facts: result.facts, locations: result.locations, hours: result.hours, services, faqs });
  const knowledgeChunks = buildKnowledgeChunks({ facts: result.facts, services, faqs, offers, staff, products: result.products, hours: result.hours, locations: result.locations });
  const snapshot = buildSnapshot({ websiteUrl: context.websiteUrl, businessName, locations: result.locations, hours: result.hours, services, faqs, staff });
  snapshot.source_pages = result.snapshot.source_pages;
  const quality = evaluateProfileQuality({ businessName, facts: result.facts, locations: result.locations, hours: result.hours, services, faqs, offers, voiceAnswers, pages: result.pageUpdates.map((page) => ({
    url: page.url,
    canonicalUrl: page.url,
    title: null,
    metaDescription: null,
    cleanedText: page.normalized_text,
    normalizedText: page.normalized_text,
    html: "",
    jsonLd: [],
    links: [],
    httpStatus: 200,
    pageType: page.page_type,
  })) });

  return {
    ...result,
    modelUsed: selectExtractionModel(),
    services: services.map((service, index) => ({ ...service, sort_order: index })),
    faqs,
    offers,
    staff,
    voiceAnswers,
    knowledgeChunks,
    snapshot,
    quality,
    warnings: quality.warnings,
  };
}

function mergeServices(services: NormalizedService[]) {
  const bySlug = new Map<string, NormalizedService>();
  for (const service of services) {
    const lower = service.display_name.toLowerCase();
    if (neverServiceLabels.has(lower)) continue;
    if (broadCategoryLabels.has(lower) && services.some((entry) => entry.service_slug !== service.service_slug && entry.category === service.category)) continue;
    const existing = bySlug.get(service.service_slug);
    if (existing) mergeService(existing, service);
    else bySlug.set(service.service_slug, service);
  }
  return [...bySlug.values()].map((service, index) => ({ ...service, sort_order: index }));
}

function extractFaqs(pages: PipelinePage[]) {
  const faqs: NormalizedFaq[] = [];
  for (const page of pages) {
    if (shouldIgnorePageForExtraction(page)) continue;
    const text = page.normalizedText ?? normalizeExtractionPageText(page.cleanedText);
    const lines = text.split(/\n+/).map(normalizeText).filter(Boolean);
    for (let index = 0; index < lines.length - 1; index += 1) {
      const question = lines[index];
      const answer = lines[index + 1];
      if (!question.endsWith("?") || answer.endsWith("?")) continue;
      if (isJunkText(question) || isJunkText(answer)) continue;
      if (/^(book now|call now|learn more|contact us)$/i.test(answer) || answer.length < 12) continue;
      faqs.push({
        id: randomUUID(),
        service_id: null,
        question,
        answer,
        category: /insurance/i.test(question + answer) ? "Insurance" : "FAQ",
        source_url: page.url,
        source_page_id: page.id ?? null,
        confidence: page.pageType === "faq" ? 0.86 : 0.72,
        is_medical_disclaimer_needed: /side effects|risks|medical|treatment/i.test(question + answer),
      });
    }
  }
  return faqs;
}

function extractStaff(pages: PipelinePage[]) {
  const staff: NormalizedStaff[] = [];
  for (const page of pages) {
    if (shouldIgnorePageForExtraction(page) || !["team", "home", "contact"].includes(String(page.pageType ?? ""))) continue;
    const text = page.normalizedText ?? normalizeExtractionPageText(page.cleanedText);
    for (const match of text.matchAll(/\b((?:Dr\.|Nurse|NP|PA)?\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})(?:,\s*([^.\n]{2,50}))?/g)) {
      const fullName = normalizeText(match[1]);
      if (!/^Dr\.|^[A-Z][a-z]+\s+[A-Z][a-z]+/.test(fullName)) continue;
      if (neverServiceLabels.has(fullName.toLowerCase())) continue;
      if (staffRejectPatterns.some((pattern) => pattern.test(fullName))) continue;
      const role = match[2] ? normalizeText(match[2]) : /dr\./i.test(fullName) ? "Provider" : null;
      if (role && staffRejectPatterns.some((pattern) => pattern.test(role))) continue;
      if (!role && page.pageType !== "team") continue;
      staff.push({
        id: randomUUID(),
        full_name: fullName,
        role_title: role,
        bio_short: shortQuote(match[0], 180),
        credentials: /\b(MD|DO|NP|PA|RN|DDS|DMD)\b/.exec(match[0])?.[1] ?? null,
        specialties: null,
        source_url: page.url,
        source_page_id: page.id ?? null,
        confidence: page.pageType === "team" ? 0.78 : 0.58,
      });
    }
  }
  const seen = new Set<string>();
  return staff.filter((entry) => {
    const key = entry.full_name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeFactsAndLocation(pages: PipelinePage[], context: ExtractionContext) {
  const combinedText = pages.map((page) => page.normalizedText ?? normalizeExtractionPageText(page.cleanedText)).join("\n");
  const firstPage = pages[0];
  const businessName = context.businessNameHint || pages.map(businessNameFromPage).find(Boolean) || "Unknown Clinic";
  const phoneDisplay = extractPhone(combinedText);
  const email = extractEmail(combinedText);
  const address = extractAddress(combinedText);
  const facts: NormalizedFact[] = [];
  const addFact = (fact_type: string, fact_key: string, value: string | null, normalized: string | null, confidence: number, method: ExtractionMethod, sourceUrl?: string | null, quote?: string | null) => {
    if (!value) return;
    facts.push({
      id: randomUUID(),
      fact_type,
      fact_key,
      fact_value: value,
      normalized_value: normalized,
      confidence,
      source_url: sourceUrl ?? firstPage?.url ?? context.websiteUrl,
      source_page_id: firstPage?.id ?? null,
      source_quote: quote ? shortQuote(quote) : null,
      extraction_method: method,
    });
  };

  addFact("business_name", "name", businessName, businessName.toLowerCase(), businessName === "Unknown Clinic" ? 0.3 : 0.82, "deterministic", firstPage?.url, businessName);
  addFact("website", "primary", context.websiteUrl, context.websiteUrl, 0.95, "deterministic", context.websiteUrl, context.websiteUrl);
  addFact("phone", "primary", phoneDisplay, phoneDisplay ? normalizedPhone(phoneDisplay) : null, 0.88, "deterministic", firstPage?.url, phoneDisplay);
  addFact("email", "primary", email, email, 0.88, "deterministic", firstPage?.url, email);
  if (address) {
    addFact("address", "primary", address.raw, address.raw.toLowerCase(), 0.84, "deterministic", firstPage?.url, address.raw);
    addFact("city", "primary", address.city, address.city.toLowerCase(), 0.84, "deterministic", firstPage?.url, address.raw);
    addFact("state", "primary", address.region, address.region, 0.84, "deterministic", firstPage?.url, address.raw);
    addFact("postal_code", "primary", address.postalCode, address.postalCode, 0.84, "deterministic", firstPage?.url, address.raw);
    addFact("country", "primary", address.country, address.country, 0.8, "deterministic", firstPage?.url, address.raw);
  }

  const locations: NormalizedLocation[] = address || phoneDisplay || email ? [{
    id: randomUUID(),
    location_name: businessName,
    address_line1: address?.line1 ?? null,
    address_line2: null,
    city: address?.city ?? null,
    region: address?.region ?? null,
    postal_code: address?.postalCode ?? null,
    country: address?.country ?? null,
    phone_e164: phoneDisplay ? normalizedPhone(phoneDisplay) : null,
    phone_display: phoneDisplay,
    email,
    timezone: context.timezone ?? "America/New_York",
    source_url: firstPage?.url ?? context.websiteUrl,
    confidence: address ? 0.84 : 0.72,
  }] : [];

  return { facts, locations, businessName, phoneDisplay, email, address };
}

function extractHours(pages: PipelinePage[], context: ExtractionContext) {
  const combinedText = pages.map((page) => page.normalizedText ?? normalizeExtractionPageText(page.cleanedText)).join("\n");
  const parsed = parseHours(combinedText);
  const hasOpen = weekdayOrder.some((day) => parsed[day].open);
  if (!hasOpen) return [];

  return weekdayOrder.map((day, index): NormalizedHour => ({
    id: randomUUID(),
    day_of_week: index,
    opens_at: parsed[day].start,
    closes_at: parsed[day].end,
    is_closed: !parsed[day].open,
    by_appointment_only: false,
    raw_text: day,
    timezone: context.timezone ?? "America/New_York",
    source_url: pages.find((page) => new RegExp(day, "i").test(page.cleanedText))?.url ?? pages[0]?.url ?? context.websiteUrl,
    confidence: parsed[day].open ? 0.82 : 0.7,
  }));
}

function buildVoiceAnswers(input: {
  businessName: string;
  facts: NormalizedFact[];
  locations: NormalizedLocation[];
  hours: NormalizedHour[];
  services: NormalizedService[];
  faqs: NormalizedFaq[];
}) {
  const answers: VoiceAnswer[] = [];
  const sourceUrls = (values: Array<string | null | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))];
  const add = (answer_type: string, answer_text: string, confidence: number, service_id: string | null = null, urls: string[] | null = null) => {
    const spoken = cleanSentence(answer_text, 450);
    if (!spoken || /Source:/i.test(spoken)) return;
    answers.push({
      id: randomUUID(),
      answer_type,
      service_id,
      question_pattern: null,
      answer_text: spoken,
      source_urls: urls,
      confidence,
      max_age_days: answer_type.includes("price") ? 30 : null,
    });
  };

  if (input.services.length) {
    const grouped = asSentenceList(input.services.slice(0, 14).map((service) => service.display_name));
    add("services_list", `${input.businessName} offers ${grouped}.`, 0.9, null, sourceUrls(input.services.map((service) => service.source_url)));
  }

  const openHours = input.hours.filter((hour) => !hour.is_closed && hour.opens_at && hour.closes_at);
  if (openHours.length) {
    const summary = openHours
      .map((hour) => `${weekdayOrder[hour.day_of_week]} from ${hour.opens_at} to ${hour.closes_at}`)
      .join(", ");
    add("hours", `${input.businessName} is open ${summary}.`, 0.84, null, sourceUrls(openHours.map((hour) => hour.source_url)));
  }

  const location = input.locations[0];
  if (location?.address_line1) {
    add("address", `${input.businessName} is at ${[location.address_line1, location.city, location.region, location.postal_code].filter(Boolean).join(", ")}.`, 0.84, null, location.source_url ? [location.source_url] : null);
  }
  if (location?.phone_display) {
    add("phone", `The listed phone number is ${location.phone_display}.`, 0.86, null, location.source_url ? [location.source_url] : null);
  }

  const pricedServices = input.services.filter((service) => service.price_available);
  if (pricedServices.length) {
    add(
      "pricing_summary",
      `Published pricing includes ${pricedServices.slice(0, 8).map((service) => `${service.display_name}: ${service.price_summary}`).join(" ")}`,
      0.86,
      null,
      sourceUrls(pricedServices.map((service) => service.source_url)),
    );
  }

  for (const service of input.services) {
    if (service.description_short) {
      add("service_description", `${service.display_name}: ${service.description_short}`, service.confidence, service.id, service.source_url ? [service.source_url] : null);
    }
    if (service.price_available) {
      add("service_price", `For ${service.display_name}, ${service.price_summary}`, 0.88, service.id, service.source_url ? [service.source_url] : null);
    }
  }

  add("fallback", "I do not have that detail in the extracted clinic information, but the office can confirm it.", 0.7, null, null);
  return answers;
}

function buildKnowledgeChunks(input: {
  facts: NormalizedFact[];
  services: NormalizedService[];
  faqs: NormalizedFaq[];
  offers: NormalizedOffer[];
  staff: NormalizedStaff[];
  products: NormalizedProduct[];
  hours: NormalizedHour[];
  locations: NormalizedLocation[];
}) {
  const chunks: KnowledgeChunk[] = [];
  const add = (entry: Omit<KnowledgeChunk, "id" | "content_hash">) => {
    chunks.push({
      ...entry,
      id: randomUUID(),
      content_hash: contentHash(`${entry.subtype}:${entry.topic}:${entry.chunk_text}:${entry.source_url ?? ""}`),
    });
  };

  for (const service of input.services) {
    add({
      service_id: service.id,
      subtype: "service_overview",
      topic: service.display_name,
      chunk_text: [service.display_name, service.description_long ?? service.description_short].filter(Boolean).join(": "),
      source_url: service.source_url,
      confidence: service.confidence,
      price_available: service.price_available,
      has_structured_service: true,
      metadata: { service_slug: service.service_slug, aliases: service.aliases.map((alias) => alias.alias) },
    });
    if (service.price_available) {
      add({
        service_id: service.id,
        subtype: "service_price",
        topic: `${service.display_name} pricing`,
        chunk_text: cleanSentence(`For ${service.display_name}, ${service.price_summary}`),
        source_url: service.source_url,
        confidence: 0.88,
        price_available: true,
        has_structured_service: true,
        metadata: { service_slug: service.service_slug },
      });
    }
  }

  for (const faq of input.faqs) {
    add({
      service_id: faq.service_id,
      subtype: faq.service_id ? "service_faq" : "general_faq",
      topic: faq.question,
      chunk_text: `${faq.question} ${faq.answer}`,
      source_url: faq.source_url,
      confidence: faq.confidence,
      price_available: false,
      has_structured_service: Boolean(faq.service_id),
      metadata: { category: faq.category },
    });
  }

  for (const offer of input.offers) {
    add({
      service_id: offer.related_service_id,
      subtype: "offer",
      topic: offer.title,
      chunk_text: [offer.title, offer.description, offer.discount_text].filter(Boolean).join(" "),
      source_url: offer.source_url,
      confidence: offer.confidence,
      price_available: Boolean(offer.price_cents),
      has_structured_service: Boolean(offer.related_service_id),
      metadata: offer.metadata,
    });
  }

  if (input.hours.length) {
    add({
      service_id: null,
      subtype: "clinic_hours",
      topic: "Clinic hours",
      chunk_text: input.hours.map((hour) => `${weekdayOrder[hour.day_of_week]} ${hour.is_closed ? "closed" : `from ${hour.opens_at} to ${hour.closes_at}`}`).join("; "),
      source_url: input.hours[0]?.source_url ?? null,
      confidence: 0.82,
      price_available: false,
      has_structured_service: false,
      metadata: {},
    });
  }

  for (const location of input.locations) {
    add({
      service_id: null,
      subtype: "clinic_location",
      topic: "Clinic location",
      chunk_text: [location.location_name, location.address_line1, location.city, location.region, location.postal_code, location.phone_display, location.email].filter(Boolean).join(", "),
      source_url: location.source_url,
      confidence: location.confidence,
      price_available: false,
      has_structured_service: false,
      metadata: {},
    });
  }

  return chunks.filter((chunk) => chunk.chunk_text.trim().length > 0);
}

export function evaluateProfileQuality(input: {
  businessName: string | null;
  facts: NormalizedFact[];
  locations: NormalizedLocation[];
  hours: NormalizedHour[];
  services: NormalizedService[];
  faqs: NormalizedFaq[];
  offers: NormalizedOffer[];
  voiceAnswers: VoiceAnswer[];
  pages: PipelinePage[];
}) {
  let score = 100;
  const checks: QualityCheck[] = [];
  const fail = (check_name: string, message: string, details: Record<string, unknown> = {}) => {
    checks.push({ check_name, status: "fail", score: null, message, details });
  };
  const warn = (check_name: string, points: number, message: string, details: Record<string, unknown> = {}) => {
    score -= points;
    checks.push({ check_name, status: "warn", score: points, message, details });
  };
  const pass = (check_name: string, message: string, details: Record<string, unknown> = {}) => {
    checks.push({ check_name, status: "pass", score: null, message, details });
  };

  const phone = input.facts.find((fact) => fact.fact_type === "phone");
  const address = input.facts.find((fact) => fact.fact_type === "address");
  const priceTextExists = input.pages.some((page) => /\$[0-9]/.test(page.cleanedText));
  const genericOnly = input.services.length > 0 && input.services.every((service) => broadCategoryLabels.has(service.display_name.toLowerCase()));
  const hasServicePages = input.pages.some((page) => /service|treatment|pricing|hydra|botox|filler|dental/i.test(`${page.url} ${page.title ?? ""} ${page.cleanedText.slice(0, 1000)}`));

  if (!input.businessName || input.businessName === "Unknown Clinic") fail("business_name", "Business name is missing.");
  else pass("business_name", "Business name extracted.");

  if (!phone && !input.locations.some((location) => location.email)) warn("contact_method", 15, "No phone or contact method was extracted.");
  else pass("contact_method", "Contact method extracted.");

  if (!address) warn("address", 10, "No address was extracted for this local clinic.");
  else pass("address", "Address extracted.");

  if (hasServicePages && input.services.length < 5) warn("services_count", 30, "Website appears service-rich but fewer than 5 real services were extracted.", { services: input.services.length });
  else pass("services_count", "Service count is sufficient for the scraped pages.", { services: input.services.length });

  if (!input.facts.length) fail("facts_count", "No clinic facts were extracted.");
  else pass("facts_count", "Clinic facts extracted.", { facts: input.facts.length });

  if (input.services.some((service) => !isUuid(service.id))) fail("service_uuid", "A service id is not a valid UUID.");
  else pass("service_uuid", "All service ids are UUIDs.");

  if (genericOnly) fail("generic_services", "Service list is generic taxonomy only.");
  else pass("generic_services", "Service list is not generic-only.");

  if (input.services.some((service) => !service.source_url)) warn("service_sources", 20, "Some services are missing source URLs.");
  else if (input.services.length) pass("service_sources", "Services have source URLs.");

  if (priceTextExists && !input.services.some((service) => service.price_available)) warn("prices_present_not_structured", 25, "Raw pages contain prices but no structured service prices were stored.");
  else if (!input.services.some((service) => service.price_available)) warn("prices_missing", 5, "No structured prices were extracted.");
  else pass("prices", "Structured prices extracted.");

  if (!input.hours.length) warn("hours", 8, "No hours were extracted.");
  else pass("hours", "Hours extracted.");

  if (!input.faqs.length) warn("faqs", 4, "No FAQs were extracted.");
  else pass("faqs", "FAQs extracted.");

  const requiredAnswers = new Set(["services_list", "hours", "address"]);
  const presentAnswers = new Set(input.voiceAnswers.map((answer) => answer.answer_type));
  const missingAnswers = [...requiredAnswers].filter((answer) => !presentAnswers.has(answer));
  if (missingAnswers.length) warn("voice_answers", 20, "Voice-ready answers are missing required entries.", { missing: missingAnswers });
  else pass("voice_answers", "Voice-ready answers generated.");

  if (input.offers.some((offer) => offer.metadata.maybe_stale)) warn("stale_specials", 3, "Some specials may be stale because the page has a month but no year.");

  const blockers = checks.filter((check) => check.status === "fail").map((check) => check.message);
  const warnings = checks.filter((check) => check.status === "warn").map((check) => check.message);
  const finalScore = Math.max(0, Math.round(score));
  const status = blockers.length || finalScore < 50 ? "not_demo_ready" : finalScore < 85 ? "warning" : "demo_ready";

  return {
    score: finalScore,
    status,
    isDemoReady: status === "demo_ready" || status === "warning",
    blockers,
    warnings,
    checks,
  } satisfies QualityResult;
}

function buildSnapshot(input: {
  websiteUrl: string;
  businessName: string;
  locations: NormalizedLocation[];
  hours: NormalizedHour[];
  services: NormalizedService[];
  faqs: NormalizedFaq[];
  staff: NormalizedStaff[];
}) {
  const profile = createEmptyExtractedProfile(input.websiteUrl);
  const location = input.locations[0];
  profile.clinic.name = input.businessName;
  profile.clinic.industry = input.services.some((service) => service.category && service.category !== "Dental") ? "med_spa" : "dental";
  profile.clinic.website = input.websiteUrl;
  profile.clinic.phone = location?.phone_e164 ?? location?.phone_display ?? "";
  profile.clinic.email = location?.email ?? "";
  profile.clinic.address = {
    line1: location?.address_line1 ?? "",
    line2: location?.address_line2 ?? "",
    city: location?.city ?? "",
    state: location?.region ?? "",
    zip: location?.postal_code ?? "",
    country: location?.country ?? "US",
  };
  profile.clinic.timezone = location?.timezone ?? "America/New_York";

  for (const hour of input.hours) {
    const day = weekdayOrder[hour.day_of_week];
    profile.hours[day] = {
      open: !hour.is_closed,
      start: hour.opens_at,
      end: hour.closes_at,
    };
  }

  profile.services = input.services.map((service) => ({
    name: service.display_name,
    aliases: service.aliases.map((alias) => alias.alias),
    description: service.description_short ?? service.description_long ?? "",
    duration_minutes: service.duration_min_minutes,
    price_text: service.price_summary,
    price_min_cents: service.starting_price_cents,
    bookable: service.is_bookable,
    source_url: service.source_url ?? "",
    confidence: service.confidence,
  }));
  profile.faqs = input.faqs.map((faq) => ({
    question: faq.question,
    answer: faq.answer,
    category: faq.category ?? "FAQ",
    source_url: faq.source_url ?? "",
    confidence: faq.confidence,
  }));
  profile.staff = input.staff.map((staff) => ({
    name: staff.full_name,
    role: staff.role_title ?? "",
    bio: staff.bio_short ?? "",
  }));
  profile.source_pages = [];
  return profile;
}

export function selectExtractionModel() {
  if (process.env.EXTRACTION_MODEL) return process.env.EXTRACTION_MODEL;
  return "gpt-4.1-nano";
}

function responseText(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as Record<string, unknown>).content) ? ((item as Record<string, unknown>).content as unknown[]) : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

function parseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    const match = input.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map(normalizeText).filter(Boolean) : [];
}

function normalizeLlmExtraction(value: Record<string, unknown> | null): LlmExtraction | null {
  if (!value) return null;
  const normalizeObjects = <T extends Record<string, unknown>>(items: unknown, map: (entry: Record<string, unknown>) => T | null) =>
    Array.isArray(items) ? items.map((entry) => (entry && typeof entry === "object" ? map(entry as Record<string, unknown>) : null)).filter((entry): entry is T => Boolean(entry)) : [];
  return {
    business_name: typeof value.business_name === "string" ? normalizeText(value.business_name) : undefined,
    services: normalizeObjects(value.services, (entry) => ({
      name: typeof entry.name === "string" ? normalizeText(entry.name) : undefined,
      description: typeof entry.description === "string" ? cleanSentence(entry.description, 360) : undefined,
      category: typeof entry.category === "string" ? normalizeText(entry.category) : undefined,
      price_text: typeof entry.price_text === "string" ? normalizeText(entry.price_text) : undefined,
      duration_text: typeof entry.duration_text === "string" ? normalizeText(entry.duration_text) : undefined,
      aliases: stringArray(entry.aliases),
      source_url: typeof entry.source_url === "string" ? entry.source_url : undefined,
    })),
    faqs: normalizeObjects(value.faqs, (entry) => ({
      question: typeof entry.question === "string" ? cleanSentence(entry.question, 220).replace(/\.$/, "?").replace(/\?+$/, "?") : undefined,
      answer: typeof entry.answer === "string" ? cleanSentence(entry.answer, 420) : undefined,
      category: typeof entry.category === "string" ? normalizeText(entry.category) : undefined,
      source_url: typeof entry.source_url === "string" ? entry.source_url : undefined,
    })),
    staff: normalizeObjects(value.staff, (entry) => ({
      full_name: typeof entry.full_name === "string" ? normalizeText(entry.full_name) : undefined,
      role_title: typeof entry.role_title === "string" ? normalizeText(entry.role_title) : undefined,
      bio: typeof entry.bio === "string" ? cleanSentence(entry.bio, 260) : undefined,
      source_url: typeof entry.source_url === "string" ? entry.source_url : undefined,
    })),
    offers: normalizeObjects(value.offers, (entry) => ({
      title: typeof entry.title === "string" ? cleanSentence(entry.title, 160) : undefined,
      description: typeof entry.description === "string" ? cleanSentence(entry.description, 260) : undefined,
      discount_text: typeof entry.discount_text === "string" ? normalizeText(entry.discount_text) : undefined,
      price_text: typeof entry.price_text === "string" ? normalizeText(entry.price_text) : undefined,
      source_url: typeof entry.source_url === "string" ? entry.source_url : undefined,
    })),
  };
}

function llmInputForPages(pages: PipelinePage[]) {
  return pages
    .filter((page) => !shouldIgnorePageForExtraction(page))
    .filter((page) => !["policies", "booking", "products"].includes(String(page.pageType ?? "")))
    .slice(0, 12)
    .map((page, index) => `PAGE ${index + 1}\nURL: ${page.url}\nTYPE: ${page.pageType ?? "unknown"}\nTEXT:\n${(page.normalizedText ?? page.cleanedText).slice(0, 5000)}`)
    .join("\n\n---\n\n")
    .slice(0, 45000);
}

async function extractWithOpenAI(pages: PipelinePage[], context: ExtractionContext): Promise<LlmExtraction | null> {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey || env.EXTRACTION_MODE === "free") return null;
  const input = llmInputForPages(pages);
  if (!input) return null;
  const model = selectExtractionModel();

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content:
              "Extract only real clinic facts from scraped med spa or dental website text. Ignore navigation, footer, cart, privacy, policy, article index, reviews, and error-page text. Return compact JSON only.",
          },
          {
            role: "user",
            content: `Website: ${context.websiteUrl}\nBusiness hint: ${context.businessNameHint ?? ""}\nReturn JSON with keys: business_name, services[{name,description,category,price_text,duration_text,aliases,source_url}], faqs[{question,answer,category,source_url}], staff[{full_name,role_title,bio,source_url}], offers[{title,description,discount_text,price_text,source_url}]. Pricing and answers must be complete spoken sentences. Do not include sources inside any spoken text.\n\n${input}`,
          },
        ],
        text: { format: { type: "json_object" } },
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logWarn("profile_extraction.openai_failed", { status: response.status, detail: detail.slice(0, 500), model });
      return null;
    }

    const payload = await response.json().catch(() => null);
    const text = responseText(payload);
    return normalizeLlmExtraction(parseJsonObject(text ?? ""));
  } catch (error) {
    logWarn("profile_extraction.openai_error", { error: error instanceof Error ? error.message : String(error), model });
    return null;
  }
}

export function extractNormalizedClinicProfile(pages: PipelinePage[], context: ExtractionContext): NormalizedExtractionResult {
  const extractionRunId = context.extractionRunId ?? randomUUID();
  const normalizedPages = pages.map((page) => {
    const normalized_text = normalizeExtractionPageText(page.normalizedText ?? page.cleanedText);
    const classification = classifyClinicPage({ url: page.url, title: page.title, cleanedText: normalized_text });
    return {
      ...page,
      normalizedText: normalized_text,
      pageType: classification.pageType,
      classification,
    };
  });

  const { facts, locations, businessName } = makeFactsAndLocation(normalizedPages, context);
  const hours = extractHours(normalizedPages, context);
  const extracted = normalizedPages.map((page) => extractServicesFromPage(page, page.classification.pageType));
  const services = mergeServices(extracted.flatMap((entry) => entry.services));
  const products = extracted.flatMap((entry) => entry.products);
  const offers = extracted.flatMap((entry) => entry.offers);
  const faqs = extractFaqs(normalizedPages);
  const staff = extractStaff(normalizedPages);
  const voiceAnswers = buildVoiceAnswers({ businessName, facts, locations, hours, services, faqs });
  const knowledgeChunks = buildKnowledgeChunks({ facts, services, faqs, offers, staff, products, hours, locations });
  const snapshot = buildSnapshot({ websiteUrl: context.websiteUrl, businessName, locations, hours, services, faqs, staff });
  snapshot.source_pages = [...new Set(normalizedPages.map((page) => page.url))];
  const quality = evaluateProfileQuality({ businessName, facts, locations, hours, services, faqs, offers, voiceAnswers, pages: normalizedPages });
  const warnings = [...quality.warnings];

  return {
    extractionRunId,
    modelUsed: selectExtractionModel(),
    pageUpdates: normalizedPages.map((page) => ({
      id: page.id ?? null,
      url: page.url,
      page_type: page.classification.pageType,
      confidence: page.classification.confidence,
      evidence: page.classification.evidence,
      normalized_text: page.normalizedText,
    })),
    facts,
    locations,
    hours,
    services,
    faqs,
    offers,
    staff,
    products,
    voiceAnswers,
    knowledgeChunks,
    quality,
    snapshot,
    warnings,
  };
}

function baseDbFields(input: { organizationId: string; leadId: string; leadDemoProfileId: string; extractionRunId: string; clinicId?: string | null }) {
  return {
    organization_id: input.organizationId,
    lead_id: input.leadId,
    lead_demo_profile_id: input.leadDemoProfileId,
    extraction_run_id: input.extractionRunId,
    clinic_id: input.clinicId ?? null,
  };
}

async function deactivatePreviousRows(leadDemoProfileId: string) {
  const supabase = await getAdminClient();
  const replaceTables = [
    "lead_clinic_voice_answers",
    "lead_clinic_knowledge_chunks",
    "lead_clinic_service_prices",
    "lead_clinic_service_aliases",
    "lead_clinic_offers",
    "lead_clinic_faqs",
    "lead_clinic_staff",
    "lead_clinic_products",
    "lead_clinic_hours",
    "lead_clinic_locations",
    "lead_clinic_facts",
    "lead_profile_quality_checks",
    "lead_clinic_services",
  ];
  for (const table of replaceTables) {
    const { error } = await supabase.from(table).delete().eq("lead_demo_profile_id", leadDemoProfileId);
    if (error) throw new Error(`Failed clearing ${table}: ${error.message}`);
  }
}

async function insertRows(table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return 0;
  const supabase = await getAdminClient();
  const { error } = await supabase.from(table).insert(rows);
  if (error) throw new Error(`Failed writing ${table}: ${error.message}`);
  return rows.length;
}

function uniqueRows(rows: Record<string, unknown>[], getKey: (row: Record<string, unknown>) => string) {
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];

  for (const row of rows) {
    const key = getKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  return unique;
}

function nullableKey(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim().toLowerCase();
}

export async function writeNormalizedExtraction(input: {
  result: NormalizedExtractionResult;
  organizationId: string;
  leadId: string;
  leadDemoProfileId: string;
  clinicId?: string | null;
  force?: boolean;
}) {
  const base = baseDbFields({
    organizationId: input.organizationId,
    leadId: input.leadId,
    leadDemoProfileId: input.leadDemoProfileId,
    extractionRunId: input.result.extractionRunId,
    clinicId: input.clinicId,
  });
  const supabase = await getAdminClient();

  if (input.force) await deactivatePreviousRows(input.leadDemoProfileId);

  for (const page of input.result.pageUpdates) {
    if (!page.id) continue;
    await supabase
      .from("lead_website_pages")
      .update({
        normalized_text: page.normalized_text,
        page_type: page.page_type,
        page_type_confidence: page.confidence,
        page_type_evidence: page.evidence,
        extracted_json: { pageType: page.page_type, pageTypeConfidence: page.confidence, pageTypeEvidence: page.evidence },
      })
      .eq("id", page.id);
  }

  const writeCounts: Record<string, number> = {};
  const factRows = uniqueRows(input.result.facts.map((fact) => ({ ...base, ...fact })), (row) =>
    [row.fact_type, row.fact_key, row.normalized_value ?? row.fact_value].map(nullableKey).join("|"),
  );
  const locationRows = uniqueRows(input.result.locations.map((location) => ({ ...base, ...location })), (row) =>
    [row.address_line1, row.city, row.region, row.postal_code, row.phone_e164, row.email].map(nullableKey).join("|"),
  );
  const hourRows = uniqueRows(input.result.hours.map((hour) => ({ ...base, ...hour })), (row) =>
    [row.day_of_week, row.opens_at, row.closes_at, row.raw_text].map(nullableKey).join("|"),
  );
  const serviceRows = uniqueRows(input.result.services.map((service) => {
    const row = { ...service } as Record<string, unknown>;
    delete row.aliases;
    delete row.prices;
    return { ...base, ...row };
  }), (row) => nullableKey(row.service_slug));
  const insertedServiceIds = new Set(serviceRows.map((row) => String(row.id)));
  const servicesToWrite = input.result.services.filter((service) => insertedServiceIds.has(service.id));
  const aliasRows = uniqueRows(servicesToWrite.flatMap((service) =>
    service.aliases.map((alias) => ({
      id: randomUUID(),
      organization_id: input.organizationId,
      lead_demo_profile_id: input.leadDemoProfileId,
      service_id: service.id,
      alias: alias.alias,
      alias_type: alias.alias_type,
      confidence: alias.confidence,
    })),
  ), (row) => [row.service_id, row.alias].map(nullableKey).join("|"));
  const priceRows = uniqueRows(servicesToWrite.flatMap((service) =>
    service.prices.map((price) => ({
      ...base,
      id: randomUUID(),
      service_id: service.id,
      ...price,
      source_url: service.source_url,
      source_page_id: service.source_page_id,
      source_quote: price.source_quote,
    })),
  ), (row) => [row.service_id, row.raw_price_text, row.price_type, row.price_label].map(nullableKey).join("|"));
  const offerRows = uniqueRows(input.result.offers.map((offer) => ({ ...base, ...offer })), (row) =>
    [row.title, row.offer_type, row.discount_text, row.source_url].map(nullableKey).join("|"),
  );
  const faqRows = uniqueRows(input.result.faqs.map((faq) => ({ ...base, ...faq })), (row) => nullableKey(row.question));
  const staffRows = uniqueRows(input.result.staff.map((staff) => ({ ...base, ...staff })), (row) =>
    [row.display_name, row.role, row.source_url].map(nullableKey).join("|"),
  );
  const productRows = uniqueRows(input.result.products.map((product) => ({ ...base, ...product })), (row) =>
    [row.product_name, row.brand, row.source_url].map(nullableKey).join("|"),
  );
  const voiceAnswerRows = uniqueRows(input.result.voiceAnswers.map((answer) => ({ ...base, ...answer })), (row) =>
    [row.answer_type, row.service_id].map(nullableKey).join("|"),
  );
  const knowledgeChunkRows = uniqueRows(input.result.knowledgeChunks.map((chunk) => ({ ...base, ...chunk })), (row) => nullableKey(row.content_hash));
  const qualityCheckRows = uniqueRows(input.result.quality.checks.map((check) => ({
    id: randomUUID(),
    organization_id: input.organizationId,
    lead_id: input.leadId,
    lead_demo_profile_id: input.leadDemoProfileId,
    extraction_run_id: input.result.extractionRunId,
    ...check,
  })), (row) => nullableKey(row.check_name));

  writeCounts.facts = await insertRows("lead_clinic_facts", factRows);
  writeCounts.locations = await insertRows("lead_clinic_locations", locationRows);
  writeCounts.hours = await insertRows("lead_clinic_hours", hourRows);
  writeCounts.services = await insertRows("lead_clinic_services", serviceRows);
  writeCounts.aliases = await insertRows("lead_clinic_service_aliases", aliasRows);
  writeCounts.prices = await insertRows("lead_clinic_service_prices", priceRows);
  writeCounts.offers = await insertRows("lead_clinic_offers", offerRows);
  writeCounts.faqs = await insertRows("lead_clinic_faqs", faqRows);
  writeCounts.staff = await insertRows("lead_clinic_staff", staffRows);
  writeCounts.products = await insertRows("lead_clinic_products", productRows);
  writeCounts.voiceAnswers = await insertRows("lead_clinic_voice_answers", voiceAnswerRows);
  writeCounts.knowledgeChunks = await insertRows("lead_clinic_knowledge_chunks", knowledgeChunkRows);
  writeCounts.qualityChecks = await insertRows("lead_profile_quality_checks", qualityCheckRows);

  return writeCounts;
}

function dbPageToPipelinePage(row: Record<string, unknown>): PipelinePage {
  return {
    id: String(row.id),
    url: String(row.url),
    canonicalUrl: typeof row.canonical_url === "string" ? row.canonical_url : null,
    title: typeof row.title === "string" ? row.title : null,
    metaDescription: typeof row.meta_description === "string" ? row.meta_description : null,
    cleanedText: String(row.cleaned_text ?? ""),
    normalizedText: typeof row.normalized_text === "string" ? row.normalized_text : null,
    html: "",
    jsonLd: Array.isArray(row.json_ld) ? row.json_ld : [],
    links: [],
    httpStatus: typeof row.http_status === "number" ? row.http_status : null,
    pageType: typeof row.page_type === "string" ? row.page_type : "unknown",
  };
}

export async function executeLeadProfileExtraction(options: DbExtractionOptions) {
  const supabase = await getAdminClient();
  const profileResult = await supabase.from("lead_demo_profiles").select("*").eq("id", options.leadDemoProfileId).maybeSingle();
  if (profileResult.error) throw new Error(profileResult.error.message);
  if (!profileResult.data) throw new Error("Lead demo profile not found");
  const profile = profileResult.data as Record<string, unknown>;

  let scrapeJobId = options.scrapeJobId ?? null;
  if (!scrapeJobId) {
    const jobResult = await supabase
      .from("lead_website_scrape_jobs")
      .select("*")
      .eq("lead_demo_profile_id", options.leadDemoProfileId)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (jobResult.error) throw new Error(jobResult.error.message);
    scrapeJobId = String(jobResult.data?.id ?? "");
  }
  if (!scrapeJobId) throw new Error("No completed scrape job found for profile");

  if (!options.force) {
    const existingRun = await supabase
      .from("lead_profile_extraction_runs")
      .select("*")
      .eq("lead_demo_profile_id", options.leadDemoProfileId)
      .eq("scrape_job_id", scrapeJobId)
      .eq("extractor_version", PROFILE_EXTRACTOR_VERSION)
      .in("status", ["completed", "completed_with_warnings"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingRun.error) throw new Error(existingRun.error.message);
    if (existingRun.data && !options.dryRun) {
      return { skipped: true, extractionRunId: String(existingRun.data.id), summary: existingRun.data.stats };
    }
  }

  const pagesResult = await supabase
    .from("lead_website_pages")
    .select("*")
    .eq("scrape_job_id", scrapeJobId)
    .order("scraped_at", { ascending: true });
  if (pagesResult.error) throw new Error(pagesResult.error.message);
  const pages = (pagesResult.data ?? []).map((row) => dbPageToPipelinePage(row as Record<string, unknown>));
  if (!pages.length) throw new Error("No scraped pages found for extraction");

  const extractionRunId = randomUUID();
  if (!options.dryRun) {
    const { error } = await supabase.from("lead_profile_extraction_runs").insert({
      id: extractionRunId,
      organization_id: profile.organization_id,
      lead_id: profile.lead_id,
      lead_demo_profile_id: options.leadDemoProfileId,
      scrape_job_id: scrapeJobId,
      root_url: profile.source_website_url,
      status: "running",
      extractor_version: PROFILE_EXTRACTOR_VERSION,
      model_used: selectExtractionModel(),
      started_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
  }

  const extractionContext = {
    extractionRunId,
    leadDemoProfileId: options.leadDemoProfileId,
    clinicId: typeof profile.clinic_id === "string" ? profile.clinic_id : null,
    websiteUrl: String(profile.source_website_url),
    businessNameHint: typeof profile.business_name === "string" ? profile.business_name : null,
  };
  const deterministicResult = extractNormalizedClinicProfile(pages, extractionContext);
  const llmExtraction = await extractWithOpenAI(
    deterministicResult.pageUpdates.map((pageUpdate) => ({
      url: pageUpdate.url,
      canonicalUrl: pageUpdate.url,
      title: null,
      metaDescription: null,
      cleanedText: pageUpdate.normalized_text,
      normalizedText: pageUpdate.normalized_text,
      html: "",
      jsonLd: [],
      links: [],
      httpStatus: 200,
      pageType: pageUpdate.page_type,
    })),
    extractionContext,
  );
  const result = applyLlmExtraction(deterministicResult, llmExtraction, extractionContext);

  const stats = {
    pagesProcessed: pages.length,
    servicesExtracted: result.services.length,
    pricesExtracted: result.services.reduce((sum, service) => sum + service.prices.length, 0),
    factsExtracted: result.facts.length,
    faqsExtracted: result.faqs.length,
    offersExtracted: result.offers.length,
    voiceAnswersGenerated: result.voiceAnswers.length,
    qualityScore: result.quality.score,
    qualityStatus: result.quality.status,
  };

  logInfo("profile_extraction.complete", {
    extraction_run_id: extractionRunId,
    lead_demo_profile_id: options.leadDemoProfileId,
    scrape_job_id: scrapeJobId,
    model_used: result.modelUsed,
    extracted_services_count: result.services.length,
    extracted_prices_count: stats.pricesExtracted,
    rejected_item_count: 0,
    validation_status: result.quality.status,
    quality_score: result.quality.score,
  });

  if (options.dryRun) {
    return { skipped: false, dryRun: true, extractionRunId, result, summary: stats };
  }

  try {
    const writeCounts = await writeNormalizedExtraction({
      result,
      organizationId: String(profile.organization_id),
      leadId: String(profile.lead_id),
      leadDemoProfileId: options.leadDemoProfileId,
      clinicId: typeof profile.clinic_id === "string" ? profile.clinic_id : null,
      force: true,
    });

    await supabase.from("lead_profile_extraction_runs").update({
      status: result.quality.isDemoReady ? "completed" : "completed_with_warnings",
      completed_at: new Date().toISOString(),
      warnings: result.warnings,
      stats: { ...stats, writeCounts },
    }).eq("id", extractionRunId);

    await supabase.from("lead_demo_profiles").update({
      business_name: result.snapshot.clinic.name,
      status: result.quality.isDemoReady ? "ready" : "needs_review",
      extraction_confidence: Number((result.quality.score / 100).toFixed(2)),
      extraction_status: "completed",
      extraction_run_id: extractionRunId,
      extraction_quality_score: result.quality.score,
      extraction_quality_status: result.quality.status,
      is_demo_ready: result.quality.isDemoReady,
      demo_ready_blockers: result.quality.blockers,
      extracted_profile_json: result.snapshot,
      last_scraped_at: new Date().toISOString(),
    }).eq("id", options.leadDemoProfileId);

    return { skipped: false, dryRun: false, extractionRunId, result, summary: { ...stats, writeCounts } };
  } catch (error) {
    await supabase.from("lead_profile_extraction_runs").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }).eq("id", extractionRunId);
    throw error;
  }
}

export async function loadRuntimeProfileFromNormalized(leadDemoProfileId: string) {
  const supabase = await getAdminClient();
  const [profileResult, locationResult, hourResult, serviceResult, aliasResult, priceResult, faqResult, staffResult] = await Promise.all([
    supabase.from("lead_demo_profiles").select("*").eq("id", leadDemoProfileId).maybeSingle(),
    supabase.from("lead_clinic_locations").select("*").eq("lead_demo_profile_id", leadDemoProfileId).order("created_at", { ascending: false }).limit(1),
    supabase.from("lead_clinic_hours").select("*").eq("lead_demo_profile_id", leadDemoProfileId).order("day_of_week", { ascending: true }),
    supabase.from("lead_clinic_services").select("*").eq("lead_demo_profile_id", leadDemoProfileId).eq("is_active", true).order("sort_order", { ascending: true }),
    supabase.from("lead_clinic_service_aliases").select("*").eq("lead_demo_profile_id", leadDemoProfileId),
    supabase.from("lead_clinic_service_prices").select("*").eq("lead_demo_profile_id", leadDemoProfileId).eq("is_active", true),
    supabase.from("lead_clinic_faqs").select("*").eq("lead_demo_profile_id", leadDemoProfileId).eq("is_active", true),
    supabase.from("lead_clinic_staff").select("*").eq("lead_demo_profile_id", leadDemoProfileId),
  ]);
  for (const result of [profileResult, locationResult, hourResult, serviceResult, aliasResult, priceResult, faqResult, staffResult]) {
    if (result.error) throw new Error(result.error.message);
  }
  if (!profileResult.data || !(serviceResult.data?.length)) return null;

  const profile = createEmptyExtractedProfile(String(profileResult.data.source_website_url));
  const location = locationResult.data?.[0] as Record<string, unknown> | undefined;
  profile.clinic.name = String(profileResult.data.business_name ?? "Unknown Clinic");
  profile.clinic.website = String(profileResult.data.source_website_url ?? "");
  profile.clinic.phone = String(location?.phone_e164 ?? location?.phone_display ?? "");
  profile.clinic.email = String(location?.email ?? "");
  profile.clinic.address = {
    line1: String(location?.address_line1 ?? ""),
    line2: String(location?.address_line2 ?? ""),
    city: String(location?.city ?? ""),
    state: String(location?.region ?? ""),
    zip: String(location?.postal_code ?? ""),
    country: String(location?.country ?? "US"),
  };
  profile.clinic.timezone = String(location?.timezone ?? "America/New_York");

  for (const row of hourResult.data ?? []) {
    const hour = row as Record<string, unknown>;
    const day = weekdayOrder[Number(hour.day_of_week)];
    if (!day) continue;
    profile.hours[day] = {
      open: !hour.is_closed,
      start: typeof hour.opens_at === "string" ? hour.opens_at.slice(0, 5) : null,
      end: typeof hour.closes_at === "string" ? hour.closes_at.slice(0, 5) : null,
    };
  }

  const aliasesByService = new Map<string, string[]>();
  for (const row of aliasResult.data ?? []) {
    const alias = row as Record<string, unknown>;
    const serviceId = String(alias.service_id);
    aliasesByService.set(serviceId, [...(aliasesByService.get(serviceId) ?? []), String(alias.alias)]);
  }
  const pricesByService = new Map<string, string[]>();
  for (const row of priceResult.data ?? []) {
    const price = row as Record<string, unknown>;
    const serviceId = String(price.service_id);
    const label = price.price_type === "starting_at" ? `starting at ${formatMoney(Number(price.amount_min_cents))}` : formatMoney(Number(price.amount_cents ?? price.amount_min_cents));
    pricesByService.set(serviceId, [...(pricesByService.get(serviceId) ?? []), label ?? String(price.raw_price_text)]);
  }
  profile.services = (serviceResult.data ?? []).map((row) => {
    const service = row as Record<string, unknown>;
    const serviceId = String(service.id);
    const priceText = pricesByService.get(serviceId)?.join(", ") ?? (typeof service.price_summary === "string" ? service.price_summary : null);
    return {
      name: String(service.display_name),
      aliases: aliasesByService.get(serviceId) ?? [],
      description: String(service.description_short ?? service.description_long ?? ""),
      duration_minutes: typeof service.duration_min_minutes === "number" ? service.duration_min_minutes : null,
      price_text: priceText,
      price_min_cents: typeof service.starting_price_cents === "number" ? service.starting_price_cents : null,
      bookable: service.is_bookable !== false,
      source_url: String(service.source_url ?? ""),
      confidence: typeof service.confidence === "number" ? service.confidence : 0.75,
    };
  });
  profile.faqs = (faqResult.data ?? []).map((row) => {
    const faq = row as Record<string, unknown>;
    return {
      question: String(faq.question),
      answer: String(faq.answer),
      category: String(faq.category ?? "FAQ"),
      source_url: String(faq.source_url ?? ""),
      confidence: typeof faq.confidence === "number" ? faq.confidence : 0.75,
    };
  });
  profile.staff = (staffResult.data ?? []).map((row) => {
    const staff = row as Record<string, unknown>;
    return {
      name: String(staff.full_name),
      role: String(staff.role_title ?? ""),
      bio: String(staff.bio_short ?? ""),
    };
  });

  return profile;
}

export function printExtractionSummary(summary: Record<string, unknown>) {
  return [
    `pages processed: ${summary.pagesProcessed ?? 0}`,
    `services extracted: ${summary.servicesExtracted ?? 0}`,
    `prices extracted: ${summary.pricesExtracted ?? 0}`,
    `facts extracted: ${summary.factsExtracted ?? 0}`,
    `FAQs extracted: ${summary.faqsExtracted ?? 0}`,
    `offers extracted: ${summary.offersExtracted ?? 0}`,
    `voice answers generated: ${summary.voiceAnswersGenerated ?? 0}`,
    `quality score: ${summary.qualityScore ?? "unknown"}`,
    `quality status: ${summary.qualityStatus ?? "unknown"}`,
  ].join("\n");
}

export function stableSyntheticKey(input: string) {
  return `synthetic:${createHash("sha1").update(input).digest("hex").slice(0, 16)}`;
}

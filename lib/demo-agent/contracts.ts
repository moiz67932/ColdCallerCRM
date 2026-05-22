import { z } from "zod";

export const PUBLIC_DEMO_AGENT_ID = "agent-87112821-4661-4dd9-a22e-ba57b48feb17";
export const DEFAULT_DEMO_AGENT_DB_ID = "87112821-4661-4dd9-a22e-ba57b48feb17";

export const weekdayOrder = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const dayHoursSchema = z.object({
  open: z.boolean(),
  start: z.string().nullable(),
  end: z.string().nullable(),
});

export const extractedProfileSchema = z.object({
  clinic: z.object({
    name: z.string().default(""),
    industry: z.string().default("dental"),
    website: z.string().default(""),
    phone: z.string().default(""),
    email: z.string().default(""),
    timezone: z.string().default("America/New_York"),
    address: z.object({
      line1: z.string().default(""),
      line2: z.string().default(""),
      city: z.string().default(""),
      state: z.string().default(""),
      zip: z.string().default(""),
      country: z.string().default("US"),
    }),
  }),
  hours: z.object({
    monday: dayHoursSchema,
    tuesday: dayHoursSchema,
    wednesday: dayHoursSchema,
    thursday: dayHoursSchema,
    friday: dayHoursSchema,
    saturday: dayHoursSchema,
    sunday: dayHoursSchema,
  }),
  services: z.array(
    z.object({
      name: z.string(),
      aliases: z.array(z.string()).default([]),
      category: z.string().nullable().optional().default(null),
      subcategory: z.string().nullable().optional().default(null),
      voice_label: z.string().nullable().optional().default(null),
      voice_category: z.string().nullable().optional().default(null),
      description: z.string().default(""),
      duration_minutes: z.number().int().nullable(),
      price_text: z.string().nullable(),
      price_min_cents: z.number().int().nullable(),
      price_summary: z.string().nullable().optional().default(null),
      price_available: z.boolean().optional().default(false),
      price_details: z.array(z.record(z.string(), z.unknown())).optional().default([]),
      bookable: z.boolean().default(true),
      source_url: z.string().default(""),
      source_quote: z.string().nullable().optional().default(null),
      extraction_method: z.string().nullable().optional().default(null),
      service_kind: z.enum(["service", "category", "add_on", "package", "membership", "consultation", "product", "staff", "navigation", "unknown"]).optional().default("service"),
      rejected: z.boolean().optional().default(false),
      rejection_reason: z.string().nullable().optional().default(null),
      confidence: z.number().min(0).max(1).default(0),
    }),
  ),
  faqs: z.array(
    z.object({
      question: z.string(),
      answer: z.string(),
      category: z.string().default("FAQ"),
      source_url: z.string().default(""),
      confidence: z.number().min(0).max(1).default(0),
    }),
  ),
  policies: z.array(
    z.object({
      title: z.string(),
      body: z.string(),
      source_url: z.string().default(""),
    }),
  ),
  payments: z.array(z.string()),
  insurance: z.array(z.string()),
  staff: z.array(
    z.object({
      name: z.string(),
      role: z.string().default(""),
      bio: z.string().default(""),
    }),
  ),
  source_pages: z.array(z.string()),
});

export type ExtractedProfile = z.infer<typeof extractedProfileSchema>;

export type ScrapedLink = {
  href: string;
  text: string;
  ariaLabel: string | null;
  title: string | null;
};

export type ScrapedStructuredBlock = {
  kind:
    | "heading_section"
    | "service_card"
    | "pricing_table_row"
    | "booking_service_card"
    | "faq_pair"
    | "contact_block"
    | "hours_block"
    | "staff_card"
    | "offer_card"
    | "navigation_link"
    | "jsonld_node";
  type?: string;
  heading: string | null;
  text: string;
  price_text?: string | null;
  duration_text?: string | null;
  link_text?: string | null;
  href?: string | null;
  aria_label?: string | null;
  source_url?: string | null;
  dom_hint?: string | null;
  confidence?: number;
  items?: Array<Record<string, unknown>>;
  source?: string | null;
};

export type ScrapedPage = {
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  metaDescription: string | null;
  cleanedText: string;
  html: string;
  jsonLd: unknown[];
  links: ScrapedLink[];
  linkHints?: ScrapedLink[];
  structuredBlocks?: ScrapedStructuredBlock[];
  jsonLdSummary?: Record<string, unknown>;
  httpStatus: number | null;
  pageType: string;
};

export type LeadDemoSummary = {
  businessName: string | null;
  servicesCount: number;
  faqsCount: number;
  hasHours: boolean;
  hasPricing: boolean;
};

export function createEmptyExtractedProfile(website: string): ExtractedProfile {
  const closedDay = { open: false, start: null, end: null };

  return extractedProfileSchema.parse({
    clinic: {
      website,
      address: {
        line1: "",
        line2: "",
        city: "",
        state: "",
        zip: "",
        country: "US",
      },
    },
    hours: {
      monday: closedDay,
      tuesday: closedDay,
      wednesday: closedDay,
      thursday: closedDay,
      friday: closedDay,
      saturday: closedDay,
      sunday: closedDay,
    },
    services: [],
    faqs: [],
    policies: [],
    payments: [],
    insurance: [],
    staff: [],
    source_pages: [],
  });
}

import { z } from "zod";

import { extractedProfileSchema, type ExtractedProfile } from "@/lib/demo-agent/contracts";
import { normalizePhoneNumber } from "@/lib/phone";
import { prisma } from "@/lib/workstation-db";
import { PORTIVE_SERVICES } from "@/lib/elevenlabs/shared-demo-context";

type MatchDb = typeof prisma;
type ExtractedService = ExtractedProfile["services"][number];

export const matchServiceRequestSchema = z.object({
  lead_demo_profile_id: z.string().optional(),
  lead_id: z.string().optional(),
  binding_id: z.string().optional(),
  conversation_id: z.string().optional(),
  caller_number: z.string().optional(),
  called_number: z.string().optional(),
  spoken_service: z.string().trim().min(1),
});

export type MatchServiceRequest = z.infer<typeof matchServiceRequestSchema>;

export class MatchServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MatchServiceError";
  }
}

type MatchServiceDeps = {
  db?: MatchDb;
};

type Candidate = {
  name: string;
  aliases: string[];
  normalized_name: string;
  normalized_aliases: string[];
  confidence: number;
  duration_minutes: number | null;
  price_text: string | null;
  bookable: boolean;
  score: number;
  match_type: "exact" | "alias" | "fuzzy";
};

const fillerWords = new Set([
  "a",
  "an",
  "and",
  "appointment",
  "book",
  "for",
  "get",
  "i",
  "like",
  "need",
  "please",
  "schedule",
  "service",
  "the",
  "to",
  "want",
  "would",
]);

export function normalizeServiceText(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part && !fillerWords.has(part))
    .join(" ")
    .trim();
}

function compact(input: string) {
  return input.replace(/\s+/g, "");
}

function consonants(input: string) {
  return compact(input).replace(/[aeiou]/g, "");
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}

function sequenceSimilarity(a: string, b: string) {
  const left = compact(a);
  const right = compact(b);
  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) return 0;
  return 1 - levenshtein(left, right) / maxLength;
}

function fuzzyScore(a: string, b: string) {
  const base = sequenceSimilarity(a, b);
  const consonantScore = sequenceSimilarity(consonants(a), consonants(b));
  return Math.max(base, consonantScore);
}

function servicePayload(service: ExtractedService, normalizedName: string, normalizedAliases: string[]) {
  return {
    name: service.name,
    aliases: service.aliases,
    normalized_name: normalizedName,
    normalized_aliases: normalizedAliases,
    duration_minutes: service.duration_minutes,
    price_text: service.price_text,
    bookable: service.bookable,
  };
}

function buildCandidates(services: ExtractedService[], spokenService: string): Candidate[] {
  const normalizedSpoken = normalizeServiceText(spokenService);

  return services
    .map((service) => {
      const normalizedName = normalizeServiceText(service.name);
      const normalizedAliases = service.aliases.map(normalizeServiceText).filter(Boolean);

      if (normalizedName === normalizedSpoken) {
        return {
          ...servicePayload(service, normalizedName, normalizedAliases),
          confidence: service.confidence,
          score: 1,
          match_type: "exact" as const,
        };
      }

      if (normalizedAliases.includes(normalizedSpoken)) {
        return {
          ...servicePayload(service, normalizedName, normalizedAliases),
          confidence: service.confidence,
          score: 1,
          match_type: "alias" as const,
        };
      }

      const variants = [normalizedName, ...normalizedAliases].filter(Boolean);
      const score = variants.reduce((best, variant) => Math.max(best, fuzzyScore(normalizedSpoken, variant)), 0);

      return {
        ...servicePayload(service, normalizedName, normalizedAliases),
        confidence: service.confidence,
        score,
        match_type: "fuzzy" as const,
      };
    })
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.name.localeCompare(b.name));
}

function portiveExtractedServices(): ExtractedService[] {
  return PORTIVE_SERVICES.map((service) => ({
    name: service.name,
    aliases: service.aliases,
    category: service.category,
    subcategory: null,
    voice_label: service.name,
    voice_category: service.category,
    description: service.summary,
    duration_minutes: Number(service.duration.match(/\d+/)?.[0] ?? 30),
    price_text: service.price,
    price_min_cents: null,
    price_summary: service.price,
    price_available: true,
    price_details: [],
    bookable: true,
    source_url: "portive-clinic://dummy-profile",
    source_quote: service.summary,
    extraction_method: "static_dummy_clinic",
    service_kind: "service",
    rejected: false,
    rejection_reason: null,
    confidence: 1,
  }));
}

async function loadProfile(input: MatchServiceRequest, db: MatchDb) {
  if (input.lead_demo_profile_id) {
    const profile = await db.leadDemoProfile.findUnique({ where: { id: input.lead_demo_profile_id } });
    if (!profile) throw new MatchServiceError("Lead demo profile not found.", 404);
    return profile;
  }

  if (input.binding_id) {
    const binding = await db.elevenlabsDemoBinding.findUnique({ where: { id: input.binding_id } });
    if (!binding) throw new MatchServiceError("ElevenLabs demo binding not found.", 404);
    const profile = await db.leadDemoProfile.findUnique({ where: { id: binding.leadDemoProfileId } });
    if (!profile) throw new MatchServiceError("Lead demo profile not found for binding.", 404);
    return profile;
  }

  if (input.lead_id) {
    const profile = await db.leadDemoProfile.findUnique({ where: { leadId: input.lead_id } });
    if (!profile) throw new MatchServiceError("Lead demo profile not found for lead.", 404);
    return profile;
  }

  if (input.caller_number && input.called_number) {
    const callerE164 = normalizePhoneNumber(input.caller_number);
    const calledE164 = normalizePhoneNumber(input.called_number);

    if (!callerE164) throw new MatchServiceError("Invalid caller_number. Expected a valid phone number.", 400);
    if (!calledE164) throw new MatchServiceError("Invalid called_number. Expected a valid phone number.", 400);

    const binding = await db.elevenlabsDemoBinding.findFirst({
      where: {
        callerE164,
        phoneE164: calledE164,
        status: "active",
      },
      orderBy: { createdAt: "desc" },
    });

    if (!binding) throw new MatchServiceError("Active ElevenLabs demo binding not found.", 404);

    const profile = await db.leadDemoProfile.findUnique({ where: { id: binding.leadDemoProfileId } });
    if (!profile) throw new MatchServiceError("Lead demo profile not found for binding.", 404);
    return profile;
  }

  throw new MatchServiceError(
    "Provide lead_demo_profile_id, binding_id, or caller_number and called_number to resolve a demo profile.",
    400,
  );
}

export async function matchElevenLabsService(input: MatchServiceRequest, deps: MatchServiceDeps = {}) {
  const db = deps.db ?? prisma;
  const hasExplicitProfileLookup = Boolean(input.lead_demo_profile_id || input.lead_id || input.binding_id);
  const services = hasExplicitProfileLookup
    ? extractedProfileSchema.parse((await loadProfile(input, db)).extractedProfileJson).services
    : portiveExtractedServices();
  const candidates = buildCandidates(services, input.spoken_service).slice(0, 5);
  const best = candidates[0] ?? null;

  if (!best) {
    return {
      ok: true,
      matched: false,
      spoken_service: input.spoken_service,
      confidence: 0,
      message: "No confident service match found.",
      candidates,
    };
  }

  if (best.match_type === "exact" || best.match_type === "alias" || best.score >= 0.82) {
    return {
      ok: true,
      matched: true,
      service_name: best.name,
      confidence: best.score,
      match_type: best.match_type,
      spoken_service: input.spoken_service,
      service: {
        name: best.name,
        aliases: best.aliases,
        duration_minutes: best.duration_minutes,
        price_text: best.price_text,
        bookable: best.bookable,
      },
      candidates,
    };
  }

  return {
    ok: true,
    matched: false,
    spoken_service: input.spoken_service,
    confidence: best.score,
    message: "No confident service match found.",
    candidates,
  };
}

import { z } from "zod";

import { extractedProfileSchema } from "@/lib/demo-agent/contracts";
import { normalizePhoneDigits } from "@/lib/phone";
import { prisma } from "@/lib/workstation-db";
import { buildVoiceContextCompact } from "@/lib/elevenlabs/voice-context";

type ServiceDetailsDb = typeof prisma;
type DemoBinding = Awaited<ReturnType<ServiceDetailsDb["elevenlabsDemoBinding"]["findMany"]>>[number];

export const getServiceDetailsRequestSchema = z.object({
  conversation_id: z.string().min(1),
  caller_number: z.string().min(1),
  called_number: z.string().min(1),
  agent_id: z.string().min(1),
  service_name: z.string().trim().min(1),
});

export type GetServiceDetailsRequest = z.infer<typeof getServiceDetailsRequestSchema>;

type ServiceDetailsDeps = {
  db?: ServiceDetailsDb;
};

function findBinding(bindings: DemoBinding[], callerDigits: string, calledDigits: string) {
  const calledNumberMatches = bindings.filter((row) => normalizePhoneDigits(row.phoneE164) === calledDigits);
  return calledNumberMatches.find((row) => normalizePhoneDigits(row.callerE164) === callerDigits) ?? calledNumberMatches[0] ?? null;
}

function phoneLookupCandidates(digits: string) {
  return [...new Set([`+${digits}`, digits])];
}

function normalizeLookup(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function serviceMatches(serviceName: string, query: string) {
  const service = normalizeLookup(serviceName);
  const needle = normalizeLookup(query);
  return service === needle || service.includes(needle) || needle.includes(service);
}

export async function getElevenLabsServiceDetails(input: GetServiceDetailsRequest, deps: ServiceDetailsDeps = {}) {
  const db = deps.db ?? prisma;
  const callerDigits = normalizePhoneDigits(input.caller_number);
  const calledDigits = normalizePhoneDigits(input.called_number);

  if (!callerDigits) throw new Error("Invalid caller_number. Expected a valid phone number.");
  if (!calledDigits) throw new Error("Invalid called_number. Expected a valid phone number.");

  const activeBindings = await db.elevenlabsDemoBinding.findMany({
    where: {
      status: "active",
      phoneE164: { in: phoneLookupCandidates(calledDigits) },
    },
    orderBy: { createdAt: "desc" },
  });
  const binding = findBinding(activeBindings, callerDigits, calledDigits);

  console.info("ElevenLabs get-service-details lookup.", {
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    caller_number: input.caller_number,
    called_number: input.called_number,
    normalized_caller_digits: callerDigits,
    normalized_called_digits: calledDigits,
    service_name: input.service_name,
    called_number_matched: Boolean(binding),
    caller_matched: Boolean(binding && normalizePhoneDigits(binding.callerE164) === callerDigits),
    binding_id: binding?.id ?? null,
  });

  if (!binding) {
    return {
      ok: false,
      status: "not_found" as const,
      resolved: false,
      reason: "no_active_demo_binding_found" as const,
      normalized_caller_digits: callerDigits,
      normalized_called_digits: calledDigits,
      caller_matched: false,
      called_number_matched: false,
    };
  }

  const profile = await db.leadDemoProfile.findUnique({
    where: { id: binding.leadDemoProfileId },
  });

  if (!profile) throw new Error("Active demo binding points to a missing lead demo profile.");

  const extractedProfile = extractedProfileSchema.parse(profile.extractedProfileJson);
  const service = extractedProfile.services.find((entry) => serviceMatches(entry.name, input.service_name));
  const compact = buildVoiceContextCompact({
    extractedProfileJson: profile.extractedProfileJson,
    leadId: binding.leadId,
    bindingId: binding.id,
    phoneE164: binding.phoneE164,
  });

  if (!service) {
    return {
      ok: false,
      status: "not_found" as const,
      resolved: false,
      reason: "service_not_found" as const,
      service_name: input.service_name,
      safe_service_names: compact.safe_service_names,
      binding_id: binding.id,
      lead_id: binding.leadId,
      lead_demo_profile_id: binding.leadDemoProfileId,
    };
  }

  const context = {
    clinic_name: compact.clinic_name,
    service_name: service.name,
    duration_minutes: service.duration_minutes,
    price_text: service.price_text,
    bookable: service.bookable,
    booking_cta: compact.booking_cta,
    safety_note: "A licensed provider can explain benefits, risks, suitability, and expected outcomes during consultation.",
  };

  return {
    ok: true,
    status: "resolved" as const,
    resolved: true,
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    lead_id: binding.leadId,
    lead_demo_profile_id: binding.leadDemoProfileId,
    binding_id: binding.id,
    context_text: `Service: ${service.name}. For clinical details, a licensed provider can explain during consultation. ${compact.booking_cta}`,
    context,
  };
}

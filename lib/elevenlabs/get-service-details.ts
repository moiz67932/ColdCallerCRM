import { z } from "zod";

import { normalizePhoneDigits } from "@/lib/phone";
import { PORTIVE_BOOKING_CTA, PORTIVE_CLINIC_NAME, PORTIVE_SERVICES } from "@/lib/elevenlabs/shared-demo-context";

export const getServiceDetailsRequestSchema = z.object({
  conversation_id: z.string().min(1),
  caller_number: z.string().min(1),
  called_number: z.string().min(1),
  agent_id: z.string().min(1),
  service_name: z.string().trim().min(1),
});

export type GetServiceDetailsRequest = z.infer<typeof getServiceDetailsRequestSchema>;

function normalizeLookup(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function serviceMatches(serviceName: string, aliases: string[], query: string) {
  const service = normalizeLookup(serviceName);
  const aliasValues = aliases.map(normalizeLookup);
  const needle = normalizeLookup(query);
  return service === needle || service.includes(needle) || needle.includes(service) || aliasValues.some((alias) => alias === needle || alias.includes(needle) || needle.includes(alias));
}

export async function getElevenLabsServiceDetails(input: GetServiceDetailsRequest) {
  const callerDigits = normalizePhoneDigits(input.caller_number);
  const calledDigits = normalizePhoneDigits(input.called_number);

  if (!callerDigits) throw new Error("Invalid caller_number. Expected a valid phone number.");
  if (!calledDigits) throw new Error("Invalid called_number. Expected a valid phone number.");

  const service = PORTIVE_SERVICES.find((entry) => serviceMatches(entry.name, entry.aliases, input.service_name));

  console.info("ElevenLabs get-service-details shared Portive context.", {
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    normalized_caller_digits: callerDigits,
    normalized_called_digits: calledDigits,
    service_name: input.service_name,
    service_found: Boolean(service),
  });

  if (!service) {
    return {
      ok: false,
      status: "not_found" as const,
      resolved: false,
      reason: "service_not_found" as const,
      service_name: input.service_name,
      clinic_name: PORTIVE_CLINIC_NAME,
      safe_service_names: PORTIVE_SERVICES.map((entry) => entry.name),
    };
  }

  const context = {
    clinic_name: PORTIVE_CLINIC_NAME,
    service_name: service.name,
    category: service.category,
    duration_text: service.duration,
    price_text: service.price,
    summary: service.summary,
    bookable: true,
    booking_cta: PORTIVE_BOOKING_CTA,
    safety_note: "A licensed provider can explain benefits, risks, suitability, and expected outcomes during consultation.",
  };

  return {
    ok: true,
    status: "resolved" as const,
    resolved: true,
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    lead_id: "",
    lead_demo_profile_id: "",
    binding_id: null,
    context_text: `Service: ${service.name}. Category: ${service.category}. Typical duration: ${service.duration}. Pricing: ${service.price}. ${service.summary} For clinical details, a licensed provider can explain during consultation. ${PORTIVE_BOOKING_CTA}`,
    context,
  };
}

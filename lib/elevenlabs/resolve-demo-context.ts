import { z } from "zod";

import { extractedProfileSchema } from "@/lib/demo-agent/contracts";
import { normalizePhoneNumber } from "@/lib/phone";
import { prisma } from "@/lib/workstation-db";

type ResolveDb = typeof prisma;

export const resolveDemoContextRequestSchema = z.object({
  conversation_id: z.string().min(1),
  caller_number: z.string().min(1),
  called_number: z.string().min(1),
  agent_id: z.string().min(1),
});

export type ResolveDemoContextRequest = z.infer<typeof resolveDemoContextRequestSchema>;

type ResolveDemoContextDeps = {
  db?: ResolveDb;
};

function buildContextText(context: {
  clinic: unknown;
  services: unknown;
  hours: unknown;
  faqs: unknown;
}) {
  return [
    "Clinic context for this active phone demo:",
    `Clinic: ${JSON.stringify(context.clinic)}`,
    `Services: ${JSON.stringify(context.services)}`,
    `Hours: ${JSON.stringify(context.hours)}`,
    `FAQs: ${JSON.stringify(context.faqs)}`,
  ].join("\n");
}

export async function resolveElevenLabsDemoContext(input: ResolveDemoContextRequest, deps: ResolveDemoContextDeps = {}) {
  const db = deps.db ?? prisma;
  const callerE164 = normalizePhoneNumber(input.caller_number);
  const calledE164 = normalizePhoneNumber(input.called_number);

  if (!callerE164) {
    throw new Error("Invalid caller_number. Expected a valid phone number.");
  }

  if (!calledE164) {
    throw new Error("Invalid called_number. Expected a valid phone number.");
  }

  const binding = await db.elevenlabsDemoBinding.findFirst({
    where: {
      callerE164,
      phoneE164: calledE164,
      status: "active",
    },
    orderBy: { createdAt: "desc" },
  });

  if (!binding) {
    return {
      ok: false,
      status: "not_found" as const,
      conversation_id: input.conversation_id,
      agent_id: input.agent_id,
      caller_e164: callerE164,
      phone_e164: calledE164,
      message: "No active demo binding found for caller and called number.",
    };
  }

  const profile = await db.leadDemoProfile.findUnique({
    where: { id: binding.leadDemoProfileId },
  });

  if (!profile) {
    throw new Error("Active demo binding points to a missing lead demo profile.");
  }

  const extractedProfile = extractedProfileSchema.parse(profile.extractedProfileJson);
  const context = {
    clinic: extractedProfile.clinic,
    services: extractedProfile.services,
    hours: extractedProfile.hours,
    faqs: extractedProfile.faqs,
  };

  return {
    ok: true,
    status: "resolved" as const,
    resolved: true,
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    caller_e164: callerE164,
    phone_e164: calledE164,
    lead_id: binding.leadId,
    lead_demo_profile_id: profile.id,
    binding_id: binding.id,
    context_text: buildContextText(context),
    context,
  };
}

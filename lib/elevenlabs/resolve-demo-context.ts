import { z } from "zod";

import { normalizePhoneDigits } from "@/lib/phone";
import { prisma } from "@/lib/workstation-db";
import { parseVoiceContextCompact, voiceContextText } from "@/lib/elevenlabs/voice-context";

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

type DemoBinding = Awaited<ReturnType<ResolveDb["elevenlabsDemoBinding"]["findMany"]>>[number];

function phoneLookupCandidates(digits: string) {
  return [...new Set([`+${digits}`, digits])];
}

export async function resolveElevenLabsDemoContext(input: ResolveDemoContextRequest, deps: ResolveDemoContextDeps = {}) {
  const db = deps.db ?? prisma;
  const callerDigits = normalizePhoneDigits(input.caller_number);
  const calledDigits = normalizePhoneDigits(input.called_number);

  if (!callerDigits) {
    throw new Error("Invalid caller_number. Expected a valid phone number.");
  }

  if (!calledDigits) {
    throw new Error("Invalid called_number. Expected a valid phone number.");
  }

  const activeBindings = await db.elevenlabsDemoBinding.findMany({
    where: {
      status: "active",
      phoneE164: { in: phoneLookupCandidates(calledDigits) },
    },
    orderBy: { createdAt: "desc" },
  });
  const calledNumberMatches = activeBindings.filter((row: DemoBinding) => normalizePhoneDigits(row.phoneE164) === calledDigits);
  const exactCallerMatch = calledNumberMatches.find((row: DemoBinding) => normalizePhoneDigits(row.callerE164) === callerDigits) ?? null;
  const fallbackMatch = exactCallerMatch ? null : calledNumberMatches[0] ?? null;
  const binding = exactCallerMatch ?? fallbackMatch;
  const callerMatched = Boolean(exactCallerMatch);
  const calledNumberMatched = calledNumberMatches.length > 0;

  console.info("ElevenLabs resolve-demo-context lookup.", {
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    caller_number: input.caller_number,
    called_number: input.called_number,
    normalized_caller_digits: callerDigits,
    normalized_called_digits: calledDigits,
    called_number_matched: calledNumberMatched,
    caller_matched: callerMatched,
    binding_id: binding?.id ?? null,
  });

  if (!binding) {
    return {
      ok: false,
      status: "not_found" as const,
      resolved: false,
      reason: "no_active_demo_binding_found" as const,
      conversation_id: input.conversation_id,
      agent_id: input.agent_id,
      normalized_caller_digits: callerDigits,
      normalized_called_digits: calledDigits,
      caller_matched: false,
      called_number_matched: false,
    };
  }

  const cachedContext = parseVoiceContextCompact(binding.voiceContextCompactJson);

  if (!cachedContext) {
    throw new Error("Active demo binding is missing voice_context_compact_json. Reactivate this demo profile.");
  }

  const context = {
    ...cachedContext,
    lead_id: binding.leadId,
    binding_id: binding.id,
    phone_e164: binding.phoneE164,
  };

  return {
    ok: true,
    status: "resolved" as const,
    resolved: true,
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    caller_e164: binding.callerE164,
    phone_e164: binding.phoneE164,
    lead_id: binding.leadId,
    lead_demo_profile_id: binding.leadDemoProfileId,
    binding_id: binding.id,
    ...(fallbackMatch
      ? {
          match_type: "called_number_fallback" as const,
          caller_matched: false,
        }
      : {}),
    context_text: voiceContextText(context),
    context,
  };
}

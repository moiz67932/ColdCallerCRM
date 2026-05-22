import { z } from "zod";

import { normalizePhoneDigits } from "@/lib/phone";
import { voiceContextText } from "@/lib/elevenlabs/voice-context";
import { getSharedDemoVoiceContext, portiveCategoryDetailsText, portiveFaqText, portivePolicyText } from "@/lib/elevenlabs/shared-demo-context";

export const resolveDemoContextRequestSchema = z.object({
  conversation_id: z.string().min(1),
  caller_number: z.string().min(1),
  called_number: z.string().min(1),
  agent_id: z.string().min(1),
});

export type ResolveDemoContextRequest = z.infer<typeof resolveDemoContextRequestSchema>;

type ResolveDemoContextDeps = {
  db?: unknown;
};

export async function resolveElevenLabsDemoContext(input: ResolveDemoContextRequest, _deps: ResolveDemoContextDeps = {}) {
  const callerDigits = normalizePhoneDigits(input.caller_number);
  const calledDigits = normalizePhoneDigits(input.called_number);

  if (!callerDigits) {
    throw new Error("Invalid caller_number. Expected a valid phone number.");
  }

  if (!calledDigits) {
    throw new Error("Invalid called_number. Expected a valid phone number.");
  }

  const context = getSharedDemoVoiceContext();

  console.info("ElevenLabs resolve-demo-context shared demo context.", {
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    caller_number: input.caller_number,
    called_number: input.called_number,
    normalized_caller_digits: callerDigits,
    normalized_called_digits: calledDigits,
    clinic_name: context.clinic_name,
  });

  return {
    ok: true,
    status: "resolved" as const,
    resolved: true,
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    caller_e164: input.caller_number,
    phone_e164: context.phone_e164 || input.called_number,
    lead_id: "",
    lead_demo_profile_id: "",
    binding_id: null,
    match_type: "shared_demo_context" as const,
    caller_matched: false,
    context_text: `${voiceContextText(context)}\nServices by category with duration and pricing: ${portiveCategoryDetailsText()}\nFAQs: ${portiveFaqText()}\nPolicies: ${portivePolicyText()}`,
    context,
  };
}

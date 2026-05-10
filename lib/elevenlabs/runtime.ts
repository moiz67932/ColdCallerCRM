import { requireEnv } from "@/lib/env";
import { logInfo, logWarn } from "@/lib/logger";
import { normalizePhoneNumber } from "@/lib/phone";
import { prisma } from "@/lib/workstation-db";

type ActivationDb = typeof prisma;

type ActivationConfig = {
  organizationId: string;
  elevenlabsAgentId: string;
  phoneE164: string;
};

type ActivationDeps = {
  db?: ActivationDb;
  config?: Partial<ActivationConfig>;
};

function getActivationConfig(overrides: Partial<ActivationConfig> = {}): ActivationConfig {
  return {
    organizationId: overrides.organizationId ?? requireEnv("DEMO_RUNTIME_ORGANIZATION_ID"),
    elevenlabsAgentId: overrides.elevenlabsAgentId ?? requireEnv("ELEVENLABS_AGENT_ID"),
    phoneE164: overrides.phoneE164 ?? requireEnv("ELEVENLABS_PHONE_E164"),
  };
}

function buildPhoneWarning(leadPhoneNumber: unknown) {
  const raw = typeof leadPhoneNumber === "string" ? leadPhoneNumber : "";
  return raw
    ? `Could not normalize lead phone number "${raw}" to E.164. Binding was activated without caller-specific routing.`
    : "Lead has no phone number. Binding was activated without caller-specific routing.";
}

export async function activateElevenLabsLeadDemoAgent(leadId: string, deps: ActivationDeps = {}) {
  const db = deps.db ?? prisma;
  const config = getActivationConfig(deps.config);

  logInfo("elevenlabs.activation_start", {
    leadId,
    elevenlabsAgentId: config.elevenlabsAgentId,
    phoneE164: config.phoneE164,
  });

  const lead = await db.lead.findUnique({
    where: { id: leadId },
  });

  if (!lead) {
    throw new Error("Lead not found");
  }

  const profile = await db.leadDemoProfile.findUnique({
    where: { leadId },
  });

  if (!profile) {
    throw new Error("This lead has not been prepared yet. Prepare the demo first from Automations.");
  }

  if (profile.status !== "ready" && profile.status !== "active") {
    const blockers = Array.isArray(profile.demoReadyBlockers) && profile.demoReadyBlockers.length
      ? ` Blockers: ${profile.demoReadyBlockers.join("; ")}`
      : "";
    throw new Error(`Lead demo profile is not ready.${blockers}`);
  }

  if (profile.isDemoReady === false) {
    const blockers = Array.isArray(profile.demoReadyBlockers) && profile.demoReadyBlockers.length
      ? profile.demoReadyBlockers.join("; ")
      : "Extraction quality gate did not pass.";
    throw new Error(`Lead demo profile is not demo ready. ${blockers}`);
  }

  const callerE164 = typeof lead.phoneNumber === "string" ? normalizePhoneNumber(lead.phoneNumber) : null;
  const warning = callerE164 ? undefined : buildPhoneWarning(lead.phoneNumber);

  if (warning) {
    logWarn("elevenlabs.activation_warning", {
      leadId,
      leadPhoneNumber: lead.phoneNumber ?? null,
      warning,
    });
  }

  await db.elevenlabsDemoBinding.updateMany({
    where: {
      leadId,
      elevenlabsAgentId: config.elevenlabsAgentId,
      phoneE164: config.phoneE164,
      status: "active",
    },
    data: {
      status: "replaced",
    },
  });

  const binding = await db.elevenlabsDemoBinding.create({
    data: {
      organizationId: config.organizationId,
      leadId,
      leadDemoProfileId: profile.id,
      elevenlabsAgentId: config.elevenlabsAgentId,
      phoneE164: config.phoneE164,
      callerE164,
      status: "active",
      metadataJson: {
        source: "crm_activate_agent",
        previous_runtime: "hetzner_livekit",
        activated_from: "lead_demo_profile",
      },
    },
  });

  await db.leadDemoProfile.update({
    where: { id: profile.id },
    data: {
      status: "active",
      lastActivatedAt: new Date(),
    },
  });

  if (profile.clinicId && profile.agentId) {
    try {
      await db.leadDemoActivation.create({
        data: {
          leadId,
          leadDemoProfileId: profile.id,
          organizationId: config.organizationId,
          clinicId: profile.clinicId,
          agentId: profile.agentId,
          phoneE164: config.phoneE164,
          previousClinicId: null,
        },
      });
    } catch (error) {
      logWarn("elevenlabs.activation_history_warning", {
        leadId,
        profileId: profile.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    logWarn("elevenlabs.activation_history_warning", {
      leadId,
      profileId: profile.id,
      reason: "Skipped lead_demo_activations insert because profile is missing clinicId or agentId.",
      hasClinicId: Boolean(profile.clinicId),
      hasAgentId: Boolean(profile.agentId),
    });
  }

  logInfo("elevenlabs.activation_complete", {
    leadId,
    profileId: profile.id,
    bindingId: binding?.id ?? null,
    elevenlabsAgentId: config.elevenlabsAgentId,
    phoneE164: config.phoneE164,
    callerE164,
  });

  return {
    ok: true,
    provider: "elevenlabs" as const,
    leadId,
    leadDemoProfileId: profile.id,
    elevenlabsAgentId: config.elevenlabsAgentId,
    phoneE164: config.phoneE164,
    callerE164,
    warning,
    message: `Activated ElevenLabs demo. Ask the lead to call back on ${config.phoneE164}.`,
  };
}

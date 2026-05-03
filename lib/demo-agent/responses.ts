import { PUBLIC_DEMO_AGENT_ID } from "@/lib/demo-agent/contracts";

export function formatActivationResult(input: {
  clinicId: string;
  leadDemoProfileId: string;
  phoneE164: string;
  agentDbId: string;
  runtimeRefresh?: {
    attempted: boolean;
    ok: boolean;
    warning: string | null;
  };
}) {
  return {
    agent_id: PUBLIC_DEMO_AGENT_ID,
    agent_db_id: input.agentDbId,
    clinic_id: input.clinicId,
    lead_demo_profile_id: input.leadDemoProfileId,
    phone_e164: input.phoneE164,
    runtime_refresh: input.runtimeRefresh ?? {
      attempted: false,
      ok: false,
      warning: null,
    },
    warning: input.runtimeRefresh?.warning ?? null,
    status: "active" as const,
  };
}

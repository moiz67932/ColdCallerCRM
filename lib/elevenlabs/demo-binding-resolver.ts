import { normalizePhoneDigits } from "@/lib/phone";
import { prisma } from "@/lib/workstation-db";

type ResolveDb = typeof prisma;
type DemoBinding = Awaited<ReturnType<ResolveDb["elevenlabsDemoBinding"]["findMany"]>>[number];

export type ActiveDemoBindingMatchType = "caller_and_called" | "called_number_fallback" | "none";

export type ActiveDemoBindingLookup = {
  binding: DemoBinding | null;
  matchType: ActiveDemoBindingMatchType;
  callerDigits: string;
  calledDigits: string;
  callerMatched: boolean;
  calledNumberMatched: boolean;
};

type ResolveActiveDemoBindingForCallInput = {
  callerNumber?: string | null;
  calledNumber?: string | null;
  agentId?: string | null;
};

type ResolveActiveDemoBindingForCallDeps = {
  db?: ResolveDb;
};

export function phoneLookupCandidates(digits: string) {
  return [...new Set([`+${digits}`, digits])];
}

function cleanAgentId(value: string | null | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bindingMatchesAgent(binding: DemoBinding, agentId: string | null) {
  if (!agentId) return true;
  const bindingAgentId = typeof binding.elevenlabsAgentId === "string" ? binding.elevenlabsAgentId.trim() : "";
  return !bindingAgentId || bindingAgentId === agentId;
}

export async function resolveActiveDemoBindingForCall(
  input: ResolveActiveDemoBindingForCallInput,
  deps: ResolveActiveDemoBindingForCallDeps = {},
): Promise<ActiveDemoBindingLookup> {
  const db = deps.db ?? prisma;
  const callerDigits = normalizePhoneDigits(input.callerNumber);
  const calledDigits = normalizePhoneDigits(input.calledNumber);
  const agentId = cleanAgentId(input.agentId);

  if (!calledDigits) {
    return {
      binding: null,
      matchType: "none",
      callerDigits,
      calledDigits,
      callerMatched: false,
      calledNumberMatched: false,
    };
  }

  const activeBindings = await db.elevenlabsDemoBinding.findMany({
    where: {
      status: "active",
      phoneE164: { in: phoneLookupCandidates(calledDigits) },
    },
    orderBy: { createdAt: "desc" },
  });

  const calledNumberMatches = activeBindings
    .filter((row: DemoBinding) => normalizePhoneDigits(row.phoneE164) === calledDigits)
    .filter((row: DemoBinding) => bindingMatchesAgent(row, agentId));
  const exactCallerMatch = callerDigits ? calledNumberMatches.find((row: DemoBinding) => normalizePhoneDigits(row.callerE164) === callerDigits) ?? null : null;
  const fallbackMatch = exactCallerMatch ? null : calledNumberMatches[0] ?? null;
  const binding = exactCallerMatch ?? fallbackMatch;

  return {
    binding,
    matchType: exactCallerMatch ? "caller_and_called" : fallbackMatch ? "called_number_fallback" : "none",
    callerDigits,
    calledDigits,
    callerMatched: Boolean(exactCallerMatch),
    calledNumberMatched: calledNumberMatches.length > 0,
  };
}

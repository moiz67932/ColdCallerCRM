type CallAttempt = {
  createdAt: Date;
  status: string;
  outcome?: string | null;
  callbackAt?: Date | null;
};

type FollowUp = {
  dueAt: Date;
  status: string;
};

type Lead = {
  createdAt: Date;
  website?: string | null;
  derivedStatus: string;
};

type LeadWithRelations = Lead & {
  callAttempts: CallAttempt[];
  followUps: FollowUp[];
};

type RankedLead = {
  lead: LeadWithRelations;
  score: number;
  callbackDueAt?: Date;
};

function getLatestCallAttempt(lead: LeadWithRelations) {
  return [...lead.callAttempts].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

function getOpenCallbackDueAt(lead: LeadWithRelations) {
  const followUp = lead.followUps
    .filter((item) => item.status === "open")
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];

  if (followUp) {
    return followUp.dueAt;
  }

  const latestAttempt = getLatestCallAttempt(lead);
  return latestAttempt?.callbackAt ?? undefined;
}

function rankLead(lead: LeadWithRelations): RankedLead {
  const now = Date.now();
  const callbackDueAt = getOpenCallbackDueAt(lead);
  const hasDueCallback = callbackDueAt ? callbackDueAt.getTime() <= now : false;
  const hasCalls = lead.callAttempts.length > 0;
  const hasPastFailedAttempts = lead.callAttempts.some(
    (attempt) => attempt.status === "failed" || attempt.outcome === "no_answer" || attempt.outcome === "voicemail",
  );

  if (hasDueCallback) {
    return { lead, score: 0, callbackDueAt };
  }

  if (!hasCalls) {
    return { lead, score: 1 };
  }

  if (!hasPastFailedAttempts) {
    return { lead, score: 2 };
  }

  return { lead, score: 3 };
}

export function sortLeadsForQueue(leads: LeadWithRelations[]) {
  return leads
    .map(rankLead)
    .sort((a, b) => {
      if (a.score !== b.score) {
        return a.score - b.score;
      }

      if (a.callbackDueAt && b.callbackDueAt) {
        return a.callbackDueAt.getTime() - b.callbackDueAt.getTime();
      }

      if (a.callbackDueAt) {
        return -1;
      }

      if (b.callbackDueAt) {
        return 1;
      }

      return a.lead.createdAt.getTime() - b.lead.createdAt.getTime();
    })
    .map((entry) => entry.lead);
}

export function getLeadTags(lead: LeadWithRelations) {
  const tags: string[] = [];

  if (!lead.website) {
    tags.push("no website");
  } else {
    tags.push("has website");
  }

  const callbackDueAt = getOpenCallbackDueAt(lead);

  if (callbackDueAt && callbackDueAt.getTime() <= Date.now()) {
    tags.push("callback due");
  }

  if (lead.derivedStatus === "bad_number") {
    tags.push("bad number");
  }

  return tags;
}

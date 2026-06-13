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
  id: string;
  createdAt: Date;
  website?: string | null;
  derivedStatus: string;
};

type LeadWithRelations = Lead & {
  callAttempts: CallAttempt[];
  followUps: FollowUp[];
};

const outcomeTagLabels: Record<string, string> = {
  answered: "answered",
  voicemail: "voicemail",
  no_answer: "no answer",
  not_interested: "not interested",
  callback: "callback",
  gatekeeper: "gatekeeper",
  bad_number: "bad number",
  interested: "interested",
  demo_requested: "demo requested",
  already_have_system: "already have system",
};

const derivedStatusTagLabels: Record<string, string> = {
  follow_up: "follow up",
  interested: "interested",
  closed_lost: "not interested",
  bad_number: "bad number",
  demo_requested: "demo requested",
};

function addTag(tags: string[], tag?: string) {
  if (tag && !tags.includes(tag)) {
    tags.push(tag);
  }
}

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

export function sortLeadsForQueue(leads: LeadWithRelations[]) {
  return [...leads].sort((a, b) => {
    const latestCallA = getLatestCallAttempt(a);
    const latestCallB = getLatestCallAttempt(b);

    if (!latestCallA && latestCallB) {
      return -1;
    }

    if (latestCallA && !latestCallB) {
      return 1;
    }

    if (latestCallA && latestCallB) {
      const callOrder = latestCallA.createdAt.getTime() - latestCallB.createdAt.getTime();

      if (callOrder !== 0) {
        return callOrder;
      }
    }

    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

export function getLeadTags(lead: LeadWithRelations) {
  const tags: string[] = [];

  if (!lead.website) {
    addTag(tags, "no website");
  } else {
    addTag(tags, "has website");
  }

  const callbackDueAt = getOpenCallbackDueAt(lead);

  if (callbackDueAt && callbackDueAt.getTime() <= Date.now()) {
    addTag(tags, "callback due");
  }

  const latestAttempt = getLatestCallAttempt(lead);
  addTag(tags, latestAttempt?.outcome ? outcomeTagLabels[latestAttempt.outcome] : undefined);
  addTag(tags, derivedStatusTagLabels[lead.derivedStatus]);

  return tags;
}

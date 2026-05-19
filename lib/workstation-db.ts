import { getSupabaseAdmin } from "@/lib/supabase-admin";
/* eslint-disable @typescript-eslint/no-explicit-any */

type SortDirection = "asc" | "desc";
type QueryOptions = {
  limit?: number;
  order?: { column: string; ascending?: boolean };
};
type SupabaseQuery = any;
/*
type SupabaseQueryShape = {
  or: (filters: string) => SupabaseQuery;
  in: (column: string, values: unknown[]) => SupabaseQuery;
  ilike: (column: string, pattern: string) => SupabaseQuery;
  gte: (column: string, value: unknown) => SupabaseQuery;
  lte: (column: string, value: unknown) => SupabaseQuery;
  eq: (column: string, value: unknown) => SupabaseQuery;
  order: (column: string, options: { ascending: boolean }) => SupabaseQuery;
  limit: (count: number) => SupabaseQuery;
  select: (columns: string) => SupabaseQuery;
};
*/

const tableNames = {
  leadList: "lead_lists",
  lead: "leads",
  callAttempt: "call_attempts",
  callRecording: "call_recordings",
  callTranscript: "workstation_call_transcripts",
  leadNote: "lead_notes",
  followUp: "follow_ups",
  smsMessage: "sms_messages",
  telnyxWebhookEvent: "workstation_telnyx_webhook_events",
  appSetting: "app_settings",
  leadDemoProfile: "lead_demo_profiles",
  leadWebsiteScrapeJob: "lead_website_scrape_jobs",
  leadWebsitePage: "lead_website_pages",
  leadDemoActivation: "lead_demo_activations",
  elevenlabsDemoBinding: "elevenlabs_demo_bindings",
  elevenlabsConversation: "elevenlabs_conversations",
  appointment: "appointments",
  appointmentType: "appointment_types",
  appointmentTypeProvider: "appointment_type_providers",
} as const;

const columnMaps: Record<keyof typeof tableNames, Record<string, string>> = {
  leadList: { sourceFileName: "source_file_name", createdAt: "created_at" },
  lead: {
    leadListId: "lead_list_id",
    businessName: "business_name",
    contactName: "contact_name",
    phoneNumber: "phone_number",
    customFieldsJson: "custom_fields_json",
    derivedStatus: "derived_status",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  callAttempt: {
    leadId: "lead_id",
    startedAt: "started_at",
    answeredAt: "answered_at",
    endedAt: "ended_at",
    durationSeconds: "duration_seconds",
    operatorNotes: "operator_notes",
    callbackAt: "callback_at",
    nextAction: "next_action",
    telnyxConnectionId: "telnyx_connection_id",
    telnyxCallSessionId: "telnyx_call_session_id",
    telnyxCallControlId: "telnyx_call_control_id",
    telnyxCallLegId: "telnyx_call_leg_id",
    telnyxAgentCallControlId: "telnyx_agent_call_control_id",
    telnyxAgentCallLegId: "telnyx_agent_call_leg_id",
    amdResult: "amd_result",
    recordingId: "recording_id",
    transcriptId: "transcript_id",
    rawSummaryJson: "raw_summary_json",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  callRecording: {
    callAttemptId: "call_attempt_id",
    telnyxRecordingId: "telnyx_recording_id",
    downloadUrl: "download_url",
    fileName: "file_name",
    durationMillis: "duration_millis",
    rawPayloadJson: "raw_payload_json",
    createdAt: "created_at",
  },
  callTranscript: {
    callAttemptId: "call_attempt_id",
    telnyxTranscriptId: "telnyx_transcript_id",
    rawPayloadJson: "raw_payload_json",
    createdAt: "created_at",
  },
  leadNote: { leadId: "lead_id", callAttemptId: "call_attempt_id", createdAt: "created_at" },
  followUp: { leadId: "lead_id", callAttemptId: "call_attempt_id", dueAt: "due_at", createdAt: "created_at", updatedAt: "updated_at" },
  smsMessage: {
    leadId: "lead_id",
    callAttemptId: "call_attempt_id",
    telnyxMessageId: "telnyx_message_id",
    fromNumber: "from_number",
    toNumber: "to_number",
    rawPayloadJson: "raw_payload_json",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  telnyxWebhookEvent: {
    eventId: "event_id",
    eventType: "event_type",
    receivedAt: "received_at",
    processedAt: "processed_at",
    callControlId: "call_control_id",
    payloadJson: "payload_json",
    signatureVerified: "signature_verified",
    processingError: "processing_error",
  },
  appSetting: { valueJson: "value_json", updatedAt: "updated_at" },
  leadDemoProfile: {
    leadId: "lead_id",
    organizationId: "organization_id",
    clinicId: "clinic_id",
    agentId: "agent_id",
    sourceWebsiteUrl: "source_website_url",
    businessName: "business_name",
    extractionConfidence: "extraction_confidence",
    extractionStatus: "extraction_status",
    extractionRunId: "extraction_run_id",
    extractionQualityScore: "extraction_quality_score",
    extractionQualityStatus: "extraction_quality_status",
    isDemoReady: "is_demo_ready",
    demoReadyBlockers: "demo_ready_blockers",
    extractedProfileJson: "extracted_profile_json",
    lastScrapedAt: "last_scraped_at",
    lastActivatedAt: "last_activated_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  leadWebsiteScrapeJob: {
    leadId: "lead_id",
    leadDemoProfileId: "lead_demo_profile_id",
    organizationId: "organization_id",
    rootUrl: "root_url",
    pagesDiscovered: "pages_discovered",
    pagesScraped: "pages_scraped",
    pagesFailed: "pages_failed",
    startedAt: "started_at",
    completedAt: "completed_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  leadWebsitePage: {
    scrapeJobId: "scrape_job_id",
    leadId: "lead_id",
    organizationId: "organization_id",
    canonicalUrl: "canonical_url",
    pageType: "page_type",
    httpStatus: "http_status",
    metaDescription: "meta_description",
    cleanedText: "cleaned_text",
    jsonLd: "json_ld",
    extractedJson: "extracted_json",
    contentHash: "content_hash",
    scrapedAt: "scraped_at",
  },
  leadDemoActivation: {
    leadId: "lead_id",
    leadDemoProfileId: "lead_demo_profile_id",
    organizationId: "organization_id",
    clinicId: "clinic_id",
    agentId: "agent_id",
    phoneE164: "phone_e164",
    activatedBy: "activated_by",
    previousClinicId: "previous_clinic_id",
    createdAt: "created_at",
  },
  elevenlabsDemoBinding: {
    organizationId: "organization_id",
    leadId: "lead_id",
    leadDemoProfileId: "lead_demo_profile_id",
    elevenlabsAgentId: "elevenlabs_agent_id",
    phoneE164: "phone_e164",
    callerE164: "caller_e164",
    activatedAt: "activated_at",
    expiresAt: "expires_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
    voiceContextCompactJson: "voice_context_compact_json",
    metadataJson: "metadata_json",
  },
  elevenlabsConversation: {
    conversationId: "conversation_id",
    organizationId: "organization_id",
    leadId: "lead_id",
    leadDemoProfileId: "lead_demo_profile_id",
    elevenlabsAgentId: "elevenlabs_agent_id",
    callerE164: "caller_e164",
    calledE164: "called_e164",
    summaryText: "summary_text",
    summaryJson: "summary_json",
    analysisJson: "analysis_json",
    metadataJson: "metadata_json",
    rawPayloadJson: "raw_payload_json",
    startedAt: "started_at",
    endedAt: "ended_at",
    receivedAt: "received_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  appointment: {
    organizationId: "organization_id",
    clinicId: "clinic_id",
    providerId: "provider_id",
    appointmentTypeId: "appointment_type_id",
    callSessionId: "call_session_id",
    patientName: "patient_name",
    patientPhoneMasked: "patient_phone_masked",
    patientEmail: "patient_email",
    startTime: "start_time",
    endTime: "end_time",
    insuranceInfo: "insurance_info",
    createdAt: "created_at",
    updatedAt: "updated_at",
    calendarProvider: "calendar_provider",
    calendarId: "calendar_id",
    calendarEventId: "calendar_event_id",
    agentId: "agent_id",
    callLogId: "call_log_id",
    callerName: "caller_name",
    callerPhone: "caller_phone",
  },
  appointmentType: {
    organizationId: "organization_id",
    clinicId: "clinic_id",
    durationMinutes: "duration_minutes",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  appointmentTypeProvider: {
    organizationId: "organization_id",
    clinicId: "clinic_id",
    appointmentTypeId: "appointment_type_id",
    providerId: "provider_id",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
};

function toColumn(model: keyof typeof tableNames, key: string) {
  return columnMaps[model][key] ?? key;
}

function toDb(model: keyof typeof tableNames, value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      toColumn(model, key),
      entry instanceof Date ? entry.toISOString() : entry,
    ]),
  );
}

function fromDb(model: keyof typeof tableNames, row: Record<string, unknown> | null) {
  if (!row) return null;
  const reverse = Object.fromEntries(Object.entries(columnMaps[model]).map(([key, column]) => [column, key]));
  const value = Object.fromEntries(Object.entries(row).map(([key, entry]) => [reverse[key] ?? key, entry]));
  for (const [key, entry] of Object.entries(value)) {
    if ((key.endsWith("At") || key === "createdAt" || key === "updatedAt") && typeof entry === "string") {
      value[key] = new Date(entry);
    }
  }
  return value;
}

function applyWhere(query: SupabaseQuery, model: keyof typeof tableNames, where?: Record<string, unknown>) {
  if (!where) return query;

  let next = query;
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === "OR" && Array.isArray(value)) {
      const filters = value
        .map((entry) => {
          const [orKey, orValue] = Object.entries(entry as Record<string, unknown>)[0] ?? [];
          return orKey && orValue !== undefined ? `${toColumn(model, orKey)}.eq.${orValue}` : "";
        })
        .filter(Boolean)
        .join(",");
      if (filters) next = next.or(filters);
      continue;
    }
    const column = toColumn(model, key);

    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      const condition = value as Record<string, unknown>;
      if (Array.isArray(condition.in)) next = next.in(column, condition.in);
      else if (condition.contains) next = next.ilike(column, `%${condition.contains}%`);
      else if (condition.gte || condition.lte) {
        if (condition.gte) next = next.gte(column, condition.gte instanceof Date ? condition.gte.toISOString() : condition.gte);
        if (condition.lte) next = next.lte(column, condition.lte instanceof Date ? condition.lte.toISOString() : condition.lte);
      } else {
        next = next.eq(column, value);
      }
    } else {
      next = next.eq(column, value instanceof Date ? value.toISOString() : value);
    }
  }
  return next;
}

async function selectMany(model: keyof typeof tableNames, where?: Record<string, unknown>, options: QueryOptions = {}) {
  const supabase = getSupabaseAdmin();
  let query = supabase.from(tableNames[model]).select("*") as unknown as SupabaseQuery;
  query = applyWhere(query, model, where);
  if (options.order) query = query.order(toColumn(model, options.order.column), { ascending: options.order.ascending ?? true });
  if (options.limit) query = query.limit(options.limit);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: unknown) => fromDb(model, row as Record<string, unknown>)).filter(Boolean) as Record<string, unknown>[];
}

async function selectOne(model: keyof typeof tableNames, where: Record<string, unknown>, options: QueryOptions = {}) {
  return (await selectMany(model, where, { ...options, limit: 1 }))[0] ?? null;
}

async function insertOne(model: keyof typeof tableNames, data: Record<string, unknown>) {
  const { data: row, error } = await getSupabaseAdmin()
    .from(tableNames[model])
    .insert(toDb(model, data))
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return fromDb(model, row as Record<string, unknown>);
}

async function updateManyRows(model: keyof typeof tableNames, where: Record<string, unknown>, data: Record<string, unknown>) {
  let query = getSupabaseAdmin().from(tableNames[model]).update(toDb(model, data)) as unknown as SupabaseQuery;
  query = applyWhere(query.select("*"), model, where);
  const { data: rows, error } = await query;
  if (error) throw new Error(error.message);
  return (rows ?? []).map((row: unknown) => fromDb(model, row as Record<string, unknown>));
}

async function updateOne(model: keyof typeof tableNames, where: Record<string, unknown>, data: Record<string, unknown>) {
  const rows = await updateManyRows(model, where, data);
  if (!rows[0]) throw new Error("Record not found");
  return rows[0];
}

async function upsertOne(model: keyof typeof tableNames, where: Record<string, unknown>, create: Record<string, unknown>, update: Record<string, unknown>) {
  const existing = await selectOne(model, where);
  return existing ? updateOne(model, where, update) : insertOne(model, create);
}

async function deleteRows(model: keyof typeof tableNames, where: Record<string, unknown>) {
  let query = getSupabaseAdmin().from(tableNames[model]).delete() as unknown as SupabaseQuery;
  query = applyWhere(query.select("*"), model, where);
  const { error } = await query;
  if (error) throw new Error(error.message);
}

function orderArgs(orderBy?: Record<string, SortDirection>) {
  if (!orderBy) return undefined;
  const [column, direction] = Object.entries(orderBy)[0] ?? [];
  return column ? { column, ascending: direction !== "desc" } : undefined;
}

async function includeLeadRelations(lead: Record<string, unknown>, include?: Record<string, unknown>) {
  if (!include) return lead;
  const id = String(lead.id);
  const next = { ...lead };
  if (include.leadList) next.leadList = await selectOne("leadList", { id: lead.leadListId });
  if (include.callAttempts) {
    const cfg = typeof include.callAttempts === "object" ? (include.callAttempts as Record<string, unknown>) : {};
    next.callAttempts = await callAttempt.findMany({
      where: { leadId: id },
      include: cfg.include as Record<string, unknown> | undefined,
      orderBy: (cfg.orderBy as Record<string, SortDirection>) ?? { createdAt: "desc" },
      take: cfg.take as number | undefined,
    });
  }
  if (include.followUps) {
    const cfg = typeof include.followUps === "object" ? (include.followUps as Record<string, unknown>) : {};
    next.followUps = await selectMany("followUp", { leadId: id, ...((cfg.where as Record<string, unknown>) ?? {}) }, {
      order: orderArgs((cfg.orderBy as Record<string, SortDirection>) ?? { dueAt: "asc" }),
    });
  }
  if (include.leadNotes) next.leadNotes = await selectMany("leadNote", { leadId: id }, { order: { column: "createdAt", ascending: false } });
  if (include.smsMessages) next.smsMessages = await selectMany("smsMessage", { leadId: id }, { order: { column: "createdAt", ascending: false } });
  if (include.scrapeJobs) next.scrapeJobs = await selectMany("leadWebsiteScrapeJob", { leadId: id }, { order: { column: "createdAt", ascending: false }, limit: 1 });
  return next;
}

async function includeAttemptRelations(attempt: Record<string, unknown>, include?: Record<string, unknown>) {
  if (!include) return attempt;
  const id = String(attempt.id);
  const next = { ...attempt };
  if (include.lead) {
    const cfg = typeof include.lead === "object" ? (include.lead as Record<string, unknown>) : {};
    const lead = await selectOne("lead", { id: attempt.leadId });
    next.lead = lead ? await includeLeadRelations(lead as Record<string, unknown>, cfg.include as Record<string, unknown> | undefined) : null;
  }
  if (include.recording) next.recording = await selectOne("callRecording", { callAttemptId: id });
  if (include.transcript) next.transcript = await selectOne("callTranscript", { callAttemptId: id });
  if (include.notes) next.notes = await selectMany("leadNote", { callAttemptId: id }, { order: { column: "createdAt", ascending: false } });
  if (include.smsMessages) next.smsMessages = await selectMany("smsMessage", { callAttemptId: id }, { order: { column: "createdAt", ascending: false } });
  if (include.followUps) next.followUps = await selectMany("followUp", { callAttemptId: id }, { order: { column: "dueAt", ascending: true } });
  return next;
}

export const leadList = {
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("leadList", data),
};

export const lead = {
  async findUnique({ where, include }: { where: Record<string, unknown>; include?: Record<string, unknown> }) {
    const row = await selectOne("lead", where);
    return row ? includeLeadRelations(row, include) : null;
  },
  async findMany({ where, include, orderBy, take }: { where?: Record<string, unknown>; include?: Record<string, unknown>; orderBy?: Record<string, SortDirection>; take?: number } = {}) {
    let rows = await selectMany("lead", where, { order: orderArgs(orderBy), limit: take });
    if (include) rows = await Promise.all(rows.map((row) => includeLeadRelations(row as Record<string, unknown>, include)));
    return rows;
  },
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("lead", data),
  update: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateOne("lead", where, data),
  count: async ({ where }: { where?: Record<string, unknown> } = {}) => (await selectMany("lead", where)).length,
};

export const callAttempt = {
  async findUnique({ where, include }: { where: Record<string, unknown>; include?: Record<string, unknown> }) {
    const row = await selectOne("callAttempt", where);
    return row ? includeAttemptRelations(row, include) : null;
  },
  async findFirst({ where, orderBy, include }: { where?: Record<string, unknown>; orderBy?: Record<string, SortDirection>; include?: Record<string, unknown> } = {}) {
    const rows = await this.findMany({ where, orderBy, include, take: 1 });
    return rows[0] ?? null;
  },
  async findMany({ where, include, orderBy, take }: { where?: Record<string, unknown>; include?: Record<string, unknown>; orderBy?: Record<string, SortDirection>; take?: number } = {}) {
    let rows = await selectMany("callAttempt", where, { order: orderArgs(orderBy), limit: take });
    if (include) rows = await Promise.all(rows.map((row) => includeAttemptRelations(row as Record<string, unknown>, include)));
    return rows;
  },
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("callAttempt", data),
  update: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateOne("callAttempt", where, data),
  count: async ({ where }: { where?: Record<string, unknown> } = {}) => (await selectMany("callAttempt", where)).length,
};

export const callRecording = {
  upsert: ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) =>
    upsertOne("callRecording", where, create, update),
};

export const callTranscript = {
  upsert: ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) =>
    upsertOne("callTranscript", where, create, update),
};

export const leadNote = {
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("leadNote", data),
  update: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateOne("leadNote", where, data),
};

export const followUp = {
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("followUp", data),
  count: async ({ where }: { where?: Record<string, unknown> } = {}) => (await selectMany("followUp", where)).length,
};

export const smsMessage = {
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("smsMessage", data),
  update: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateOne("smsMessage", where, data),
  updateMany: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateManyRows("smsMessage", where, data),
};

export const telnyxWebhookEvent = {
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("telnyxWebhookEvent", data),
  update: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateOne("telnyxWebhookEvent", where, data),
  findMany: ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: Record<string, SortDirection> } = {}) =>
    selectMany("telnyxWebhookEvent", where, { order: orderArgs(orderBy) }),
};

export const appSetting = {
  findUnique: ({ where }: { where: Record<string, unknown> }) => selectOne("appSetting", where),
  upsert: ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) =>
    upsertOne("appSetting", where, create, update),
};

export const leadDemoProfile = {
  async findUnique({ where, include }: { where: Record<string, unknown>; include?: Record<string, unknown> }) {
    const profile = await selectOne("leadDemoProfile", where);
    if (!profile || !include?.scrapeJobs) return profile;
    return {
      ...profile,
      scrapeJobs: await selectMany("leadWebsiteScrapeJob", { leadDemoProfileId: profile.id }, { order: { column: "createdAt", ascending: false }, limit: 1 }),
    };
  },
  upsert: ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) =>
    upsertOne("leadDemoProfile", where, create, update),
  update: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateOne("leadDemoProfile", where, data),
};

export const leadWebsiteScrapeJob = {
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("leadWebsiteScrapeJob", data),
  async findUnique({ where, include }: { where: Record<string, unknown>; include?: Record<string, unknown> }) {
    const job = await selectOne("leadWebsiteScrapeJob", where);
    if (!job || !include) return job;
    return {
      ...job,
      profile: include.profile ? await selectOne("leadDemoProfile", { id: job.leadDemoProfileId }) : undefined,
      lead: include.lead ? await selectOne("lead", { id: job.leadId }) : undefined,
    };
  },
  update: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateOne("leadWebsiteScrapeJob", where, data),
  updateMany: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateManyRows("leadWebsiteScrapeJob", where, data),
};

export const leadWebsitePage = {
  deleteMany: ({ where }: { where: Record<string, unknown> }) => deleteRows("leadWebsitePage", where),
  async createMany({ data }: { data: Array<Record<string, unknown>> }) {
    if (!data.length) return { count: 0 };

    const uniqueRows = [...new Map(data.map((row) => [`${row.scrapeJobId}:${row.url}`, row])).values()];
    const { error } = await getSupabaseAdmin()
      .from(tableNames.leadWebsitePage)
      .upsert(uniqueRows.map((row) => toDb("leadWebsitePage", row)), {
        onConflict: "scrape_job_id,url",
        ignoreDuplicates: false,
      });

    if (error) throw new Error(error.message);
    return { count: uniqueRows.length };
  },
};

export const leadDemoActivation = {
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("leadDemoActivation", data),
};

export const elevenlabsDemoBinding = {
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("elevenlabsDemoBinding", data),
  findUnique: ({ where }: { where: Record<string, unknown> }) => selectOne("elevenlabsDemoBinding", where),
  async findFirst({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: Record<string, SortDirection> } = {}) {
    const rows = await this.findMany({ where, orderBy, take: 1 });
    return rows[0] ?? null;
  },
  findMany: ({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Record<string, SortDirection>; take?: number } = {}) =>
    selectMany("elevenlabsDemoBinding", where, { order: orderArgs(orderBy), limit: take }),
  update: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateOne("elevenlabsDemoBinding", where, data),
  updateMany: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateManyRows("elevenlabsDemoBinding", where, data),
};

export const elevenlabsConversation = {
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("elevenlabsConversation", data),
  findUnique: ({ where }: { where: Record<string, unknown> }) => selectOne("elevenlabsConversation", where),
  async findFirst({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: Record<string, SortDirection> } = {}) {
    const rows = await this.findMany({ where, orderBy, take: 1 });
    return rows[0] ?? null;
  },
  findMany: ({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Record<string, SortDirection>; take?: number } = {}) =>
    selectMany("elevenlabsConversation", where, { order: orderArgs(orderBy), limit: take }),
  update: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateOne("elevenlabsConversation", where, data),
  upsert: ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) =>
    upsertOne("elevenlabsConversation", where, create, update),
};

export const appointment = {
  create: ({ data }: { data: Record<string, unknown> }) => insertOne("appointment", data),
};

export const appointmentType = {
  findMany: ({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Record<string, SortDirection>; take?: number } = {}) =>
    selectMany("appointmentType", where, { order: orderArgs(orderBy), limit: take }),
};

export const appointmentTypeProvider = {
  async findFirst({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: Record<string, SortDirection> } = {}) {
    const rows = await selectMany("appointmentTypeProvider", where, { order: orderArgs(orderBy), limit: 1 });
    return rows[0] ?? null;
  },
};

const workstationDb = {
  leadList,
  lead,
  callAttempt,
  callRecording,
  callTranscript,
  leadNote,
  followUp,
  smsMessage,
  telnyxWebhookEvent,
  appSetting,
  leadDemoProfile,
  leadWebsiteScrapeJob,
  leadWebsitePage,
  leadDemoActivation,
  elevenlabsDemoBinding,
  elevenlabsConversation,
  appointment,
  appointmentType,
  appointmentTypeProvider,
  $queryRaw: async () => {
    const { error } = await getSupabaseAdmin().from("lead_lists").select("id").limit(1);
    if (error) throw new Error(error.message);
    return [{ "?column?": 1 }];
  },
};

export const db: any = {
  ...workstationDb,
  $transaction: async <T>(fn: (tx: typeof workstationDb) => Promise<T>) => fn(workstationDb),
};

export const prisma = db;

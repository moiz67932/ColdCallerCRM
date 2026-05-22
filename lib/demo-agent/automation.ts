import { normalizeWebsiteUrl } from "@/lib/demo-agent/extraction";
import { getLeadDemoAgentStatus, prepareLeadDemoAgent, runLeadDemoPreparationJob } from "@/lib/demo-agent/service";
import { requireEnv } from "@/lib/env";
import { formatUnknownError } from "@/lib/http";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

type LeadRow = {
  id: string;
  business_name: string | null;
  website: string | null;
  niche?: string | null;
};

type ProfileRow = {
  id: string;
  lead_id: string;
  status: string;
  source_website_url: string;
  last_scraped_at?: string | null;
  updated_at?: string | null;
};

type ActiveJobRow = {
  id: string;
  lead_id: string;
  status: string;
};

type EligibleLead = LeadRow & {
  normalizedWebsite: string;
  profile?: ProfileRow;
};

type AutomationJobRow = {
  id: string;
  lead_id: string;
  website_url: string | null;
  retry_count?: number | null;
};

type AutomationFilters = {
  industry?: string | null;
  onlyUnprepared?: boolean;
  retryFailed?: boolean;
  staleAfterDays?: number | null;
};

const activeBatches = new Set<string>();
const terminalProfileStatuses = new Set(["ready", "active", "needs_review", "failed"]);
const preparedProfileStatuses = new Set(["ready", "active"]);
const runningJobStatuses = ["pending", "running"];
const STUCK_JOB_MS = 30 * 60 * 1000;
const missingOptionalTables = new Set<string>();

function getOrganizationId() {
  return requireEnv("DEMO_RUNTIME_ORGANIZATION_ID");
}

function normalizeNullableWebsite(value: string | null | undefined) {
  if (!value) return null;

  try {
    return normalizeWebsiteUrl(value);
  } catch {
    return null;
  }
}

function isPreparedProfile(profile: ProfileRow | undefined, websiteUrl: string, staleAfterDays?: number | null) {
  if (!profile || !preparedProfileStatuses.has(profile.status)) return false;
  if (normalizeNullableWebsite(profile.source_website_url) !== websiteUrl) return false;
  if (!staleAfterDays) return true;

  const lastPreparedAt = profile.last_scraped_at ?? profile.updated_at;
  if (!lastPreparedAt) return false;
  return Date.now() - new Date(lastPreparedAt).getTime() <= staleAfterDays * 24 * 60 * 60 * 1000;
}

async function markStaleAutomationJobsFailed() {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();
  const staleBefore = new Date(Date.now() - STUCK_JOB_MS).toISOString();

  const { data: staleJobs, error: staleJobsError } = await supabase
    .from("lead_demo_automation_jobs")
    .select("id,batch_id,lead_id")
    .eq("organization_id", organizationId)
    .eq("status", "running")
    .lt("started_at", staleBefore);

  if (staleJobsError) throw new Error(staleJobsError.message);
  if (!staleJobs?.length) return;

  const batchIds = [...new Set(staleJobs.map((job) => String(job.batch_id)))];
  const { error } = await supabase
    .from("lead_demo_automation_jobs")
    .update({
      status: "failed",
      stage: "failed",
      error: "Preparation job timed out and was marked failed.",
      completed_at: new Date().toISOString(),
    })
    .in(
      "id",
      staleJobs.map((job) => job.id),
    );

  if (error) throw new Error(error.message);

  await Promise.all(
    batchIds.map(async (batchId) => {
      await refreshBatchCounts(batchId);
      await completeBatchIfIdle(batchId);
    }),
  );

  logWarn("demo_agent.automation_stale_jobs_failed", {
    organization_id: organizationId,
    count: staleJobs.length,
    batch_ids: batchIds,
  });
}

async function loadEligibleLeads(input: {
  requestedCount: number;
  filters?: AutomationFilters;
  forceReprocess?: boolean;
}) {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();
  const requestedCount = input.requestedCount;
  const staleAfterDays = input.filters?.staleAfterDays ?? null;

  let leadsQuery = supabase
    .from("leads")
    .select("id,business_name,website,niche")
    .not("website", "is", null)
    .neq("website", "")
    .order("created_at", { ascending: true })
    .limit(Math.max(requestedCount * 6, requestedCount + 50));

  if (input.filters?.industry && input.filters.industry !== "all") {
    leadsQuery = leadsQuery.ilike("niche", `%${input.filters.industry}%`);
  }

  const { data: leads, error: leadsError } = await leadsQuery;
  if (leadsError) throw new Error(leadsError.message);

  const leadRows = (leads ?? []) as LeadRow[];
  if (!leadRows.length) return { eligibleLeads: [] as EligibleLead[], skippedCount: 0 };

  const leadIds = leadRows.map((lead) => lead.id);
  const [profilesResult, activeJobsResult] = await Promise.all([
    supabase
      .from("lead_demo_profiles")
      .select("id,lead_id,status,source_website_url,last_scraped_at,updated_at")
      .eq("organization_id", organizationId)
      .in("lead_id", leadIds),
    supabase
      .from("lead_demo_automation_jobs")
      .select("id,lead_id,status")
      .eq("organization_id", organizationId)
      .in("lead_id", leadIds)
      .in("status", runningJobStatuses),
  ]);

  if (profilesResult.error) throw new Error(profilesResult.error.message);
  if (activeJobsResult.error) throw new Error(activeJobsResult.error.message);

  const profilesByLead = new Map<string, ProfileRow>((profilesResult.data ?? []).map((profile) => [profile.lead_id, profile as ProfileRow]));
  const activeAutomationByLead = new Map<string, ActiveJobRow>(
    (activeJobsResult.data ?? []).map((job) => [String(job.lead_id), job as ActiveJobRow]),
  );

  let skippedCount = 0;
  const eligibleLeads = leadRows
    .map((lead) => ({
      ...lead,
      normalizedWebsite: normalizeNullableWebsite(lead.website),
      profile: profilesByLead.get(lead.id),
      activeAutomationJob: activeAutomationByLead.get(lead.id),
    }))
    .filter((lead) => {
      if (!lead.normalizedWebsite) {
        skippedCount += 1;
        return false;
      }
      if (lead.activeAutomationJob) {
        skippedCount += 1;
        return false;
      }
      if (!input.forceReprocess && isPreparedProfile(lead.profile, lead.normalizedWebsite, staleAfterDays)) {
        skippedCount += 1;
        return false;
      }
      return true;
    })
    .slice(0, requestedCount)
    .map((lead) => ({
      id: lead.id,
      business_name: lead.business_name,
      website: lead.website,
      niche: lead.niche,
      normalizedWebsite: lead.normalizedWebsite!,
      profile: lead.profile,
    }));

  return { eligibleLeads, skippedCount };
}

async function refreshBatchCounts(batchId: string) {
  const supabase = getSupabaseAdmin();
  const { data: jobs, error } = await supabase.from("lead_demo_automation_jobs").select("status").eq("batch_id", batchId);

  if (error) throw new Error(error.message);

  const counts = (jobs ?? []).reduce(
    (next, job) => {
      const status = String(job.status);
      if (status === "completed") next.completed_count += 1;
      if (status === "failed") next.failed_count += 1;
      if (status === "skipped_existing") next.skipped_count += 1;
      return next;
    },
    { completed_count: 0, failed_count: 0, skipped_count: 0 },
  );

  await supabase.from("lead_demo_automation_batches").update({ ...counts, updated_at: new Date().toISOString() }).eq("id", batchId).throwOnError();
}

async function completeBatchIfIdle(batchId: string) {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();
  const { data: jobs, error } = await supabase
    .from("lead_demo_automation_jobs")
    .select("status")
    .eq("organization_id", organizationId)
    .eq("batch_id", batchId);

  if (error) throw new Error(error.message);

  const statuses = (jobs ?? []).map((job) => String(job.status));
  if (statuses.some((status) => runningJobStatuses.includes(status))) return;

  const failedCount = statuses.filter((status) => status === "failed").length;
  await supabase
    .from("lead_demo_automation_batches")
    .update({
      status: failedCount > 0 ? "completed_with_errors" : "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", batchId)
    .eq("organization_id", organizationId)
    .in("status", ["pending", "running"])
    .throwOnError();
}

async function isAutomationJobCancelled(jobId: string, batchId: string) {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();

  const [jobResult, batchResult] = await Promise.all([
    supabase.from("lead_demo_automation_jobs").select("status").eq("id", jobId).eq("organization_id", organizationId).maybeSingle(),
    supabase.from("lead_demo_automation_batches").select("status").eq("id", batchId).eq("organization_id", organizationId).maybeSingle(),
  ]);

  if (jobResult.error) throw new Error(jobResult.error.message);
  if (batchResult.error) throw new Error(batchResult.error.message);

  return jobResult.data?.status === "cancelled" || batchResult.data?.status === "cancelled";
}

async function isAutomationBatchCancelled(batchId: string) {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();

  const { data, error } = await supabase
    .from("lead_demo_automation_batches")
    .select("status")
    .eq("id", batchId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data?.status === "cancelled";
}

async function waitForPreparedLeadOrCancellation(leadId: string, jobId: string, batchId: string) {
  const startedAt = Date.now();
  const timeoutMs = 15 * 60 * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    if (await isAutomationJobCancelled(jobId, batchId)) {
      return { cancelled: true as const };
    }

    const status = await getLeadDemoAgentStatus(leadId);

    if (terminalProfileStatuses.has(status.profile_status)) {
      return { cancelled: false as const, status };
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error("Timed out while waiting for scrape and extraction to finish");
}

async function runAutomationJob(batchId: string, job: AutomationJobRow, forceReprocess: boolean) {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();
  const startedAtMs = Date.now();

  await supabase
    .from("lead_demo_automation_jobs")
    .update({ status: "running", stage: "scraping", started_at: new Date().toISOString(), completed_at: null, error: null })
    .eq("id", job.id)
    .eq("status", "pending")
    .throwOnError();

  try {
    if (!job.website_url) {
      throw new Error("Lead does not have a website URL");
    }

    if (await isAutomationJobCancelled(job.id, batchId)) {
      return;
    }

    const currentStatus = await getLeadDemoAgentStatus(job.lead_id);
    if (!forceReprocess && (currentStatus.profile_status === "ready" || currentStatus.profile_status === "active")) {
      await supabase
        .from("lead_demo_automation_jobs")
        .update({
          status: "skipped_existing",
          stage: "completed",
          lead_demo_profile_id: currentStatus.lead_demo_profile_id ?? null,
          scrape_job_id: currentStatus.scrape_job_id ?? null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .throwOnError();
      return;
    }

    logInfo("demo_agent.automation_job_started", {
      organization_id: organizationId,
      batch_id: batchId,
      job_id: job.id,
      lead_id: job.lead_id,
      status: "running",
    });

    const prepared = await prepareLeadDemoAgent({
      leadId: job.lead_id,
      websiteUrl: job.website_url,
      forceRescrape: forceReprocess,
      queue: false,
    });
    if (!prepared.jobId) {
      throw new Error("Lead demo profile was reused but no scrape job was available");
    }

    await runLeadDemoPreparationJob(prepared.jobId);
    const finalResult = await waitForPreparedLeadOrCancellation(job.lead_id, job.id, batchId);
    if (finalResult.cancelled) {
      logInfo("demo_agent.automation_job_cancelled", {
        organization_id: organizationId,
        batch_id: batchId,
        job_id: job.id,
        lead_id: job.lead_id,
        duration_ms: Date.now() - startedAtMs,
      });
      return;
    }

    const finalStatus = finalResult.status;
    const completed = finalStatus.profile_status === "ready" || finalStatus.profile_status === "active";

    await supabase
      .from("lead_demo_automation_jobs")
      .update({
        status: completed ? "completed" : "failed",
        stage: completed ? "completed" : "failed",
        lead_demo_profile_id: prepared.leadDemoProfileId,
        scrape_job_id: prepared.jobId,
        error: completed ? null : finalStatus.scrape_error ?? "Lead demo profile needs review after extraction",
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "running")
      .throwOnError();

    logInfo("demo_agent.automation_job_completed", {
      organization_id: organizationId,
      batch_id: batchId,
      job_id: job.id,
      lead_id: job.lead_id,
      lead_demo_profile_id: prepared.leadDemoProfileId,
      scrape_job_id: prepared.jobId,
      status: completed ? "completed" : "failed",
      duration_ms: Date.now() - startedAtMs,
    });
  } catch (error) {
    await supabase
      .from("lead_demo_automation_jobs")
      .update({
        status: "failed",
        stage: "failed",
        error: formatUnknownError(error),
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "running")
      .throwOnError();

    logError("demo_agent.automation_job_failed", {
      organization_id: organizationId,
      batch_id: batchId,
      job_id: job.id,
      lead_id: job.lead_id,
      status: "failed",
      error: formatUnknownError(error),
      duration_ms: Date.now() - startedAtMs,
    });
  } finally {
    await refreshBatchCounts(batchId);
  }
}

export async function runLeadDemoAutomationBatch(batchId: string) {
  if (activeBatches.has(batchId)) return;
  activeBatches.add(batchId);

  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();
  const startedAtMs = Date.now();

  try {
    const { data: batch, error: batchError } = await supabase
      .from("lead_demo_automation_batches")
      .select("id,max_concurrency,filters")
      .eq("id", batchId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (batchError) throw new Error(batchError.message);
    if (!batch) throw new Error("Automation batch not found");

    await supabase
      .from("lead_demo_automation_batches")
      .update({ status: "running", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: null })
      .eq("id", batchId)
      .eq("organization_id", organizationId)
      .in("status", ["pending", "running", "failed", "completed_with_errors"])
      .throwOnError();

    const { data: jobs, error: jobsError } = await supabase
      .from("lead_demo_automation_jobs")
      .select("id,lead_id,website_url,retry_count")
      .eq("organization_id", organizationId)
      .eq("batch_id", batchId)
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (jobsError) throw new Error(jobsError.message);

    const pendingJobs = (jobs ?? []) as AutomationJobRow[];
    if (!pendingJobs.length) {
      const { count: runningCount, error: runningError } = await supabase
        .from("lead_demo_automation_jobs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("batch_id", batchId)
        .eq("status", "running");

      if (runningError) throw new Error(runningError.message);
      if ((runningCount ?? 0) > 0) return;
    }

    const concurrency = Math.max(1, Math.min(Number(batch.max_concurrency ?? 2), 5));
    const filters = (batch.filters ?? {}) as Record<string, unknown>;
    const forceReprocess = Boolean(filters.force_reprocess);
    let cursor = 0;

    async function worker() {
      while (cursor < pendingJobs.length) {
        if (await isAutomationBatchCancelled(batchId)) return;
        const job = pendingJobs[cursor];
        cursor += 1;
        await runAutomationJob(batchId, job, forceReprocess);
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, pendingJobs.length) }, () => worker()));
    await refreshBatchCounts(batchId);

    const { data: finalBatch, error: finalError } = await supabase
      .from("lead_demo_automation_batches")
      .select("failed_count,completed_count,skipped_count,selected_count,status")
      .eq("id", batchId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (finalError) throw new Error(finalError.message);
    if (finalBatch?.status === "cancelled") return;

    const failedCount = Number(finalBatch?.failed_count ?? 0);
    await supabase
      .from("lead_demo_automation_batches")
      .update({
        status: failedCount > 0 ? "completed_with_errors" : "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .eq("organization_id", organizationId)
      .throwOnError();

    logInfo("demo_agent.automation_batch_completed", {
      organization_id: organizationId,
      batch_id: batchId,
      status: failedCount > 0 ? "completed_with_errors" : "completed",
      duration_ms: Date.now() - startedAtMs,
    });
  } catch (error) {
    logError("demo_agent.automation_batch_failed", {
      organization_id: organizationId,
      batch_id: batchId,
      error: formatUnknownError(error),
      duration_ms: Date.now() - startedAtMs,
    });
    await supabase
      .from("lead_demo_automation_batches")
      .update({ status: "failed", error: formatUnknownError(error), completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", batchId)
      .eq("organization_id", organizationId)
      .throwOnError();
  } finally {
    activeBatches.delete(batchId);
  }
}

async function resumeLeadDemoAutomationBatches() {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();
  const { data: batches, error } = await supabase
    .from("lead_demo_automation_batches")
    .select("id,status")
    .eq("organization_id", organizationId)
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: true })
    .limit(2);

  if (error) throw new Error(error.message);

  for (const batch of batches ?? []) {
    await runLeadDemoAutomationBatch(String(batch.id));
  }
}

export async function createLeadDemoAutomationBatch(input: {
  requestedCount: number;
  maxConcurrency: number;
  name?: string;
  filters?: AutomationFilters;
  forceReprocess?: boolean;
}) {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();
  const requestedCount = Math.max(1, Math.min(input.requestedCount, 100));
  const maxConcurrency = Math.max(1, Math.min(input.maxConcurrency, 5));

  await markStaleAutomationJobsFailed();

  const { eligibleLeads, skippedCount } = await loadEligibleLeads({
    requestedCount,
    filters: input.filters,
    forceReprocess: input.forceReprocess,
  });

  const { data: batch, error: batchError } = await supabase
    .from("lead_demo_automation_batches")
    .insert({
      organization_id: organizationId,
      name: input.name ?? `Prepare ${requestedCount} demo profiles`,
      status: eligibleLeads.length ? "pending" : "completed",
      requested_count: requestedCount,
      selected_count: eligibleLeads.length,
      skipped_count: skippedCount,
      max_concurrency: maxConcurrency,
      filters: {
        ...(input.filters ?? {}),
        force_reprocess: Boolean(input.forceReprocess),
        skip_prepared: !input.forceReprocess,
        requires_website: true,
      },
      completed_at: eligibleLeads.length ? null : new Date().toISOString(),
    })
    .select("*")
    .single();

  if (batchError) throw new Error(batchError.message);

  if (eligibleLeads.length) {
    let insertedCount = 0;
    let duplicateSkipCount = 0;

    for (const lead of eligibleLeads) {
      const { error: jobError } = await supabase
        .from("lead_demo_automation_jobs")
        .insert({
          organization_id: organizationId,
          batch_id: batch.id,
          lead_id: lead.id,
          status: "pending",
          stage: "selected",
          website_url: lead.normalizedWebsite,
          business_name: lead.business_name,
        });

      if (jobError) {
        if (jobError.code === "23505" || /duplicate key/i.test(jobError.message)) {
          duplicateSkipCount += 1;
          logWarn("demo_agent.automation_job_duplicate_skipped", {
            organization_id: organizationId,
            batch_id: batch.id,
            lead_id: lead.id,
            error: jobError.message,
          });
          continue;
        }

        throw new Error(jobError.message);
      }

      insertedCount += 1;
    }

    if (insertedCount !== eligibleLeads.length) {
      await supabase
        .from("lead_demo_automation_batches")
        .update({
          selected_count: insertedCount,
          skipped_count: skippedCount + duplicateSkipCount,
          status: insertedCount ? "pending" : "completed",
          completed_at: insertedCount ? null : new Date().toISOString(),
        })
        .eq("id", batch.id)
        .throwOnError();
      batch.selected_count = insertedCount;
    }

    logInfo("demo_agent.automation_batch_created", {
      organization_id: organizationId,
      batch_id: batch.id,
      requested_count: requestedCount,
      selected_count: batch.selected_count,
      skipped_count: skippedCount,
      max_concurrency: maxConcurrency,
    });

    if (batch.selected_count > 0) {
      void runLeadDemoAutomationBatch(batch.id);
    }
  }

  return batch;
}

export async function getLeadDemoAutomationSummary() {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();

  await markStaleAutomationJobsFailed();
  await resumeLeadDemoAutomationBatches();

  const [leadsResult, profilesResult, runningJobsResult, failedJobsResult, batchesResult] = await Promise.all([
    supabase.from("leads").select("id", { count: "exact", head: true }).not("website", "is", null).neq("website", ""),
    supabase
      .from("lead_demo_profiles")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("status", ["ready", "active"]),
    supabase
      .from("lead_demo_automation_jobs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("status", runningJobStatuses),
    supabase
      .from("lead_demo_automation_jobs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "failed"),
    supabase
      .from("lead_demo_automation_batches")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  for (const result of [leadsResult, profilesResult, runningJobsResult, failedJobsResult, batchesResult]) {
    if (result.error) throw new Error(result.error.message);
  }

  const totalWebsiteLeads = leadsResult.count ?? 0;
  const preparedCount = profilesResult.count ?? 0;
  const runningCount = runningJobsResult.count ?? 0;

  return {
    total_leads: totalWebsiteLeads,
    prepared_count: preparedCount,
    scraping_count: runningCount,
    running_count: runningCount,
    failed_count: failedJobsResult.count ?? 0,
    needs_scraping_count: Math.max(totalWebsiteLeads - preparedCount - runningCount, 0),
    last_batch: batchesResult.data?.[0] ?? null,
    batches: batchesResult.data ?? [],
  };
}

async function countByProfile(table: string, profileIds: string[]) {
  const supabase = getSupabaseAdmin();
  if (!profileIds.length) return new Map<string, number>();
  const { data, error } = await supabase.from(table).select("lead_demo_profile_id").in("lead_demo_profile_id", profileIds).eq("is_active", true);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      if (!missingOptionalTables.has(table)) {
        missingOptionalTables.add(table);
        logWarn("demo_agent.automation_optional_table_missing", { table, error: error.message });
      }
      return new Map<string, number>();
    }

    throw new Error(error.message);
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const profileId = String(row.lead_demo_profile_id);
    counts.set(profileId, (counts.get(profileId) ?? 0) + 1);
  }
  return counts;
}

export async function getPreparedLeadDemoProfiles(limit = 25) {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();

  const { data: profiles, error } = await supabase
    .from("lead_demo_profiles")
    .select("id,lead_id,business_name,status,last_scraped_at,source_website_url,updated_at")
    .eq("organization_id", organizationId)
    .in("status", ["ready", "active"])
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  if (!profiles?.length) return [];

  const profileIds = profiles.map((profile) => String(profile.id));
  const [leadsResult, servicesCount, pricesCount, factsCount] = await Promise.all([
    supabase
      .from("leads")
      .select("id,phone_number,city,state,niche")
      .in(
        "id",
        profiles.map((profile) => profile.lead_id),
      ),
    countByProfile("lead_clinic_services", profileIds),
    countByProfile("lead_clinic_service_prices", profileIds),
    countByProfile("lead_clinic_facts", profileIds),
  ]);

  if (leadsResult.error) throw new Error(leadsResult.error.message);

  const leadsById = new Map((leadsResult.data ?? []).map((lead) => [lead.id, lead]));

  return profiles.map((profile) => ({
    ...profile,
    is_demo_ready: profile.status === "ready" || profile.status === "active",
    demo_readiness_status: profile.status === "ready" || profile.status === "active" ? "ready" : "needs_review",
    services_count: servicesCount.get(String(profile.id)) ?? 0,
    prices_count: pricesCount.get(String(profile.id)) ?? 0,
    facts_count: factsCount.get(String(profile.id)) ?? 0,
    lead: leadsById.get(profile.lead_id) ?? null,
  }));
}

export async function getFailedLeadDemoAutomationJobs(limit = 25) {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();
  const { data, error } = await supabase
    .from("lead_demo_automation_jobs")
    .select("id,batch_id,lead_id,website_url,business_name,error,retry_count,started_at,completed_at,created_at")
    .eq("organization_id", organizationId)
    .eq("status", "failed")
    .order("completed_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function cancelLeadDemoAutomationBatch(batchId: string) {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();
  await supabase
    .from("lead_demo_automation_batches")
    .update({ status: "cancelled", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", batchId)
    .eq("organization_id", organizationId)
    .in("status", ["pending", "running"])
    .throwOnError();
  await supabase
    .from("lead_demo_automation_jobs")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("batch_id", batchId)
    .in("status", runningJobStatuses)
    .throwOnError();
  await refreshBatchCounts(batchId);
}

export async function retryLeadDemoAutomationJob(jobId: string) {
  const supabase = getSupabaseAdmin();
  const organizationId = getOrganizationId();

  const { data: existingJob, error: existingError } = await supabase
    .from("lead_demo_automation_jobs")
    .select("batch_id,retry_count")
    .eq("id", jobId)
    .eq("organization_id", organizationId)
    .eq("status", "failed")
    .single();

  if (existingError) throw new Error(existingError.message);

  const retryCount = Number(existingJob.retry_count ?? 0) + 1;
  const { data: job, error } = await supabase
    .from("lead_demo_automation_jobs")
    .update({
      status: "pending",
      stage: "selected",
      error: null,
      retry_count: retryCount,
      completed_at: null,
      started_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("organization_id", organizationId)
    .eq("status", "failed")
    .select("batch_id,retry_count")
    .single();

  if (error) throw new Error(error.message);

  logInfo("demo_agent.automation_retry_started", {
    organization_id: organizationId,
    batch_id: job.batch_id,
    job_id: jobId,
    retry_count: retryCount,
  });

  void runLeadDemoAutomationBatch(job.batch_id);
}

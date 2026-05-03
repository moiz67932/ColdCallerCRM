import { PUBLIC_DEMO_AGENT_ID, extractedProfileSchema } from "@/lib/demo-agent/contracts";
import { normalizeWebsiteUrl, summarizeExtractedProfile, contentHash } from "@/lib/demo-agent/extraction";
import { executeLeadProfileExtraction, loadRuntimeProfileFromNormalized } from "@/lib/demo-agent/profile-pipeline";
import { formatActivationResult } from "@/lib/demo-agent/responses";
import { activateRuntimeProfile, refreshDeployedRuntimeConfig, writeRuntimeProfile } from "@/lib/demo-agent/runtime";
import { crawlLeadWebsite } from "@/lib/demo-agent/scraper";
import { prisma } from "@/lib/workstation-db";
import { requireEnv } from "@/lib/env";
import { logError, logInfo, logWarn } from "@/lib/logger";

const activeJobs = new Map<string, Promise<void>>();
const autoActivateJobs = new Set<string>();
const PROCESSING_JOB_STALE_MS = 10 * 60 * 1000;

function getOrganizationId() {
  return requireEnv("DEMO_RUNTIME_ORGANIZATION_ID");
}

function getAgentDbId() {
  return requireEnv("EXISTING_DEMO_AGENT_DB_ID");
}

export async function prepareLeadDemoAgent(input: {
  leadId: string;
  websiteUrl: string;
  activate?: boolean;
  forceRescrape?: boolean;
  queue?: boolean;
}) {
  const lead = await prisma.lead.findUnique({
    where: { id: input.leadId },
  });

  if (!lead) {
    throw new Error("Lead not found");
  }

  const websiteUrl = normalizeWebsiteUrl(input.websiteUrl || lead.website || "");
  const organizationId = getOrganizationId();
  const agentId = getAgentDbId();

  const existingProfile = await prisma.leadDemoProfile.findUnique({
    where: { leadId: input.leadId },
    include: {
      scrapeJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  const latestJob = existingProfile?.scrapeJobs[0];
  const latestJobStartedAt = latestJob?.startedAt ? new Date(latestJob.startedAt) : null;
  const latestJobIsStale =
    latestJob?.status === "processing" &&
    (!latestJobStartedAt || Date.now() - latestJobStartedAt.getTime() > PROCESSING_JOB_STALE_MS);

  if (
    existingProfile &&
    latestJob &&
    !input.forceRescrape &&
    existingProfile.sourceWebsiteUrl === websiteUrl &&
    existingProfile.status === "scraping" &&
    (latestJob.status === "pending" || latestJobIsStale)
  ) {
    logInfo("demo_agent.prepare_existing_job", {
      leadId: input.leadId,
      jobId: latestJob.id,
      websiteUrl,
      status: latestJob.status,
    });

    if (input.queue !== false) {
      queueLeadDemoPreparation(String(latestJob.id));
    }

    return {
      jobId: latestJob.id,
      leadDemoProfileId: existingProfile.id,
      status: "scraping" as const,
    };
  }

  if (
    existingProfile &&
    latestJob &&
    !input.forceRescrape &&
    existingProfile.sourceWebsiteUrl === websiteUrl &&
    existingProfile.status === "scraping" &&
    latestJob.status === "processing"
  ) {
    logInfo("demo_agent.prepare_existing_processing_job", {
      leadId: input.leadId,
      jobId: latestJob.id,
      websiteUrl,
      startedAt: latestJob.startedAt,
    });

    return {
      jobId: latestJob.id,
      leadDemoProfileId: existingProfile.id,
      status: "scraping" as const,
    };
  }

  if (
    existingProfile &&
    !input.forceRescrape &&
    (existingProfile.status === "ready" || existingProfile.status === "active") &&
    existingProfile.sourceWebsiteUrl === websiteUrl
  ) {
    logInfo("demo_agent.prepare_reuse_prepared_profile", {
      leadId: input.leadId,
      profileId: existingProfile.id,
      status: existingProfile.status,
      websiteUrl,
    });

    return {
      jobId: existingProfile.scrapeJobs[0]?.id ?? null,
      leadDemoProfileId: existingProfile.id,
      status: existingProfile.status,
    };
  }

  const profile = await prisma.leadDemoProfile.upsert({
    where: { leadId: input.leadId },
    create: {
      leadId: input.leadId,
      organizationId,
      agentId,
      sourceWebsiteUrl: websiteUrl,
      businessName: lead.businessName,
      status: "scraping",
      extractedProfileJson: {},
    },
    update: {
      organizationId,
      agentId,
      sourceWebsiteUrl: websiteUrl,
      businessName: lead.businessName,
      status: "scraping",
      extractionConfidence: null,
      extractionStatus: null,
      extractionRunId: null,
      extractionQualityScore: null,
      extractionQualityStatus: null,
      isDemoReady: false,
      demoReadyBlockers: [],
      extractedProfileJson: {},
    },
  });

  const job = await prisma.leadWebsiteScrapeJob.create({
    data: {
      leadId: input.leadId,
      leadDemoProfileId: profile.id,
      organizationId,
      rootUrl: websiteUrl,
      status: "pending",
    },
  });

  if (input.activate) {
    autoActivateJobs.add(job.id);
  }

  logInfo("demo_agent.prepare_created", {
    leadId: input.leadId,
    jobId: job.id,
    profileId: profile.id,
    websiteUrl,
    autoActivate: Boolean(input.activate),
  });

  if (input.queue !== false) {
    queueLeadDemoPreparation(job.id);
  }

  return {
    jobId: job.id,
    leadDemoProfileId: profile.id,
    status: "scraping" as const,
  };
}

export function queueLeadDemoPreparation(jobId: string) {
  if (activeJobs.has(jobId)) {
    logInfo("demo_agent.queue_skip_active", { jobId });
    return;
  }

  logInfo("demo_agent.queue_start", { jobId });

  const task = runLeadDemoPreparationJob(jobId)
    .catch((error) => {
      logError("demo_agent.queue_failed", {
        jobId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    })
    .finally(() => {
      activeJobs.delete(jobId);
      autoActivateJobs.delete(jobId);
      logInfo("demo_agent.queue_finished", { jobId });
    });

  activeJobs.set(jobId, task);
  void task;
}

export async function getLeadDemoAgentStatus(leadId: string) {
  const profile = await prisma.leadDemoProfile.findUnique({
    where: { leadId },
    include: {
      scrapeJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  if (!profile) {
    return {
      lead_id: leadId,
      lead_demo_profile_id: null,
      profile_status: "draft",
      scrape_status: "pending",
      last_scraped_at: null,
      last_prepared_at: null,
      last_activated_at: null,
      is_demo_ready: false,
      demo_ready_blockers: [],
      can_activate: false,
      can_prepare: true,
      can_retry: false,
      clinic_id: null,
      agent_id: PUBLIC_DEMO_AGENT_ID,
      summary: null,
    };
  }

  const latestJob = profile.scrapeJobs[0];
  const latestJobStartedAt = latestJob?.startedAt ? new Date(latestJob.startedAt) : null;
  const latestJobIsStale =
    latestJob?.status === "processing" &&
    (!latestJobStartedAt || Date.now() - latestJobStartedAt.getTime() > PROCESSING_JOB_STALE_MS);

  if (
    profile.status === "scraping" &&
    latestJob &&
    (latestJob.status === "pending" || latestJobIsStale) &&
    !activeJobs.has(String(latestJob.id))
  ) {
    logWarn("demo_agent.status_requeue_stale_job", {
      leadId,
      jobId: latestJob.id,
      scrapeStatus: latestJob.status,
    });
    queueLeadDemoPreparation(String(latestJob.id));
  }

  const extractedProfile = extractedProfileSchema.safeParse(profile.extractedProfileJson);

  return {
    lead_id: leadId,
    lead_demo_profile_id: profile.id,
    profile_status: profile.status,
    scrape_status: latestJob?.status ?? "pending",
    scrape_error: latestJob?.error ?? null,
    scrape_job_id: latestJob?.id ?? null,
    last_scraped_at: profile.lastScrapedAt ?? null,
    last_prepared_at: profile.updatedAt ?? null,
    last_activated_at: profile.lastActivatedAt ?? null,
    is_demo_ready: Boolean(profile.isDemoReady),
    demo_ready_blockers: profile.demoReadyBlockers ?? [],
    can_activate: (profile.status === "ready" || profile.status === "active") && Boolean(profile.isDemoReady),
    can_prepare: profile.status !== "scraping",
    can_retry: profile.status === "failed",
    pages_discovered: latestJob?.pagesDiscovered ?? 0,
    pages_scraped: latestJob?.pagesScraped ?? 0,
    pages_failed: latestJob?.pagesFailed ?? 0,
    clinic_id: profile.clinicId,
    agent_id: PUBLIC_DEMO_AGENT_ID,
    summary: extractedProfile.success ? summarizeExtractedProfile(extractedProfile.data) : null,
    extraction: {
      status: profile.extractionStatus ?? null,
      run_id: profile.extractionRunId ?? null,
      quality_score: profile.extractionQualityScore ?? null,
      quality_status: profile.extractionQualityStatus ?? null,
      is_demo_ready: Boolean(profile.isDemoReady),
      blockers: profile.demoReadyBlockers ?? [],
    },
  };
}

export async function activateLeadDemoAgent(leadId: string) {
  const profile = await prisma.leadDemoProfile.findUnique({
    where: { leadId },
  });

  if (!profile) {
    throw new Error("This lead has not been prepared yet. Prepare the demo first from Automations or this lead page.");
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

  const extractedProfile = (await loadRuntimeProfileFromNormalized(String(profile.id))) ?? extractedProfileSchema.parse(profile.extractedProfileJson);
  logInfo("demo_agent.activate_start", {
    leadId,
    profileId: profile.id,
    existingClinicId: profile.clinicId,
  });

  const runtimeWrite = await writeRuntimeProfile(extractedProfile, profile.clinicId);
  const activation = await activateRuntimeProfile(leadId, profile.id, runtimeWrite.clinicId);

  await prisma.$transaction(async (tx: typeof prisma) => {
    await tx.leadDemoProfile.update({
      where: { id: profile.id },
      data: {
        clinicId: runtimeWrite.clinicId,
        status: "active",
        lastActivatedAt: new Date(),
      },
    });

    await tx.leadDemoActivation.create({
      data: {
        leadId,
        leadDemoProfileId: profile.id,
        organizationId: activation.organizationId,
        clinicId: runtimeWrite.clinicId,
        agentId: activation.agentDbId,
        phoneE164: activation.phoneE164,
        previousClinicId: activation.previousClinicId,
      },
    });
  });

  logInfo("demo_agent.activate_complete", {
    leadId,
    profileId: profile.id,
    clinicId: runtimeWrite.clinicId,
    agentDbId: activation.agentDbId,
    phoneE164: activation.phoneE164,
  });

  const runtimeRefresh = await refreshDeployedRuntimeConfig(activation.agentDbId);

  return formatActivationResult({
    clinicId: runtimeWrite.clinicId,
    leadDemoProfileId: profile.id,
    phoneE164: activation.phoneE164,
    agentDbId: activation.agentDbId,
    runtimeRefresh,
  });
}

export async function runLeadDemoPreparationJob(jobId: string) {
  const job = await prisma.leadWebsiteScrapeJob.findUnique({
    where: { id: jobId },
    include: {
      profile: true,
      lead: true,
    },
  });

  if (!job || !job.profile) {
    throw new Error("Scrape job not found");
  }

  const staleStartedBefore = new Date(Date.now() - PROCESSING_JOB_STALE_MS);

  if (job.status === "completed") {
    logInfo("demo_agent.job_skip_completed", { jobId, leadId: job.leadId });
    return;
  }

  if (job.status === "failed" || job.status === "cancelled") {
    logWarn("demo_agent.job_skip_terminal", { jobId, leadId: job.leadId, status: job.status });
    return;
  }

  if (job.status === "processing" && job.startedAt && new Date(job.startedAt) > staleStartedBefore) {
    logInfo("demo_agent.job_skip_active_processing", {
      jobId,
      leadId: job.leadId,
      startedAt: job.startedAt,
    });
    return;
  }

  const claimWhere =
    job.status === "processing"
      ? { id: jobId, status: "processing", startedAt: { lte: staleStartedBefore } }
      : { id: jobId, status: "pending" };

  const claimedJobs = await prisma.leadWebsiteScrapeJob.updateMany({
    where: claimWhere,
    data: {
      status: "processing",
      startedAt: new Date(),
      error: null,
      completedAt: null,
    },
  });

  if (!claimedJobs.length) {
    logInfo("demo_agent.job_claim_lost", {
      jobId,
      leadId: job.leadId,
      previousStatus: job.status,
    });
    return;
  }

  logInfo("demo_agent.job_start", {
    jobId,
    leadId: job.leadId,
    profileId: job.profile.id,
    rootUrl: job.rootUrl,
  });

  try {
    const crawlResult = await crawlLeadWebsite(job.rootUrl);

    await prisma.$transaction(async (tx: typeof prisma) => {
      await tx.leadWebsitePage.deleteMany({
        where: { scrapeJobId: jobId },
      });

      if (crawlResult.pages.length) {
        await tx.leadWebsitePage.createMany({
          data: crawlResult.pages.map((page) => ({
            scrapeJobId: jobId,
            leadId: job.leadId,
            organizationId: job.organizationId,
            url: page.url,
            canonicalUrl: page.canonicalUrl,
            pageType: page.pageType,
            httpStatus: page.httpStatus,
            title: page.title,
            metaDescription: page.metaDescription,
            cleanedText: page.cleanedText,
            jsonLd: page.jsonLd,
            extractedJson: {
              pageType: page.pageType,
            },
            contentHash: contentHash(`${page.url}\n${page.cleanedText}`),
          })),
        });
      }

      await tx.leadWebsiteScrapeJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          pagesDiscovered: crawlResult.pagesDiscovered,
          pagesScraped: crawlResult.pages.length,
          pagesFailed: crawlResult.pagesFailed,
          completedAt: new Date(),
        },
      });
    });

    const extraction = await executeLeadProfileExtraction({
      leadDemoProfileId: String(job.profile.id),
      scrapeJobId: jobId,
      force: true,
    });
    const summary = extraction.result ? summarizeExtractedProfile(extraction.result.snapshot) : null;

    logInfo("demo_agent.extraction_complete", {
      jobId,
      leadId: job.leadId,
      pagesScraped: crawlResult.pages.length,
      pagesDiscovered: crawlResult.pagesDiscovered,
      pagesFailed: crawlResult.pagesFailed,
      businessName: summary?.businessName ?? null,
      servicesCount: summary?.servicesCount ?? 0,
      faqsCount: summary?.faqsCount ?? 0,
      hasHours: summary?.hasHours ?? false,
      hasPricing: summary?.hasPricing ?? false,
      extractionConfidence: extraction.result ? Number((extraction.result.quality.score / 100).toFixed(2)) : null,
      qualityStatus: extraction.result?.quality.status ?? null,
      isDemoReady: extraction.result?.quality.isDemoReady ?? false,
    });

    if (autoActivateJobs.has(jobId) && extraction.result?.quality.isDemoReady) {
      await activateLeadDemoAgent(job.leadId);
    } else if (autoActivateJobs.has(jobId)) {
      logWarn("demo_agent.auto_activate_blocked_quality", {
        jobId,
        leadId: job.leadId,
        profileId: job.profile.id,
        qualityStatus: extraction.result?.quality.status ?? null,
        blockers: extraction.result?.quality.blockers ?? [],
      });
    }

    logInfo("demo_agent.job_complete", {
      jobId,
      leadId: job.leadId,
      profileId: job.profile.id,
      autoActivated: autoActivateJobs.has(jobId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Lead website scraping failed";
    const latestJob = await prisma.leadWebsiteScrapeJob.findUnique({
      where: { id: jobId },
    });

    logError("demo_agent.job_failed", {
      jobId,
      leadId: job.leadId,
      rootUrl: job.rootUrl,
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });

    if (latestJob?.status === "completed") {
      await prisma.leadDemoProfile.update({
        where: { id: job.profile!.id },
        data: {
          status: "failed",
          extractionStatus: "failed",
          demoReadyBlockers: [message],
          isDemoReady: false,
        },
      });
      logWarn("demo_agent.job_failed_after_scrape_completed", {
        jobId,
        leadId: job.leadId,
        error: message,
      });
      throw error;
    }

    await prisma.$transaction(async (tx: typeof prisma) => {
      await tx.leadWebsiteScrapeJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          error: message,
          completedAt: new Date(),
        },
      });

      await tx.leadDemoProfile.update({
        where: { id: job.profile!.id },
        data: {
          status: "failed",
        },
      });
    });

    throw error;
  }
}

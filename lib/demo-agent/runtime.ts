import { randomUUID } from "node:crypto";

import { DEFAULT_DEMO_AGENT_DB_ID, PUBLIC_DEMO_AGENT_ID, type ExtractedProfile, weekdayOrder } from "@/lib/demo-agent/contracts";
import { buildVoiceContextCompact } from "@/lib/elevenlabs/voice-context";
import { contentHash, normalizeServiceName } from "@/lib/demo-agent/extraction";
import { env, requireEnv } from "@/lib/env";
import { logInfo, logWarn } from "@/lib/logger";

type RuntimeWriteResult = {
  clinicId: string;
};

export const STALE_RUNTIME_CONFIG_WARNING =
  "Supabase was updated, but deployed runtime config may still be stale. Republish or sync Hetzner env for agent-87112821-4661-4dd9-a22e-ba57b48feb17.";

type RuntimeRefreshResult = {
  attempted: boolean;
  ok: boolean;
  warning: string | null;
};

async function getSupabaseAdmin() {
  const { createClient } = await import("@supabase/supabase-js");

  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function getRuntimeOrganizationId() {
  return requireEnv("DEMO_RUNTIME_ORGANIZATION_ID");
}

function getDemoPhone() {
  return requireEnv("DEMO_TELNYX_PHONE_E164");
}

function getAgentDbId() {
  return env.EXISTING_DEMO_AGENT_DB_ID ?? DEFAULT_DEMO_AGENT_DB_ID;
}

function cleanRuntimeSentence(input: string) {
  const text = input.replace(/\bSource:\s*\S+/gi, "").replace(/\s+([,.!?;:])/g, "$1").trim();
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function listForSpeech(items: string[]) {
  const values = items.map((item) => item.trim()).filter(Boolean);
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

export function buildKnowledgeArticles(profile: ExtractedProfile, clinicId: string, organizationId: string) {
  const voiceContext = buildVoiceContextCompact({
    extractedProfileJson: profile,
    leadId: "",
    phoneE164: profile.clinic.phone,
  });
  const safePricedServices = profile.services.filter((service) =>
    service.price_text &&
    !service.rejected &&
    !["staff", "navigation", "product", "unknown"].includes(service.service_kind ?? "service") &&
    !/\b(get in touch|contact|book now|gift card|address|staff|team|prices|all services|menu of services)\b/i.test(service.name)
  );
  const articles = [
    {
      organization_id: organizationId,
      clinic_id: clinicId,
      title: "Services Overview",
      category: "Services",
      active: true,
      body: voiceContext.service_categories_short || voiceContext.service_menu_short
        ? cleanRuntimeSentence(`${profile.clinic.name} offers ${voiceContext.service_categories_short || voiceContext.service_menu_short.replace(/^The menu includes\s+/i, "")}.`)
        : "Services are not clearly published. The office can confirm current offerings.",
    },
    {
      organization_id: organizationId,
      clinic_id: clinicId,
      title: "Service Pricing",
      category: "Pricing",
      active: true,
      body: voiceContext.pricing_lookup_text
        ? voiceContext.pricing_lookup_text.split(";").map((entry) => cleanRuntimeSentence(entry)).join(" ")
        : safePricedServices.length
          ? safePricedServices.map((service) => cleanRuntimeSentence(`For ${service.name}, ${service.price_text}`)).join(" ")
        : "Pricing is not published. The office can confirm current pricing.",
    },
    {
      organization_id: organizationId,
      clinic_id: clinicId,
      title: "Clinic Hours",
      category: "Hours",
      active: true,
      body: weekdayOrder
        .map((day) => {
          const hours = profile.hours[day];
          const label = day.charAt(0).toUpperCase() + day.slice(1);
          return hours.open ? `${label}: ${hours.start} to ${hours.end}.` : `${label}: Closed.`;
        })
        .join(" "),
    },
    {
      organization_id: organizationId,
      clinic_id: clinicId,
      title: "Clinic Location",
      category: "Location",
      active: true,
      body: cleanRuntimeSentence(`${profile.clinic.name} is located at ${[profile.clinic.address.line1, profile.clinic.address.city, profile.clinic.address.state, profile.clinic.address.zip].filter(Boolean).join(", ")}. Phone: ${profile.clinic.phone || "not published"}. Email: ${profile.clinic.email || "not published"}.`),
    },
    ...profile.faqs.map((faq) => ({
      organization_id: organizationId,
      clinic_id: clinicId,
      title: faq.question,
      category: faq.category || "FAQ",
      active: true,
      body: cleanRuntimeSentence(faq.answer),
    })),
    ...profile.policies.map((policy) => ({
      organization_id: organizationId,
      clinic_id: clinicId,
      title: policy.title,
      category: "Policy",
      active: true,
      body: cleanRuntimeSentence(policy.body),
    })),
  ];

  return articles;
}

export function buildAgentSettingsConfig(profile: ExtractedProfile) {
  return {
    clinic: {
      name: profile.clinic.name,
      phone: profile.clinic.phone,
      email: profile.clinic.email,
      website: profile.clinic.website,
      address: profile.clinic.address,
      timezone: profile.clinic.timezone,
    },
    industry_type: profile.clinic.industry,
    working_hours: Object.fromEntries(
      weekdayOrder.map((day) => {
        const hours = profile.hours[day];
        return [day.slice(0, 3), hours.open && hours.start && hours.end ? [{ start: hours.start, end: hours.end }] : []];
      }),
    ),
    treatment_durations: Object.fromEntries(
      profile.services.filter((service) => service.duration_minutes).map((service) => [service.name, service.duration_minutes]),
    ),
    services: profile.services.map((service) => ({
      name: service.name,
      category: service.category ?? service.voice_category ?? null,
      subcategory: service.subcategory ?? null,
      voice_label: service.voice_label ?? service.name,
      voice_category: service.voice_category ?? service.category ?? null,
      duration: service.duration_minutes,
      price: service.price_summary ?? service.price_text,
      price_available: service.price_available ?? Boolean(service.price_text),
      enabled: service.confidence >= 0.55,
    })),
    faqs: profile.faqs.map((faq) => ({
      question: faq.question,
      answer: faq.answer,
      category: faq.category,
    })),
    policies: profile.policies.map((policy) => ({
      title: policy.title,
      body: policy.body,
    })),
    collect_insurance: true,
    agent_role: "receptionist",
    custom_instructions:
      "Answer as the receptionist for this clinic using only the configured clinic data. If information is unknown, say you can have the office confirm it.",
  };
}

export function buildDeployPublishEndpoint(baseUrl: string, agentDbId = DEFAULT_DEMO_AGENT_DB_ID) {
  const trimmed = baseUrl.trim();
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const base = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  return `${base}/api/agents/${agentDbId}/publish`;
}

function buildDeployAuthHeaders(): HeadersInit {
  const key = env.DEPLOY_API_KEY?.trim();

  if (!key) {
    return {};
  }

  const looksLikePath =
    /^[a-zA-Z]:[\\/]/.test(key) ||
    key.startsWith("/") ||
    /(^|[\\/])id_(rsa|ed25519)(\.pub)?$/i.test(key) ||
    /\.(pem|ppk|key)$/i.test(key);

  if (looksLikePath) {
    logWarn("demo_agent.deploy_refresh_skipped_invalid_auth", {
      reason: "DEPLOY_API_KEY appears to be a file path, but deploy refresh expects a bearer token",
    });
    return {};
  }

  return { authorization: `Bearer ${key}` };
}

export async function refreshDeployedRuntimeConfig(agentDbId = getAgentDbId()): Promise<RuntimeRefreshResult> {
  if (!env.DEPLOY_API_URL) {
    return {
      attempted: false,
      ok: false,
      warning: STALE_RUNTIME_CONFIG_WARNING,
    };
  }

  const endpoint = buildDeployPublishEndpoint(env.DEPLOY_API_URL, agentDbId);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...buildDeployAuthHeaders(),
      },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const warning = `Supabase was updated, but deploy refresh failed with HTTP ${response.status}. Republish or sync Hetzner env for ${PUBLIC_DEMO_AGENT_ID}.`;
      logWarn("demo_agent.deploy_refresh_failed", { endpoint, status: response.status, detail: detail.slice(0, 500) });
      return { attempted: true, ok: false, warning };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const detail = await response.text().catch(() => "");
      const warning = `Supabase was updated, but deploy refresh returned a non-JSON response. Check DEPLOY_API_URL for ${PUBLIC_DEMO_AGENT_ID}.`;
      logWarn("demo_agent.deploy_refresh_invalid_response", { endpoint, detail: detail.slice(0, 500) });
      return { attempted: true, ok: false, warning };
    }

    const payload = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    if (!payload?.ok) {
      const warning = `Supabase was updated, but deploy refresh did not confirm runtime reload for ${PUBLIC_DEMO_AGENT_ID}.`;
      logWarn("demo_agent.deploy_refresh_not_confirmed", { endpoint, payload });
      return { attempted: true, ok: false, warning };
    }

    logInfo("demo_agent.deploy_refresh_complete", { endpoint, agentDbId });
    return { attempted: true, ok: true, warning: null };
  } catch (error) {
    const warning = `Supabase was updated, but deploy refresh failed: ${error instanceof Error ? error.message : String(error)}. Republish or sync Hetzner env for ${PUBLIC_DEMO_AGENT_ID}.`;
    logWarn("demo_agent.deploy_refresh_error", { endpoint, error: error instanceof Error ? error.message : String(error) });
    return { attempted: true, ok: false, warning };
  }
}

async function maybePopulateNormalizedTables(profile: ExtractedProfile, clinicId: string, organizationId: string) {
  const supabase = await getSupabaseAdmin();

  const servicesPayload = profile.services
    .filter((service) => service.confidence >= 0.55)
    .map((service, index) => ({
      id: randomUUID(),
      organization_id: organizationId,
      clinic_id: clinicId,
      canonical_name: service.name,
      display_name: service.name,
      normalized_name: normalizeServiceName(service.name).toLowerCase(),
      active: true,
      bookable: service.bookable,
      default_duration_minutes: service.duration_minutes,
      sort_order: index,
      source_ref: service.source_url,
    }));

  if (!servicesPayload.length) {
    return;
  }

  const serviceInsert = await supabase.from("services").upsert(servicesPayload);

  if (serviceInsert.error) {
    logWarn("demo_agent.runtime_optional_services_failed", { error: serviceInsert.error.message });
    return;
  }

  const aliasRows = servicesPayload.flatMap((service, index) =>
    profile.services[index]?.aliases.map((alias) => ({
      organization_id: organizationId,
      clinic_id: clinicId,
      service_id: service.id,
      alias,
      normalized_alias: normalizeServiceName(alias).toLowerCase(),
    })) ?? [],
  );

  if (aliasRows.length) {
    const aliasInsert = await supabase.from("service_aliases").upsert(aliasRows);

    if (aliasInsert.error) {
      logWarn("demo_agent.runtime_optional_aliases_failed", { error: aliasInsert.error.message });
    }
  }

  const factRows = servicesPayload.flatMap((service, index) => {
    const profileService = profile.services[index];
    const rows = [];

    if (profileService?.description) {
      rows.push({
        organization_id: organizationId,
        clinic_id: clinicId,
        service_id: service.id,
        fact_type: "description",
        answer_text: cleanRuntimeSentence(profileService.description),
        structured_value_json: null,
        priority: 10,
        source_ref: profileService.source_url,
        content_hash: contentHash(`description:${profileService.description}`),
        active: true,
      });
    }

    if (profileService?.price_text) {
      rows.push({
        organization_id: organizationId,
        clinic_id: clinicId,
        service_id: service.id,
        fact_type: "price",
        answer_text: cleanRuntimeSentence(`For ${profileService.name}, ${profileService.price_text}`),
        structured_value_json: {
          price_text: profileService.price_text,
          currency: "USD",
          min_cents: profileService.price_min_cents,
        },
        priority: 10,
        source_ref: profileService.source_url,
        content_hash: contentHash(`price:${profileService.price_text}`),
        active: true,
      });
    }

    if (profileService?.duration_minutes) {
      rows.push({
        organization_id: organizationId,
        clinic_id: clinicId,
        service_id: service.id,
        fact_type: "duration",
        answer_text: `${profileService.name} typically takes ${profileService.duration_minutes} minutes.`,
        structured_value_json: {
          duration_minutes: profileService.duration_minutes,
        },
        priority: 10,
        source_ref: profileService.source_url,
        content_hash: contentHash(`duration:${profileService.duration_minutes}`),
        active: true,
      });
    }

    return rows;
  });

  if (factRows.length) {
    const factInsert = await supabase.from("service_facts").upsert(factRows);

    if (factInsert.error) {
      logWarn("demo_agent.runtime_optional_facts_failed", { error: factInsert.error.message });
    }
  }

  const faqRows = profile.faqs.map((faq, index) => ({
    organization_id: organizationId,
    clinic_id: clinicId,
    service_id: null,
    category: faq.category,
    fact_type: "faq",
    title: faq.question,
    chunk_text: faq.answer,
    content_hash: contentHash(`${faq.question}:${faq.answer}`),
    source_article_id: null,
    source_ref: faq.source_url,
    chunk_index: index,
    active: true,
  }));

  if (faqRows.length) {
    const faqInsert = await supabase.from("faq_chunks").upsert(faqRows);

    if (faqInsert.error) {
      logWarn("demo_agent.runtime_optional_faq_chunks_failed", { error: faqInsert.error.message });
    }
  }
}

export async function writeRuntimeProfile(profile: ExtractedProfile, clinicId?: string | null): Promise<RuntimeWriteResult> {
  const supabase = await getSupabaseAdmin();
  const organizationId = getRuntimeOrganizationId();
  const resolvedClinicId = clinicId ?? randomUUID();
  const agentId = getAgentDbId();

  logInfo("demo_agent.runtime_write_start", {
    clinicId: resolvedClinicId,
    organizationId,
    agentId,
    businessName: profile.clinic.name,
    servicesCount: profile.services.length,
    faqsCount: profile.faqs.length,
  });

  await supabase
    .from("clinics")
    .upsert({
      id: resolvedClinicId,
      organization_id: organizationId,
      name: profile.clinic.name,
      industry: profile.clinic.industry,
      timezone: profile.clinic.timezone,
      phone: profile.clinic.phone || null,
      email: profile.clinic.email || null,
      address_line1: profile.clinic.address.line1 || null,
      address_line2: profile.clinic.address.line2 || null,
      city: profile.clinic.address.city || null,
      state: profile.clinic.address.state || null,
      zip: profile.clinic.address.zip || null,
      country: profile.clinic.address.country || "US",
      website: profile.clinic.website,
      working_hours: profile.hours,
    })
    .throwOnError();

  const agentSettingsPayload = {
    organization_id: organizationId,
    agent_id: agentId,
    greeting_text: `Thank you for calling ${profile.clinic.name}. How can I help you today?`,
    persona_tone: "professional",
    voice_id: null,
    config_json: buildAgentSettingsConfig(profile),
  };
  const existingAgentSettings = await supabase.from("agent_settings").select("agent_id").eq("agent_id", agentId).maybeSingle();

  if (existingAgentSettings.data) {
    await supabase.from("agent_settings").update(agentSettingsPayload).eq("agent_id", agentId).throwOnError();
  } else {
    await supabase.from("agent_settings").insert(agentSettingsPayload).throwOnError();
  }

  await supabase.from("clinic_hours").delete().eq("clinic_id", resolvedClinicId).throwOnError();
  const clinicHoursRows = weekdayOrder.map((day, index) => ({
    organization_id: organizationId,
    clinic_id: resolvedClinicId,
    weekday: index,
    open_time: profile.hours[day].start,
    close_time: profile.hours[day].end,
    closed: !profile.hours[day].open,
  }));
  await supabase.from("clinic_hours").insert(clinicHoursRows).throwOnError();

  await supabase.from("knowledge_articles").delete().eq("clinic_id", resolvedClinicId).throwOnError();
  await supabase.from("knowledge_articles").insert(buildKnowledgeArticles(profile, resolvedClinicId, organizationId)).throwOnError();

  await maybePopulateNormalizedTables(profile, resolvedClinicId, organizationId);

  const syncRequest = await supabase.rpc("request_clinic_knowledge_sync", {
    organization_id: organizationId,
    clinic_id: resolvedClinicId,
    triggered_by: "lead_website_scraper",
    reason: "Lead demo profile activated",
  });

  if (syncRequest.error) {
    logWarn("demo_agent.runtime_knowledge_sync_request_failed", { error: syncRequest.error.message });
  }

  logInfo("demo_agent.runtime_write_complete", {
    clinicId: resolvedClinicId,
    organizationId,
    agentId,
  });

  return {
    clinicId: resolvedClinicId,
  };
}

async function verifyRuntimeActivation(input: {
  agentId: string;
  clinicId: string;
  clinicName: string;
  organizationId: string;
  phone: string;
}) {
  const supabase = await getSupabaseAdmin();

  const [agentResult, phoneResult, settingsResult, articlesResult] = await Promise.all([
    supabase.from("agents").select("id,clinic_id,organization_id,status").eq("id", input.agentId).maybeSingle(),
    supabase.from("phone_numbers").select("phone_e164,clinic_id,organization_id,agent_id,status,telephony_provider").eq("phone_e164", input.phone).maybeSingle(),
    supabase.from("agent_settings").select("agent_id,greeting_text,config_json").eq("agent_id", input.agentId).maybeSingle(),
    supabase.from("knowledge_articles").select("id", { count: "exact", head: true }).eq("clinic_id", input.clinicId),
  ]);

  if (agentResult.error) throw new Error(`Activation verification failed for agents: ${agentResult.error.message}`);
  if (phoneResult.error) throw new Error(`Activation verification failed for phone_numbers: ${phoneResult.error.message}`);
  if (settingsResult.error) throw new Error(`Activation verification failed for agent_settings: ${settingsResult.error.message}`);
  if (articlesResult.error) throw new Error(`Activation verification failed for knowledge_articles: ${articlesResult.error.message}`);

  if (!agentResult.data || agentResult.data.clinic_id !== input.clinicId || agentResult.data.organization_id !== input.organizationId) {
    throw new Error("Activation verification failed: agents row does not point to the activated clinic.");
  }

  if (
    !phoneResult.data ||
    phoneResult.data.clinic_id !== input.clinicId ||
    phoneResult.data.organization_id !== input.organizationId ||
    phoneResult.data.agent_id !== input.agentId ||
    phoneResult.data.status !== "active" ||
    phoneResult.data.telephony_provider !== "telnyx"
  ) {
    throw new Error("Activation verification failed: phone number row does not point to the activated clinic and agent.");
  }

  const settingsText = JSON.stringify(settingsResult.data ?? {});

  if (!input.clinicName || !settingsResult.data || !settingsText.includes(input.clinicName) || /bella medspa/i.test(settingsText)) {
    throw new Error("Activation verification failed: agent settings still look stale.");
  }

  if ((articlesResult.count ?? 0) < 1) {
    throw new Error("Activation verification failed: no knowledge articles were written for the activated clinic.");
  }

  logInfo("demo_agent.runtime_verify_complete", {
    agentId: input.agentId,
    clinicId: input.clinicId,
    phone: input.phone,
    knowledgeArticles: articlesResult.count ?? 0,
  });
}

export async function activateRuntimeProfile(leadId: string, leadDemoProfileId: string, clinicId: string) {
  const supabase = await getSupabaseAdmin();
  const organizationId = getRuntimeOrganizationId();
  const agentId = getAgentDbId();
  const phone = getDemoPhone();

  const currentAgent = await supabase.from("agents").select("clinic_id").eq("id", agentId).maybeSingle();
  const previousClinicId = currentAgent.data?.clinic_id ?? null;

  if (currentAgent.error) {
    logWarn("demo_agent.runtime_current_agent_lookup_failed", { error: currentAgent.error.message, agentId });
  }

  await supabase
    .from("agents")
    .update({
      clinic_id: clinicId,
      organization_id: organizationId,
      status: "live",
      default_language: "en-US",
      updated_at: new Date().toISOString(),
    })
    .eq("id", agentId)
    .throwOnError();

  await supabase
    .from("phone_numbers")
    .update({
      clinic_id: clinicId,
      organization_id: organizationId,
      agent_id: agentId,
      telephony_provider: "telnyx",
      status: "active",
    })
    .eq("phone_e164", phone)
    .throwOnError();

  const clinicResult = await supabase.from("clinics").select("name").eq("id", clinicId).maybeSingle();

  if (clinicResult.error) {
    throw new Error(`Activation verification failed for clinics: ${clinicResult.error.message}`);
  }

  await verifyRuntimeActivation({
    agentId,
    clinicId,
    clinicName: clinicResult.data?.name ?? "",
    organizationId,
    phone,
  });

  return {
    agentId: PUBLIC_DEMO_AGENT_ID,
    agentDbId: agentId,
    previousClinicId,
    phoneE164: phone,
    organizationId,
    leadId,
    leadDemoProfileId,
  };
}

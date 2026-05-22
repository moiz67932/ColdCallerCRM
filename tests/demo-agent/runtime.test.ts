import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyExtractedProfile, createExtractedService, PUBLIC_DEMO_AGENT_ID } from "@/lib/demo-agent/contracts";
import { formatActivationResult } from "@/lib/demo-agent/responses";
import { buildAgentSettingsConfig, buildDeployPublishEndpoint, buildKnowledgeArticles, STALE_RUNTIME_CONFIG_WARNING } from "@/lib/demo-agent/runtime";

function makeProfile() {
  const profile = createEmptyExtractedProfile("https://clinic.com");
  profile.clinic.name = "Bright Smile Dental";
  profile.clinic.phone = "+13105550123";
  profile.clinic.address.line1 = "123 Main St";
  profile.clinic.address.city = "Austin";
  profile.clinic.address.state = "TX";
  profile.clinic.address.zip = "78701";
  profile.hours.monday = { open: true, start: "09:00", end: "17:00" };
  profile.services = [
    createExtractedService({
      name: "Teeth Whitening",
      aliases: ["Whitening"],
      description: "Professional whitening treatment",
      duration_minutes: 60,
      price_text: "Starts at $299",
      price_min_cents: 29900,
      bookable: true,
      source_url: "https://clinic.com/services",
      confidence: 0.9,
    }),
  ];
  profile.faqs = [
    {
      question: "Do you accept insurance?",
      answer: "Yes, most PPO plans.",
      category: "Insurance",
      source_url: "https://clinic.com/faq",
      confidence: 0.8,
    },
  ];

  return profile;
}

test("buildKnowledgeArticles includes a truthful pricing fallback", () => {
  const profile = makeProfile();
  profile.services[0].price_text = null;
  profile.services[0].price_min_cents = null;

  const articles = buildKnowledgeArticles(profile, "clinic-1", "org-1");
  const pricingArticle = articles.find((article) => article.category === "Pricing");

  assert.ok(pricingArticle);
  assert.match(pricingArticle.body, /Pricing is not published/i);
});

test("buildKnowledgeArticles does not speak source URLs", () => {
  const articles = buildKnowledgeArticles(makeProfile(), "clinic-1", "org-1");

  assert.equal(articles.some((article) => /Source:|https:\/\/clinic\.com/i.test(article.body)), false);
  assert.match(articles.find((article) => article.category === "Pricing")?.body ?? "", /For Teeth Whitening/i);
});

test("buildAgentSettingsConfig maps services into receptionist config", () => {
  const config = buildAgentSettingsConfig(makeProfile());

  assert.equal(config.agent_role, "receptionist");
  assert.equal(config.clinic.name, "Bright Smile Dental");
  assert.equal(config.services[0].name, "Teeth Whitening");
  assert.equal(config.treatment_durations["Teeth Whitening"], 60);
  assert.equal(config.faqs[0].question, "Do you accept insurance?");
});

test("formatActivationResult always returns the shared public demo agent id", () => {
  const result = formatActivationResult({
    clinicId: "clinic-1",
    leadDemoProfileId: "profile-1",
    phoneE164: "+13105550123",
    agentDbId: "87112821-4661-4dd9-a22e-ba57b48feb17",
    runtimeRefresh: {
      attempted: false,
      ok: false,
      warning: STALE_RUNTIME_CONFIG_WARNING,
    },
  });

  assert.equal(result.agent_id, PUBLIC_DEMO_AGENT_ID);
  assert.equal(result.status, "active");
  assert.equal(result.warning, STALE_RUNTIME_CONFIG_WARNING);
});

test("buildDeployPublishEndpoint targets the existing shared agent", () => {
  assert.equal(
    buildDeployPublishEndpoint("https://deploy.example.com/"),
    "https://deploy.example.com/api/agents/87112821-4661-4dd9-a22e-ba57b48feb17/publish",
  );
});

test("buildDeployPublishEndpoint normalizes bare deploy host values", () => {
  assert.equal(
    buildDeployPublishEndpoint("178.104.70.97"),
    "http://178.104.70.97/api/agents/87112821-4661-4dd9-a22e-ba57b48feb17/publish",
  );
});

test("buildDeployPublishEndpoint preserves explicit deploy ports", () => {
  assert.equal(
    buildDeployPublishEndpoint("http://178.104.70.97:8001"),
    "http://178.104.70.97:8001/api/agents/87112821-4661-4dd9-a22e-ba57b48feb17/publish",
  );
});

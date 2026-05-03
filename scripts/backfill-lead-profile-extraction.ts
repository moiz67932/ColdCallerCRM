import { executeLeadProfileExtraction, printExtractionSummary } from "@/lib/demo-agent/profile-pipeline";

function readArgs() {
  const args = process.argv.slice(2);
  const leadDemoProfileId = args.find((arg) => !arg.startsWith("--"));
  return {
    leadDemoProfileId,
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    scrapeJobId: args.find((arg) => arg.startsWith("--scrape-job-id="))?.split("=")[1] ?? null,
  };
}

async function main() {
  const args = readArgs();
  if (!args.leadDemoProfileId) {
    throw new Error("Usage: npm run demo-agent:backfill -- <lead_demo_profile_id> [--dry-run] [--force] [--scrape-job-id=<id>]");
  }

  const result = await executeLeadProfileExtraction({
    leadDemoProfileId: args.leadDemoProfileId,
    scrapeJobId: args.scrapeJobId,
    dryRun: args.dryRun,
    force: args.force,
  });

  if (result.skipped) {
    console.log(`Skipped existing extraction run: ${result.extractionRunId}`);
    console.log(printExtractionSummary((result.summary ?? {}) as Record<string, unknown>));
    return;
  }

  console.log(`Extraction run: ${result.extractionRunId}`);
  console.log(printExtractionSummary((result.summary ?? {}) as Record<string, unknown>));

  if (result.dryRun && result.result) {
    console.log("\nDry run proposed counts:");
    console.log(JSON.stringify({
      facts: result.result.facts.length,
      locations: result.result.locations.length,
      hours: result.result.hours.length,
      services: result.result.services.length,
      prices: result.result.services.reduce((sum, service) => sum + service.prices.length, 0),
      aliases: result.result.services.reduce((sum, service) => sum + service.aliases.length, 0),
      faqs: result.result.faqs.length,
      offers: result.result.offers.length,
      products: result.result.products.length,
      voice_answers: result.result.voiceAnswers.length,
      knowledge_chunks: result.result.knowledgeChunks.length,
      quality: result.result.quality,
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    ADMIN_PASSWORD: z.string().optional(),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    EXISTING_DEMO_AGENT_ID: z.string().optional(),
    EXISTING_DEMO_AGENT_DB_ID: z.string().optional(),
    DEMO_RUNTIME_ORGANIZATION_ID: z.string().optional(),
    DEMO_TELNYX_PHONE_E164: z.string().optional(),
    DEMO_VOICE_PROVIDER: z.enum(["elevenlabs", "hetzner", "livekit"]).optional(),
    ELEVENLABS_AGENT_ID: z.string().optional(),
    ELEVENLABS_PHONE_E164: z.string().optional(),
    ELEVENLABS_TOOL_SECRET: z.string().optional(),
    ELEVENLABS_WEBHOOK_SECRET: z.string().optional(),
    SCRAPER_USER_AGENT: z.string().optional(),
    SCRAPER_MAX_PAGES: z.coerce.number().int().positive().optional(),
    SCRAPER_MAX_DEPTH: z.coerce.number().int().nonnegative().optional(),
    SCRAPER_CONCURRENCY: z.coerce.number().int().positive().optional(),
    SCRAPER_PAGE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    SCRAPER_MAX_TEXT_CHARS: z.coerce.number().int().positive().optional(),
    SCRAPER_MAX_HTML_CHARS: z.coerce.number().int().positive().optional(),
    SCRAPER_RESPECT_ROBOTS_TXT: z.enum(["true", "false"]).optional(),
    DEMO_PROFILE_EXTRACTION_MODE: z.enum(["strict", "legacy"]).default("strict"),
    EXTRACTION_MODE: z.enum(["free", "openai"]).optional(),
    OPENAI_API_KEY: z.string().optional(),
    EXTRACTION_MODEL: z.string().optional(),
    TELNYX_API_KEY: z.string().optional(),
    TELNYX_CONNECTION_ID: z.string().optional(),
    TELNYX_TELEPHONY_CREDENTIAL_ID: z.string().optional(),
    TELNYX_FROM_NUMBER: z.string().optional(),
    TELNYX_MESSAGING_FROM_NUMBER: z.string().optional(),
    TELNYX_WHATSAPP_FROM_NUMBER: z.string().optional(),
    TELNYX_WHATSAPP_PAYMENT_LINK_TEMPLATE: z.string().optional(),
    TELNYX_WHATSAPP_CONFIRMATION_TEMPLATE: z.string().optional(),
    TELNYX_WHATSAPP_REMINDER_TEMPLATE: z.string().optional(),
    TELNYX_WHATSAPP_PAYMENT_LINK_TEMPLATE_ID: z.string().optional(),
    TELNYX_WHATSAPP_CONFIRMATION_TEMPLATE_ID: z.string().optional(),
    TELNYX_WHATSAPP_MANUAL_REVIEW_TEMPLATE_ID: z.string().optional(),
    TELNYX_WHATSAPP_WEBHOOK_URL: z.string().url().optional(),
    TELNYX_MANUAL_DIAL_FLOW: z.enum(["browser_first", "pstn_first"]).default("browser_first"),
    TELNYX_PUBLIC_KEY: z.string().optional(),
    NEXT_PUBLIC_APP_NAME: z.string().default("ColdCaller CRM"),
    APP_BASE_URL: z.string().url().optional(),
    PUBLIC_APP_URL: z.string().url().optional(),
    PAY_LINK_SECRET: z.string().optional(),
    DEPLOY_API_URL: z.string().optional(),
    DEPLOY_API_KEY: z.string().optional(),
    SQUARE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
    SQUARE_BASE_URL: z.string().url().default("https://connect.squareupsandbox.com"),
    SQUARE_API_VERSION: z.string().default("2026-05-20"),
    SQUARE_ACCESS_TOKEN: z.string().optional(),
    SQUARE_LOCATION_ID: z.string().optional(),
    SQUARE_TEAM_MEMBER_ID: z.string().optional(),
    SQUARE_BOTOX_SERVICE_VARIATION_ID: z.string().optional(),
    SQUARE_BOTOX_SERVICE_VARIATION_VERSION: z.string().optional(),
    SQUARE_BOTOX_DURATION_MINUTES: z.string().optional(),
    SQUARE_BOTOX_DEPOSIT_AMOUNT_CENTS: z.string().optional(),
    SQUARE_CURRENCY: z.string().default("USD"),
    SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().optional(),
    SQUARE_WEBHOOK_NOTIFICATION_URL: z.string().url().optional(),
    TELNYX_SKIP_SIGNATURE_VERIFICATION: z.enum(["true", "false"]).optional(),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  })
  .passthrough();

export const env = envSchema.parse(process.env);

export function requireEnv(name: keyof typeof env): string {
  const value = env[name];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getRequiredEnvStatus() {
  return {
    ADMIN_PASSWORD: Boolean(env.ADMIN_PASSWORD),
    SUPABASE_URL: Boolean(env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
    TELNYX_API_KEY: Boolean(env.TELNYX_API_KEY),
    TELNYX_CONNECTION_ID: Boolean(env.TELNYX_CONNECTION_ID),
    TELNYX_TELEPHONY_CREDENTIAL_ID: Boolean(env.TELNYX_TELEPHONY_CREDENTIAL_ID),
    TELNYX_FROM_NUMBER: Boolean(env.TELNYX_FROM_NUMBER),
    NEXT_PUBLIC_APP_NAME: Boolean(env.NEXT_PUBLIC_APP_NAME),
  };
}

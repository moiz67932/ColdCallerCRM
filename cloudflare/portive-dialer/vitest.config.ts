import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'},miniflare:{bindings:{
 DEPLOYMENT_ENV:'test',DIALER_CALLER_NAME:'Fixture Business',DIALER_CLOUDFLARE_SECRET:'local-fixture-secret-at-least-32-characters',SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture-service-key',TELNYX_API_KEY:'fixture-telnyx-key',TELNYX_PUBLIC_KEY:'11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=',TELNYX_PARALLEL_CONNECTION_ID:'app',TELNYX_TELEPHONY_CREDENTIAL_ID:'credential',TELNYX_FROM_NUMBER:'+12125550100',VERCEL_VOICE_WEBHOOK_URL:'https://portive.example/api/webhooks/telnyx/voice',DIALER_PARALLEL_ENABLED:'true'
}}})],test:{include:['test/**/*.test.ts']}});

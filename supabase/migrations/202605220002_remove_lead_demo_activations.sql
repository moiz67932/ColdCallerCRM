drop table if exists public.lead_demo_activations;

comment on table public.elevenlabs_demo_bindings is
  'Legacy routing bindings table retained for compatibility. Inbound demo calls now use the shared demo clinic agent context instead of per-lead activation.';

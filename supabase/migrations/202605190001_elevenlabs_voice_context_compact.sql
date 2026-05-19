alter table public.elevenlabs_demo_bindings
  add column if not exists voice_context_compact_json jsonb not null default '{}'::jsonb;

comment on column public.elevenlabs_demo_bindings.voice_context_compact_json is
  'Precomputed compact, voice-safe ElevenLabs tool context used during live demo calls.';

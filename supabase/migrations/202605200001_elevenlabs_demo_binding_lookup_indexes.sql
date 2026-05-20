create index if not exists elevenlabs_demo_bindings_status_idx
  on public.elevenlabs_demo_bindings(status);

create index if not exists elevenlabs_demo_bindings_agent_idx
  on public.elevenlabs_demo_bindings(elevenlabs_agent_id);

create index if not exists elevenlabs_demo_bindings_phone_idx
  on public.elevenlabs_demo_bindings(phone_e164);

create index if not exists elevenlabs_demo_bindings_caller_idx
  on public.elevenlabs_demo_bindings(caller_e164);

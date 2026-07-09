alter table public.sms_messages
  alter column lead_id drop not null;

alter table public.sms_messages
  add column if not exists template_key text,
  add column if not exists error_code text,
  add column if not exists error_message text,
  add column if not exists consent_source text,
  add column if not exists consent_note text,
  add column if not exists sent_by text;

create index if not exists sms_messages_telnyx_message_id_idx on public.sms_messages(telnyx_message_id);
create index if not exists sms_messages_status_created_at_idx on public.sms_messages(status, created_at desc);

do $$
declare
  v_org_id uuid := '54673cc5-1b6d-4b53-af05-e1d792c466fd';
  v_clinic_id uuid := '11111111-2222-4333-8444-555555555555';
  v_agent_id uuid := '87112821-4661-4dd9-a22e-ba57b48feb17';
  v_phone_e164 text := '+13103318914';
begin
  v_org_id := coalesce(
    (select organization_id from public.agents where id = v_agent_id limit 1),
    v_org_id
  );

  insert into public.clinics (
    id,
    organization_id,
    name,
    industry,
    timezone,
    phone,
    email,
    address_line1,
    address_line2,
    city,
    state,
    zip,
    country,
    website,
    working_hours
  )
  values (
    v_clinic_id,
    v_org_id,
    'Portive Clinic',
    'med_spa',
    'America/Los_Angeles',
    v_phone_e164,
    'hello@portiveclinic.example',
    '1200 Coastline Center',
    'Suite 210',
    'Newport Beach',
    'CA',
    '92660',
    'US',
    'https://portiveclinic.example',
    '{
      "monday": {"open": true, "start": "09:00", "end": "18:00"},
      "tuesday": {"open": true, "start": "09:00", "end": "18:00"},
      "wednesday": {"open": true, "start": "09:00", "end": "18:00"},
      "thursday": {"open": true, "start": "09:00", "end": "18:00"},
      "friday": {"open": true, "start": "09:00", "end": "18:00"},
      "saturday": {"open": true, "start": "10:00", "end": "15:00"},
      "sunday": {"open": false, "start": null, "end": null}
    }'::jsonb
  )
  on conflict (id) do update set
    organization_id = excluded.organization_id,
    name = excluded.name,
    industry = excluded.industry,
    timezone = excluded.timezone,
    phone = excluded.phone,
    email = excluded.email,
    address_line1 = excluded.address_line1,
    address_line2 = excluded.address_line2,
    city = excluded.city,
    state = excluded.state,
    zip = excluded.zip,
    country = excluded.country,
    website = excluded.website,
    working_hours = excluded.working_hours;

  update public.agents
  set
    clinic_id = v_clinic_id,
    organization_id = v_org_id,
    status = 'live',
    default_language = 'en-US',
    updated_at = now()
  where id = v_agent_id;

  update public.phone_numbers
  set
    clinic_id = v_clinic_id,
    organization_id = v_org_id,
    agent_id = v_agent_id,
    telephony_provider = 'telnyx',
    status = 'active'
  where phone_e164 = v_phone_e164;

  if exists (select 1 from public.agent_settings where agent_id = v_agent_id) then
    update public.agent_settings
    set
      organization_id = v_org_id,
      greeting_text = 'Thank you for calling Portive Clinic. How can I help you today?',
      persona_tone = 'professional',
      voice_id = null,
      config_json = jsonb_build_object(
        'clinic', jsonb_build_object(
          'name', 'Portive Clinic',
          'phone', v_phone_e164,
          'email', 'hello@portiveclinic.example',
          'website', 'https://portiveclinic.example',
          'timezone', 'America/Los_Angeles',
          'address', jsonb_build_object(
            'line1', '1200 Coastline Center',
            'line2', 'Suite 210',
            'city', 'Newport Beach',
            'state', 'CA',
            'zip', '92660',
            'country', 'US'
          )
        ),
        'industry_type', 'med_spa',
        'working_hours', jsonb_build_object(
          'mon', jsonb_build_array(jsonb_build_object('start', '09:00', 'end', '18:00')),
          'tue', jsonb_build_array(jsonb_build_object('start', '09:00', 'end', '18:00')),
          'wed', jsonb_build_array(jsonb_build_object('start', '09:00', 'end', '18:00')),
          'thu', jsonb_build_array(jsonb_build_object('start', '09:00', 'end', '18:00')),
          'fri', jsonb_build_array(jsonb_build_object('start', '09:00', 'end', '18:00')),
          'sat', jsonb_build_array(jsonb_build_object('start', '10:00', 'end', '15:00')),
          'sun', jsonb_build_array()
        ),
        'services', '[
          {"name":"Botox and Dysport","category":"Injectables","duration":"30 minutes","price":"$13-$15 per unit","enabled":true},
          {"name":"Dermal Fillers","category":"Injectables","duration":"45-60 minutes","price":"$650-$850 per syringe","enabled":true},
          {"name":"Lip Filler","category":"Injectables","duration":"45 minutes","price":"from $650","enabled":true},
          {"name":"Kybella","category":"Injectables","duration":"30 minutes","price":"from $600 per vial","enabled":true},
          {"name":"Hydrafacial","category":"Facials","duration":"45 minutes","price":"$199-$275","enabled":true},
          {"name":"Custom Medical Facial","category":"Facials","duration":"60 minutes","price":"$165-$225","enabled":true},
          {"name":"Chemical Peel","category":"Skin Treatments","duration":"30-45 minutes","price":"$175-$350","enabled":true},
          {"name":"Microneedling","category":"Skin Treatments","duration":"60 minutes","price":"$399-$499","enabled":true},
          {"name":"PRP Microneedling","category":"Skin Treatments","duration":"75 minutes","price":"$650-$800","enabled":true},
          {"name":"Laser Hair Removal","category":"Laser Services","duration":"15-60 minutes","price":"$95-$450 by area","enabled":true},
          {"name":"IPL Photofacial","category":"Laser Services","duration":"45 minutes","price":"$350-$500","enabled":true},
          {"name":"RF Skin Tightening","category":"Laser Services","duration":"45-60 minutes","price":"$450-$650","enabled":true},
          {"name":"Body Contouring","category":"Body Treatments","duration":"45 minutes","price":"$250-$400 per area","enabled":true},
          {"name":"Wellness Shot","category":"Wellness","duration":"15 minutes","price":"$35-$60","enabled":true},
          {"name":"GLP-1 Weight Wellness Consultation","category":"Wellness","duration":"30 minutes","price":"$99 consultation","enabled":true}
        ]'::jsonb,
        'faqs', '[
          {"question":"Do I need a consultation before treatment?","answer":"For injectables, lasers, body treatments, and weight wellness, Portive Clinic starts with a consultation or provider assessment to confirm the right plan.","category":"Booking"},
          {"question":"Can prices change after the consultation?","answer":"Yes. Published pricing is a starting estimate. Final pricing depends on the treatment plan, area, product amount, and provider assessment.","category":"Pricing"},
          {"question":"Do you take deposits?","answer":"Portive Clinic may request a booking deposit for longer appointments. The team can confirm the deposit amount when scheduling.","category":"Booking"},
          {"question":"What is the cancellation policy?","answer":"Please give at least 24 hours notice to reschedule or cancel. Late cancellations or no-shows may be subject to a fee.","category":"Policy"},
          {"question":"Can I book if I am pregnant or nursing?","answer":"Some treatments may not be appropriate during pregnancy or nursing. A licensed provider can review options during consultation.","category":"Safety"},
          {"question":"Do you provide medical advice over the phone?","answer":"The phone agent can share general service and booking information only. Clinical questions are handled by a licensed provider during consultation.","category":"Safety"}
        ]'::jsonb,
        'collect_insurance', false,
        'agent_role', 'receptionist',
        'custom_instructions', 'Answer as the receptionist for Portive Clinic using only configured Portive Clinic data. Do not provide medical advice. For clinical details, say a licensed provider can explain during consultation.'
      )
    where agent_id = v_agent_id;
  else
    insert into public.agent_settings (
      organization_id,
      agent_id,
      greeting_text,
      persona_tone,
      voice_id,
      config_json
    )
    values (
      v_org_id,
      v_agent_id,
      'Thank you for calling Portive Clinic. How can I help you today?',
      'professional',
      null,
      jsonb_build_object(
        'clinic', jsonb_build_object('name', 'Portive Clinic', 'phone', v_phone_e164, 'timezone', 'America/Los_Angeles'),
        'industry_type', 'med_spa',
        'agent_role', 'receptionist',
        'custom_instructions', 'Answer as the receptionist for Portive Clinic using only configured Portive Clinic data. Do not provide medical advice.'
      )
    );
  end if;

  delete from public.clinic_hours where clinic_id = v_clinic_id;
  insert into public.clinic_hours (organization_id, clinic_id, weekday, open_time, close_time, closed)
  values
    (v_org_id, v_clinic_id, 0, '09:00', '18:00', false),
    (v_org_id, v_clinic_id, 1, '09:00', '18:00', false),
    (v_org_id, v_clinic_id, 2, '09:00', '18:00', false),
    (v_org_id, v_clinic_id, 3, '09:00', '18:00', false),
    (v_org_id, v_clinic_id, 4, '09:00', '18:00', false),
    (v_org_id, v_clinic_id, 5, '10:00', '15:00', false),
    (v_org_id, v_clinic_id, 6, null, null, true);

  delete from public.knowledge_articles where clinic_id = v_clinic_id;
  insert into public.knowledge_articles (organization_id, clinic_id, title, category, active, body)
  values
    (v_org_id, v_clinic_id, 'Services Overview', 'Services', true, 'Portive Clinic is a med spa offering injectables, facials, skin treatments, laser services, body treatments, and wellness appointments. The phone agent should only discuss service names, general scheduling, typical duration, and published price ranges. Clinical questions should be routed to a licensed provider.'),
    (v_org_id, v_clinic_id, 'Injectables', 'Services', true, 'Injectable services include Botox and Dysport at $13-$15 per unit, Dermal Fillers at $650-$850 per syringe, Lip Filler from $650, and Kybella from $600 per vial. These appointments require provider assessment.'),
    (v_org_id, v_clinic_id, 'Facials and Skin Treatments', 'Services', true, 'Facial and skin services include Hydrafacial at $199-$275, Custom Medical Facial at $165-$225, Chemical Peel at $175-$350, Microneedling at $399-$499, and PRP Microneedling at $650-$800.'),
    (v_org_id, v_clinic_id, 'Laser and Body Treatments', 'Services', true, 'Laser and body services include Laser Hair Removal at $95-$450 by area, IPL Photofacial at $350-$500, RF Skin Tightening at $450-$650, and Body Contouring at $250-$400 per area.'),
    (v_org_id, v_clinic_id, 'Wellness Services', 'Services', true, 'Wellness services include Wellness Shot appointments at $35-$60 and GLP-1 Weight Wellness Consultation appointments at $99. Eligibility and treatment plans are confirmed by the clinic team.'),
    (v_org_id, v_clinic_id, 'Pricing Policy', 'Pricing', true, 'Published pricing is a starting estimate. Final pricing depends on treatment plan, treatment area, product amount, and provider assessment. The agent can quote published ranges and offer to schedule a consultation.'),
    (v_org_id, v_clinic_id, 'Hours and Location', 'Hours', true, 'Portive Clinic is located at 1200 Coastline Center, Suite 210, Newport Beach, CA 92660. Hours are Monday through Friday 9:00 AM to 6:00 PM, Saturday 10:00 AM to 3:00 PM, and Sunday closed.'),
    (v_org_id, v_clinic_id, 'Booking and Cancellation Policy', 'Policy', true, 'Portive Clinic may request a deposit for longer appointments. Please give at least 24 hours notice to reschedule or cancel. Late cancellations or no-shows may be subject to a fee.'),
    (v_org_id, v_clinic_id, 'Safety Boundaries', 'Safety', true, 'The phone agent must not provide medical advice, treatment suitability, benefits, risks, or outcome guarantees. For clinical questions, the agent should say a licensed provider can explain during consultation.');

  if to_regclass('public.services') is not null then
    if to_regclass('public.service_aliases') is not null then
      delete from public.service_aliases where clinic_id = v_clinic_id;
    end if;

    if to_regclass('public.service_facts') is not null then
      delete from public.service_facts where clinic_id = v_clinic_id;
    end if;

    delete from public.services where clinic_id = v_clinic_id;
    insert into public.services (
      id,
      organization_id,
      clinic_id,
      canonical_name,
      display_name,
      normalized_name,
      active,
      bookable,
      default_duration_minutes,
      sort_order,
      source_ref
    )
    values
      ('10000000-0000-4000-8000-000000000001', v_org_id, v_clinic_id, 'Botox and Dysport', 'Botox and Dysport', 'botox dysport', true, true, 30, 1, 'portive-clinic://services/injectables'),
      ('10000000-0000-4000-8000-000000000002', v_org_id, v_clinic_id, 'Dermal Fillers', 'Dermal Fillers', 'dermal fillers', true, true, 60, 2, 'portive-clinic://services/injectables'),
      ('10000000-0000-4000-8000-000000000003', v_org_id, v_clinic_id, 'Lip Filler', 'Lip Filler', 'lip filler', true, true, 45, 3, 'portive-clinic://services/injectables'),
      ('10000000-0000-4000-8000-000000000004', v_org_id, v_clinic_id, 'Kybella', 'Kybella', 'kybella', true, true, 30, 4, 'portive-clinic://services/injectables'),
      ('10000000-0000-4000-8000-000000000005', v_org_id, v_clinic_id, 'Hydrafacial', 'Hydrafacial', 'hydrafacial', true, true, 45, 5, 'portive-clinic://services/facials'),
      ('10000000-0000-4000-8000-000000000006', v_org_id, v_clinic_id, 'Custom Medical Facial', 'Custom Medical Facial', 'custom medical facial', true, true, 60, 6, 'portive-clinic://services/facials'),
      ('10000000-0000-4000-8000-000000000007', v_org_id, v_clinic_id, 'Chemical Peel', 'Chemical Peel', 'chemical peel', true, true, 45, 7, 'portive-clinic://services/skin'),
      ('10000000-0000-4000-8000-000000000008', v_org_id, v_clinic_id, 'Microneedling', 'Microneedling', 'microneedling', true, true, 60, 8, 'portive-clinic://services/skin'),
      ('10000000-0000-4000-8000-000000000009', v_org_id, v_clinic_id, 'PRP Microneedling', 'PRP Microneedling', 'prp microneedling', true, true, 75, 9, 'portive-clinic://services/skin'),
      ('10000000-0000-4000-8000-000000000010', v_org_id, v_clinic_id, 'Laser Hair Removal', 'Laser Hair Removal', 'laser hair removal', true, true, 45, 10, 'portive-clinic://services/laser'),
      ('10000000-0000-4000-8000-000000000011', v_org_id, v_clinic_id, 'IPL Photofacial', 'IPL Photofacial', 'ipl photofacial', true, true, 45, 11, 'portive-clinic://services/laser'),
      ('10000000-0000-4000-8000-000000000012', v_org_id, v_clinic_id, 'RF Skin Tightening', 'RF Skin Tightening', 'rf skin tightening', true, true, 60, 12, 'portive-clinic://services/laser'),
      ('10000000-0000-4000-8000-000000000013', v_org_id, v_clinic_id, 'Body Contouring', 'Body Contouring', 'body contouring', true, true, 45, 13, 'portive-clinic://services/body'),
      ('10000000-0000-4000-8000-000000000014', v_org_id, v_clinic_id, 'Wellness Shot', 'Wellness Shot', 'wellness shot', true, true, 15, 14, 'portive-clinic://services/wellness'),
      ('10000000-0000-4000-8000-000000000015', v_org_id, v_clinic_id, 'GLP-1 Weight Wellness Consultation', 'GLP-1 Weight Wellness Consultation', 'glp 1 weight wellness consultation', true, true, 30, 15, 'portive-clinic://services/wellness');
  end if;

  if to_regclass('public.service_aliases') is not null then
    insert into public.service_aliases (organization_id, clinic_id, service_id, alias, normalized_alias)
    values
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000001', 'wrinkle relaxer', 'wrinkle relaxer'),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000001', 'tox', 'tox'),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000002', 'filler', 'filler'),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000002', 'cheek filler', 'cheek filler'),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000003', 'lip injections', 'lip injections'),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000005', 'hydra facial', 'hydra facial'),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000007', 'skin peel', 'skin peel'),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000010', 'laser hair', 'laser hair'),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000011', 'photo facial', 'photo facial'),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000012', 'skin tightening', 'skin tightening'),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000014', 'B12 shot', 'b12 shot'),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000015', 'weight loss consultation', 'weight loss consultation');
  end if;

  if to_regclass('public.service_facts') is not null then
    delete from public.service_facts where clinic_id = v_clinic_id;
    insert into public.service_facts (
      organization_id,
      clinic_id,
      service_id,
      fact_type,
      answer_text,
      structured_value_json,
      priority,
      source_ref,
      content_hash,
      active
    )
    values
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000001', 'price', 'Botox and Dysport is $13-$15 per unit.', '{"price_text":"$13-$15 per unit","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/injectables', md5('portive-botox-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000002', 'price', 'Dermal Fillers are $650-$850 per syringe.', '{"price_text":"$650-$850 per syringe","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/injectables', md5('portive-fillers-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000003', 'price', 'Lip Filler starts at $650.', '{"price_text":"from $650","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/injectables', md5('portive-lip-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000004', 'price', 'Kybella starts at $600 per vial.', '{"price_text":"from $600 per vial","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/injectables', md5('portive-kybella-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000005', 'price', 'Hydrafacial is $199-$275.', '{"price_text":"$199-$275","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/facials', md5('portive-hydrafacial-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000006', 'price', 'Custom Medical Facial is $165-$225.', '{"price_text":"$165-$225","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/facials', md5('portive-custom-facial-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000007', 'price', 'Chemical Peel is $175-$350.', '{"price_text":"$175-$350","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/skin', md5('portive-peel-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000008', 'price', 'Microneedling is $399-$499.', '{"price_text":"$399-$499","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/skin', md5('portive-microneedling-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000009', 'price', 'PRP Microneedling is $650-$800.', '{"price_text":"$650-$800","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/skin', md5('portive-prp-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000010', 'price', 'Laser Hair Removal is $95-$450 by area.', '{"price_text":"$95-$450 by area","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/laser', md5('portive-laser-hair-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000011', 'price', 'IPL Photofacial is $350-$500.', '{"price_text":"$350-$500","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/laser', md5('portive-ipl-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000012', 'price', 'RF Skin Tightening is $450-$650.', '{"price_text":"$450-$650","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/laser', md5('portive-rf-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000013', 'price', 'Body Contouring is $250-$400 per area.', '{"price_text":"$250-$400 per area","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/body', md5('portive-body-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000014', 'price', 'Wellness Shot is $35-$60.', '{"price_text":"$35-$60","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/wellness', md5('portive-shot-price'), true),
      (v_org_id, v_clinic_id, '10000000-0000-4000-8000-000000000015', 'price', 'GLP-1 Weight Wellness Consultation is $99.', '{"price_text":"$99 consultation","currency":"USD"}'::jsonb, 10, 'portive-clinic://services/wellness', md5('portive-glp1-price'), true);
  end if;

  if to_regclass('public.faq_chunks') is not null then
    delete from public.faq_chunks where clinic_id = v_clinic_id;
    insert into public.faq_chunks (
      organization_id,
      clinic_id,
      service_id,
      category,
      fact_type,
      title,
      chunk_text,
      content_hash,
      source_article_id,
      source_ref,
      chunk_index,
      active
    )
    values
      (v_org_id, v_clinic_id, null, 'Booking', 'faq', 'Do I need a consultation before treatment?', 'For injectables, lasers, body treatments, and weight wellness, Portive Clinic starts with a consultation or provider assessment to confirm the right plan.', md5('portive-faq-consultation'), null, 'portive-clinic://faqs', 1, true),
      (v_org_id, v_clinic_id, null, 'Pricing', 'faq', 'Can prices change after the consultation?', 'Yes. Published pricing is a starting estimate. Final pricing depends on the treatment plan, area, product amount, and provider assessment.', md5('portive-faq-pricing'), null, 'portive-clinic://faqs', 2, true),
      (v_org_id, v_clinic_id, null, 'Booking', 'faq', 'Do you take deposits?', 'Portive Clinic may request a booking deposit for longer appointments. The team can confirm the deposit amount when scheduling.', md5('portive-faq-deposit'), null, 'portive-clinic://faqs', 3, true),
      (v_org_id, v_clinic_id, null, 'Policy', 'faq', 'What is the cancellation policy?', 'Please give at least 24 hours notice to reschedule or cancel. Late cancellations or no-shows may be subject to a fee.', md5('portive-faq-cancel'), null, 'portive-clinic://faqs', 4, true),
      (v_org_id, v_clinic_id, null, 'Safety', 'faq', 'Can I book if I am pregnant or nursing?', 'Some treatments may not be appropriate during pregnancy or nursing. A licensed provider can review options during consultation.', md5('portive-faq-pregnant'), null, 'portive-clinic://faqs', 5, true),
      (v_org_id, v_clinic_id, null, 'Safety', 'faq', 'Do you provide medical advice over the phone?', 'The phone agent can share general service and booking information only. Clinical questions are handled by a licensed provider during consultation.', md5('portive-faq-medical-advice'), null, 'portive-clinic://faqs', 6, true);
  end if;
end $$;

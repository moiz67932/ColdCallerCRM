do $$
declare
  v_org_id uuid := '54673cc5-1b6d-4b53-af05-e1d792c466fd';
  v_clinic_id uuid := '11111111-2222-4333-8444-555555555555';
  v_agent_id uuid := '87112821-4661-4dd9-a22e-ba57b48feb17';
  v_service_details text :=
    'Injectables: Botox and Dysport (30 minutes, $13-$15 per unit); Dermal Fillers (45-60 minutes, $650-$850 per syringe); Lip Filler (45 minutes, from $650); Kybella (30 minutes, from $600 per vial). ' ||
    'Facials: Hydrafacial (45 minutes, $199-$275); Custom Medical Facial (60 minutes, $165-$225). ' ||
    'Skin Treatments: Chemical Peel (30-45 minutes, $175-$350); Microneedling (60 minutes, $399-$499); PRP Microneedling (75 minutes, $650-$800). ' ||
    'Laser Services: Laser Hair Removal (15-60 minutes, $95-$450 by area); IPL Photofacial (45 minutes, $350-$500); RF Skin Tightening (45-60 minutes, $450-$650). ' ||
    'Body Treatments: Body Contouring (45 minutes, $250-$400 per area). ' ||
    'Wellness: Wellness Shot (15 minutes, $35-$60); GLP-1 Weight Wellness Consultation (30 minutes, $99 consultation).';
begin
  v_org_id := coalesce(
    (select organization_id from public.agents where id = v_agent_id limit 1),
    v_org_id
  );

  update public.agent_settings
  set config_json = coalesce(config_json, '{}'::jsonb)
    || jsonb_build_object(
      'service_category_details', v_service_details,
      'conversation_guidance', 'When callers ask about a category, answer with the service names in that category plus typical duration and published price range. Do not merely say the category is listed. For facials, say Hydrafacial is 45 minutes and $199-$275, and Custom Medical Facial is 60 minutes and $165-$225.'
    )
  where agent_id = v_agent_id;

  delete from public.knowledge_articles
  where clinic_id = v_clinic_id
    and title in (
      'Service Category Details',
      'Facials with Pricing and Duration',
      'Injectables with Pricing and Duration',
      'Skin Treatments with Pricing and Duration',
      'Laser Services with Pricing and Duration',
      'Body and Wellness with Pricing and Duration'
    );

  insert into public.knowledge_articles (organization_id, clinic_id, title, category, active, body)
  values
    (v_org_id, v_clinic_id, 'Service Category Details', 'Services', true, v_service_details),
    (v_org_id, v_clinic_id, 'Facials with Pricing and Duration', 'Services', true, 'Facials at Portive Clinic include Hydrafacial, which takes about 45 minutes and is $199-$275, and Custom Medical Facial, which takes about 60 minutes and is $165-$225. If a caller asks about facials, list both services with these prices and durations.'),
    (v_org_id, v_clinic_id, 'Injectables with Pricing and Duration', 'Services', true, 'Injectables at Portive Clinic include Botox and Dysport, 30 minutes, $13-$15 per unit; Dermal Fillers, 45-60 minutes, $650-$850 per syringe; Lip Filler, 45 minutes, from $650; and Kybella, 30 minutes, from $600 per vial.'),
    (v_org_id, v_clinic_id, 'Skin Treatments with Pricing and Duration', 'Services', true, 'Skin treatments at Portive Clinic include Chemical Peel, 30-45 minutes, $175-$350; Microneedling, 60 minutes, $399-$499; and PRP Microneedling, 75 minutes, $650-$800.'),
    (v_org_id, v_clinic_id, 'Laser Services with Pricing and Duration', 'Services', true, 'Laser services at Portive Clinic include Laser Hair Removal, 15-60 minutes, $95-$450 by area; IPL Photofacial, 45 minutes, $350-$500; and RF Skin Tightening, 45-60 minutes, $450-$650.'),
    (v_org_id, v_clinic_id, 'Body and Wellness with Pricing and Duration', 'Services', true, 'Body and wellness services at Portive Clinic include Body Contouring, 45 minutes, $250-$400 per area; Wellness Shot, 15 minutes, $35-$60; and GLP-1 Weight Wellness Consultation, 30 minutes, $99 consultation.');

  if to_regclass('public.faq_chunks') is not null then
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
      (v_org_id, v_clinic_id, null, 'Services', 'faq', 'What facials do you offer?', 'Facials at Portive Clinic include Hydrafacial, 45 minutes, $199-$275, and Custom Medical Facial, 60 minutes, $165-$225.', md5('portive-faq-facials-details'), null, 'portive-clinic://faqs/services', 20, true),
      (v_org_id, v_clinic_id, null, 'Services', 'faq', 'What services are in each category?', v_service_details, md5('portive-faq-category-details'), null, 'portive-clinic://faqs/services', 21, true)
    on conflict do nothing;
  end if;
end $$;

import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { getSharedDemoVoiceContextWithBackendPricing } from "@/lib/elevenlabs/shared-demo-context";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  const context = await getSharedDemoVoiceContextWithBackendPricing();

  return NextResponse.json({
    service_categories_short: context.service_categories_short,
    service_menu_short: context.service_menu_short,
    service_menu_spoken_short: context.service_menu_spoken_short,
    facials_list_spoken_short: context.facials_list_spoken_short,
    injectables_list_spoken_short: context.injectables_list_spoken_short,
    laser_list_spoken_short: context.laser_list_spoken_short,
    skin_list_spoken_short: context.skin_list_spoken_short,
    wellness_list_spoken_short: context.wellness_list_spoken_short,
    body_list_spoken_short: context.body_list_spoken_short,
    services_with_pricing_and_deposits_text: context.services_with_pricing_and_deposits_text,
    bookable_services_with_deposits_text: context.bookable_services_with_deposits_text,
    exact_service_pricing_text: context.exact_service_pricing_text,
    pricing_lookup_text: context.pricing_lookup_text,
    deposit_policy_text: context.deposit_policy_text,
    services_by_category_text: context.services_by_category_text,
    clinic_timezone: context.timezone ?? "",
  });
}

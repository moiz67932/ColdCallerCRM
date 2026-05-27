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
    service_menu_short: context.service_menu_short,
    services_with_pricing_and_deposits_text: context.services_with_pricing_and_deposits_text,
    deposit_policy_text: context.deposit_policy_text,
    services_by_category_text: context.services_by_category_text,
    clinic_timezone: context.timezone ?? "",
  });
}

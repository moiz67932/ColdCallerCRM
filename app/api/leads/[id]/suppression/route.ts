import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/workstation-db";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { normalizePhoneNumber } from "@/lib/phone";
import { jsonError } from "@/lib/http";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request, { mutation: true });
  if (auth) return auth;
  const { id } = await context.params;
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) return jsonError("Lead not found", 404);
  const phone = normalizePhoneNumber(lead.phoneNumber);
  if (!phone) return jsonError("Lead has no valid phone number", 400);
  const { error } = await getSupabaseAdmin().from("dial_suppressions").upsert({
    phone_number: phone, reason: "Operator recorded Do Not Call request",
  }, { onConflict: "phone_number" });
  if (error) return jsonError(error.message, 503);
  return NextResponse.json({ suppressed: true, phoneNumber: phone });
}

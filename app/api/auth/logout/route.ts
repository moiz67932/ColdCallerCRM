import { NextResponse } from "next/server";

import { getClearedSessionCookieValue } from "@/lib/auth";

export async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.set(getClearedSessionCookieValue());
  return response;
}

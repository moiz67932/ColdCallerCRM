import { NextRequest, NextResponse } from "next/server";

import { isAuthenticated } from "@/lib/auth";
import { ensureSameOrigin } from "@/lib/http";

export async function requireApiAuth(request: NextRequest, options?: { mutation?: boolean }) {
  const authenticated = await isAuthenticated();

  if (!authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (options?.mutation) {
    try {
      ensureSameOrigin(request);
    } catch {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }
  }

  return null;
}

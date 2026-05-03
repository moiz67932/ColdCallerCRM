import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";

import { getSessionCookieValue, isPasswordValid } from "@/lib/auth";
import { getClientIp, jsonError } from "@/lib/http";
import { consumeRateLimit } from "@/lib/rate-limit";

const loginSchema = z.object({
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);

  const rateLimit = consumeRateLimit(`login:${ip}`, {
    max: 10,
    windowMs: 15 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return jsonError("Too many login attempts. Please try again shortly.", 429);
  }

  let payload: z.infer<typeof loginSchema>;

  try {
    payload = loginSchema.parse(await request.json());
  } catch {
    return jsonError("Invalid login payload", 400);
  }

  if (!isPasswordValid(payload.password)) {
    return jsonError("Invalid password", 401);
  }

  const cookie = await getSessionCookieValue();

  const response = NextResponse.json({ success: true });
  response.cookies.set(cookie);

  return response;
}

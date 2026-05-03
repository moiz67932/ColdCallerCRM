import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";

export async function parseJsonBody<T>(request: NextRequest, schema: z.Schema<T>) {
  const body = await request.json();
  return schema.parse(body);
}

export function getClientIp(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  return request.headers.get("x-real-ip") ?? "unknown";
}

export function ensureSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");

  if (!origin || !host) {
    return;
  }

  const originHost = new URL(origin).host;

  if (originHost !== host) {
    throw new Error("Cross-origin mutation blocked");
  }
}

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export function formatUnknownError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

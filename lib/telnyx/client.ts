import "server-only";

import Telnyx from "telnyx";

import { env, requireEnv } from "@/lib/env";

let client: Telnyx | null = null;

export function getTelnyxClient() {
  if (!client) {
    client = new Telnyx({
      apiKey: requireEnv("TELNYX_API_KEY"),
      timeout: 20_000,
      maxRetries: 1,
      logLevel: env.NODE_ENV === "development" ? "info" : "off",
    });
  }

  return client;
}

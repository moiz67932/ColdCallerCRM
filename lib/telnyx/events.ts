import { z } from "zod";

export const telnyxEventSchema = z.object({
  data: z
    .object({
      id: z.string().optional(),
      event_type: z.string(),
      occurred_at: z.string().optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
});

export type TelnyxWebhookPayload = z.infer<typeof telnyxEventSchema>;

export function parseTelnyxEvent(rawBody: string) {
  const parsedJson = JSON.parse(rawBody);
  return telnyxEventSchema.parse(parsedJson);
}

export function getPayloadValue(payload: Record<string, unknown> | undefined, key: string) {
  if (!payload) {
    return undefined;
  }

  const value = payload[key];

  return typeof value === "string" ? value : undefined;
}

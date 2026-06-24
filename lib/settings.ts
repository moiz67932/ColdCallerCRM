import { z } from "zod";

import { prisma } from "@/lib/workstation-db";
import { getDefaultScripts, type ScriptTemplates } from "@/lib/scripts";

const appSettingsSchema = z.object({
  enableRecording: z.boolean().default(true),
  locations: z
    .array(z.string())
    .default([])
    .transform((locations) => Array.from(new Set(locations.map((location) => location.trim()).filter(Boolean)))),
  defaultFollowUpSmsTemplate: z
    .string()
    .default("Hi {{contactName}}, thanks for your time today. I will follow up shortly with next steps."),
  scripts: z
    .object({
      opening: z.string(),
      gatekeeper: z.string(),
      voicemail: z.string(),
      callbackConfirmation: z.string(),
      close: z.string(),
    })
    .default(getDefaultScripts()),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppSettingsPatch = Partial<Omit<AppSettings, "scripts">> & {
  scripts?: Partial<ScriptTemplates>;
};

const SETTINGS_KEY = "operator_settings";

const DEFAULT_SETTINGS: AppSettings = {
  enableRecording: true,
  locations: [],
  defaultFollowUpSmsTemplate:
    "Hi {{contactName}}, thanks for your time today. I will follow up shortly with next steps.",
  scripts: getDefaultScripts(),
};

export async function getAppSettings(): Promise<AppSettings> {
  const row = await prisma.appSetting.findUnique({
    where: { key: SETTINGS_KEY },
  });

  if (!row) {
    return DEFAULT_SETTINGS;
  }

  const storedValue =
    row.valueJson && typeof row.valueJson === "object" && !Array.isArray(row.valueJson)
      ? (row.valueJson as Record<string, unknown>)
      : {};

  return appSettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...storedValue,
  });
}

export async function saveAppSettings(nextSettings: AppSettingsPatch) {
  const current = await getAppSettings();

  const merged = appSettingsSchema.parse({
    ...current,
    ...nextSettings,
    scripts: {
      ...current.scripts,
      ...(nextSettings.scripts as Partial<ScriptTemplates> | undefined),
    },
  });

  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: {
      key: SETTINGS_KEY,
      valueJson: merged,
    },
    update: {
      valueJson: merged,
    },
  });

  return merged;
}

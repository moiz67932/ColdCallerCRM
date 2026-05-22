"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type AppSettings = {
  enableRecording: boolean;
  defaultFollowUpSmsTemplate: string;
  scripts: {
    opening: string;
    gatekeeper: string;
    voicemail: string;
    callbackConfirmation: string;
    close: string;
  };
};

type RuntimeConfig = {
  telnyxConnectionConfigured?: boolean;
  telnyxFromNumber?: string | null;
  telnyxMessagingFromConfigured?: boolean;
  signatureVerificationConfigured?: boolean;
  telnyxExpectedVoiceWebhookUrl?: string | null;
  adminPasswordEnvBased?: boolean;
};

type HealthCheckResponse = {
  checks?: {
    dbConnected?: boolean;
    requiredEnv?: Record<string, boolean>;
    telnyxCredentialsConfigured?: boolean;
    outboundCallerConfigured?: boolean;
    messagingConfigured?: boolean;
    webhookBaseUrlConfigured?: boolean;
    webhookBaseUrlPublic?: boolean;
    signatureVerificationConfigured?: boolean;
  };
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadData() {
      const [settingsRes, healthRes] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/health", { cache: "no-store" }),
      ]);

      const settingsPayload = (await settingsRes.json()) as {
        settings: AppSettings;
        runtimeConfig: RuntimeConfig;
      };

      if (settingsRes.ok) {
        setSettings(settingsPayload.settings);
        setRuntimeConfig(settingsPayload.runtimeConfig);
      }

      const healthPayload = (await healthRes.json()) as HealthCheckResponse;
      setHealth(healthPayload);
    }

    void loadData();
  }, []);

  async function saveSettings() {
    if (!settings) {
      return;
    }

    setSaving(true);
    setStatusMessage("Saving...");

    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(settings),
      });

      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        setStatusMessage(payload.error ?? "Could not save settings");
        return;
      }

      setStatusMessage("Settings saved");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <p className="text-sm text-slate-500">Loading settings...</p>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>Operator, telephony flags, scripts, and integration readiness checks.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="font-medium">TELNYX_CONNECTION_ID</p>
              <p className="text-slate-600">{runtimeConfig?.telnyxConnectionConfigured ? "Configured" : "Not configured"}</p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="font-medium">TELNYX_FROM_NUMBER</p>
              <p className="text-slate-600">{runtimeConfig?.telnyxFromNumber ?? "Not configured"}</p>
              <p className="mt-2 text-xs text-slate-500">Used as caller ID for Telnyx Call Control outbound calls.</p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
              <div>
                <p className="font-medium">Enable recording</p>
                <p className="text-sm text-slate-600">Store native Telnyx recordings and transcripts for connected calls</p>
              </div>
              <Switch
                checked={settings.enableRecording}
                onCheckedChange={(checked) => setSettings((prev) => (prev ? { ...prev, enableRecording: checked } : prev))}
              />
            </div>
            <div className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="font-medium">Outbound calling</p>
              <p className="text-slate-600">Backend Call Control over the configured Telnyx connection.</p>
              <p className="mt-2 text-xs text-slate-500">Voicemail detection is enabled with `detect_beep`.</p>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 p-3 text-sm">
            <p className="font-medium">Telnyx Voice Webhook URL</p>
            <p className="mt-2 break-all text-xs text-slate-500">Expected: {runtimeConfig?.telnyxExpectedVoiceWebhookUrl ?? "Not set"}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sms-template">Default follow-up SMS template</Label>
            <Textarea
              id="sms-template"
              value={settings.defaultFollowUpSmsTemplate}
              onChange={(event) =>
                setSettings((prev) =>
                  prev
                    ? {
                        ...prev,
                        defaultFollowUpSmsTemplate: event.target.value,
                      }
                    : prev,
                )
              }
            />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {(Object.keys(settings.scripts) as Array<keyof AppSettings["scripts"]>).map((key) => (
              <div className="space-y-2" key={key}>
                <Label>{key}</Label>
                <Textarea
                  value={settings.scripts[key]}
                  onChange={(event) =>
                    setSettings((prev) =>
                      prev
                        ? {
                            ...prev,
                            scripts: {
                              ...prev.scripts,
                              [key]: event.target.value,
                            },
                          }
                        : prev,
                    )
                  }
                />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <Button loading={saving} onClick={() => void saveSettings()}>Save settings</Button>
            {statusMessage ? <p className="text-sm text-slate-600">{statusMessage}</p> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Integration Status</CardTitle>
          <CardDescription>Readiness checks without exposing secrets.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <StatusRow label="Database connectivity" ok={Boolean(health?.checks?.dbConnected)} />
          <StatusRow label="Telnyx credentials configured" ok={Boolean(health?.checks?.telnyxCredentialsConfigured)} />
          <StatusRow label="Outbound caller configured" ok={Boolean(health?.checks?.outboundCallerConfigured)} />
          <StatusRow label="Messaging number configured" ok={Boolean(health?.checks?.messagingConfigured)} />
          <StatusRow label="Webhook base URL configured" ok={Boolean(health?.checks?.webhookBaseUrlConfigured)} />
          <StatusRow label="Webhook base URL publicly reachable" ok={Boolean(health?.checks?.webhookBaseUrlPublic)} />
          <StatusRow
            label="Webhook signature verification configured"
            ok={Boolean(health?.checks?.signatureVerificationConfigured)}
          />

          {!health?.checks?.webhookBaseUrlPublic ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              Telnyx cannot post call-control webhooks to `localhost` or a private LAN URL. Use a public tunnel such as
              `ngrok` or `cloudflared`, set `APP_BASE_URL` to that public URL, then restart the app before testing outbound calls.
            </div>
          ) : null}

          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            Admin password is env-based in v1. To change it, update ADMIN_PASSWORD and restart the app.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2">
      <span>{label}</span>
      <span className={ok ? "text-emerald-700" : "text-amber-700"}>{ok ? "Ready" : "Needs attention"}</span>
    </div>
  );
}

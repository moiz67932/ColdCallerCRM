"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import type { Call as TelnyxCall, INotification, TelnyxRTC as TelnyxRTCType } from "@telnyx/webrtc";
import { addDays, format } from "date-fns";
import { ExternalLink, Mic, MicOff, PhoneCall, PhoneOff, RefreshCcw } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { applyTemplateVariables } from "@/lib/scripts";

type FollowUp = {
  id: string;
  dueAt: string;
  status: "open" | "completed" | "canceled";
  note?: string | null;
};

type CallAttempt = {
  id: string;
  status: string;
  outcome?: string | null;
  startedAt?: string | null;
  answeredAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number | null;
  telnyxConnectionId?: string | null;
  telnyxCallControlId?: string | null;
  telnyxCallLegId?: string | null;
  telnyxAgentCallControlId?: string | null;
  telnyxAgentCallLegId?: string | null;
  telnyxCallSessionId?: string | null;
  amdResult?: string | null;
  recording?: {
    telnyxRecordingId?: string;
    downloadUrl?: string | null;
  } | null;
  transcript?: {
    status: "pending" | "completed" | "failed";
    text?: string | null;
  } | null;
};

type LeadItem = {
  id: string;
  businessName?: string | null;
  contactName?: string | null;
  phoneNumber: string;
  city?: string | null;
  state?: string | null;
  niche?: string | null;
  website?: string | null;
  notes?: string | null;
  tags: string[];
  callAttempts: CallAttempt[];
  followUps: FollowUp[];
};

type DemoAgentSummary = {
  businessName: string | null;
  servicesCount: number;
  faqsCount: number;
  hasHours: boolean;
  hasPricing: boolean;
  hoursStatus?: "not_listed" | "listed";
  pricingStatus?: "not_listed" | "partial" | "listed";
};

type DemoAgentStatusResponse = {
  lead_id: string;
  lead_demo_profile_id?: string | null;
  profile_status: "draft" | "scraping" | "ready" | "active" | "failed";
  scrape_status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  scrape_error?: string | null;
  scrape_job_id?: string | null;
  pages_discovered?: number;
  pages_scraped?: number;
  pages_failed?: number;
  last_scraped_at?: string | null;
  last_prepared_at?: string | null;
  is_demo_ready?: boolean;
  demo_ready_blockers?: string[];
  can_prepare?: boolean;
  can_retry?: boolean;
  clinic_id: string | null;
  agent_id: string;
  summary: DemoAgentSummary | null;
};

type SettingsResponse = {
  settings: {
    scripts: {
      opening: string;
      gatekeeper: string;
      voicemail: string;
      callbackConfirmation: string;
      close: string;
    };
  };
};

type ScriptKey = keyof SettingsResponse["settings"]["scripts"];

type CallBootstrapResponse = {
  attempt?: CallAttempt;
  callSession?: {
    attemptId: string;
    clientState: string;
    callerNumber?: string | null;
    destinationNumber: string;
  };
  error?: string;
};

type ClientFailureDebug = {
  callState: string;
  callControlId: string | null;
  callLegId: string | null;
  callSessionId: string | null;
  cause: string | null;
  sipCode: number | null;
  sipReason: string | null;
};

type TelnyxRTCInstance = InstanceType<typeof TelnyxRTCType>;

const outcomeButtons: Array<{ outcome: string; label: string }> = [
  { outcome: "answered", label: "Answered" },
  { outcome: "voicemail", label: "Voicemail" },
  { outcome: "no_answer", label: "No Answer" },
  { outcome: "not_interested", label: "Not Interested" },
  { outcome: "callback", label: "Callback" },
  { outcome: "gatekeeper", label: "Gatekeeper" },
  { outcome: "bad_number", label: "Bad Number" },
  { outcome: "interested", label: "Interested" },
  { outcome: "demo_requested", label: "Demo Requested" },
];

const shortcutOutcomeMap: Record<string, string> = {
  "1": "answered",
  "2": "voicemail",
  "3": "no_answer",
  "4": "not_interested",
  "5": "callback",
  "6": "gatekeeper",
  "7": "bad_number",
  "8": "interested",
};

function getCallbackDate(preset: "today_later" | "tomorrow_morning" | "tomorrow_afternoon") {
  const now = new Date();

  if (preset === "today_later") {
    const atFive = new Date(now);
    atFive.setHours(17, 0, 0, 0);
    return atFive;
  }

  const tomorrow = addDays(now, 1);

  if (preset === "tomorrow_morning") {
    tomorrow.setHours(9, 0, 0, 0);
    return tomorrow;
  }

  tomorrow.setHours(15, 0, 0, 0);
  return tomorrow;
}

function getSoftphoneStatusLabel(status: "idle" | "connecting" | "ready" | "error") {
  switch (status) {
    case "connecting":
      return "connecting";
    case "ready":
      return "ready";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function mapBrowserCallStateToStatus(state: string) {
  switch (state) {
    case "trying":
    case "requesting":
    case "ringing":
    case "recovering":
    case "new":
      return "dialing";
    case "active":
    case "held":
      return "connected";
    case "hangup":
    case "destroy":
    case "purge":
      return "completed";
    default:
      return "idle";
  }
}

export default function QueuePage() {
  const searchParams = useSearchParams();
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [lastSavedNotes, setLastSavedNotes] = useState("");
  const [settings, setSettings] = useState<SettingsResponse["settings"] | null>(null);
  const [scriptDrafts, setScriptDrafts] = useState<SettingsResponse["settings"]["scripts"] | null>(null);
  const [customCallbackAt, setCustomCallbackAt] = useState("");
  const [showScripts, setShowScripts] = useState(true);
  const [calling, setCalling] = useState(false);
  const [softphoneStatus, setSoftphoneStatus] = useState<"idle" | "connecting" | "ready" | "error">("idle");
  const [softphoneMessage, setSoftphoneMessage] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<TelnyxCall | null>(null);
  const [activeCallState, setActiveCallState] = useState("idle");
  const [callMuted, setCallMuted] = useState(false);
  const [pendingAttemptId, setPendingAttemptId] = useState<string | null>(null);
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [savingScripts, setSavingScripts] = useState(false);
  const [demoAgentStatus, setDemoAgentStatus] = useState<DemoAgentStatusResponse | null>(null);
  const [loadingDemoAgentStatus, setLoadingDemoAgentStatus] = useState(false);
  const syncedAgentLegAttemptIdsRef = useRef<Set<string>>(new Set());
  const syncingAgentLegAttemptIdsRef = useRef<Set<string>>(new Set());
  const locallyEndedAttemptIdsRef = useRef<Set<string>>(new Set());
  const promptedVoicemailAttemptIdsRef = useRef<Set<string>>(new Set());
  const didPrewarmSoftphoneRef = useRef(false);
  const didPrimeMicrophoneRef = useRef(false);
  const didInitialLeadLoadRef = useRef(false);
  const didLoadSettingsRef = useRef(false);
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const clientRef = useRef<TelnyxRTCInstance | null>(null);
  const refreshLeadsRef = useRef<() => Promise<void>>(async () => undefined);
  const pendingAttemptIdRef = useRef<string | null>(null);
  const requestedLeadId = searchParams.get("leadId");

  const selectedLead = useMemo(() => leads.find((lead) => lead.id === selectedLeadId) ?? null, [leads, selectedLeadId]);
  const latestAttempt = selectedLead?.callAttempts[0] ?? null;

  const refreshLeads = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/leads?sort=queue", { cache: "no-store" });
      const payload = (await response.json()) as { error?: string; leads?: LeadItem[] };

      if (!response.ok || !payload.leads) {
        throw new Error(payload.error ?? "Failed to load leads");
      }

      setLeads(payload.leads);

      if (!selectedLeadId && payload.leads.length > 0) {
        setSelectedLeadId(requestedLeadId && payload.leads.some((lead) => lead.id === requestedLeadId) ? requestedLeadId : payload.leads[0].id);
      }

      if (selectedLeadId && !payload.leads.some((lead) => lead.id === selectedLeadId)) {
        setSelectedLeadId(payload.leads[0]?.id ?? null);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load leads");
    } finally {
      setLoading(false);
    }
  }, [requestedLeadId, selectedLeadId]);

  useEffect(() => {
    refreshLeadsRef.current = refreshLeads;
  }, [refreshLeads]);

  useEffect(() => {
    pendingAttemptIdRef.current = pendingAttemptId;
  }, [pendingAttemptId]);

  useEffect(() => {
    if (requestedLeadId && leads.some((lead) => lead.id === requestedLeadId)) {
      setSelectedLeadId(requestedLeadId);
    }
  }, [leads, requestedLeadId]);

  useEffect(() => {
    if (didInitialLeadLoadRef.current) {
      return;
    }

    didInitialLeadLoadRef.current = true;
    void refreshLeads();
  }, [refreshLeads]);

  useEffect(() => {
    if (didPrewarmSoftphoneRef.current) {
      return;
    }

    didPrewarmSoftphoneRef.current = true;

    window.setTimeout(() => {
      void ensureSoftphoneReady().catch((error) => {
        const message = error instanceof Error ? error.message : "Could not prepare browser phone";
        setSoftphoneMessage(message);
      });
    }, 250);
    // `ensureSoftphoneReady` is intentionally run once to prewarm the browser phone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (didPrimeMicrophoneRef.current || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return;
    }

    didPrimeMicrophoneRef.current = true;

    window.setTimeout(() => {
      void navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop());
          setSoftphoneMessage((current) => current ?? "Microphone ready");
        })
        .catch(() => {
          setSoftphoneMessage((current) => current ?? "Microphone access will be requested when you place a call");
        });
    }, 500);
  }, []);

  useEffect(() => {
    async function loadSettings() {
      const response = await fetch("/api/settings", { cache: "no-store" });
      const payload = (await response.json()) as SettingsResponse;

      if (response.ok) {
        setSettings(payload.settings);
        setScriptDrafts(payload.settings.scripts);
      }
    }

    if (didLoadSettingsRef.current) {
      return;
    }

    didLoadSettingsRef.current = true;
    void loadSettings();
  }, []);

  function getClientFailureDebug(call: TelnyxCall): ClientFailureDebug {
    const telnyxIds = call.telnyxIDs;

    return {
      callState: call.state ?? "unknown",
      callControlId: telnyxIds?.telnyxCallControlId || null,
      callLegId: telnyxIds?.telnyxLegId || null,
      callSessionId: telnyxIds?.telnyxSessionId || null,
      cause: "cause" in call && typeof call.cause === "string" ? call.cause : null,
      sipCode: "sipCode" in call && typeof call.sipCode === "number" ? call.sipCode : null,
      sipReason: "sipReason" in call && typeof call.sipReason === "string" ? call.sipReason : null,
    };
  }

  async function syncAttemptFailure(
    attemptId: string,
    status: "failed" | "canceled",
    clientError: string,
    debug?: ClientFailureDebug,
  ) {
    try {
      await fetch(`/api/calls/${attemptId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status,
          clientError,
          debug,
        }),
      });
    } catch {
      // Ignore best-effort sync failures here. Webhooks remain the primary source of truth.
    } finally {
      await refreshLeadsRef.current();
    }
  }

  async function syncAttemptConnected(attemptId: string) {
    try {
      await fetch(`/api/calls/${attemptId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "connected",
          answeredAt: new Date().toISOString(),
        }),
      });
    } catch {
      // Ignore best-effort connected sync failures here. Webhooks remain authoritative.
    } finally {
      await refreshLeadsRef.current();
    }
  }

  async function resetSoftphoneClient() {
    const client = clientRef.current;
    clientRef.current = null;

    if (client) {
      try {
        await client.disconnect();
      } catch {
        // Ignore disconnect cleanup failures while resetting the browser phone.
      }
    }

    setActiveCall(null);
    setActiveCallState("idle");
    setCallMuted(false);
    setSoftphoneStatus("idle");
  }

  function isTelnyxAuthenticationErrorMessage(message: string) {
    return message.includes("Authentication Required") || message.includes("AUTHENTICATION_REQUIRED");
  }

  function createBrowserCallSilently(client: TelnyxRTCInstance, callOptions: {
    destinationNumber: string;
    callerNumber?: string;
    clientState: string;
    audio: true;
  }) {
    const originalConsoleInfo = console.info;
    const originalConsoleLog = console.log;
    const originalConsoleDebug = console.debug;
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;

    // The Telnyx SDK logs the full call options object in dev, which Next.js 16
    // tries to inspect and turns into noisy dynamic API warnings. Suppress the
    // bootstrap logging window so those dev-only warnings do not leak through.
    console.info = () => undefined;
    console.log = () => undefined;
    console.debug = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;

    let restored = false;
    const restoreConsole = () => {
      if (restored) {
        return;
      }

      restored = true;
      console.info = originalConsoleInfo;
      console.log = originalConsoleLog;
      console.debug = originalConsoleDebug;
      console.warn = originalConsoleWarn;
      console.error = originalConsoleError;
    };

    try {
      return client.newCall(callOptions);
    } finally {
      window.setTimeout(restoreConsole, 3000);
    }
  }

  function promptVoicemailDetected(leadName: string, phoneNumber: string) {
    const message = `${leadName} (${phoneNumber}) went to voicemail. The call was ended automatically.`;

    if (typeof window === "undefined") {
      return;
    }

    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Voicemail detected", { body: message });
      return;
    }

    window.alert(message);
  }

  async function waitForSoftphoneReady(client: TelnyxRTCInstance) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const registered = await client.getIsRegistered().catch(() => false);

      if (registered) {
        setSoftphoneStatus("ready");
        setSoftphoneMessage("Browser phone ready");
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }

    throw new Error("Browser phone registration timed out");
  }

  function handleTelnyxNotification(notification: INotification) {
    if (notification.type !== "callUpdate" || !notification.call) {
      return;
    }

    const call = notification.call;
    setActiveCallState(call.state);
    setCallMuted(Boolean(call.isAudioMuted));

    const attemptId = pendingAttemptIdRef.current;
    if (attemptId) {
      void syncAgentLegToBackend(attemptId, call).catch(async (syncError) => {
        const message = syncError instanceof Error ? syncError.message : "Could not sync browser leg";
        setError(message);
        setSoftphoneMessage(message);
        setPendingAttemptId(null);
        await syncAttemptFailure(attemptId, "failed", message, getClientFailureDebug(call));
      });

      if (call.state === "active") {
        void syncAttemptConnected(attemptId);
      }
    }

    if (["hangup", "destroy", "purge"].includes(call.state)) {
      setActiveCall(null);
      setPendingAttemptId(null);
      void refreshLeadsRef.current();
      return;
    }

    setActiveCall(call);
  }

  async function ensureSoftphoneReady() {
    const existingClient = clientRef.current;

    if (existingClient) {
      if (remoteAudioRef.current) {
        existingClient.remoteElement = remoteAudioRef.current;
      }

      if (softphoneStatus === "ready") {
        return existingClient;
      }

      if (softphoneStatus === "connecting") {
        await waitForSoftphoneReady(existingClient);
        return existingClient;
      }

      await resetSoftphoneClient();
    }

    setSoftphoneStatus("connecting");
    setSoftphoneMessage("Connecting browser phone...");

    try {
      window.localStorage.setItem("loglevel", "ERROR");
      window.localStorage.setItem("loglevel:default", "ERROR");
      window.localStorage.setItem("loglevel:TelnyxRTC", "ERROR");
    } catch {
      // Ignore localStorage failures in restrictive browser contexts.
    }

    const { TelnyxRTC } = await import("@telnyx/webrtc");

    const tokenResponse = await fetch("/api/telnyx/webrtc-token", {
      method: "POST",
    });
    const tokenPayload = (await tokenResponse.json()) as { token?: string; error?: string };

    if (!tokenResponse.ok || !tokenPayload.token) {
      throw new Error(tokenPayload.error ?? "Could not create a WebRTC token");
    }

    const client = new TelnyxRTC({
      login_token: tokenPayload.token,
      keepConnectionAliveOnSocketClose: true,
      mutedMicOnStart: false,
    });

    if (remoteAudioRef.current) {
      client.remoteElement = remoteAudioRef.current;
    }

    client.on("telnyx.ready", () => {
      setSoftphoneStatus("ready");
      setSoftphoneMessage("Browser phone ready");
    });

    client.on("telnyx.error", ({ error: clientError }) => {
      const message = clientError?.message ?? "Browser phone error";
      const attemptId = pendingAttemptIdRef.current;

      setSoftphoneMessage(message);
      setError(message);
      setActiveCall(null);
      setActiveCallState("idle");
      setCallMuted(false);

      if (isTelnyxAuthenticationErrorMessage(message)) {
        void resetSoftphoneClient().catch(() => undefined);
      } else {
        setSoftphoneStatus("error");
      }

      if (attemptId) {
        setPendingAttemptId(null);
        void syncAttemptFailure(attemptId, "failed", message, activeCall ? getClientFailureDebug(activeCall) : undefined);
      }
    });

    client.on("telnyx.notification", handleTelnyxNotification);

    clientRef.current = client;

    await client.connect();
    await waitForSoftphoneReady(client);

    return client;
  }

  async function hangupBrowserCall() {
    if (!activeCall) {
      return;
    }

    try {
      if (pendingAttemptIdRef.current) {
        locallyEndedAttemptIdsRef.current.add(pendingAttemptIdRef.current);
      }

      setPendingAttemptId(null);
      setActiveCall(null);
      setActiveCallState("hangup");
      setCallMuted(false);
      setSoftphoneMessage("Ending call...");
      await activeCall.hangup();
    } catch {
      // Ignore local hangup errors and let webhook/client updates reconcile state.
    }
  }

  async function syncAgentLegToBackend(attemptId: string, call: TelnyxCall) {
    if (syncedAgentLegAttemptIdsRef.current.has(attemptId) || syncingAgentLegAttemptIdsRef.current.has(attemptId)) {
      return;
    }

    syncingAgentLegAttemptIdsRef.current.add(attemptId);

    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const telnyxIds = call.telnyxIDs;

        if (telnyxIds?.telnyxCallControlId || telnyxIds?.telnyxLegId || telnyxIds?.telnyxSessionId) {
          const response = await fetch(`/api/calls/${attemptId}`, {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              agentLeg: {
                ...(telnyxIds?.telnyxCallControlId ? { callControlId: telnyxIds.telnyxCallControlId } : {}),
                ...(telnyxIds?.telnyxLegId ? { callLegId: telnyxIds.telnyxLegId } : {}),
                ...(telnyxIds?.telnyxSessionId ? { callSessionId: telnyxIds.telnyxSessionId } : {}),
              },
            }),
          });

          if (!response.ok) {
            const payload = (await response.json().catch(() => ({ error: "Could not sync browser leg" }))) as { error?: string };
            throw new Error(payload.error ?? "Could not sync browser leg");
          }

          syncedAgentLegAttemptIdsRef.current.add(attemptId);
          setSoftphoneMessage(telnyxIds?.telnyxCallControlId ? "Dialing lead..." : "Browser leg connected");
          await refreshLeadsRef.current();
          return;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }

      const debug = getClientFailureDebug(call);
      throw new Error(
        `Browser call started, but no Telnyx leg identifiers were received. ` +
          `state=${debug.callState}, cause=${debug.cause ?? "-"}, sip=${debug.sipCode ?? "-"} ${debug.sipReason ?? ""}`.trim(),
      );
    } finally {
      syncingAgentLegAttemptIdsRef.current.delete(attemptId);
    }
  }

  function toggleMute() {
    if (!activeCall) {
      return;
    }

    if (callMuted) {
      activeCall.unmuteAudio();
      setCallMuted(false);
      return;
    }

    activeCall.muteAudio();
    setCallMuted(true);
  }

  useEffect(() => {
    return () => {
      void resetSoftphoneClient();
    };
  }, []);

  async function saveScriptTemplates() {
    if (!scriptDrafts) {
      return;
    }

    setSavingScripts(true);

    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scripts: scriptDrafts,
        }),
      });

      if (response.ok) {
        setSettings((current) => (current ? { ...current, scripts: scriptDrafts } : current));
      }
    } finally {
      setSavingScripts(false);
    }
  }

  useEffect(() => {
    if (!selectedLead) {
      setNotes("");
      setLastSavedNotes("");
      setDemoAgentStatus(null);
      return;
    }

    setNotes(selectedLead.notes ?? "");
    setLastSavedNotes(selectedLead.notes ?? "");
  }, [selectedLead]);

  const refreshDemoAgentStatus = useCallback(async (leadId: string) => {
    setLoadingDemoAgentStatus(true);

    try {
      const response = await fetch(`/api/leads/${leadId}/demo-agent/status`, { cache: "no-store" });
      const payload = (await response.json()) as DemoAgentStatusResponse & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load demo agent status");
      }

      setDemoAgentStatus(payload);
    } catch (statusError) {
      setSoftphoneMessage(statusError instanceof Error ? statusError.message : "Failed to load demo agent status");
    } finally {
      setLoadingDemoAgentStatus(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedLead) {
      return;
    }

    void refreshDemoAgentStatus(selectedLead.id);
  }, [refreshDemoAgentStatus, selectedLead]);

  useEffect(() => {
    if (!selectedLead || demoAgentStatus?.profile_status !== "scraping") {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshDemoAgentStatus(selectedLead.id);
    }, 2500);

    return () => window.clearInterval(interval);
  }, [demoAgentStatus?.profile_status, refreshDemoAgentStatus, selectedLead]);

  useEffect(() => {
    if (
      !latestAttempt ||
      locallyEndedAttemptIdsRef.current.has(latestAttempt.id) ||
      !["dialing", "connected"].includes(latestAttempt.status)
    ) {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshLeadsRef.current();
    }, 1500);

    return () => window.clearInterval(interval);
  }, [latestAttempt, latestAttempt?.id, latestAttempt?.status]);

  useEffect(() => {
    if (!latestAttempt || !["voicemail_detected", "completed", "failed", "canceled"].includes(latestAttempt.status)) {
      return;
    }

    setPendingAttemptId(null);
    setActiveCall(null);
    setActiveCallState("idle");
    setCallMuted(false);
    locallyEndedAttemptIdsRef.current.delete(latestAttempt.id);
    syncedAgentLegAttemptIdsRef.current.delete(latestAttempt.id);
    syncingAgentLegAttemptIdsRef.current.delete(latestAttempt.id);

    if (latestAttempt.status === "voicemail_detected") {
      setSoftphoneMessage("Voicemail detected. Call ended automatically.");
      if (!promptedVoicemailAttemptIdsRef.current.has(latestAttempt.id) && selectedLead) {
        promptedVoicemailAttemptIdsRef.current.add(latestAttempt.id);
        promptVoicemailDetected(selectedLead.businessName ?? "This lead", selectedLead.phoneNumber);
      }
      return;
    }

    if (latestAttempt.status === "completed") {
      setSoftphoneMessage("Call completed.");
      return;
    }

    if (latestAttempt.status === "canceled") {
      setSoftphoneMessage("Call canceled.");
      return;
    }

    setSoftphoneMessage("Call ended.");
  }, [latestAttempt, selectedLead]);

  useEffect(() => {
    if (!selectedLead || notes === lastSavedNotes) {
      return;
    }

    const timer = setTimeout(async () => {
      try {
        await fetch(`/api/leads/${selectedLead.id}/notes`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            body: notes,
            autosave: true,
            callAttemptId: latestAttempt?.id,
          }),
        });

        setLastSavedNotes(notes);
      } catch {
        // Ignore autosave errors; explicit save remains available.
      }
    }, 700);

    return () => clearTimeout(timer);
  }, [selectedLead, notes, lastSavedNotes, latestAttempt?.id]);

  useEffect(() => {
    function handleShortcuts(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = target && ["INPUT", "TEXTAREA"].includes(target.tagName);

      if (event.key === "/") {
        event.preventDefault();
        notesRef.current?.focus();
        return;
      }

      if (isTypingTarget) {
        return;
      }

      if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        void startCall();
        return;
      }

      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        moveToNextLead();
        return;
      }

      const mappedOutcome = shortcutOutcomeMap[event.key];
      if (mappedOutcome) {
        event.preventDefault();
        void setOutcome(mappedOutcome);
      }
    }

    window.addEventListener("keydown", handleShortcuts);

    return () => {
      window.removeEventListener("keydown", handleShortcuts);
    };
  });

  async function startCall() {
    if (!selectedLead) {
      return;
    }

    setError(null);
    setCalling(true);

    try {
      for (let authRetry = 0; authRetry < 2; authRetry += 1) {
        try {
          const client = await ensureSoftphoneReady();
          const response = await fetch(`/api/leads/${selectedLead.id}/call`, {
            method: "POST",
          });

          const payload = (await response.json()) as CallBootstrapResponse;

          if (!response.ok || !payload.callSession || !payload.attempt) {
            setError(payload.error ?? "Call initiation failed");
            return;
          }

          const attempt = payload.attempt;
          setPendingAttemptId(attempt.id);
          setActiveCallState("dialing");

          const destinationNumber = String(payload.callSession.destinationNumber);
          const callerNumber = payload.callSession.callerNumber ? String(payload.callSession.callerNumber) : undefined;
          const clientState = String(payload.callSession.clientState);
          const callOptions = {
            destinationNumber,
            ...(callerNumber ? { callerNumber } : {}),
            clientState,
            audio: true as const,
          };

          const nextCall = createBrowserCallSilently(client, callOptions);

          setActiveCall(nextCall);
          setActiveCallState(nextCall.state ?? "new");
          setCallMuted(Boolean(nextCall.isAudioMuted));
          setSoftphoneMessage("Connecting browser leg...");

          void syncAgentLegToBackend(attempt.id, nextCall).catch((syncError) => {
            const message = syncError instanceof Error ? syncError.message : "Could not sync browser leg";
            setError(message);
            setSoftphoneMessage(message);
            setPendingAttemptId(null);
            void syncAttemptFailure(attempt.id, "failed", message, getClientFailureDebug(nextCall));
          });

          await refreshLeads();
          return;
        } catch (callError) {
          const message = callError instanceof Error ? callError.message : "Call initiation failed";

          if (authRetry === 0 && isTelnyxAuthenticationErrorMessage(message)) {
            await resetSoftphoneClient();
            setSoftphoneMessage("Refreshing browser phone session...");
            continue;
          }

          throw callError;
        }
      }
    } catch (callError) {
      const message = callError instanceof Error ? callError.message : "Call initiation failed";
      const attemptId = pendingAttemptIdRef.current;

      setError(message);
      setSoftphoneStatus("error");
      setSoftphoneMessage(message);

      if (attemptId) {
        setPendingAttemptId(null);
        await syncAttemptFailure(attemptId, "failed", message);
      }
    } finally {
      setCalling(false);
    }
  }

  function moveToNextLead() {
    if (!selectedLead) {
      return;
    }

    const currentIndex = leads.findIndex((lead) => lead.id === selectedLead.id);
    const nextLead = leads[currentIndex + 1] ?? leads[0];

    if (nextLead) {
      setSelectedLeadId(nextLead.id);
    }
  }

  async function saveNote() {
    if (!selectedLead) {
      return;
    }

    setSavingNote(true);

    try {
      const response = await fetch(`/api/leads/${selectedLead.id}/notes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          body: notes,
          callAttemptId: latestAttempt?.id,
        }),
      });

      if (response.ok) {
        setLastSavedNotes(notes);
        await refreshLeads();
      }
    } finally {
      setSavingNote(false);
    }
  }

  async function setOutcome(outcome: string, callbackAt?: Date | null) {
    if (!selectedLead) {
      return;
    }

    setSavingOutcome(true);

    try {
      const response = await fetch(`/api/leads/${selectedLead.id}/outcome`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callAttemptId: latestAttempt?.id,
          outcome,
          operatorNotes: notes,
          callbackAt: callbackAt ? callbackAt.toISOString() : undefined,
        }),
      });

      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        setError(payload.error ?? "Could not save outcome");
        return;
      }

      await refreshLeads();
    } finally {
      setSavingOutcome(false);
    }
  }

  async function setFollowUp(date: Date) {
    if (!selectedLead) {
      return;
    }

    const response = await fetch(`/api/leads/${selectedLead.id}/followups`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        callAttemptId: latestAttempt?.id,
        channel: "call",
        dueAt: date.toISOString(),
        status: "open",
        note: "Callback scheduled from workspace",
      }),
    });

    if (response.ok) {
      await setOutcome("callback", date);
    }
  }

  function getDemoPreparationLabel() {
    if (loadingDemoAgentStatus) return "Loading status";
    if (!demoAgentStatus || demoAgentStatus.profile_status === "draft") return "Not prepared";
    if (demoAgentStatus.profile_status === "scraping") return "Preparing";
    if (demoAgentStatus.profile_status === "ready" && demoAgentStatus.is_demo_ready) return "Prepared";
    if (demoAgentStatus.profile_status === "ready") return "Prepared";
    if (demoAgentStatus.profile_status === "active") return "Prepared";
    if (demoAgentStatus.profile_status === "failed") return "Failed";
    return demoAgentStatus.profile_status;
  }

  const scriptVariables = {
    businessName: selectedLead?.businessName ?? "",
    contactName: selectedLead?.contactName ?? "",
    city: selectedLead?.city ?? "",
    state: selectedLead?.state ?? "",
    niche: selectedLead?.niche ?? "",
  };

  const displayedCallStatus = latestAttempt?.status ?? mapBrowserCallStateToStatus(activeCallState);
  const latestAttemptDismissed = latestAttempt ? locallyEndedAttemptIdsRef.current.has(latestAttempt.id) : false;
  const callInProgress =
    Boolean(latestAttempt && !latestAttemptDismissed && ["dialing", "connected"].includes(latestAttempt.status)) ||
    Boolean(activeCall && !["hangup", "destroy", "purge"].includes(activeCallState));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div>
          <h1 className="text-xl font-semibold">Lead Queue / Calling Workspace</h1>
          <p className="text-sm text-slate-600">Shortcuts: C call, N next lead, 1..8 outcomes, / focus notes</p>
        </div>
        <Button loading={loading} onClick={() => void refreshLeads()} variant="outline">
          <RefreshCcw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {error ? <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Lead list</CardTitle>
            <CardDescription>{loading ? "Loading..." : `${leads.length} leads loaded`}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {leads.length === 0 ? <p className="text-sm text-slate-500">No leads yet. Import a CSV first.</p> : null}
            {leads.map((lead) => (
              <button
                className={`w-full rounded-md border px-3 py-2 text-left ${selectedLeadId === lead.id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white hover:bg-slate-50"}`}
                key={lead.id}
                onClick={() => setSelectedLeadId(lead.id)}
                type="button"
              >
                <p className="truncate font-medium">{lead.businessName ?? "Untitled business"}</p>
                <p className="truncate text-xs opacity-80">{lead.phoneNumber}</p>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card className="xl:col-span-5">
          <CardHeader>
            <CardTitle>{selectedLead?.businessName ?? "Select a lead"}</CardTitle>
            <CardDescription>
              {selectedLead ? `${selectedLead.contactName ?? "No contact name"} • ${selectedLead.phoneNumber}` : "Choose a lead from the left"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {selectedLead ? (
              <>
                <div className="grid gap-2 text-sm md:grid-cols-2">
                  <p>
                    <span className="font-medium">Location:</span> {selectedLead.city ?? "-"}, {selectedLead.state ?? "-"}
                  </p>
                  <p>
                    <span className="font-medium">Niche:</span> {selectedLead.niche ?? "-"}
                  </p>
                  <p className="md:col-span-2">
                    <span className="font-medium">Website:</span> {selectedLead.website ?? "-"}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {selectedLead.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button disabled={callInProgress} loading={calling} onClick={() => void startCall()}>
                    <PhoneCall className="mr-2 h-4 w-4" />
                    {calling ? "Starting..." : callInProgress ? "Call Live" : "Call"}
                  </Button>
                  <Button disabled={!activeCall} onClick={() => void hangupBrowserCall()} variant="destructive">
                    <PhoneOff className="mr-2 h-4 w-4" />
                    Hang up
                  </Button>
                  <Button disabled={!activeCall} onClick={toggleMute} variant="outline">
                    {callMuted ? <Mic className="mr-2 h-4 w-4" /> : <MicOff className="mr-2 h-4 w-4" />}
                    {callMuted ? "Unmute" : "Mute"}
                  </Button>
                  <Button onClick={moveToNextLead} variant="secondary">
                    Skip
                  </Button>
                  <Button disabled={savingOutcome} onClick={() => void setOutcome("bad_number")} variant="destructive">
                    Mark bad number
                  </Button>
                  <Button
                    disabled={!selectedLead.website}
                    onClick={() => {
                      if (selectedLead.website) {
                        const target = selectedLead.website.startsWith("http") ? selectedLead.website : `https://${selectedLead.website}`;
                        window.open(target, "_blank", "noopener,noreferrer");
                      }
                    }}
                    variant="outline"
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open website
                  </Button>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">Demo agent:</span>
                    <Badge variant="secondary">{demoAgentStatus?.agent_id ?? "agent-87112821-4661-4dd9-a22e-ba57b48feb17"}</Badge>
                    <Badge variant="outline">{getDemoPreparationLabel()}</Badge>
                  </div>
                  {demoAgentStatus?.summary ? (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <p className="font-medium text-emerald-700">Demo-ready compact profile</p>
                      <p>Business: {demoAgentStatus.summary.businessName ?? "-"}</p>
                      <p>Services: {demoAgentStatus.summary.servicesCount} approved</p>
                      <p>FAQs: {demoAgentStatus.summary.faqsCount} approved</p>
                      <p>{demoAgentStatus.summary.hoursStatus === "listed" || demoAgentStatus.summary.hasHours ? "Hours found" : "Hours not found"}</p>
                      <p>
                        {demoAgentStatus.summary.pricingStatus === "partial"
                          ? "Pricing partial"
                          : demoAgentStatus.summary.pricingStatus === "listed" || demoAgentStatus.summary.hasPricing
                            ? "Pricing found"
                            : "Pricing not found"}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-2 text-slate-600">Prepare a website scrape to build the clinic profile used by the shared inbound demo agent.</p>
                  )}
                  {demoAgentStatus?.last_prepared_at ? (
                    <p className="mt-2 text-xs text-slate-500">Last prepared: {format(new Date(demoAgentStatus.last_prepared_at), "PPp")}</p>
                  ) : null}
                  {demoAgentStatus && demoAgentStatus.profile_status !== "draft" ? (
                    <p className="mt-2 text-xs text-slate-500">
                      Scrape: {demoAgentStatus.scrape_status}
                      {typeof demoAgentStatus.pages_scraped === "number" ? ` • ${demoAgentStatus.pages_scraped} pages saved` : ""}
                      {typeof demoAgentStatus.pages_failed === "number" && demoAgentStatus.pages_failed > 0
                        ? ` • ${demoAgentStatus.pages_failed} pages failed`
                        : ""}
                    </p>
                  ) : null}
                  {demoAgentStatus?.demo_ready_blockers?.length ? (
                    <p className="mt-2 text-red-700">{demoAgentStatus.demo_ready_blockers.join("; ")}</p>
                  ) : null}
                  {demoAgentStatus?.scrape_error ? <p className="mt-2 text-red-700">{demoAgentStatus.scrape_error}</p> : null}
                  {demoAgentStatus?.profile_status === "draft" || !demoAgentStatus ? (
                    <Link className="mt-2 inline-flex text-sm font-medium text-cyan-700 hover:text-cyan-900" href="/automations">
                      Open Automations
                    </Link>
                  ) : null}
                </div>

                <Card className="bg-slate-50">
                  <CardHeader>
                    <CardTitle className="text-base">Call controls</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <audio ref={remoteAudioRef} autoPlay className="hidden" playsInline />
                    <p>
                      <span className="font-medium">Browser phone:</span> {getSoftphoneStatusLabel(softphoneStatus)}
                    </p>
                    {softphoneMessage ? <p className="text-xs text-slate-500">{softphoneMessage}</p> : null}
                    <p>
                      <span className="font-medium">State:</span> {displayedCallStatus}
                    </p>
                    <p>
                      <span className="font-medium">Started:</span> {latestAttempt?.startedAt ? format(new Date(latestAttempt.startedAt), "PPpp") : "-"}
                    </p>
                    <p>
                      <span className="font-medium">Answered:</span> {latestAttempt?.answeredAt ? format(new Date(latestAttempt.answeredAt), "PPpp") : "-"}
                    </p>
                    <p>
                      <span className="font-medium">Ended:</span> {latestAttempt?.endedAt ? format(new Date(latestAttempt.endedAt), "PPpp") : "-"}
                    </p>
                    <p>
                      <span className="font-medium">Duration:</span> {latestAttempt?.durationSeconds ? `${latestAttempt.durationSeconds}s` : "-"}
                    </p>
                    <p>
                      <span className="font-medium">AMD:</span> {latestAttempt?.amdResult ?? "-"}
                    </p>

                    <p>
                      <span className="font-medium">Recording:</span>{" "}
                      {latestAttempt?.recording?.downloadUrl ? (
                        <a
                          className="text-cyan-700 underline"
                          href={latestAttempt.recording.downloadUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open recording
                        </a>
                      ) : (
                        "Pending"
                      )}
                    </p>
                    <p>
                      <span className="font-medium">Transcript:</span> {latestAttempt?.transcript?.status ?? "Pending"}
                    </p>
                    {latestAttempt?.transcript?.text ? (
                      <p className="rounded-md border border-slate-200 bg-white p-2 text-xs whitespace-pre-wrap">
                        {latestAttempt.transcript.text}
                      </p>
                    ) : null}

                    <Accordion collapsible type="single">
                      <AccordionItem value="debug">
                        <AccordionTrigger>Telnyx debug identifiers</AccordionTrigger>
                        <AccordionContent>
                          <div className="space-y-1 text-xs">
                            <p>Connection ID: {latestAttempt?.telnyxConnectionId ?? "-"}</p>
                            <p>Lead Call Control ID: {latestAttempt?.telnyxCallControlId ?? "-"}</p>
                            <p>Lead Leg ID: {latestAttempt?.telnyxCallLegId ?? "-"}</p>
                            <p>Agent Call Control ID: {latestAttempt?.telnyxAgentCallControlId ?? "-"}</p>
                            <p>Agent Leg ID: {latestAttempt?.telnyxAgentCallLegId ?? "-"}</p>
                            <p>Session ID: {latestAttempt?.telnyxCallSessionId ?? "-"}</p>
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </CardContent>
                </Card>

                <div>
                  <p className="mb-2 text-sm font-medium">After-call outcomes</p>
                  <div className="flex flex-wrap gap-2">
                    {outcomeButtons.map((item) => (
                      <Button
                        disabled={savingOutcome}
                        key={item.outcome}
                        onClick={() => void setOutcome(item.outcome)}
                        size="sm"
                        variant="outline"
                      >
                        {item.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-500">Select a lead to begin.</p>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-4">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Script + Notes</CardTitle>
                <CardDescription>Editable operator notes and callback controls.</CardDescription>
              </div>
              <Button onClick={() => setShowScripts((value) => !value)} size="sm" variant="secondary">
                {showScripts ? "Hide scripts" : "Show scripts"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {showScripts && settings && scriptDrafts ? (
              <Accordion type="multiple">
                {(Object.keys(scriptDrafts) as ScriptKey[]).map((key) => (
                  <AccordionItem key={key} value={key}>
                    <AccordionTrigger>{key}</AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-2">
                        <Textarea
                          value={scriptDrafts[key]}
                          onChange={(event) =>
                            setScriptDrafts((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    [key]: event.target.value,
                                  }
                                : prev,
                            )
                          }
                        />
                        <p className="rounded-md bg-slate-50 p-2 text-xs">
                          {applyTemplateVariables(scriptDrafts[key], scriptVariables)}
                        </p>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
                <Button loading={savingScripts} onClick={() => void saveScriptTemplates()} size="sm" variant="outline">
                  Save scripts
                </Button>
              </Accordion>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="notes-box">Notes</Label>
              <Textarea id="notes-box" ref={notesRef} value={notes} onChange={(event) => setNotes(event.target.value)} />
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{notes === lastSavedNotes ? "Saved" : "Saving..."}</span>
                <Button loading={savingNote} onClick={() => void saveNote()} size="sm" variant="outline">
                  Save note
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Set callback</Label>
              <div className="flex flex-wrap gap-2">
                <Button disabled={savingOutcome} onClick={() => void setFollowUp(getCallbackDate("today_later"))} size="sm" variant="secondary">
                  Today later
                </Button>
                <Button disabled={savingOutcome} onClick={() => void setFollowUp(getCallbackDate("tomorrow_morning"))} size="sm" variant="secondary">
                  Tomorrow morning
                </Button>
                <Button disabled={savingOutcome} onClick={() => void setFollowUp(getCallbackDate("tomorrow_afternoon"))} size="sm" variant="secondary">
                  Tomorrow afternoon
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="datetime-local"
                  value={customCallbackAt}
                  onChange={(event) => setCustomCallbackAt(event.target.value)}
                />
                <Button
                  disabled={savingOutcome || !customCallbackAt}
                  onClick={() => {
                    if (customCallbackAt) {
                      void setFollowUp(new Date(customCallbackAt));
                    }
                  }}
                  size="sm"
                >
                  Set
                </Button>
              </div>
            </div>

            {selectedLead?.followUps.length ? (
              <div className="space-y-1 text-xs text-slate-600">
                <p className="font-medium">Upcoming follow-ups</p>
                {selectedLead.followUps.slice(0, 3).map((followUp) => (
                  <p key={followUp.id}>• {format(new Date(followUp.dueAt), "PPpp")}</p>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

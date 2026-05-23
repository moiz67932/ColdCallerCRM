"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { addDays, format } from "date-fns";
import { ExternalLink, PhoneCall, PhoneOff, RefreshCcw } from "lucide-react";
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
  rawSummaryJson?: {
    browserLegFailed?: boolean;
    browserLegFailureReason?: string | null;
    clientDebug?: Record<string, string | number | boolean | null>;
  } | null;
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
  error?: string;
};

type WebRtcTokenResponse = {
  loginToken?: string;
  credentialId?: string;
  sipUsername?: string;
  error?: string;
};

type WebRtcCall = {
  id?: string;
  state?: string;
  cause?: string;
  causeCode?: number;
  sipCode?: number;
  sipReason?: string;
  direction?: string;
  telnyxIDs?: {
    telnyxCallControlId?: string;
    telnyxSessionId?: string;
    telnyxLegId?: string;
  };
  remoteStream?: MediaStream;
  answer: (params?: { video?: boolean }) => Promise<void> | void;
  hangup: () => Promise<void> | void;
};

type WebRtcNotification = {
  type: string;
  call?: WebRtcCall;
  error?: Error;
};

type TelnyxWebRtcClient = {
  remoteElement?: HTMLMediaElement | string;
  connect: () => void;
  disconnect: () => void;
  on: (eventName: string, callback: (event?: WebRtcNotification) => void) => TelnyxWebRtcClient;
  off?: (eventName: string) => TelnyxWebRtcClient;
};

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
  const [callMessage, setCallMessage] = useState<string | null>(null);
  const [webrtcStatus, setWebrtcStatus] = useState("offline");
  const [micPermission, setMicPermission] = useState("unknown");
  const [activeWebRtcCallControlId, setActiveWebRtcCallControlId] = useState<string | null>(null);
  const [pendingAttemptId, setPendingAttemptId] = useState<string | null>(null);
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [savingScripts, setSavingScripts] = useState(false);
  const [demoAgentStatus, setDemoAgentStatus] = useState<DemoAgentStatusResponse | null>(null);
  const [loadingDemoAgentStatus, setLoadingDemoAgentStatus] = useState(false);
  const locallyEndedAttemptIdsRef = useRef<Set<string>>(new Set());
  const promptedVoicemailAttemptIdsRef = useRef<Set<string>>(new Set());
  const telnyxClientRef = useRef<TelnyxWebRtcClient | null>(null);
  const webRtcCallRef = useRef<WebRtcCall | null>(null);
  const webRtcReadyRef = useRef(false);
  const webRtcConnectPromiseRef = useRef<Promise<void> | null>(null);
  const webRtcClientGenerationRef = useRef(0);
  const answeredWebRtcCallIdsRef = useRef<Set<string>>(new Set());
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const didInitialLeadLoadRef = useRef(false);
  const didLoadSettingsRef = useRef(false);
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
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
    function disconnectOnPageHide() {
      disconnectTelnyxWebRtcClient("page_hide");
    }

    window.addEventListener("pagehide", disconnectOnPageHide);

    return () => {
      window.removeEventListener("pagehide", disconnectOnPageHide);
      disconnectTelnyxWebRtcClient("component_unmount");
    };
  }, []);

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

  async function logBrowserWebRtcEvent(event: string, data: Record<string, string | number | boolean | null> = {}) {
    const attemptId = pendingAttemptIdRef.current ?? latestAttempt?.id;
    const payload = {
      event,
      activeAttemptId: attemptId ?? null,
      ...data,
    };

    console.info(JSON.stringify({ source: "browser_webrtc", ...payload }));

    if (!attemptId) {
      return;
    }

    await fetch(`/api/calls/${attemptId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        debug: payload,
      }),
    }).catch(() => undefined);
  }

  function getWebRtcCallControlId(call?: WebRtcCall) {
    return call?.telnyxIDs?.telnyxCallControlId ?? null;
  }

  function disconnectTelnyxWebRtcClient(reason: string) {
    webRtcClientGenerationRef.current += 1;
    webRtcConnectPromiseRef.current = null;
    webRtcReadyRef.current = false;
    answeredWebRtcCallIdsRef.current.clear();

    const call = webRtcCallRef.current;
    const client = telnyxClientRef.current;
    webRtcCallRef.current = null;
    telnyxClientRef.current = null;
    setActiveWebRtcCallControlId(null);

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }

    try {
      void call?.hangup();
    } catch {
      // The SDK may already have finalized the call during page teardown.
    }

    try {
      client?.off?.("telnyx.ready");
      client?.off?.("telnyx.error");
      client?.off?.("telnyx.notification");
      client?.disconnect();
    } catch {
      // The SDK can throw if the socket was already closed.
    }

    void logBrowserWebRtcEvent("webrtc_client_disconnected", { reason });
  }

  async function updateRemoteAudioState(call: WebRtcCall) {
    const remoteAudio = remoteAudioRef.current;
    const remoteTrackCount = call.remoteStream?.getAudioTracks().length ?? 0;
    const browserCallControlId = getWebRtcCallControlId(call);

    if (remoteAudio && call.remoteStream && remoteAudio.srcObject !== call.remoteStream) {
      remoteAudio.srcObject = call.remoteStream;
      await logBrowserWebRtcEvent("audio_remote_stream_attached", {
        browserCallControlId,
        remoteTrackCount,
      });
    }

    if (remoteAudio) {
      await remoteAudio
        .play()
        .then(() =>
          logBrowserWebRtcEvent("remote_audio_play_success", {
            browserCallControlId,
            remoteTrackCount,
            audio_play_success_or_failure: "success",
          }),
        )
        .catch((playError) => {
          void logBrowserWebRtcEvent("remote_audio_play_failed", {
            browserCallControlId,
            remoteTrackCount,
            audio_play_success_or_failure: "failure",
            error: playError instanceof Error ? playError.message : "unknown",
          });
        });
    }

    await logBrowserWebRtcEvent("remote_audio_track_check", {
      browserCallControlId,
      remoteTrackCount,
    });
  }

  async function handleWebRtcNotification(notification: WebRtcNotification | undefined, generation: number) {
    if (generation !== webRtcClientGenerationRef.current) {
      return;
    }

    if (!notification) {
      return;
    }

    await logBrowserWebRtcEvent("telnyx_notification_received", {
      notificationType: notification.type ?? null,
      hasCall: Boolean(notification.call),
      state: notification.call?.state ?? null,
    });

    if (notification.error) {
      const message = notification.error.message;
      setWebrtcStatus("error");
      setCallMessage(message);
      await logBrowserWebRtcEvent("webrtc_error", { error: message });
      return;
    }

    if (notification.type !== "callUpdate" || !notification.call) {
      return;
    }

    const call = notification.call;
    webRtcCallRef.current = call;

    const browserCallControlId = getWebRtcCallControlId(call);
    setActiveWebRtcCallControlId(browserCallControlId);
    const browserCallKey = call.id ?? browserCallControlId ?? "unknown";

    await logBrowserWebRtcEvent("webrtc_call_update", {
      browserCallId: call.id ?? null,
      browserCallControlId,
      browserLegId: call.telnyxIDs?.telnyxLegId ?? null,
      browserSessionId: call.telnyxIDs?.telnyxSessionId ?? null,
      direction: call.direction ?? null,
      state: call.state ?? null,
    });

    await logBrowserWebRtcEvent("incoming_browser_call_state", {
      browserCallId: call.id ?? null,
      browserCallControlId,
      direction: call.direction ?? null,
      state: call.state ?? null,
    });

    if (call.state === "ringing") {
      await logBrowserWebRtcEvent("incoming_webrtc_call_received", {
        browserCallId: call.id ?? null,
        browserCallControlId,
        direction: call.direction ?? null,
      });

      if (answeredWebRtcCallIdsRef.current.has(browserCallKey)) {
        return;
      }

      answeredWebRtcCallIdsRef.current.add(browserCallKey);
      setWebrtcStatus("answering");
      await logBrowserWebRtcEvent("answering_incoming_browser_leg", {
        browserCallId: call.id ?? null,
        browserCallControlId,
      });
      await logBrowserWebRtcEvent("incoming_webrtc_call_answer_called", {
        browserCallId: call.id ?? null,
        browserCallControlId,
      });
      try {
        await call.answer({ video: false });
        await logBrowserWebRtcEvent("browser_leg_answered", {
          browserCallId: call.id ?? null,
          browserCallControlId,
        });
      } catch (answerError) {
        const message = answerError instanceof Error ? answerError.message : "Failed to answer browser leg";
        setWebrtcStatus("error");
        setCallMessage(message);
        await logBrowserWebRtcEvent("browser_leg_answer_failed", {
          browserCallId: call.id ?? null,
          browserCallControlId,
          error: message,
        });
      }
      return;
    }

    if (["active", "answered", "early", "held"].includes(call.state ?? "")) {
      setWebrtcStatus("in-call");
      await logBrowserWebRtcEvent("incoming_webrtc_call_active", {
        browserCallId: call.id ?? null,
        browserCallControlId,
        state: call.state ?? null,
      });
      await updateRemoteAudioState(call);
    }

    if (["hangup", "destroy", "purge", "done"].includes(call.state ?? "")) {
      await logBrowserWebRtcEvent("browser_leg_hangup", {
        browserCallId: call.id ?? null,
        browserCallControlId,
        cause: call.cause ?? null,
        causeCode: call.causeCode ?? null,
        sipCode: call.sipCode ?? null,
        sipReason: call.sipReason ?? null,
      });
      setWebrtcStatus(webRtcReadyRef.current ? "ready" : "offline");
      setActiveWebRtcCallControlId(null);
      webRtcCallRef.current = null;
    }
  }

  async function ensureTelnyxWebRtcReady() {
    if (webRtcReadyRef.current && telnyxClientRef.current) {
      return webRtcConnectPromiseRef.current ?? Promise.resolve();
    }

    if (webRtcConnectPromiseRef.current) {
      return webRtcConnectPromiseRef.current;
    }

    const connectPromise = (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not expose microphone access for WebRTC.");
      }

      setWebrtcStatus("checking microphone");
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStream.getTracks().forEach((track) => track.stop());
      setMicPermission("granted");
      await logBrowserWebRtcEvent("microphone_permission_granted");

      setWebrtcStatus("requesting token");
      const tokenResponse = await fetch("/api/telnyx/webrtc-token", {
        method: "POST",
      });
      const tokenPayload = (await tokenResponse.json()) as WebRtcTokenResponse;

      if (!tokenResponse.ok || !tokenPayload.loginToken) {
        throw new Error(tokenPayload.error ?? "Could not create Telnyx WebRTC token");
      }

      const generation = webRtcClientGenerationRef.current + 1;
      webRtcClientGenerationRef.current = generation;
      const { TelnyxRTC } = await import("@telnyx/webrtc");
      const client = new TelnyxRTC({
        login_token: tokenPayload.loginToken,
        debug: true,
        mediaPermissionsRecovery: {
          enabled: true,
          timeout: 10_000,
        },
      }) as TelnyxWebRtcClient;

      client.remoteElement = remoteAudioRef.current ?? "telnyx-remote-audio";
      telnyxClientRef.current = client;

      setWebrtcStatus("registering");
      await logBrowserWebRtcEvent("webrtc_registration_started", {
        credentialId: tokenPayload.credentialId ?? null,
        sipUsername: tokenPayload.sipUsername ?? null,
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          reject(new Error("Timed out waiting for Telnyx WebRTC registration"));
        }, 15_000);

        client
          .on("telnyx.ready", () => {
            if (generation !== webRtcClientGenerationRef.current) {
              return;
            }

            window.clearTimeout(timeout);
            webRtcReadyRef.current = true;
            setWebrtcStatus("ready");
            void logBrowserWebRtcEvent("telnyx_ready", {
              credentialId: tokenPayload.credentialId ?? null,
              sipUsername: tokenPayload.sipUsername ?? null,
            });
            void logBrowserWebRtcEvent("telnyx_ready_for_attempt", {
              credentialId: tokenPayload.credentialId ?? null,
              sipUsername: tokenPayload.sipUsername ?? null,
            });
            resolve();
          })
          .on("telnyx.error", (event) => {
            if (generation !== webRtcClientGenerationRef.current) {
              return;
            }

            const message = event?.error?.message ?? "Telnyx WebRTC error";
            window.clearTimeout(timeout);
            setWebrtcStatus("error");
            void logBrowserWebRtcEvent("webrtc_registration_error", { error: message });
            reject(new Error(message));
          })
          .on("telnyx.notification", (event) => {
            void handleWebRtcNotification(event, generation);
          });

        client.connect();
      });
    })();

    webRtcConnectPromiseRef.current = connectPromise;

    try {
      await connectPromise;
    } catch (connectError) {
      if (webRtcConnectPromiseRef.current === connectPromise) {
        webRtcConnectPromiseRef.current = null;
      }
      throw connectError;
    }
  }

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
      setCallMessage(statusError instanceof Error ? statusError.message : "Failed to load demo agent status");
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
    locallyEndedAttemptIdsRef.current.delete(latestAttempt.id);

    if (latestAttempt.status === "voicemail_detected") {
      setCallMessage("Voicemail detected. Call ended automatically.");
      if (!promptedVoicemailAttemptIdsRef.current.has(latestAttempt.id) && selectedLead) {
        promptedVoicemailAttemptIdsRef.current.add(latestAttempt.id);
        promptVoicemailDetected(selectedLead.businessName ?? "This lead", selectedLead.phoneNumber);
      }
      return;
    }

    if (latestAttempt.status === "completed") {
      setCallMessage("Call completed.");
      return;
    }

    if (latestAttempt.status === "canceled") {
      setCallMessage("Call canceled.");
      return;
    }

    setCallMessage("Call ended.");
  }, [latestAttempt, selectedLead]);

  useEffect(() => {
    if (!latestAttempt?.rawSummaryJson?.browserLegFailed) {
      return;
    }

    const message =
      latestAttempt.rawSummaryJson.browserLegFailureReason === "user_busy"
        ? "Browser softphone was not ready."
        : "Browser softphone leg failed.";

    setError(message);
    setCallMessage(message);
  }, [latestAttempt?.id, latestAttempt?.rawSummaryJson?.browserLegFailed, latestAttempt?.rawSummaryJson?.browserLegFailureReason]);

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
    setCallMessage("Starting outbound call...");
    setCalling(true);

    try {
      const createResponse = await fetch(`/api/leads/${selectedLead.id}/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "create_attempt",
        }),
      });

      const createPayload = (await createResponse.json()) as CallBootstrapResponse;

      if (!createResponse.ok || !createPayload.attempt) {
        setError(createPayload.error ?? "Call initiation failed");
        setCallMessage(createPayload.error ?? "Call initiation failed");
        return;
      }

      pendingAttemptIdRef.current = createPayload.attempt.id;
      setPendingAttemptId(createPayload.attempt.id);
      setCallMessage("Preparing browser softphone...");

      await ensureTelnyxWebRtcReady();
      await logBrowserWebRtcEvent("telnyx_ready_for_attempt", {
        callAttemptId: createPayload.attempt.id,
      });

      setCallMessage("Browser softphone ready. Starting outbound call...");

      const response = await fetch(`/api/leads/${selectedLead.id}/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "start_pstn",
          attemptId: createPayload.attempt.id,
          webrtcReady: true,
        }),
      });

      const payload = (await response.json()) as CallBootstrapResponse;

      if (!response.ok || !payload.attempt) {
        setError(payload.error ?? "Call initiation failed");
        setCallMessage(payload.error ?? "Call initiation failed");
        return;
      }

      await logBrowserWebRtcEvent("browser_ready_before_pstn_call", {
        callAttemptId: payload.attempt.id,
      });
      setCallMessage("Outbound call started. Browser softphone is waiting for bridge...");
      await refreshLeads();
    } catch (callError) {
      const message = callError instanceof Error ? callError.message : "Call initiation failed";

      setError(message);
      setCallMessage(message);
      if (message.toLowerCase().includes("microphone")) {
        setMicPermission("denied");
      }
    } finally {
      setCalling(false);
    }
  }

  async function hangupOutboundCall() {
    const attemptId = latestAttempt?.id ?? pendingAttemptIdRef.current;

    if (!attemptId) {
      return;
    }

    locallyEndedAttemptIdsRef.current.add(attemptId);
    setPendingAttemptId(null);
    setCallMessage("Ending call...");

    try {
      if (webRtcCallRef.current) {
        await webRtcCallRef.current.hangup();
        await logBrowserWebRtcEvent("browser_leg_hangup_requested", {
          browserCallControlId: getWebRtcCallControlId(webRtcCallRef.current),
        });
      }

      const response = await fetch(`/api/calls/${attemptId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "canceled",
        }),
      });
      const payload = (await response.json().catch(() => ({ error: "Could not end call" }))) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Could not end call");
      }

      await refreshLeads();
    } catch (hangupError) {
      const message = hangupError instanceof Error ? hangupError.message : "Could not end call";
      setError(message);
      setCallMessage(message);
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

  const displayedCallStatus = latestAttempt?.status ?? "idle";
  const latestAttemptDismissed = latestAttempt ? locallyEndedAttemptIdsRef.current.has(latestAttempt.id) : false;
  const callInProgress = Boolean(latestAttempt && !latestAttemptDismissed && ["dialing", "connected"].includes(latestAttempt.status));

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
                  <Button disabled={!callInProgress} onClick={() => void hangupOutboundCall()} variant="destructive">
                    <PhoneOff className="mr-2 h-4 w-4" />
                    Hang up
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
                    <p>
                      <span className="font-medium">Outbound path:</span> Telnyx Call Control
                    </p>
                    <p>
                      <span className="font-medium">Browser WebRTC:</span> {webrtcStatus}
                    </p>
                    <p>
                      <span className="font-medium">Microphone:</span> {micPermission}
                    </p>
                    <p>
                      <span className="font-medium">Browser Call Control ID:</span> {activeWebRtcCallControlId ?? latestAttempt?.telnyxAgentCallControlId ?? "-"}
                    </p>
                    <audio
                      autoPlay
                      className="hidden"
                      id="telnyx-remote-audio"
                      onLoadedMetadata={() => {
                        void logBrowserWebRtcEvent("remote_audio_metadata_loaded", {
                          hasSrcObject: Boolean(remoteAudioRef.current?.srcObject),
                        });
                      }}
                      onPlaying={() => {
                        void logBrowserWebRtcEvent("remote_audio_playing", {
                          hasSrcObject: Boolean(remoteAudioRef.current?.srcObject),
                        });
                      }}
                      ref={remoteAudioRef}
                    />
                    {callMessage ? <p className="text-xs text-slate-500">{callMessage}</p> : null}
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

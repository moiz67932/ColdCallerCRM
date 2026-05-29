"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { addDays, format } from "date-fns";
import { ExternalLink, PhoneCall, PhoneOff, RefreshCcw, Trash2 } from "lucide-react";
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
    progressState?: string | null;
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
  runtimeConfig?: {
    telnyxManualDialFlow?: "browser_first" | "pstn_first";
    telnyxWebrtcCredentialConfigured?: boolean;
  };
};

type ScriptKey = keyof SettingsResponse["settings"]["scripts"];

type CallBootstrapResponse = {
  attempt?: CallAttempt;
  lead?: LeadItem | null;
  manualDialFlow?: "browser_first" | "pstn_first";
  callerNumber?: string;
  error?: string;
};

type ManualDialUiState =
  | "browser_connecting"
  | "browser_ready"
  | "dialing_lead"
  | "lead_ringing"
  | "lead_answered"
  | "browser_answered"
  | "bridged"
  | "busy"
  | "failed"
  | "no_answer"
  | "ended";

type DebugEventEntry = {
  id: string;
  at: string;
  event: string;
  details: Record<string, string | number | boolean | null>;
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
  prevState?: string;
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
  newCall: (params: {
    destinationNumber: string;
    callerNumber: string;
    clientState?: string;
    debug?: boolean;
  }) => WebRtcCall;
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

const activeManualCallStates: ManualDialUiState[] = [
  "dialing_lead",
  "lead_ringing",
  "lead_answered",
  "browser_answered",
  "bridged",
];
const terminalManualCallStates = new Set<ManualDialUiState>(["busy", "failed", "no_answer", "ended"]);
const activeCallStatusSet = new Set(["dialing", "connected"]);
const activeAttemptLockWindowMs = 60 * 60 * 1000;

function isRecentActiveAttempt(attempt: CallAttempt, now = Date.now()) {
  if (!activeCallStatusSet.has(attempt.status)) {
    return false;
  }

  if (attempt.endedAt) {
    return false;
  }

  const progressState = attempt.rawSummaryJson?.progressState as ManualDialUiState | undefined;
  if (progressState && terminalManualCallStates.has(progressState)) {
    return false;
  }

  const activityAt = attempt.answeredAt ?? attempt.startedAt;
  if (!activityAt) {
    return true;
  }

  const activityTime = new Date(activityAt).getTime();
  if (!Number.isFinite(activityTime)) {
    return true;
  }

  return now - activityTime <= activeAttemptLockWindowMs;
}

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
  const [runtimeConfig, setRuntimeConfig] = useState<SettingsResponse["runtimeConfig"] | null>(null);
  const [scriptDrafts, setScriptDrafts] = useState<SettingsResponse["settings"]["scripts"] | null>(null);
  const [customCallbackAt, setCustomCallbackAt] = useState("");
  const [showScripts, setShowScripts] = useState(true);
  const [calling, setCalling] = useState(false);
  const [callMessage, setCallMessage] = useState<string | null>(null);
  const [webrtcStatus, setWebrtcStatus] = useState("offline");
  const [micPermission, setMicPermission] = useState("unknown");
  const [manualDialState, setManualDialState] = useState<ManualDialUiState | null>(null);
  const [debugEvents, setDebugEvents] = useState<DebugEventEntry[]>([]);
  const [activeWebRtcCallControlId, setActiveWebRtcCallControlId] = useState<string | null>(null);
  const [pendingAttemptId, setPendingAttemptId] = useState<string | null>(null);
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [savingScripts, setSavingScripts] = useState(false);
  const [deletingLeadId, setDeletingLeadId] = useState<string | null>(null);
  const locallyEndedAttemptIdsRef = useRef<Set<string>>(new Set());
  const promptedVoicemailAttemptIdsRef = useRef<Set<string>>(new Set());
  const telnyxClientRef = useRef<TelnyxWebRtcClient | null>(null);
  const webRtcCallRef = useRef<WebRtcCall | null>(null);
  const webRtcReadyRef = useRef(false);
  const webRtcConnectPromiseRef = useRef<Promise<void> | null>(null);
  const webRtcClientGenerationRef = useRef(0);
  const answeredWebRtcCallIdsRef = useRef<Set<string>>(new Set());
  const callStartAttemptedRef = useRef(false);
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
        setRuntimeConfig(payload.runtimeConfig ?? null);
        setScriptDrafts(payload.settings.scripts);
      }
    }

    if (didLoadSettingsRef.current) {
      return;
    }

    didLoadSettingsRef.current = true;
    void loadSettings();
  }, []);

  function appendDebugEvent(event: string, details: Record<string, string | number | boolean | null> = {}) {
    setDebugEvents((current) => [
      {
        id: `${Date.now()}-${event}-${current.length}`,
        at: new Date().toISOString(),
        event,
        details,
      },
      ...current,
    ].slice(0, 20));
  }

  function setUiCallState(state: ManualDialUiState, message?: string | null) {
    setManualDialState(state);
    if (message !== undefined) {
      setCallMessage(message);
    }
  }

  function encodeAttemptClientState(attemptId: string) {
    if (typeof window !== "undefined" && typeof window.btoa === "function") {
      return window.btoa(JSON.stringify({ attemptId, role: "lead" }));
    }

    return "";
  }

  function getManualDialFlow() {
    return runtimeConfig?.telnyxManualDialFlow ?? "browser_first";
  }

  function isBrowserReadyForOutboundDial() {
    return webRtcReadyRef.current && micPermission === "granted" && webrtcStatus !== "error" && !webRtcCallRef.current;
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

  async function logBrowserWebRtcEvent(event: string, data: Record<string, string | number | boolean | null> = {}) {
    const attemptId = pendingAttemptIdRef.current ?? latestAttempt?.id;
    const payload = {
      event,
      activeAttemptId: attemptId ?? null,
      ...data,
    };

    appendDebugEvent(event, payload);
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

  async function reportAttemptProgress(
    progressState: string,
    options?: {
      telnyxIds?: WebRtcCall["telnyxIDs"];
      status?: "connected" | "failed" | "canceled";
      clientError?: string;
      answeredAt?: string;
      debug?: Record<string, string | number | boolean | null>;
    },
  ) {
    const attemptId = pendingAttemptIdRef.current ?? latestAttempt?.id;

    if (!attemptId) {
      return;
    }

    await fetch(`/api/calls/${attemptId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        progressState,
        status: options?.status,
        clientError: options?.clientError,
        answeredAt: options?.answeredAt,
        debug: options?.debug,
        telnyxIds: options?.telnyxIds
          ? {
              callControlId: options.telnyxIds.telnyxCallControlId ?? null,
              callSessionId: options.telnyxIds.telnyxSessionId ?? null,
              callLegId: options.telnyxIds.telnyxLegId ?? null,
            }
          : undefined,
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
    callStartAttemptedRef.current = false;

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
    setManualDialState(null);
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
      previousState: notification.call?.prevState ?? null,
      direction: notification.call?.direction ?? null,
      browserCallId: notification.call?.id ?? null,
    });

    if (notification.error) {
      const message = notification.error.message;
      setWebrtcStatus("error");
      setUiCallState("failed", message);
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
      previousState: call.prevState ?? null,
    });
    await reportAttemptProgress(manualDialState ?? "browser_ready", {
      telnyxIds: call.telnyxIDs,
      debug: {
        notificationType: notification.type ?? null,
        browserCallId: call.id ?? null,
        browserCallControlId,
        browserSessionId: call.telnyxIDs?.telnyxSessionId ?? null,
        browserLegId: call.telnyxIDs?.telnyxLegId ?? null,
        callState: call.state ?? null,
        previousState: call.prevState ?? null,
        direction: call.direction ?? null,
      },
    });

    await logBrowserWebRtcEvent("incoming_browser_call_state", {
      browserCallId: call.id ?? null,
      browserCallControlId,
      direction: call.direction ?? null,
      state: call.state ?? null,
    });

    if (call.state === "ringing" && call.direction === "inbound") {
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
      setUiCallState("browser_answered", "Answering incoming browser leg...");
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
        await reportAttemptProgress("browser_answered", {
          telnyxIds: call.telnyxIDs,
        });
      } catch (answerError) {
        const message = answerError instanceof Error ? answerError.message : "Failed to answer browser leg";
        setWebrtcStatus("error");
        setUiCallState("failed", message);
        await logBrowserWebRtcEvent("browser_leg_answer_failed", {
          browserCallId: call.id ?? null,
          browserCallControlId,
          error: message,
        });
        await reportAttemptProgress("failed", {
          telnyxIds: call.telnyxIDs,
          clientError: message,
          status: "failed",
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
      if (call.direction === "outbound" && call.state === "early") {
        setUiCallState("lead_ringing", "Lead is ringing...");
        await reportAttemptProgress("lead_ringing", {
          telnyxIds: call.telnyxIDs,
        });
      }
      if (call.direction === "outbound" && ["active", "answered"].includes(call.state ?? "")) {
        setUiCallState("bridged", "Lead answered. Two-way audio should be live.");
        await reportAttemptProgress("bridged", {
          telnyxIds: call.telnyxIDs,
          status: "connected",
          answeredAt: new Date().toISOString(),
        });
      }
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
      const finalState =
        call.cause === "user_busy"
          ? "busy"
          : call.cause === "timeout" || call.cause === "no_answer"
            ? "no_answer"
            : manualDialState === "bridged" || manualDialState === "lead_answered"
              ? "ended"
              : "failed";
      const finalMessage =
        finalState === "busy"
          ? "Lead was busy."
          : finalState === "no_answer"
            ? "Lead did not answer."
            : finalState === "ended"
              ? "Call ended."
              : "Call failed before audio was established.";
      setUiCallState(finalState, finalMessage);
      await reportAttemptProgress(finalState, {
        telnyxIds: call.telnyxIDs,
        status: finalState === "ended" ? "canceled" : "failed",
        clientError: finalState === "failed" ? (call.sipReason ?? call.cause ?? "Call failed") : undefined,
      });
      setWebrtcStatus(webRtcReadyRef.current ? "ready" : "offline");
      setActiveWebRtcCallControlId(null);
      webRtcCallRef.current = null;
      callStartAttemptedRef.current = false;
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

      setUiCallState("browser_connecting", "Connecting browser softphone...");
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
            setUiCallState("browser_ready", "Browser softphone connected.");
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
            setUiCallState("failed", message);
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
      if (connectError instanceof Error && connectError.message.toLowerCase().includes("microphone")) {
        setMicPermission("denied");
      }
      throw connectError;
    }
  }

  async function connectBrowserSoftphone() {
    setError(null);

    try {
      await ensureTelnyxWebRtcReady();
      setUiCallState("browser_ready", "Browser softphone connected.");
    } catch (connectError) {
      const message = connectError instanceof Error ? connectError.message : "Could not connect browser softphone";
      setError(message);
      setUiCallState("failed", message);
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
      return;
    }

    setNotes(selectedLead.notes ?? "");
    setLastSavedNotes(selectedLead.notes ?? "");
  }, [selectedLead]);

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
    const progressState = latestAttempt?.rawSummaryJson?.progressState;

    if (!progressState) {
      return;
    }

    setManualDialState(progressState as ManualDialUiState);
  }, [latestAttempt?.id, latestAttempt?.rawSummaryJson?.progressState]);

  useEffect(() => {
    if (!latestAttempt || !["voicemail_detected", "completed", "failed", "canceled"].includes(latestAttempt.status)) {
      return;
    }

    setPendingAttemptId(null);
    locallyEndedAttemptIdsRef.current.delete(latestAttempt.id);
    callStartAttemptedRef.current = false;

    if (latestAttempt.status === "voicemail_detected") {
      setUiCallState("ended", "Voicemail detected. Call ended automatically.");
      if (!promptedVoicemailAttemptIdsRef.current.has(latestAttempt.id) && selectedLead) {
        promptedVoicemailAttemptIdsRef.current.add(latestAttempt.id);
        promptVoicemailDetected(selectedLead.businessName ?? "This lead", selectedLead.phoneNumber);
      }
      return;
    }

    if (latestAttempt.status === "completed") {
      setUiCallState("ended", "Call completed.");
      return;
    }

    if (latestAttempt.status === "canceled") {
      setUiCallState("ended", "Call canceled.");
      return;
    }

    setUiCallState("failed", "Call ended.");
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
    setUiCallState("failed", message);
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

    if (callStartAttemptedRef.current) {
      return;
    }

    if (!isBrowserReadyForOutboundDial()) {
      const message = "Browser softphone is not ready. Connect it before dialing.";
      setError(message);
      setUiCallState("failed", message);
      return;
    }

    setError(null);
    setUiCallState("dialing_lead", "Starting outbound call...");
    setCalling(true);
    callStartAttemptedRef.current = true;

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
        setUiCallState("failed", createPayload.error ?? "Call initiation failed");
        callStartAttemptedRef.current = false;
        return;
      }

      pendingAttemptIdRef.current = createPayload.attempt.id;
      setPendingAttemptId(createPayload.attempt.id);
      await logBrowserWebRtcEvent("browser_ready_before_outbound_call", {
        callAttemptId: createPayload.attempt.id,
        manualDialFlow: createPayload.manualDialFlow ?? getManualDialFlow(),
      });
      await reportAttemptProgress("browser_ready");

      if ((createPayload.manualDialFlow ?? getManualDialFlow()) === "browser_first") {
        const client = telnyxClientRef.current;

        if (!client) {
          throw new Error("Telnyx WebRTC client is not connected.");
        }

        if (!createPayload.callerNumber) {
          throw new Error("Outbound caller ID is missing from runtime configuration.");
        }

        const clientState = encodeAttemptClientState(createPayload.attempt.id);
        setUiCallState("dialing_lead", "Dialing lead from the browser softphone...");
        await reportAttemptProgress("dialing_lead");
        await logBrowserWebRtcEvent("placing_browser_originated_outbound_call", {
          callAttemptId: createPayload.attempt.id,
          destinationNumber: selectedLead.phoneNumber,
          callerNumber: createPayload.callerNumber ?? null,
        });

        const call = client.newCall({
          destinationNumber: selectedLead.phoneNumber,
          callerNumber: createPayload.callerNumber,
          clientState,
          debug: true,
        });

        webRtcCallRef.current = call;
        await logBrowserWebRtcEvent("browser_originated_outbound_call_created", {
          browserCallId: call.id ?? null,
          direction: call.direction ?? null,
          state: call.state ?? null,
        });
      } else {
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
          setUiCallState("failed", payload.error ?? "Call initiation failed");
          callStartAttemptedRef.current = false;
          return;
        }

        setCallMessage("Outbound call started. Browser softphone is waiting for bridge...");
      }

      await refreshLeads();
    } catch (callError) {
      const message = callError instanceof Error ? callError.message : "Call initiation failed";
      const failedAttemptId = pendingAttemptIdRef.current;

      setError(message);
      setUiCallState("failed", message);
      callStartAttemptedRef.current = false;
      setPendingAttemptId(null);
      pendingAttemptIdRef.current = null;
      if (failedAttemptId) {
        await fetch(`/api/calls/${failedAttemptId}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            status: "failed",
            clientError: message,
            progressState: "failed",
          }),
        }).catch(() => undefined);
      }
      if (message.toLowerCase().includes("microphone")) {
        setMicPermission("denied");
      }
    } finally {
      setCalling(false);
    }
  }

  async function hangupOutboundCall() {
    const attemptId = pendingAttemptIdRef.current ?? hangupAttemptId;

    if (!attemptId) {
      return;
    }

    locallyEndedAttemptIdsRef.current.add(attemptId);
    setPendingAttemptId(null);
    setUiCallState("ended", "Ending call...");

    try {
      if (webRtcCallRef.current) {
        await webRtcCallRef.current.hangup();
        await logBrowserWebRtcEvent("browser_leg_hangup_requested", {
          browserCallControlId: getWebRtcCallControlId(webRtcCallRef.current),
        });
      }
      await reportAttemptProgress("ended", {
        status: "canceled",
      });

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
      callStartAttemptedRef.current = false;
    } catch (hangupError) {
      const message = hangupError instanceof Error ? hangupError.message : "Could not end call";
      setError(message);
      setUiCallState("failed", message);
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

  async function deleteSelectedLeadFromWorkspace() {
    if (!selectedLead) {
      return;
    }

    const confirmed = window.confirm(
      `Remove ${selectedLead.businessName ?? "this lead"} from the workspace? Call history for this lead will remain available.`,
    );

    if (!confirmed) {
      return;
    }

    setDeletingLeadId(selectedLead.id);
    setError(null);

    try {
      const response = await fetch(`/api/leads/${selectedLead.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json().catch(() => ({ error: "Could not remove lead" }))) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Could not remove lead");
      }

      const currentIndex = leads.findIndex((lead) => lead.id === selectedLead.id);
      const remainingLeads = leads.filter((lead) => lead.id !== selectedLead.id);
      const nextLead = remainingLeads[currentIndex] ?? remainingLeads[currentIndex - 1] ?? null;

      setLeads(remainingLeads);
      setSelectedLeadId(nextLead?.id ?? null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not remove lead");
    } finally {
      setDeletingLeadId(null);
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

  const scriptVariables = {
    businessName: selectedLead?.businessName ?? "",
    contactName: selectedLead?.contactName ?? "",
    city: selectedLead?.city ?? "",
    state: selectedLead?.state ?? "",
    niche: selectedLead?.niche ?? "",
  };

  const displayedCallStatus = manualDialState ?? latestAttempt?.rawSummaryJson?.progressState ?? latestAttempt?.status ?? "idle";
  const now = Date.now();
  const latestAttemptDismissed = latestAttempt ? locallyEndedAttemptIdsRef.current.has(latestAttempt.id) : false;
  const latestAttemptIsActive = Boolean(latestAttempt && !latestAttemptDismissed && isRecentActiveAttempt(latestAttempt, now));
  const activeLeadAndAttempt =
    leads
      .map((lead) => ({ lead, attempt: lead.callAttempts[0] }))
      .find(({ attempt }) => attempt && !locallyEndedAttemptIdsRef.current.has(attempt.id) && attempt.id === pendingAttemptId) ?? null;
  const callInProgress = Boolean(
    pendingAttemptId ||
      latestAttemptIsActive ||
      (manualDialState && activeManualCallStates.includes(manualDialState)),
  );
  const activeCallLeadId = activeLeadAndAttempt?.lead.id ?? (callInProgress ? selectedLead?.id ?? null : null);
  const selectedLeadOwnsActiveCall = !activeCallLeadId || selectedLead?.id === activeCallLeadId;
  const hangupAttemptId = pendingAttemptId ?? activeLeadAndAttempt?.attempt?.id ?? (latestAttemptIsActive ? latestAttempt?.id : null) ?? null;
  const softphoneReady = isBrowserReadyForOutboundDial();
  const browserFirstFlow = getManualDialFlow() === "browser_first";
  const callButtonDisabled =
    calling ||
    callInProgress ||
    !selectedLead ||
    !selectedLeadOwnsActiveCall ||
    (browserFirstFlow && (!softphoneReady || !runtimeConfig?.telnyxWebrtcCredentialConfigured));

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
      {browserFirstFlow && !runtimeConfig?.telnyxWebrtcCredentialConfigured ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          WebRTC not connected: Telnyx WebRTC credential is not configured for browser-first dialing.
        </p>
      ) : null}
      {browserFirstFlow && runtimeConfig?.telnyxWebrtcCredentialConfigured && !softphoneReady ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          WebRTC not connected: connect the browser softphone before dialing. Current mic permission: {micPermission}.
        </p>
      ) : null}
      {micPermission === "denied" ? (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          Microphone blocked: browser softphone cannot answer or place calls until microphone access is granted.
        </p>
      ) : null}
      {manualDialState === "failed" && latestAttempt?.answeredAt ? (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          Lead answered but browser audio was not established cleanly.
        </p>
      ) : null}

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
                className={`w-full rounded-md border px-3 py-2 text-left ${
                  selectedLeadId === lead.id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white hover:bg-slate-50"
                } ${activeCallLeadId === lead.id && selectedLeadId !== lead.id ? "border-cyan-500 bg-cyan-50" : ""}`}
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
                  <Button
                    disabled={callInProgress || calling || (browserFirstFlow ? softphoneReady || webrtcStatus === "registering" : false)}
                    loading={webrtcStatus === "checking microphone" || webrtcStatus === "requesting token" || webrtcStatus === "registering"}
                    onClick={() => void connectBrowserSoftphone()}
                    variant="outline"
                  >
                    Connect softphone
                  </Button>
                  <Button disabled={callButtonDisabled} loading={calling} onClick={() => void startCall()}>
                    <PhoneCall className="mr-2 h-4 w-4" />
                    {calling ? "Starting..." : callInProgress ? "Call Live" : "Call"}
                  </Button>
                  <Button disabled={!hangupAttemptId} onClick={() => void hangupOutboundCall()} variant="destructive">
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
                  <Button
                    disabled={deletingLeadId === selectedLead.id || (callInProgress && selectedLeadOwnsActiveCall)}
                    loading={deletingLeadId === selectedLead.id}
                    onClick={() => void deleteSelectedLeadFromWorkspace()}
                    variant="destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove lead
                  </Button>
                </div>

                <Card className="bg-slate-50">
                  <CardHeader>
                    <CardTitle className="text-base">Call controls</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p>
                      <span className="font-medium">Outbound path:</span>{" "}
                      {browserFirstFlow ? "Browser-originated Telnyx WebRTC -> PSTN" : "Telnyx Call Control PSTN-first fallback"}
                    </p>
                    <p>
                      <span className="font-medium">Browser WebRTC:</span> {webrtcStatus}
                    </p>
                    <p>
                      <span className="font-medium">Manual dial flow:</span> {getManualDialFlow()}
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
                      <AccordionItem value="events">
                        <AccordionTrigger>Last 20 browser call events</AccordionTrigger>
                        <AccordionContent>
                          <div className="space-y-2 text-xs">
                            {debugEvents.length === 0 ? <p>No browser events captured yet.</p> : null}
                            {debugEvents.map((entry) => (
                              <div className="rounded-md border border-slate-200 bg-white p-2" key={entry.id}>
                                <p className="font-medium">{entry.event}</p>
                                <p className="text-slate-500">{format(new Date(entry.at), "HH:mm:ss")}</p>
                                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-slate-600">
                                  {JSON.stringify(entry.details, null, 2)}
                                </pre>
                              </div>
                            ))}
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

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { addDays, format } from "date-fns";
import { ExternalLink, PhoneCall, PhoneOff, RefreshCcw, Trash2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sendWebRtcDigit, silenceLocalRingback } from "@/lib/dialer/media";
import { ParallelLines } from "@/components/dialer/parallel-lines";
import { SessionControls } from "@/components/dialer/session-controls";
import type { DialSession, SessionCommandResult, ParallelAttempt } from "@/lib/dialer/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  normalizeAndValidateSmsNumber,
  renderSmsTemplate,
  smsTemplates,
  type SmsTemplateKey,
} from "@/lib/messaging/sms";

type FollowUp = {
  id: string;
  dueAt: string;
  status: "open" | "completed" | "canceled";
  note?: string | null;
};

type CallAttempt = {
  id: string;
  recordingConsentAt?: string | null;
  answerClassification?: string;
  technicalState?: string;
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
};

type LeadItem = {
  id: string;
  leadListId?: string;
  createdAt: string;
  businessName?: string | null;
  contactName?: string | null;
  phoneNumber: string;
  city?: string | null;
  state?: string | null;
  location?: string | null;
  niche?: string | null;
  website?: string | null;
  notes?: string | null;
  customFieldsJson?: Record<string, unknown> | null;
  tags: string[];
  leadList?: {
    name: string;
    sourceFileName: string;
  } | null;
  callAttempts: CallAttempt[];
  followUps: FollowUp[];
};

type SettingsResponse = {
  settings?: {
    locations?: string[];
  };
  runtimeConfig?: {
    telnyxManualDialFlow?: "browser_first" | "pstn_first";
    telnyxWebrtcCredentialConfigured?: boolean;
    portiveDemoNumber?: string | null;
    portiveBookingLink?: string | null;
  };
};

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
  | "lead_hung_up"
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
  dtmf?: (digit: string) => Promise<void> | void;
  sendDigits?: (digits: string) => Promise<void> | void;
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
  { outcome: "already_have_system", label: "Already Have System" },
];

const keypadDigits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

type SmsSendStatus = {
  tone: "neutral" | "success" | "error";
  message: string;
};

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
const terminalManualCallStates = new Set<ManualDialUiState>(["busy", "failed", "no_answer", "lead_hung_up", "ended"]);
const callStatusLabels: Record<string, string> = {
  browser_connecting: "Browser connecting",
  browser_ready: "Browser ready",
  dialing_lead: "Dialing lead",
  lead_ringing: "Lead ringing",
  lead_answered: "Lead answered",
  browser_answered: "Browser answered",
  bridged: "Connected",
  busy: "Busy",
  failed: "Failed",
  no_answer: "No answer",
  lead_hung_up: "Lead hung up",
  ended: "Ended",
  idle: "Idle",
};
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

function getCustomLeadString(lead: LeadItem | null, keys: string[]) {
  if (!lead?.customFieldsJson) {
    return "";
  }

  for (const key of keys) {
    const value = lead.customFieldsJson[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function getLeadSmsName(lead: LeadItem | null) {
  return (
    lead?.contactName?.trim() ||
    getCustomLeadString(lead, ["owner_name", "ownerName", "name", "contact_name", "contactName"]) ||
    lead?.businessName?.trim() ||
    getCustomLeadString(lead, ["clinic_name", "clinicName", "business_name", "businessName"]) ||
    ""
  );
}

export default function QueuePage() {
  const searchParams = useSearchParams();
  const parkedOperatorCallIdRef = useRef<string | null>(null);
  const [parallelAttempts, setParallelAttempts] = useState<ParallelAttempt[]>([]);
  const [parallelMetrics, setParallelMetrics] = useState<Record<string, number | null>>({});
  const [dialSession, setDialSession] = useState<DialSession | null>(null);
  const [silentRingback, setSilentRingback] = useState(false);
  const notificationHandlerRef = useRef(handleWebRtcNotification);
  const finishedWebRtcCallsRef = useRef(new Set<string>());
  const noteDraftsRef = useRef(new Map<string, { body: string; saved: string }>());
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosenDisposition, setChosenDisposition] = useState("answered");
  const selectedLeadIdRef = useRef<string | null>(null);
  const [notes, setNotes] = useState("");
  const [lastSavedNotes, setLastSavedNotes] = useState("");
  const [runtimeConfig, setRuntimeConfig] = useState<SettingsResponse["runtimeConfig"] | null>(null);
  const [locations, setLocations] = useState<string[]>([]);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [customCallbackAt, setCustomCallbackAt] = useState("");
  const [calling, setCalling] = useState(false);
  const [callMessage, setCallMessage] = useState<string | null>(null);
  const [webrtcStatus, setWebrtcStatus] = useState("offline");
  const [micPermission, setMicPermission] = useState("unknown");
  const [manualDialState, setManualDialState] = useState<ManualDialUiState | null>(null);
  const [, setDebugEvents] = useState<DebugEventEntry[]>([]);
  const [, setActiveWebRtcCallControlId] = useState<string | null>(null);
  const [pendingAttemptId, setPendingAttemptId] = useState<string | null>(null);
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [deletingLeadId, setDeletingLeadId] = useState<string | null>(null);
  const [smsTo, setSmsTo] = useState("");
  const [smsName, setSmsName] = useState("");
  const [smsTemplateKey, setSmsTemplateKey] = useState<SmsTemplateKey>("live_demo_number");
  const [smsBody, setSmsBody] = useState("");
  const [smsBodyEdited, setSmsBodyEdited] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);
  const [sendingSms, setSendingSms] = useState(false);
  const [smsSendStatus, setSmsSendStatus] = useState<SmsSendStatus | null>(null);
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
  const pendingAttemptIdRef = useRef<string | null>(null);
  const requestedLeadId = searchParams.get("leadId");

  const selectedLead = useMemo(() => leads.find((lead) => lead.id === selectedLeadId) ?? null, [leads, selectedLeadId]);
  const latestAttempt = selectedLead?.callAttempts[0] ?? null;

  const selectedSmsLeadSeed = {
    id: selectedLead?.id ?? null,
    phoneNumber: selectedLead?.phoneNumber ?? "",
    name: getLeadSmsName(selectedLead),
    clinicName: selectedLead?.businessName ?? getCustomLeadString(selectedLead, ["clinic_name", "clinicName"]),
  };
  const smsTemplateValues = useMemo(
    () => ({
      name: smsName,
      clinic_name: selectedSmsLeadSeed.clinicName,
      demo_number: runtimeConfig?.portiveDemoNumber ?? "",
      booking_link: runtimeConfig?.portiveBookingLink ?? "",
    }),
    [runtimeConfig?.portiveBookingLink, runtimeConfig?.portiveDemoNumber, selectedSmsLeadSeed.clinicName, smsName],
  );

  const refreshLeads = useCallback(async (nextLocation = selectedLocation, resetSelection = false) => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ sort: "queue" });

      if (nextLocation) {
        params.set("location", nextLocation);
      }

      const response = await fetch(`/api/leads?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as { error?: string; leads?: LeadItem[] };

      if (!response.ok || !payload.leads) {
        throw new Error(payload.error ?? "Failed to load leads");
      }

      if (!resetSelection && selectedLeadId && (pendingAttemptIdRef.current || dialSession?.active_call_id)) {
        setLeads((current) => {
          const pinned = current.find((lead) => lead.id === selectedLeadId);
          return pinned && !payload.leads!.some((lead) => lead.id === pinned.id) ? [pinned, ...payload.leads!] : payload.leads!;
        });
        return;
      }
      setLeads(payload.leads);

      if ((resetSelection || !selectedLeadId) && payload.leads.length > 0) {
        setSelectedLeadId(requestedLeadId && payload.leads.some((lead) => lead.id === requestedLeadId) ? requestedLeadId : payload.leads[0].id);
        return;
      }

      if (selectedLeadId && !payload.leads.some((lead) => lead.id === selectedLeadId)) {
        setSelectedLeadId(payload.leads[0]?.id ?? null);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load leads");
    } finally {
      setLoading(false);
    }
  }, [requestedLeadId, selectedLeadId, selectedLocation, dialSession?.active_call_id]);

  useEffect(() => { selectedLeadIdRef.current = selectedLeadId; }, [selectedLeadId]);

  useEffect(() => {
    pendingAttemptIdRef.current = pendingAttemptId;
  }, [pendingAttemptId]);

  const polledAttemptId = pendingAttemptId ?? dialSession?.active_call_id ??
    (latestAttempt && isRecentActiveAttempt(latestAttempt) ? latestAttempt.id : null);
  useEffect(() => {
    const attemptId = polledAttemptId;
    if (!attemptId) return;
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch(`/api/calls/${attemptId}`, { cache: "no-store" });
        const result = await response.json();
        if (!disposed && response.ok && result.callAttempt) {
          const attempt = result.callAttempt as CallAttempt & { leadId: string };
          setLeads((items) => items.map((lead) => lead.id !== attempt.leadId ? lead : {
            ...lead,
            callAttempts: lead.callAttempts.some((item) => item.id === attempt.id)
              ? lead.callAttempts.map((item) => item.id === attempt.id ? attempt : item)
              : pendingAttemptIdRef.current === attempt.id ? [attempt, ...lead.callAttempts] : lead.callAttempts,
          }));
        }
      } catch { /* Preserve the call reservation while the network recovers. */ }
      finally { polling = false; }
    };
    void poll();
    const interval = setInterval(() => { void poll(); }, 2000);
    return () => { disposed = true; clearInterval(interval); };
  }, [polledAttemptId]);

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
    if (!pendingAttemptIdRef.current && !dialSession?.active_call_id && requestedLeadId && leads.some((lead) => lead.id === requestedLeadId)) {
      setSelectedLeadId(requestedLeadId);
    }
  }, [leads, requestedLeadId, dialSession?.active_call_id]);

  useEffect(() => {
    if (!dialSession?.active_call_id) return;
    const winner = parallelAttempts.find((attempt) => attempt.id === dialSession.active_call_id);
    if (winner?.lead_id && leads.some((lead) => lead.id === winner.lead_id)) setSelectedLeadId(winner.lead_id);
  }, [dialSession?.active_call_id, parallelAttempts, leads]);

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
        const nextLocations = payload.settings?.locations ?? [];
        setLocations(nextLocations);
        setSelectedLocation((current) => current || nextLocations[0] || "");
        if (nextLocations[0]) {
          void refreshLeads(nextLocations[0], true);
        }
        setRuntimeConfig(payload.runtimeConfig ?? null);
      }
    }

    if (didLoadSettingsRef.current) {
      return;
    }

    didLoadSettingsRef.current = true;
    void loadSettings();
  }, []);

  useEffect(() => {
    const nextTemplateKey: SmsTemplateKey = "live_demo_number";

    setSmsTo(selectedSmsLeadSeed.phoneNumber);
    setSmsName(selectedSmsLeadSeed.name);
    setSmsTemplateKey(nextTemplateKey);
    setSmsBody(
      selectedSmsLeadSeed.id
        ? renderSmsTemplate(nextTemplateKey, {
            name: selectedSmsLeadSeed.name,
            clinic_name: selectedSmsLeadSeed.clinicName,
            demo_number: runtimeConfig?.portiveDemoNumber ?? "",
            booking_link: runtimeConfig?.portiveBookingLink ?? "",
          })
        : "",
    );
    setSmsBodyEdited(false);
    setSmsConsent(false);
    setSmsSendStatus(null);
  }, [runtimeConfig?.portiveBookingLink, runtimeConfig?.portiveDemoNumber, selectedSmsLeadSeed.id, selectedSmsLeadSeed.phoneNumber, selectedSmsLeadSeed.name, selectedSmsLeadSeed.clinicName]);

  useEffect(() => {
    if (smsTemplateKey === "custom" || smsBodyEdited) {
      return;
    }

    setSmsBody(renderSmsTemplate(smsTemplateKey, smsTemplateValues));
  }, [smsBodyEdited, smsTemplateKey, smsTemplateValues]);

  function selectWorkspaceLocation(value: string) {
    const nextLocation = value === "__all__" ? "" : value;
    setSelectedLocation(nextLocation);
    setSelectedLeadId(null);
    void refreshLeads(nextLocation, true);
  }

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
      client?.off?.("telnyx.socket.close");
      client?.off?.("telnyx.socket.error");
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

    if (notification.type === "callUpdate" && notification.call && (dialSession?.mode === "parallel" || Boolean(parkedOperatorCallIdRef.current && parkedOperatorCallIdRef.current === getWebRtcCallControlId(notification.call)))) {
      const call = notification.call;
      const controlId = getWebRtcCallControlId(call);
      if (dialSession?.operator_call_control_id && controlId && controlId !== dialSession.operator_call_control_id) return;
      if (controlId) parkedOperatorCallIdRef.current = controlId;
      if (call.state === "ringing" && call.direction === "inbound") {
        const key = call.id ?? controlId ?? "operator";
        if (!answeredWebRtcCallIdsRef.current.has(key)) {
          answeredWebRtcCallIdsRef.current.add(key);
          webRtcCallRef.current = call;
          await call.answer({ video: false });
        }
      } else if (["active", "answered", "held"].includes(call.state ?? "")) {
        webRtcCallRef.current = call;
        setWebrtcStatus("in-call");
        // This is the one parked operator media stream, never one stream per prospect.
        if (call.remoteStream && remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = call.remoteStream;
          void remoteAudioRef.current.play().catch(() => setError("Enable speaker playback before parallel dialing"));
        }
      } else if (["hangup", "destroy", "purge", "done"].includes(call.state ?? "")) {
        webRtcCallRef.current = null;
        parkedOperatorCallIdRef.current = null;
        setWebrtcStatus("ready");
      }
      return;
    }
    if (notification.call?.id && finishedWebRtcCallsRef.current.has(notification.call.id)) return;
    const immediateCall = notification.call;
    if (immediateCall?.remoteStream && ["active", "answered", "early", "held"].includes(immediateCall.state ?? "") && remoteAudioRef.current) {
      if (remoteAudioRef.current.srcObject !== immediateCall.remoteStream) remoteAudioRef.current.srcObject = immediateCall.remoteStream;
      void remoteAudioRef.current.play().catch(() => undefined);
    }
    void logBrowserWebRtcEvent("telnyx_notification_received", {
      notificationType: notification.type ?? null,
      hasCall: Boolean(notification.call),
      state: notification.call?.state ?? null,
      previousState: notification.call?.prevState ?? null,
      direction: notification.call?.direction ?? null,
      browserCallId: notification.call?.id ?? null,
    });

    if (notification.error) {
      webRtcReadyRef.current = false;
      const message = notification.error.message;
      setWebrtcStatus("error");
      setUiCallState("failed", message);
      void logBrowserWebRtcEvent("webrtc_error", { error: message });
      return;
    }

    if (notification.type !== "callUpdate" || !notification.call) {
      return;
    }

    const call = notification.call;
    if (call.id && finishedWebRtcCallsRef.current.has(call.id)) return;
    if (webRtcCallRef.current?.id && call.id && webRtcCallRef.current.id !== call.id) return;
    webRtcCallRef.current = call;

    const browserCallControlId = getWebRtcCallControlId(call);
    setActiveWebRtcCallControlId(browserCallControlId);
    const browserCallKey = call.id ?? browserCallControlId ?? "unknown";

    void logBrowserWebRtcEvent("webrtc_call_update", {
      browserCallId: call.id ?? null,
      browserCallControlId,
      browserLegId: call.telnyxIDs?.telnyxLegId ?? null,
      browserSessionId: call.telnyxIDs?.telnyxSessionId ?? null,
      direction: call.direction ?? null,
      state: call.state ?? null,
      previousState: call.prevState ?? null,
    });
    void reportAttemptProgress(manualDialState ?? "browser_ready", {
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

    void logBrowserWebRtcEvent("incoming_browser_call_state", {
      browserCallId: call.id ?? null,
      browserCallControlId,
      direction: call.direction ?? null,
      state: call.state ?? null,
    });

    if (call.state === "ringing" && call.direction === "inbound") {
      void logBrowserWebRtcEvent("incoming_webrtc_call_received", {
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
      void logBrowserWebRtcEvent("answering_incoming_browser_leg", {
        browserCallId: call.id ?? null,
        browserCallControlId,
      });
      void logBrowserWebRtcEvent("incoming_webrtc_call_answer_called", {
        browserCallId: call.id ?? null,
        browserCallControlId,
      });
      try {
        await call.answer({ video: false });
        void logBrowserWebRtcEvent("browser_leg_answered", {
          browserCallId: call.id ?? null,
          browserCallControlId,
        });
        void reportAttemptProgress("browser_answered", {
          telnyxIds: call.telnyxIDs,
        });
      } catch (answerError) {
        const message = answerError instanceof Error ? answerError.message : "Failed to answer browser leg";
        setWebrtcStatus("error");
        setUiCallState("failed", message);
        void logBrowserWebRtcEvent("browser_leg_answer_failed", {
          browserCallId: call.id ?? null,
          browserCallControlId,
          error: message,
        });
        void reportAttemptProgress("failed", {
          telnyxIds: call.telnyxIDs,
          clientError: message,
          status: "failed",
        });
      }
      return;
    }

    if (["active", "answered", "early", "held"].includes(call.state ?? "")) {
      setWebrtcStatus("in-call");
      void logBrowserWebRtcEvent("incoming_webrtc_call_active", {
        browserCallId: call.id ?? null,
        browserCallControlId,
        state: call.state ?? null,
      });
      if (call.direction === "outbound" && call.state === "early") {
        setUiCallState("lead_ringing", "Lead is ringing...");
        void reportAttemptProgress("lead_ringing", {
          telnyxIds: call.telnyxIDs,
        });
      }
      if (call.direction === "outbound" && ["active", "answered"].includes(call.state ?? "")) {
        setUiCallState("bridged", "Lead answered. Two-way audio should be live.");
        void reportAttemptProgress("bridged", {
          telnyxIds: call.telnyxIDs,
          status: "connected",
          answeredAt: new Date().toISOString(),
        });
      }
      await updateRemoteAudioState(call);
    }

    if (["hangup", "destroy", "purge", "done"].includes(call.state ?? "")) {
      if (call.id) finishedWebRtcCallsRef.current.add(call.id);
      const attemptId = pendingAttemptIdRef.current ?? latestAttempt?.id ?? null;
      const wasLocalHangup = attemptId ? locallyEndedAttemptIdsRef.current.has(attemptId) : false;
      const wasConnectedToLead =
        manualDialState === "bridged" ||
        manualDialState === "lead_answered" ||
        manualDialState === "browser_answered" ||
        Boolean(latestAttempt?.answeredAt);
      void logBrowserWebRtcEvent("browser_leg_hangup", {
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
            : wasLocalHangup
              ? "ended"
              : wasConnectedToLead
                ? "lead_hung_up"
                : "failed";
      const finalMessage =
        finalState === "busy"
          ? "Lead was busy."
          : finalState === "no_answer"
            ? "Lead did not answer."
            : finalState === "lead_hung_up"
              ? "Lead hung up."
              : finalState === "ended"
                ? "Call ended."
              : "Call failed before audio was established.";
      setUiCallState(finalState, finalMessage);
      void reportAttemptProgress(finalState, {
        telnyxIds: call.telnyxIDs,
        status: finalState === "lead_hung_up" || finalState === "ended" ? undefined : "failed",
        clientError: finalState === "failed" ? (call.sipReason ?? call.cause ?? "Call failed") : undefined,
      });
      setPendingAttemptId(null);
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
    if (telnyxClientRef.current && !webRtcReadyRef.current) {
      disconnectTelnyxWebRtcClient("reconnect_after_disconnect");
    }

    const connectPromise = (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not expose microphone access for WebRTC.");
      }

      setUiCallState("browser_connecting", "Connecting browser softphone...");
      setWebrtcStatus("checking microphone");
      let micStream: MediaStream;
      try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (error) { setMicPermission("denied"); throw error; }
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
            webRtcReadyRef.current = false;
            setWebrtcStatus("error");
            setUiCallState("failed", message);
            void logBrowserWebRtcEvent("webrtc_registration_error", { error: message });
            reject(new Error(message));
          })
          .on("telnyx.notification", (event) => {
            void notificationHandlerRef.current(event, generation);
          })
          .on("telnyx.socket.close", () => {
            if (generation !== webRtcClientGenerationRef.current) return;
            webRtcReadyRef.current = false;
            webRtcConnectPromiseRef.current = null;
            setWebrtcStatus("offline");
            setCallMessage("Softphone disconnected. Dialing is paused until it reconnects.");
          })
          .on("telnyx.socket.error", () => {
            if (generation !== webRtcClientGenerationRef.current) return;
            webRtcReadyRef.current = false;
            webRtcConnectPromiseRef.current = null;
            setWebrtcStatus("error");
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
        webRtcReadyRef.current = false;
        setWebrtcStatus("error");
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

  useEffect(() => {
    if (!selectedLead) {
      setNotes("");
      setLastSavedNotes("");
      return;
    }

    const draft = noteDraftsRef.current.get(selectedLead.id);
    setNotes(draft?.body ?? selectedLead.notes ?? "");
    setLastSavedNotes(draft?.saved ?? selectedLead.notes ?? "");
    // Notes belong to the selected ID; provider polling must not replace an unsaved draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLead?.id]);

  useEffect(() => {
    const progressState = latestAttempt?.rawSummaryJson?.progressState;

    if (!progressState) {
      return;
    }

    setManualDialState(progressState as ManualDialUiState);
    if (progressState === "lead_hung_up") {
      setCallMessage("Lead hung up.");
    }
  }, [latestAttempt?.id, latestAttempt?.rawSummaryJson?.progressState]);

  useEffect(() => {
    if (!latestAttempt || !["voicemail_detected", "completed", "failed", "canceled"].includes(latestAttempt.status)) {
      return;
    }

    setPendingAttemptId(null);
    locallyEndedAttemptIdsRef.current.delete(latestAttempt.id);
    callStartAttemptedRef.current = false;

    if (latestAttempt.rawSummaryJson?.progressState === "lead_hung_up") {
      setUiCallState("lead_hung_up", "Lead hung up.");
      return;
    }

    if (latestAttempt.status === "voicemail_detected") {
      setUiCallState("ended", "Voicemail detected. Call ended automatically.");
      if (!dialSession && !promptedVoicemailAttemptIdsRef.current.has(latestAttempt.id) && selectedLead) {
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
  }, [latestAttempt, selectedLead, dialSession]);

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
        const response = await fetch(`/api/leads/${selectedLead.id}/notes`, {
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

        if (!response.ok) throw new Error("Autosave failed");
        noteDraftsRef.current.set(selectedLead.id, { body: noteDraftsRef.current.get(selectedLead.id)?.body ?? notes, saved: notes });
        if (selectedLeadIdRef.current === selectedLead.id) setLastSavedNotes(notes);
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

      if (callInProgress && keypadDigits.includes(event.key)) {
        event.preventDefault();
        void sendDtmfDigit(event.key);
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

  async function startCall(reservation?: SessionCommandResult) {
    let callLead = selectedLead;
    if (reservation?.lead) {
      const response = await fetch(`/api/leads/${reservation.lead.id}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.lead) throw new Error(payload.error ?? "Reserved lead unavailable");
      callLead = { ...payload.lead, tags: payload.lead.tags ?? [] } as LeadItem;
      const reservedLead = callLead;
      setLeads((current) => [reservedLead, ...current.filter((lead) => lead.id !== reservedLead.id)]);
      setSelectedLeadId(callLead.id);
    } else if (dialSession) {
      setError("Use the dial-session controls while a session is active.");
      return;
    }
    if (!callLead) {
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
      const createResponse = reservation ? null : await fetch(`/api/leads/${callLead.id}/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "create_attempt",
        }),
      });

      const createPayload: CallBootstrapResponse = reservation ? {
        attempt: { id: reservation.attempt!.id, status: "dialing" },
        callerNumber: reservation.callerNumber, manualDialFlow: "browser_first",
      } : await createResponse!.json();

      if ((createResponse && !createResponse.ok) || !createPayload.attempt) {
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
          destinationNumber: reservation?.destination ?? callLead.phoneNumber,
          callerNumber: createPayload.callerNumber ?? null,
        });

        const call = client.newCall({
          destinationNumber: reservation?.destination ?? callLead.phoneNumber,
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
        const response = await fetch(`/api/leads/${callLead.id}/call`, {
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
    if (dialSession?.mode === "parallel") {
      if (!dialSession.active_call_id) return;
      const response = await fetch(`/api/calls/${dialSession.active_call_id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "canceled" }),
      });
      if (!response.ok) setError("Could not request prospect hangup; the parked operator call was preserved");
      return;
    }
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

  async function sendDtmfDigit(digit: string) {
    const call = webRtcCallRef.current;

    if (!call || !activeManualCallStates.includes((manualDialState ?? "ended") as ManualDialUiState)) {
      setCallMessage("DTMF is available only while a Telnyx WebRTC call is live.");
      return;
    }

    try {
      await sendWebRtcDigit(call, digit);

      setCallMessage(`Sent DTMF ${digit}`);
      await logBrowserWebRtcEvent("dtmf_digit_sent", {
        digit,
        browserCallControlId: getWebRtcCallControlId(call),
      });
    } catch (dtmfError) {
      const message = dtmfError instanceof Error ? dtmfError.message : "Could not send DTMF digit";
      setError(message);
      setCallMessage(message);
      await logBrowserWebRtcEvent("dtmf_digit_failed", {
        digit,
        browserCallControlId: getWebRtcCallControlId(call),
        error: message,
      });
    }
  }

  async function moveToNextLead() {
    if (pendingAttemptIdRef.current || webRtcCallRef.current || dialSession?.active_call_id) {
      setError("End the call and save its disposition before changing leads.");
      return;
    }
    if (!selectedLead) {
      return;
    }

    try { if (notes !== lastSavedNotes) await saveNote(); }
    catch (error) { setError(error instanceof Error ? error.message : "Save notes before skipping"); return; }
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

      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? "Note could not be saved");
      }
      noteDraftsRef.current.set(selectedLead.id, { body: noteDraftsRef.current.get(selectedLead.id)?.body ?? notes, saved: notes });
      if (selectedLeadIdRef.current === selectedLead.id) setLastSavedNotes(notes);
    } finally {
      setSavingNote(false);
    }
  }

  async function setOutcome(outcome: string, callbackAt?: Date | null, nextAction?: string) {
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
          nextAction,
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
    if (dialSession?.mode === "parallel" && dialSession.active_call_id && callInProgress && selectedLead) {
      const response = await fetch(`/api/leads/${selectedLead.id}/followups`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callAttemptId: dialSession.active_call_id, dueAt: date.toISOString(), channel: "call", note: "Callback requested during conversation" }),
      });
      if (!response.ok) setError("Could not save the callback reminder");
      else setCallMessage("Callback reminder saved. Select the final disposition after the conversation.");
      return;
    }
    // The outcome endpoint creates the callback once with the stable call-attempt ID.
    await setOutcome("callback", date);
  }

  function resetSmsTemplate(nextTemplateKey = smsTemplateKey, nextName = smsName) {
    setSmsBody(renderSmsTemplate(nextTemplateKey, { ...smsTemplateValues, name: nextName }));
    setSmsBodyEdited(false);
    setSmsSendStatus(null);
  }

  function selectSmsTemplate(value: string) {
    const nextTemplateKey = value as SmsTemplateKey;
    setSmsTemplateKey(nextTemplateKey);
    setSmsSendStatus(null);

    if (nextTemplateKey !== "custom") {
      setSmsBody(renderSmsTemplate(nextTemplateKey, smsTemplateValues));
      setSmsBodyEdited(false);
    }
  }

  async function sendSms() {
    if (!selectedLead || sendingSms) {
      return;
    }

    if (!smsConsent) {
      setSmsSendStatus({ tone: "error", message: "Confirm permission to text this number before sending." });
      return;
    }

    const normalizedTo = normalizeAndValidateSmsNumber(smsTo, "US");

    if (!normalizedTo.ok) {
      setSmsSendStatus({ tone: "error", message: normalizedTo.error });
      return;
    }

    if (!smsBody.trim()) {
      setSmsSendStatus({ tone: "error", message: "Enter a message before sending." });
      return;
    }

    setSendingSms(true);
    setSmsSendStatus({ tone: "neutral", message: "Sending SMS..." });

    try {
      const response = await fetch("/api/messages/sms/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          leadId: selectedLead.id,
          to: normalizedTo.number,
          body: smsBody,
          templateKey: smsTemplateKey,
          consentSource: "verbal_phone_call",
          consentNote: "User checked permission box in calling workspace",
        }),
      });
      const payload = (await response.json().catch(() => ({ error: "Could not send SMS" }))) as {
        error?: string;
        to?: string;
        status?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Could not send SMS");
      }

      const sentTo = payload.to ?? normalizedTo.number;
      setSmsTo(sentTo);
      setSmsConsent(false);
      setSmsSendStatus({ tone: "success", message: `SMS sent to ${sentTo}` });
      await refreshLeads();
    } catch (sendError) {
      setSmsSendStatus({
        tone: "error",
        message: sendError instanceof Error ? sendError.message : "Could not send SMS",
      });
    } finally {
      setSendingSms(false);
    }
  }

  useEffect(() => {
    const attemptId = dialSession?.active_call_id;
    if (!attemptId) return;
    let canceled = false;
    void (async () => {
      const response = await fetch(`/api/calls/${attemptId}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.callAttempt?.leadId) return;
      const leadResponse = await fetch(`/api/leads/${payload.callAttempt.leadId}`, { cache: "no-store" });
      const leadPayload = await leadResponse.json();
      if (!canceled && leadResponse.ok && leadPayload.lead) {
        const lead = { ...leadPayload.lead, tags: leadPayload.lead.tags ?? [] } as LeadItem;
        setLeads((items) => [lead, ...items.filter((item) => item.id !== lead.id)]);
        setSelectedLeadId(lead.id);
      }
    })().catch(() => setError("Could not recover the active call's lead. Session will remain reserved."));
    return () => { canceled = true; };
  }, [dialSession?.active_call_id]);

  useEffect(() => {
    if (dialSession?.mode !== "parallel") return;
    const acknowledge = () => {
      const call = webRtcCallRef.current;
      const controlId = getWebRtcCallControlId(call ?? undefined);
      if (!call || !controlId || !["active", "answered", "held"].includes(call.state ?? "") || !call.remoteStream?.getAudioTracks().length) return;
      void fetch("/api/dial-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        action: "operator_ready", sessionId: dialSession.id, controllerId: sessionStorage.getItem("portive-controller"),
        ready: webRtcReadyRef.current && micPermission === "granted", callControlId: controlId,
      }) }).catch(() => undefined);
    };
    acknowledge(); const timer = setInterval(acknowledge, 1500);
    return () => clearInterval(timer);
  }, [dialSession?.id, dialSession?.mode, micPermission]);

  const audioReportedAttempts = useRef(new Set<string>());
  useEffect(() => {
    if (dialSession?.mode !== "parallel" || !dialSession.active_call_id) return;
    const winner=parallelAttempts.find(a=>a.id===dialSession.active_call_id && a.was_bridged_to_operator && !a.ended_at);
    const audio=remoteAudioRef.current;
    if (!winner || !audio || audio.paused || audio.readyState<2 || audioReportedAttempts.current.has(winner.id)) return;
    audioReportedAttempts.current.add(winner.id);
    void fetch(`/api/dial-sessions/${dialSession.id}/telemetry`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({controllerId:sessionStorage.getItem("portive-controller"),attemptId:winner.id,clientAt:Date.now(),event:"operator_audio_available"})});
  }, [dialSession?.id,dialSession?.mode,dialSession?.active_call_id,parallelAttempts]);

  useEffect(() => { notificationHandlerRef.current = handleWebRtcNotification; });

  useEffect(() => {
    // Only the SDK's dedicated local tone element is changed. Never mute remote audio or a media track.
    const apply = () => silenceLocalRingback(document, silentRingback);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); silenceLocalRingback(document, false); };
  }, [silentRingback]);

  const displayedCallStatus = manualDialState ?? latestAttempt?.rawSummaryJson?.progressState ?? latestAttempt?.status ?? "idle";
  const displayedCallStatusLabel = callStatusLabels[displayedCallStatus] ?? displayedCallStatus.replaceAll("_", " ");
  const now = Date.now();
  const latestAttemptDismissed = latestAttempt ? locallyEndedAttemptIdsRef.current.has(latestAttempt.id) : false;
  const latestAttemptIsActive = Boolean(latestAttempt && !latestAttemptDismissed && isRecentActiveAttempt(latestAttempt, now));
  const activeLeadAndAttempt =
    leads
      .map((lead) => ({ lead, attempt: lead.callAttempts[0] }))
      .find(({ attempt }) => attempt && !locallyEndedAttemptIdsRef.current.has(attempt.id) && attempt.id === pendingAttemptId) ?? null;
  const callInProgress = dialSession?.mode === "parallel" ? parallelAttempts.some((attempt) => attempt.id === dialSession.active_call_id && !attempt.ended_at) : Boolean(
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
    Boolean(dialSession) ||
    calling ||
    callInProgress ||
    !selectedLead ||
    !selectedLeadOwnsActiveCall ||
    (browserFirstFlow && (!softphoneReady || !runtimeConfig?.telnyxWebrtcCredentialConfigured));
  const smsSendDisabled = sendingSms || !selectedLead || !smsConsent || !smsTo.trim() || !smsBody.trim();

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-100 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Lead Queue / Calling Workspace</h1>
          <p className="text-sm text-slate-600 dark:text-slate-300">Shortcuts: C call, N next lead, 1..8 outcomes, / focus notes</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full sm:w-56">
            <Select disabled={Boolean(dialSession) || callInProgress} value={selectedLocation || "__all__"} onValueChange={selectWorkspaceLocation}>
              <SelectTrigger>
                <SelectValue placeholder="All locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All locations</SelectItem>
                {locations.map((location) => (
                  <SelectItem key={location} value={location}>
                    {location}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button loading={loading} onClick={() => void refreshLeads()} variant="outline">
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      <SessionControls
        location={selectedLocation}
        ready={webRtcReadyRef.current && micPermission === "granted" && webrtcStatus !== "error"}
        idle={!webRtcCallRef.current && !calling && !pendingAttemptId}
        onDispatch={startCall}
        onSession={(session) => { setDialSession(session); if (session?.mode === "parallel") setSilentRingback(Boolean(session.parallel_options?.silentRingback)); }}
        onSnapshot={(snapshot) => { setParallelAttempts(snapshot.attempts); setParallelMetrics(snapshot.metrics); }}
        beforeAdvance={async () => { if (notes !== lastSavedNotes) await saveNote(); }}
        onEndCall={hangupOutboundCall}
      />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={silentRingback} onChange={(event) => setSilentRingback(event.target.checked)} />Silent local ringback (carrier early media remains audible)</label>
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
      {manualDialState === "lead_hung_up" ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
          Lead hung up.
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Lead list</CardTitle>
            <CardDescription>{loading ? "Loading..." : `${leads.length} leads loaded`}</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[calc(100vh-17rem)] space-y-2 overflow-y-auto pr-2">
            {leads.length === 0 ? <p className="text-sm text-slate-500">No leads yet. Import a CSV first.</p> : null}
            {leads.map((lead) => (
              <button
                className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                  selectedLeadId === lead.id
                    ? "border-slate-900 bg-slate-900 text-white dark:border-cyan-400 dark:bg-cyan-400 dark:text-slate-950"
                    : "border-slate-200 bg-white text-slate-900 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950/70 dark:text-slate-100 dark:hover:bg-slate-800"
                } ${
                  activeCallLeadId === lead.id && selectedLeadId !== lead.id
                    ? "border-cyan-500 bg-cyan-50 dark:border-cyan-400 dark:bg-cyan-950/50"
                    : ""
                }`}
                key={lead.id}
                disabled={Boolean(pendingAttemptId || dialSession?.active_call_id) && selectedLeadId !== lead.id}
                onClick={() => {
                  void (async () => {
                    try { if (notes !== lastSavedNotes) await saveNote(); setSelectedLeadId(lead.id); }
                    catch (error) { setError(error instanceof Error ? error.message : "Save notes before switching leads"); }
                  })();
                }}
                type="button"
              >
                <p className="truncate font-medium">{lead.businessName ?? "Untitled business"}</p>
                <p className="truncate text-xs opacity-80">{lead.phoneNumber}</p>
                <p className="truncate text-xs opacity-70">
                  {lead.location ? `${lead.location} - ` : ""}Added {format(new Date(lead.createdAt), "MMM d, yyyy")} from{" "}
                  {lead.leadList?.sourceFileName ?? "unknown file"}
                </p>
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
            {dialSession?.mode === "parallel" ? <ParallelLines attempts={parallelAttempts} winner={dialSession.active_call_id} metrics={parallelMetrics} /> : null}
            {selectedLead ? (
              <>
                <div className="grid gap-2 text-sm md:grid-cols-2">
                  <p>
                    <span className="font-medium">Location category:</span> {selectedLead.location ?? "-"}
                  </p>
                  <p>
                    <span className="font-medium">City/state:</span> {selectedLead.city ?? "-"}, {selectedLead.state ?? "-"}
                  </p>
                  <p>
                    <span className="font-medium">Niche:</span> {selectedLead.niche ?? "-"}
                  </p>
                  <p className="md:col-span-2">
                    <span className="font-medium">Website:</span> {selectedLead.website ?? "-"}
                  </p>
                  <p>
                    <span className="font-medium">Added:</span> {format(new Date(selectedLead.createdAt), "MMM d, yyyy 'at' h:mm a")}
                  </p>
                  <p>
                    <span className="font-medium">Source file:</span> {selectedLead.leadList?.sourceFileName ?? "-"}
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
                  <Button disabled={savingOutcome || Boolean(dialSession && callInProgress)} onClick={() => void setOutcome("bad_number")} variant="destructive">
                    Mark bad number
                  </Button>
                  <Button variant="outline" onClick={() => {
                    const leadId = selectedLead.id;
                    void fetch(`/api/leads/${leadId}/suppression`, { method: "POST" }).then(async (response) => {
                      const result = await response.json();
                      if (!response.ok) throw new Error(result.error ?? "Suppression failed");
                      setCallMessage("Number added to persistent Do Not Call suppression.");
                    }).catch((err) => setError(err.message));
                  }}>Do Not Call</Button>
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

                <div>
                  <p className="mb-2 text-sm font-medium">After-call outcomes</p>
                  <div className="flex flex-wrap gap-2">
                    {outcomeButtons.map((item) => (
                      <Button
                        disabled={savingOutcome || Boolean(dialSession && callInProgress)}
                        key={item.outcome}
                        onClick={() => void setOutcome(item.outcome)}
                        size="sm"
                        variant="outline"
                      >
                        {item.label}
                      </Button>
                    ))}
                    <Button size="sm" variant="outline" disabled={savingOutcome || Boolean(dialSession && callInProgress)} onClick={() => void setOutcome("gatekeeper", null, "manager_callback_pending")}>Manager callback pending</Button>
                  </div>
                  {dialSession ? <div className="mt-3 flex flex-wrap items-center gap-2">
                    <select aria-label="Disposition to save" className="rounded border bg-background p-2 text-sm" value={chosenDisposition} onChange={(event) => setChosenDisposition(event.target.value)}>{outcomeButtons.map((item) => <option value={item.outcome} key={item.outcome}>{item.label}</option>)}</select>
                    <Button disabled={savingOutcome || callInProgress} onClick={() => {
                      void (async () => { try { await saveNote(); await setOutcome(chosenDisposition); } catch (error) { setError(error instanceof Error ? error.message : "Could not save wrap-up"); } })();
                    }}>Save Disposition and Continue</Button>
                  </div> : null}
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-500">Select a lead to begin.</p>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-4">
          <CardHeader>
            <CardTitle>Dialer Notepad</CardTitle>
            <CardDescription>Notes, IVR keypad, callback controls, and call recording.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Keypad</Label>
                <span className="text-xs text-slate-500">State: {displayedCallStatusLabel}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {keypadDigits.map((digit) => (
                  <Button
                    className="h-12 text-lg font-semibold"
                    disabled={!callInProgress}
                    key={digit}
                    onClick={() => void sendDtmfDigit(digit)}
                    type="button"
                    variant="outline"
                  >
                    {digit}
                  </Button>
                ))}
              </div>
              {callMessage ? (
                <p className={`text-xs ${manualDialState === "lead_hung_up" ? "font-semibold text-amber-900 dark:text-amber-300" : "text-slate-500 dark:text-slate-400"}`}>
                  {callMessage}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label>Recording</Label>
              <Button size="sm" variant="outline" disabled={!latestAttempt || !callInProgress || Boolean(latestAttempt.recordingConsentAt)} onClick={() => {
                if (!latestAttempt) return;
                void fetch(`/api/calls/${latestAttempt.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordingConsent: true }) })
                  .then(async (response) => { if (!response.ok) throw new Error("Recording consent could not be saved"); await refreshLeads(); })
                  .catch((err) => setError(err.message));
              }}>{latestAttempt?.recordingConsentAt ? "Recording consent saved" : "Confirm recording consent"}</Button>
              {latestAttempt?.recording?.downloadUrl ? (
                <audio className="w-full" controls src={latestAttempt.recording.downloadUrl} />
              ) : (
                <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-950/70 dark:text-slate-300">
                  Recording pending or unavailable.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes-box">Notes</Label>
              <Textarea id="notes-box" ref={notesRef} value={notes} onChange={(event) => {
                setNotes(event.target.value);
                if (selectedLead) noteDraftsRef.current.set(selectedLead.id, { body: event.target.value, saved: lastSavedNotes });
              }} />
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

            <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-950/70">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm font-semibold">Send SMS</Label>
                <Button disabled={smsTemplateKey === "custom"} onClick={() => resetSmsTemplate()} size="sm" type="button" variant="ghost">
                  Reset template
                </Button>
              </div>
              <div className="grid gap-2">
                <div className="grid gap-1.5">
                  <Label className="text-xs" htmlFor="sms-to-number">
                    To
                  </Label>
                  <Input
                    id="sms-to-number"
                    onChange={(event) => {
                      setSmsTo(event.target.value);
                      setSmsSendStatus(null);
                    }}
                    placeholder="+1 mobile number"
                    value={smsTo}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs" htmlFor="sms-template-name">
                    Name
                  </Label>
                  <Input
                    id="sms-template-name"
                    onChange={(event) => {
                      const nextName = event.target.value;
                      setSmsName(nextName);
                      setSmsSendStatus(null);
                      if (!smsBodyEdited && smsTemplateKey !== "custom") {
                        setSmsBody(renderSmsTemplate(smsTemplateKey, { ...smsTemplateValues, name: nextName }));
                      }
                    }}
                    placeholder="Name for template"
                    value={smsName}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Template</Label>
                  <Select value={smsTemplateKey} onValueChange={selectSmsTemplate}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose template" />
                    </SelectTrigger>
                    <SelectContent>
                      {smsTemplates.map((template) => (
                        <SelectItem key={template.key} value={template.key}>
                          {template.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs" htmlFor="sms-message-body">
                    Message
                  </Label>
                  <Textarea
                    className="min-h-32"
                    id="sms-message-body"
                    maxLength={1600}
                    onChange={(event) => {
                      setSmsBody(event.target.value);
                      setSmsBodyEdited(true);
                      setSmsSendStatus(null);
                    }}
                    value={smsBody}
                  />
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span>{smsBody.length}/1600 characters</span>
                    <span>{smsTemplateKey === "custom" ? "Custom message" : smsBodyEdited ? "Edited" : "Template ready"}</span>
                  </div>
                </div>
              </div>
              <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
                <input
                  checked={smsConsent}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                  onChange={(event) => setSmsConsent(event.target.checked)}
                  type="checkbox"
                />
                <span>I got permission to text this number on the call.</span>
              </label>
              <p className="text-xs text-slate-500 dark:text-slate-400">Use only after the person agrees to receive the demo link by text.</p>
              <div className="flex items-center justify-between gap-3">
                <p
                  className={`min-h-4 flex-1 text-xs ${
                    smsSendStatus?.tone === "success"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : smsSendStatus?.tone === "error"
                        ? "text-red-600 dark:text-red-400"
                        : "text-slate-500 dark:text-slate-400"
                  }`}
                >
                  {smsSendStatus?.message ?? "Ready after permission is checked."}
                </p>
                <Button disabled={smsSendDisabled} loading={sendingSms} onClick={() => void sendSms()} size="sm" type="button">
                  {sendingSms ? "Sending..." : smsSendStatus?.tone === "success" ? "Sent" : "Send SMS"}
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

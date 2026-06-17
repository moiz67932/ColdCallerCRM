import type { CallStatus, JsonObject, TranscriptStatus } from "@/lib/db-types";

import { logError, logInfo } from "@/lib/logger";
import { prisma } from "@/lib/workstation-db";
import {
  computeAttemptSummary,
  bridgeAttemptLegs,
  dialBrowserWebRtcLeg,
  hangupCallControlIds,
  isCallTerminalStatus,
  isBrowserFirstManualDialFlow,
  startAttemptRecording,
} from "@/lib/telnyx/call-flow";
import { decodeClientState } from "@/lib/telnyx/client-state";
import { getPayloadValue, type TelnyxWebhookPayload } from "@/lib/telnyx/events";

type ExistingCallAttempt = NonNullable<Awaited<ReturnType<typeof prisma.callAttempt.findUnique>>>;

const TELNYX_LIFECYCLE_EVENTS = new Set([
  "call.initiated",
  "call.ringing",
  "call.answered",
  "call.hangup",
  "streaming.started",
  "streaming.stopped",
  "streaming.failed",
]);

const statusProgression: Record<CallStatus, number> = {
  dialing: 0,
  connected: 1,
  completed: 2,
  failed: 2,
  canceled: 2,
  voicemail_detected: 3,
};

async function updateWebhookProcessing(
  webhookRowId: string,
  payload: JsonObject,
  data: {
    processedAt?: Date;
    processingError?: string | null;
  },
) {
  await prisma.telnyxWebhookEvent.update({
    where: { id: webhookRowId },
    data: {
      payloadJson: payload,
      processedAt: data.processedAt,
      processingError: data.processingError,
    },
  });
}

function getPayloadNumber(payload: Record<string, unknown>, key: string) {
  const value = payload[key];

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getEventTimestamp(event: TelnyxWebhookPayload) {
  return event.data.occurred_at ? new Date(event.data.occurred_at) : new Date();
}

function getStructuredPayloadValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function getSipTransferTargets(payload: Record<string, unknown>) {
  const targetKeys = [
    "to",
    "sip_address",
    "target",
    "target_sip_uri",
    "transfer_to",
    "refer_to",
    "call_control_id_to_bridge_with",
  ];

  return Object.fromEntries(
    targetKeys
      .map((key) => [key, getStructuredPayloadValue(payload, key)])
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined),
  );
}

function getMediaStreamingState(eventType: string, payload: Record<string, unknown>) {
  return {
    eventIsStreaming: eventType.startsWith("streaming."),
    status:
      eventType === "streaming.started"
        ? "started"
        : eventType === "streaming.stopped"
          ? "stopped"
          : eventType === "streaming.failed"
            ? "failed"
            : undefined,
    streamId: getStructuredPayloadValue(payload, "stream_id"),
    streamUrl: getStructuredPayloadValue(payload, "stream_url"),
    streamTrack: getStructuredPayloadValue(payload, "stream_track"),
    streamCodec: getStructuredPayloadValue(payload, "stream_codec"),
    failureReason: getStructuredPayloadValue(payload, "failure_reason") ?? getStructuredPayloadValue(payload, "error"),
  };
}

function getWebhookLifecycleLogContext(event: TelnyxWebhookPayload, webhookRowId: string, attempt?: ExistingCallAttempt | null) {
  const eventType = event.data.event_type;
  const payload = (event.data.payload ?? {}) as Record<string, unknown>;
  const rawClientState = getPayloadValue(payload, "client_state");
  const decodedClientState = decodeClientState(rawClientState);
  const callControlId = getPayloadValue(payload, "call_control_id");
  const callSessionId = getPayloadValue(payload, "call_session_id");
  const from = getStructuredPayloadValue(payload, "from");
  const to = getStructuredPayloadValue(payload, "to");
  const hangupCause = getStructuredPayloadValue(payload, "hangup_cause");
  const role = attempt ? getCallRole(attempt, callControlId, decodedClientState?.role ?? null) : decodedClientState?.role ?? null;
  const legType = role === "agent" ? "browser" : "lead";

  return {
    attemptId: attempt?.id ?? decodedClientState?.attemptId ?? null,
    legType,
    call_control_id: callControlId ?? null,
    call_session_id: callSessionId ?? null,
    from: from ?? null,
    to: to ?? null,
    hangup_cause: hangupCause ?? null,
    timestamp: event.data.occurred_at ?? getEventTimestamp(event).toISOString(),
    webhookRowId,
    eventId: event.data.id,
    event_type: eventType,
    occurred_at: event.data.occurred_at,
    payload: {
      call_control_id: callControlId,
      call_leg_id: getPayloadValue(payload, "call_leg_id"),
      call_session_id: callSessionId,
      connection_id: getPayloadValue(payload, "connection_id"),
      client_state: rawClientState,
      client_state_decoded: decodedClientState,
      from,
      to,
      hangup_cause: hangupCause,
      hangup_source: getStructuredPayloadValue(payload, "hangup_source"),
      result: getStructuredPayloadValue(payload, "result"),
      machine_detection_result: getStructuredPayloadValue(payload, "machine_detection_result"),
    },
    sip_transfer_targets: getSipTransferTargets(payload),
    media_streaming_state: getMediaStreamingState(eventType, payload),
    attempt: attempt
      ? {
          id: attempt.id,
          status: attempt.status,
          leadId: attempt.leadId,
          answeredAt: attempt.answeredAt,
          endedAt: attempt.endedAt,
          telnyxConnectionId: attempt.telnyxConnectionId,
          telnyxCallControlId: attempt.telnyxCallControlId,
          telnyxCallLegId: attempt.telnyxCallLegId,
          telnyxAgentCallControlId: attempt.telnyxAgentCallControlId,
          telnyxAgentCallLegId: attempt.telnyxAgentCallLegId,
          amdResult: attempt.amdResult,
        }
      : null,
  };
}

function logTelnyxLifecycleEvent(
  message: string,
  webhookRowId: string,
  event: TelnyxWebhookPayload,
  attempt?: ExistingCallAttempt | null,
  extra: Record<string, unknown> = {},
) {
  const context = getWebhookLifecycleLogContext(event, webhookRowId, attempt);

  logInfo(message, {
    ...context,
    ...extra,
  });
}

function getCallRole(
  attempt: ExistingCallAttempt,
  callControlId?: string,
  clientStateRole?: "agent" | "lead" | null,
) {
  if (clientStateRole) {
    return clientStateRole;
  }

  if (callControlId && attempt.telnyxCallControlId === callControlId) {
    return "lead";
  }

  if (callControlId && attempt.telnyxAgentCallControlId === callControlId) {
    return "agent";
  }

  return null;
}

function shouldPromoteStatus(currentStatus: CallStatus, nextStatus: CallStatus) {
  return statusProgression[nextStatus] >= statusProgression[currentStatus];
}

function getExistingSummary(attempt: ExistingCallAttempt) {
  return attempt.rawSummaryJson && typeof attempt.rawSummaryJson === "object" && !Array.isArray(attempt.rawSummaryJson)
    ? (attempt.rawSummaryJson as JsonObject)
    : {};
}

async function updateAttemptSummary(attemptId: string, summary: JsonObject) {
  return prisma.callAttempt.update({
    where: { id: attemptId },
    data: {
      rawSummaryJson: summary,
    },
  });
}

async function updateAttemptProgressState(attempt: ExistingCallAttempt, progressState: string, extra: JsonObject = {}) {
  const existingSummary = getExistingSummary(attempt);

  return prisma.callAttempt.update({
    where: { id: attempt.id },
    data: {
      rawSummaryJson: {
        ...existingSummary,
        progressState,
        progressUpdatedAt: new Date().toISOString(),
        ...extra,
      },
    },
  });
}

function isHumanDetectionResult(result?: string | null) {
  return result === "human" || result === "human_business" || result === "human_residence";
}

function isMachineDetectionResult(result?: string | null) {
  return result === "machine" || result === "beep_detected";
}

async function findAttemptFromEvent(event: TelnyxWebhookPayload) {
  const payload = (event.data.payload ?? {}) as Record<string, unknown>;
  const callControlId = getPayloadValue(payload, "call_control_id");
  const callLegId = getPayloadValue(payload, "call_leg_id");
  const callSessionId = getPayloadValue(payload, "call_session_id");
  const clientState = decodeClientState(getPayloadValue(payload, "client_state"));

  if (clientState?.attemptId) {
    const direct = await prisma.callAttempt.findUnique({ where: { id: clientState.attemptId } });

    if (direct) {
      return direct;
    }
  }

  const lookupConditions: Record<string, string>[] = [];

  if (callControlId) {
    lookupConditions.push({ telnyxCallControlId: callControlId }, { telnyxAgentCallControlId: callControlId });
  }

  if (callLegId) {
    lookupConditions.push({ telnyxCallLegId: callLegId }, { telnyxAgentCallLegId: callLegId });
  }

  if (callSessionId) {
    lookupConditions.push({ telnyxCallSessionId: callSessionId });
  }

  if (lookupConditions.length === 0) {
    return null;
  }

  return prisma.callAttempt.findFirst({
    where: {
      OR: lookupConditions,
    },
    orderBy: { createdAt: "desc" },
  });
}

async function syncAttemptFromEvent(attempt: ExistingCallAttempt, event: TelnyxWebhookPayload) {
  const payload = (event.data.payload ?? {}) as Record<string, unknown>;
  const callControlId = getPayloadValue(payload, "call_control_id");
  const callLegId = getPayloadValue(payload, "call_leg_id");
  const callSessionId = getPayloadValue(payload, "call_session_id");
  const connectionId = getPayloadValue(payload, "connection_id");
  const clientState = decodeClientState(getPayloadValue(payload, "client_state"));
  const role = getCallRole(attempt, callControlId, clientState?.role ?? null);

  const data: Record<string, unknown> = {};

  if (connectionId && attempt.telnyxConnectionId !== connectionId) {
    data.telnyxConnectionId = connectionId;
  }

  if (callSessionId && attempt.telnyxCallSessionId !== callSessionId) {
    data.telnyxCallSessionId = callSessionId;
  }

  if (role === "lead") {
    if (callControlId && attempt.telnyxCallControlId !== callControlId) {
      data.telnyxCallControlId = callControlId;
    }

    if (callLegId && attempt.telnyxCallLegId !== callLegId) {
      data.telnyxCallLegId = callLegId;
    }
  }

  if (role === "agent") {
    if (callControlId && attempt.telnyxAgentCallControlId !== callControlId) {
      data.telnyxAgentCallControlId = callControlId;
    }

    if (callLegId && attempt.telnyxAgentCallLegId !== callLegId) {
      data.telnyxAgentCallLegId = callLegId;
    }
  }

  if (Object.keys(data).length === 0) {
    return attempt;
  }

  return prisma.callAttempt.update({
    where: { id: attempt.id },
    data,
  });
}

async function updateAttemptStatus(attempt: ExistingCallAttempt, status: CallStatus, updates?: Record<string, unknown>) {
  const nextStatus = shouldPromoteStatus(attempt.status, status) ? status : attempt.status;

  return prisma.callAttempt.update({
    where: { id: attempt.id },
    data: {
      status: nextStatus,
      ...updates,
    },
  });
}

async function markVoicemailDetected(attempt: ExistingCallAttempt, amdResult: string | null, event: TelnyxWebhookPayload) {
  const nextAttempt = await prisma.callAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "voicemail_detected",
      outcome: "voicemail",
      amdResult: amdResult ?? attempt.amdResult,
      answeredAt: attempt.answeredAt ?? getEventTimestamp(event),
    },
  });

  await hangupCallControlIds(nextAttempt.id, [
    nextAttempt.telnyxCallControlId,
    nextAttempt.telnyxAgentCallControlId,
    getPayloadValue((event.data.payload ?? {}) as Record<string, unknown>, "call_control_id"),
  ]);

  return nextAttempt;
}

async function handleInitiatedEvent(attempt: ExistingCallAttempt, event: TelnyxWebhookPayload) {
  const syncedAttempt = await syncAttemptFromEvent(attempt, event);

  await updateAttemptStatus(syncedAttempt, "dialing");
  await updateAttemptProgressState(syncedAttempt, "dialing_lead");
}

async function handleRingingEvent(attempt: ExistingCallAttempt, event: TelnyxWebhookPayload) {
  const syncedAttempt = await syncAttemptFromEvent(attempt, event);

  await updateAttemptStatus(syncedAttempt, "dialing");
  await updateAttemptProgressState(syncedAttempt, "lead_ringing");
}

async function handleAnsweredEvent(attempt: ExistingCallAttempt, event: TelnyxWebhookPayload) {
  const syncedAttempt = await syncAttemptFromEvent(attempt, event);
  const payload = (event.data.payload ?? {}) as Record<string, unknown>;
  const clientState = decodeClientState(getPayloadValue(payload, "client_state"));
  const role = getCallRole(syncedAttempt, getPayloadValue(payload, "call_control_id"), clientState?.role ?? null);

  if (role === "lead") {
    const connectedAttempt = await updateAttemptStatus(syncedAttempt, "connected", {
      answeredAt: syncedAttempt.answeredAt ?? getEventTimestamp(event),
    });

    await updateAttemptProgressState(connectedAttempt, "lead_answered");
    await startAttemptRecording(connectedAttempt.id);

    if (isBrowserFirstManualDialFlow()) {
      await updateAttemptProgressState(connectedAttempt, "browser_answered", {
        bridgeMode: "direct_browser_originated_pstn",
        bridgeSupported: false,
        bridgeReason: "Direct browser-originated PSTN mode does not create a second browser leg.",
        bridgeTimeoutCheck: "not_applicable",
      });
      return;
    }

    await dialBrowserWebRtcLeg(connectedAttempt.id);
    return;
  }

  if (role === "agent") {
    logInfo("browser_call_answered_webhook_received", {
      callAttemptId: syncedAttempt.id,
      leadCallControlId: syncedAttempt.telnyxCallControlId,
      browserCallControlId: syncedAttempt.telnyxAgentCallControlId,
    });
    await updateAttemptProgressState(syncedAttempt, "browser_answered");
    await bridgeAttemptLegs(syncedAttempt.id);
  }
}

async function handleStreamingEvent(attempt: ExistingCallAttempt, event: TelnyxWebhookPayload) {
  await syncAttemptFromEvent(attempt, event);
}

async function handleMachineDetection(attempt: ExistingCallAttempt, event: TelnyxWebhookPayload) {
  const syncedAttempt = await syncAttemptFromEvent(attempt, event);
  const payload = (event.data.payload ?? {}) as Record<string, unknown>;
  const amdResult = getPayloadValue(payload, "result") ?? getPayloadValue(payload, "machine_detection_result") ?? null;

  const withAmdResult = amdResult
    ? await prisma.callAttempt.update({
        where: { id: syncedAttempt.id },
        data: {
          amdResult,
        },
      })
    : syncedAttempt;

  if (isMachineDetectionResult(amdResult)) {
    await markVoicemailDetected(withAmdResult, amdResult, event);
    return;
  }

  if (isHumanDetectionResult(amdResult)) {
    const connectedAttempt = await updateAttemptStatus(withAmdResult, "connected", {
      answeredAt: withAmdResult.answeredAt ?? getEventTimestamp(event),
    });

    await startAttemptRecording(connectedAttempt.id);
  }
}

async function handleGreetingEnded(attempt: ExistingCallAttempt, event: TelnyxWebhookPayload) {
  const syncedAttempt = await syncAttemptFromEvent(attempt, event);
  const payload = (event.data.payload ?? {}) as Record<string, unknown>;
  const amdResult =
    getPayloadValue(payload, "result") ??
    getPayloadValue(payload, "machine_detection_result") ??
    getPayloadValue(payload, "greeting_end_reason") ??
    null;

  if (!isMachineDetectionResult(amdResult)) {
    return;
  }

  await markVoicemailDetected(syncedAttempt, amdResult, event);
}

async function handleBridgedEvent(attempt: ExistingCallAttempt, event: TelnyxWebhookPayload) {
  const syncedAttempt = await syncAttemptFromEvent(attempt, event);

  logInfo("call.bridged_received", {
    callAttemptId: syncedAttempt.id,
    leadCallControlId: syncedAttempt.telnyxCallControlId,
    browserCallControlId: syncedAttempt.telnyxAgentCallControlId,
  });

  await updateAttemptStatus(syncedAttempt, "connected", {
    answeredAt: syncedAttempt.answeredAt ?? getEventTimestamp(event),
  });
  await updateAttemptProgressState(syncedAttempt, "bridged");

  await startAttemptRecording(syncedAttempt.id);
}

function getRecordingUrl(payload: Record<string, unknown>) {
  const recordingUrls = payload.recording_urls as Record<string, string | null> | undefined;
  const publicUrls = payload.public_recording_urls as Record<string, string | null> | undefined;

  return recordingUrls?.mp3 ?? recordingUrls?.wav ?? publicUrls?.mp3 ?? publicUrls?.wav ?? null;
}

async function handleRecordingSaved(attempt: ExistingCallAttempt, event: TelnyxWebhookPayload) {
  const payload = (event.data.payload ?? {}) as Record<string, unknown>;
  const telnyxRecordingId = getPayloadValue(payload, "recording_id") ?? event.data.id;

  if (!telnyxRecordingId) {
    return;
  }

  const recording = await prisma.callRecording.upsert({
    where: {
      callAttemptId: attempt.id,
    },
    create: {
      callAttemptId: attempt.id,
      telnyxRecordingId,
      downloadUrl: getRecordingUrl(payload),
      fileName: getPayloadValue(payload, "recording_custom_file_name"),
      durationMillis: getPayloadNumber(payload, "duration_millis"),
      channels: getPayloadValue(payload, "channels"),
      rawPayloadJson: event,
    },
    update: {
      telnyxRecordingId,
      downloadUrl: getRecordingUrl(payload),
      fileName: getPayloadValue(payload, "recording_custom_file_name"),
      durationMillis: getPayloadNumber(payload, "duration_millis"),
      channels: getPayloadValue(payload, "channels"),
      rawPayloadJson: event,
    },
  });

  await prisma.callAttempt.update({
    where: { id: attempt.id },
    data: {
      recordingId: recording.id,
    },
  });
}

async function handleTranscriptEvent(attempt: ExistingCallAttempt, event: TelnyxWebhookPayload, forcedStatus?: TranscriptStatus) {
  const payload = (event.data.payload ?? {}) as Record<string, unknown>;
  const transcriptId = getPayloadValue(payload, "recording_transcription_id") ?? event.data.id;

  if (!transcriptId) {
    return;
  }

  const statusFromPayload = getPayloadValue(payload, "status");
  const normalizedStatus: TranscriptStatus = forcedStatus
    ? forcedStatus
    : statusFromPayload === "completed"
      ? "completed"
      : statusFromPayload === "failed"
        ? "failed"
        : "pending";

  const transcript = await prisma.callTranscript.upsert({
    where: {
      callAttemptId: attempt.id,
    },
    create: {
      callAttemptId: attempt.id,
      telnyxTranscriptId: transcriptId,
      text: getPayloadValue(payload, "transcription_text") ?? null,
      status: normalizedStatus,
      rawPayloadJson: event,
    },
    update: {
      telnyxTranscriptId: transcriptId,
      text: getPayloadValue(payload, "transcription_text") ?? null,
      status: normalizedStatus,
      rawPayloadJson: event,
    },
  });

  await prisma.callAttempt.update({
    where: { id: attempt.id },
    data: {
      transcriptId: transcript.id,
    },
  });
}

function deriveDurationSeconds(payload: Record<string, unknown>) {
  const direct = getPayloadNumber(payload, "call_duration");

  if (direct !== null) {
    return Math.max(0, Math.floor(direct));
  }

  const startTime = getPayloadValue(payload, "start_time");
  const endTime = getPayloadValue(payload, "end_time");

  if (!startTime || !endTime) {
    return null;
  }

  const start = new Date(startTime);
  const end = new Date(endTime);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}

function deriveHangupStatus(attempt: ExistingCallAttempt, role: "agent" | "lead" | null, payload: Record<string, unknown>): CallStatus {
  if (attempt.status === "voicemail_detected") {
    return "voicemail_detected";
  }

  if (attempt.status === "connected" || Boolean(attempt.answeredAt)) {
    return "completed";
  }

  const hangupSource = getPayloadValue(payload, "hangup_source");

  if (role === "agent" && !attempt.telnyxCallControlId && hangupSource === "caller") {
    return "canceled";
  }

  return "failed";
}

function deriveOutcome(attempt: ExistingCallAttempt, payload: Record<string, unknown>) {
  if (attempt.outcome) {
    return attempt.outcome;
  }

  if (attempt.status === "voicemail_detected") {
    return "voicemail";
  }

  const hangupCause = getPayloadValue(payload, "hangup_cause");

  if (hangupCause === "timeout" || hangupCause === "no_answer") {
    return "no_answer";
  }

  return undefined;
}

async function handleHangupEvent(attempt: ExistingCallAttempt, event: TelnyxWebhookPayload) {
  const syncedAttempt = await syncAttemptFromEvent(attempt, event);

  if (syncedAttempt.endedAt && (isCallTerminalStatus(syncedAttempt.status) || syncedAttempt.status === "voicemail_detected")) {
    return;
  }

  const payload = (event.data.payload ?? {}) as Record<string, unknown>;
  const clientState = decodeClientState(getPayloadValue(payload, "client_state"));
  const role = getCallRole(syncedAttempt, getPayloadValue(payload, "call_control_id"), clientState?.role ?? null);
  const hangupCause = getPayloadValue(payload, "hangup_cause");
  const progressState =
    hangupCause === "user_busy"
      ? "busy"
      : hangupCause === "timeout" || hangupCause === "no_answer"
        ? "no_answer"
        : (syncedAttempt.answeredAt || syncedAttempt.status === "connected") && role === "lead"
          ? "lead_hung_up"
          : syncedAttempt.answeredAt || syncedAttempt.status === "connected"
            ? "ended"
          : "failed";

  if (!isBrowserFirstManualDialFlow() && role === "agent" && syncedAttempt.telnyxCallControlId && !syncedAttempt.endedAt) {
    const existingSummary = getExistingSummary(syncedAttempt);

    await updateAttemptSummary(syncedAttempt.id, {
      ...existingSummary,
      browserLegFailed: true,
      browserLegFailureReason: hangupCause ?? "unknown",
      browserLegFailureAt: getEventTimestamp(event).toISOString(),
      browserLegFailureMessage: hangupCause === "user_busy" ? "Browser softphone was not ready." : "Browser softphone leg ended.",
      progressState,
      progressUpdatedAt: new Date().toISOString(),
    });

    logInfo("browser_leg_failed", {
      callAttemptId: syncedAttempt.id,
      leadCallControlId: syncedAttempt.telnyxCallControlId,
      browserCallControlId: syncedAttempt.telnyxAgentCallControlId,
      hangupCause,
      message: hangupCause === "user_busy" ? "Browser softphone was not ready." : "Browser softphone leg ended.",
    });

    return;
  }

  await prisma.callAttempt.update({
    where: { id: syncedAttempt.id },
    data: {
      status: deriveHangupStatus(syncedAttempt, role, payload),
      endedAt: getPayloadValue(payload, "end_time") ? new Date(getPayloadValue(payload, "end_time")!) : getEventTimestamp(event),
      durationSeconds: deriveDurationSeconds(payload),
      outcome: deriveOutcome(syncedAttempt, payload),
    },
  });
  await updateAttemptProgressState(syncedAttempt, progressState, {
    hangupCause: hangupCause ?? null,
    hangupObservedAt: getEventTimestamp(event).toISOString(),
  });

  if (!isBrowserFirstManualDialFlow()) {
    await hangupCallControlIds(syncedAttempt.id, [
      role === "agent" ? syncedAttempt.telnyxCallControlId : syncedAttempt.telnyxAgentCallControlId,
    ]);

    logInfo("Requested opposite Telnyx leg hangup after call.hangup", {
      callAttemptId: syncedAttempt.id,
      endedRole: role,
      leadCallControlId: syncedAttempt.telnyxCallControlId,
      browserCallControlId: syncedAttempt.telnyxAgentCallControlId,
    });
  }

  await computeAttemptSummary(syncedAttempt.id);
}

export async function processVoiceWebhookEvent(webhookRowId: string, event: TelnyxWebhookPayload) {
  const eventType = event.data.event_type;
  const payloadObj = event as unknown as JsonObject;

  try {
    logTelnyxLifecycleEvent("Telnyx voice webhook event received by processor", webhookRowId, event, null, {
      lifecycleEvent: TELNYX_LIFECYCLE_EVENTS.has(eventType),
    });

    const attempt = await findAttemptFromEvent(event);

    if (!attempt) {
      logTelnyxLifecycleEvent("Telnyx voice webhook event had no matching call attempt", webhookRowId, event, null, {
        attemptResolution: "not_found",
      });

      await updateWebhookProcessing(webhookRowId, payloadObj, {
        processedAt: new Date(),
        processingError: null,
      });
      return;
    }

    logTelnyxLifecycleEvent("Telnyx voice webhook event matched call attempt", webhookRowId, event, attempt, {
      attemptResolution: "matched",
    });

    switch (eventType) {
      case "call.initiated": {
        await handleInitiatedEvent(attempt, event);
        logTelnyxLifecycleEvent("Handled Telnyx call.initiated", webhookRowId, event, attempt, {
          action: "synced_call_ids_and_kept_dialing",
        });
        break;
      }
      case "call.ringing": {
        await handleRingingEvent(attempt, event);
        logTelnyxLifecycleEvent("Handled Telnyx call.ringing", webhookRowId, event, attempt, {
          action: "synced_call_ids_and_kept_dialing",
        });
        break;
      }
      case "call.answered": {
        await handleAnsweredEvent(attempt, event);
        logTelnyxLifecycleEvent("Handled Telnyx call.answered", webhookRowId, event, attempt, {
          action: isBrowserFirstManualDialFlow()
            ? "marked_connected_and_started_recording_for_direct_browser_originated_call"
            : "marked_lead_connected_started_recording_and_dialed_or_bridged_browser_leg",
          downstreamCommands: {
            answerCommandIssuedAfterOutboundAnswer: false,
            sipTransferRequested: !isBrowserFirstManualDialFlow(),
            mediaStreamingStartRequested: false,
            bridgeDialRequested: !isBrowserFirstManualDialFlow(),
            directBrowserOriginatedCall: isBrowserFirstManualDialFlow(),
          },
          flowStopObservation: isBrowserFirstManualDialFlow()
            ? "The browser originated the PSTN call directly, so no secondary browser leg or bridge event is expected."
            : "Application logic now dials the browser WebRTC credential on lead answer and bridges once the browser leg answers.",
        });
        break;
      }
      case "call.machine.detection.ended":
      case "call.machine.premium.detection.ended": {
        await handleMachineDetection(attempt, event);
        break;
      }
      case "call.machine.greeting.ended":
      case "call.machine.premium.greeting.ended": {
        await handleGreetingEnded(attempt, event);
        break;
      }
      case "call.bridged": {
        await handleBridgedEvent(attempt, event);
        logTelnyxLifecycleEvent("Handled Telnyx call.bridged", webhookRowId, event, attempt, {
          action: "bridge_confirmed_by_telnyx",
          leadCallControlId: attempt.telnyxCallControlId,
          browserCallControlId: attempt.telnyxAgentCallControlId,
        });
        break;
      }
      case "call.recording.saved": {
        await handleRecordingSaved(attempt, event);
        break;
      }
      case "call.recording.transcription.saved": {
        await handleTranscriptEvent(attempt, event, "completed");
        break;
      }
      case "call.recording.transcription.failed": {
        await handleTranscriptEvent(attempt, event, "failed");
        break;
      }
      case "call.hangup": {
        await handleHangupEvent(attempt, event);
        logTelnyxLifecycleEvent("Handled Telnyx call.hangup", webhookRowId, event, attempt, {
          action: "finalized_attempt_status_and_summary",
        });
        break;
      }
      case "streaming.started":
      case "streaming.stopped":
      case "streaming.failed": {
        await handleStreamingEvent(attempt, event);
        logTelnyxLifecycleEvent("Handled Telnyx media streaming event", webhookRowId, event, attempt, {
          action: "synced_call_ids_only",
        });
        break;
      }
      default: {
        await syncAttemptFromEvent(attempt, event);

        logInfo("Unhandled Telnyx voice webhook event", {
          eventType,
          webhookRowId,
        });
      }
    }

    await updateWebhookProcessing(webhookRowId, payloadObj, {
      processedAt: new Date(),
      processingError: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown processing error";

    logError("Failed processing Telnyx voice webhook", {
      webhookRowId,
      eventType,
      error: message,
    });

    await updateWebhookProcessing(webhookRowId, payloadObj, {
      processedAt: new Date(),
      processingError: message,
    });
  }
}

function mapMessagingStatus(eventType: string) {
  if (eventType.includes("delivered")) {
    return "delivered" as const;
  }

  if (eventType.includes("failed") || eventType.includes("undeliverable")) {
    return "failed" as const;
  }

  if (eventType.includes("sent")) {
    return "sent" as const;
  }

  return "queued" as const;
}

export async function processMessagingWebhookEvent(webhookRowId: string, event: TelnyxWebhookPayload) {
  const payloadObj = event as unknown as JsonObject;
  const payload = (event.data.payload ?? {}) as Record<string, unknown>;
  const eventType = event.data.event_type;

  try {
    const telnyxMessageId = getPayloadValue(payload, "id") ?? getPayloadValue(payload, "message_id");

    if (telnyxMessageId) {
      await prisma.smsMessage.updateMany({
        where: {
          telnyxMessageId,
        },
        data: {
          status: mapMessagingStatus(eventType),
          rawPayloadJson: event,
        },
      });
    }

    await updateWebhookProcessing(webhookRowId, payloadObj, {
      processedAt: new Date(),
      processingError: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown processing error";

    await updateWebhookProcessing(webhookRowId, payloadObj, {
      processedAt: new Date(),
      processingError: message,
    });
  }
}

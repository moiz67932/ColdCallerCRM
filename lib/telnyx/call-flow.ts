import type { CallStatus } from "@/lib/db-types";

import { env } from "@/lib/env";
import { logError, logInfo } from "@/lib/logger";
import { prisma } from "@/lib/workstation-db";
import { getAppSettings } from "@/lib/settings";
import { encodeClientState } from "@/lib/telnyx/client-state";
import {
  getOutboundCallerId,
  getTelnyxConnectionId,
  getTelnyxManualDialFlow,
  getTelnyxTelephonyCredentialId,
  getVoiceWebhookUrl,
  isPublicWebhookBaseUrlConfigured,
} from "@/lib/telnyx/helpers";
import { getTelnyxClient } from "@/lib/telnyx/client";

const ACTIVE_CALL_STATUSES: CallStatus[] = ["dialing", "connected"];

function uniqueCallControlIds(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export async function ensureNoActiveCallAttempt(leadId: string) {
  const activeAttempt = await prisma.callAttempt.findFirst({
    where: {
      leadId,
      status: { in: ACTIVE_CALL_STATUSES },
    },
    orderBy: { createdAt: "desc" },
  });

  if (activeAttempt) {
    throw new Error("An active call already exists for this lead");
  }
}

export async function createOutboundCallAttempt(leadId: string) {
  await ensureNoActiveCallAttempt(leadId);

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });

  if (!lead) {
    throw new Error("Lead not found");
  }

  const attempt = await prisma.callAttempt.create({
    data: {
      leadId,
      status: "dialing",
      startedAt: new Date(),
      telnyxConnectionId: getTelnyxConnectionId(),
      rawSummaryJson: {
        manualDialFlow: getTelnyxManualDialFlow(),
        progressState: getTelnyxManualDialFlow() === "browser_first" ? "browser_connecting" : "dialing_lead",
        progressUpdatedAt: new Date().toISOString(),
        browserAnsweredTimeoutCheck:
          getTelnyxManualDialFlow() === "browser_first" ? "not_applicable_direct_browser_originated_call" : "pending",
        bridgeTimeoutCheck:
          getTelnyxManualDialFlow() === "browser_first" ? "not_applicable_direct_browser_originated_call" : "pending",
      },
    },
  });

  return {
    attempt,
    lead,
  };
}

export async function initiateOutboundCall(callAttemptId: string) {
  const attempt = await prisma.callAttempt.findUnique({
    where: { id: callAttemptId },
    include: { lead: true },
  });

  if (!attempt) {
    throw new Error("Call attempt not found");
  }

  if (attempt.telnyxCallControlId) {
    return attempt;
  }

  const client = getTelnyxClient();
  const response = await client.calls.dial({
    connection_id: getTelnyxConnectionId(),
    from: getOutboundCallerId(),
    to: attempt.lead.phoneNumber,
    webhook_url: getVoiceWebhookUrl(),
    client_state: encodeClientState({ attemptId: attempt.id, role: "lead" }),
    answering_machine_detection: "detect_beep",
    command_id: `${attempt.id}-outbound-dial`,
  });

  const callData = response.data;

  if (!callData?.call_control_id) {
    throw new Error("Outbound dial failed to return call_control_id");
  }

  const updatedAttempt = await prisma.callAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "dialing",
      telnyxConnectionId: attempt.telnyxConnectionId ?? getTelnyxConnectionId(),
      telnyxCallControlId: callData.call_control_id,
      telnyxCallLegId: callData.call_leg_id,
      telnyxCallSessionId: callData.call_session_id,
    },
  });

  logInfo("Outbound call initiated through Telnyx Call Control", {
    callAttemptId: attempt.id,
    leadId: attempt.leadId,
    connectionId: getTelnyxConnectionId(),
    callControlId: callData.call_control_id,
  });

  return updatedAttempt;
}

async function getBrowserWebRtcSipUri() {
  const credentialId = getTelnyxTelephonyCredentialId();
  const credential = await getTelnyxClient().telephonyCredentials.retrieve(credentialId);
  const sipUsername = credential.data?.sip_username;

  if (!sipUsername) {
    throw new Error("Telnyx telephony credential does not include a SIP username");
  }

  logInfo("Verified Telnyx WebRTC telephony credential target", {
    credentialId,
    sipUsername,
    sipUri: `sip:${sipUsername}@sip.telnyx.com`,
  });

  return {
    credentialId,
    sipUsername,
    sipUri: `sip:${sipUsername}@sip.telnyx.com`,
  };
}

export async function dialBrowserWebRtcLeg(callAttemptId: string) {
  const attempt = await prisma.callAttempt.findUnique({
    where: { id: callAttemptId },
  });

  if (!attempt) {
    throw new Error("Call attempt not found");
  }

  if (!attempt.telnyxCallControlId) {
    logInfo("Skipping browser WebRTC leg dial because PSTN leg is missing", {
      callAttemptId,
    });
    return attempt;
  }

  if (attempt.telnyxAgentCallControlId) {
    logInfo("Browser WebRTC leg already exists for call attempt", {
      callAttemptId,
      leadCallControlId: attempt.telnyxCallControlId,
      browserCallControlId: attempt.telnyxAgentCallControlId,
    });
    return attempt;
  }

  const target = await getBrowserWebRtcSipUri();

  logInfo("Dialing browser WebRTC leg for live call bridge", {
    callAttemptId,
    leadCallControlId: attempt.telnyxCallControlId,
    credentialId: target.credentialId,
    sipUsername: target.sipUsername,
    sipUri: target.sipUri,
  });

  const response = await getTelnyxClient().calls.dial({
    connection_id: getTelnyxConnectionId(),
    from: getOutboundCallerId(),
    to: target.sipUri,
    webhook_url: getVoiceWebhookUrl(),
    client_state: encodeClientState({ attemptId: attempt.id, role: "agent" }),
    command_id: `${attempt.id}-browser-webrtc-dial`,
    link_to: attempt.telnyxCallControlId,
    bridge_intent: true,
    timeout_secs: 30,
  });
  const callData = response.data;

  if (!callData?.call_control_id) {
    throw new Error("Browser WebRTC dial failed to return call_control_id");
  }

  const updatedAttempt = await prisma.callAttempt.update({
    where: { id: attempt.id },
    data: {
      telnyxAgentCallControlId: callData.call_control_id,
      telnyxAgentCallLegId: callData.call_leg_id,
      telnyxCallSessionId: attempt.telnyxCallSessionId ?? callData.call_session_id,
    },
  });

  logInfo("Browser WebRTC leg created", {
    callAttemptId: attempt.id,
    leadCallControlId: attempt.telnyxCallControlId,
    browserCallControlId: callData.call_control_id,
    browserCallLegId: callData.call_leg_id,
    callSessionId: callData.call_session_id,
    sipUri: target.sipUri,
  });

  return updatedAttempt;
}

export async function bridgeAttemptLegs(callAttemptId: string) {
  const attempt = await prisma.callAttempt.findUnique({
    where: { id: callAttemptId },
  });

  if (!attempt) {
    throw new Error("Call attempt not found");
  }

  if (!attempt.telnyxCallControlId || !attempt.telnyxAgentCallControlId) {
    logInfo("Skipping bridge because both call-control IDs are not available", {
      callAttemptId,
      leadCallControlId: attempt.telnyxCallControlId,
      browserCallControlId: attempt.telnyxAgentCallControlId,
    });
    return false;
  }

  logInfo("bridge_request_sent", {
    callAttemptId,
    leadCallControlId: attempt.telnyxCallControlId,
    browserCallControlId: attempt.telnyxAgentCallControlId,
  });

  try {
    await getTelnyxClient().calls.actions.bridge(attempt.telnyxAgentCallControlId, {
      call_control_id_to_bridge_with: attempt.telnyxCallControlId,
      command_id: `${attempt.id}-browser-pstn-bridge`,
      prevent_double_bridge: true,
    });

    logInfo("Browser WebRTC to PSTN bridge requested successfully", {
      callAttemptId,
      leadCallControlId: attempt.telnyxCallControlId,
      browserCallControlId: attempt.telnyxAgentCallControlId,
    });

    return true;
  } catch (error) {
    logError("Browser WebRTC to PSTN bridge request failed", {
      callAttemptId,
      leadCallControlId: attempt.telnyxCallControlId,
      browserCallControlId: attempt.telnyxAgentCallControlId,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return false;
  }
}

export async function createAndInitiateOutboundCall(leadId: string) {
  const { attempt, lead } = await createOutboundCallAttempt(leadId);
  const initiatedAttempt = await initiateOutboundCall(attempt.id);

  return {
    attempt: initiatedAttempt,
    lead,
  };
}

export async function hangupAttemptLegs(callAttemptId: string) {
  const attempt = await prisma.callAttempt.findUnique({
    where: { id: callAttemptId },
  });

  if (!attempt) {
    throw new Error("Call attempt not found");
  }

  await hangupCallControlIds(attempt.id, [attempt.telnyxCallControlId, attempt.telnyxAgentCallControlId]);
}

export async function hangupCallControlIds(attemptId: string, callControlIds: Array<string | null | undefined>) {
  const ids = uniqueCallControlIds(callControlIds);

  if (ids.length === 0) {
    return;
  }

  const client = getTelnyxClient();

  await Promise.allSettled(
    ids.map((callControlId, index) =>
      client.calls.actions.hangup(callControlId, {
        command_id: `${attemptId}-hangup-${index}`,
      }),
    ),
  );
}

export async function startAttemptRecording(callAttemptId: string) {
  const [attempt, settings] = await Promise.all([
    prisma.callAttempt.findUnique({
      where: { id: callAttemptId },
    }),
    getAppSettings(),
  ]);

  if (!attempt || !settings.enableRecording) {
    return;
  }

  const recordingControlId = attempt.telnyxAgentCallControlId ?? attempt.telnyxCallControlId;

  if (!recordingControlId) {
    return;
  }

  try {
    await getTelnyxClient().calls.actions.startRecording(recordingControlId, {
      channels: "single",
      format: "mp3",
      recording_track: "both",
      transcription: true,
      command_id: `${attempt.id}-recording`,
    });
  } catch (error) {
    logError("Failed to start recording", {
      callAttemptId: attempt.id,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export function isCallTerminalStatus(status: CallStatus) {
  return status === "completed" || status === "failed" || status === "canceled";
}

export async function computeAttemptSummary(callAttemptId: string) {
  const attempt = await prisma.callAttempt.findUnique({
    where: { id: callAttemptId },
    include: {
      smsMessages: true,
    },
  });

  if (!attempt) {
    return;
  }

  const smsSent = attempt.smsMessages.some((message: { direction?: string }) => message.direction === "outbound");

  await prisma.callAttempt.update({
    where: { id: attempt.id },
    data: {
      rawSummaryJson: {
        status: attempt.status,
        outcome: attempt.outcome,
        durationSeconds: attempt.durationSeconds,
        callbackAt: attempt.callbackAt,
        amdResult: attempt.amdResult,
        telnyxCallControlId: attempt.telnyxCallControlId,
        telnyxConnectionId: attempt.telnyxConnectionId,
        recordingId: attempt.recordingId,
        transcriptId: attempt.transcriptId,
        smsSent,
      },
    },
  });
}

export function getAttemptStatusLabel(status: CallStatus) {
  const labels: Record<CallStatus, string> = {
    dialing: "dialing",
    connected: "connected",
    voicemail_detected: "voicemail_detected",
    completed: "completed",
    failed: "failed",
    canceled: "canceled",
  };

  return labels[status];
}

export function ensureTelnyxConfigured() {
  const required = [
    env.TELNYX_API_KEY,
    env.TELNYX_CONNECTION_ID,
    env.TELNYX_TELEPHONY_CREDENTIAL_ID,
    env.TELNYX_FROM_NUMBER,
  ];

  return required.every(Boolean);
}

export function canReceiveTelnyxVoiceWebhooks() {
  return isPublicWebhookBaseUrlConfigured();
}

export function isBrowserFirstManualDialFlow() {
  return getTelnyxManualDialFlow() === "browser_first";
}

"use client";

import { format } from "date-fns";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { applyTemplateVariables } from "@/lib/scripts";

type CallDetail = {
  callAttempt: {
    id: string;
    status: string;
    outcome?: string | null;
    startedAt?: string | null;
    answeredAt?: string | null;
    endedAt?: string | null;
    endedBy?: string | null;
    durationSeconds?: number | null;
    operatorNotes?: string | null;
    callbackAt?: string | null;
    amdResult?: string | null;
    telnyxConnectionId?: string | null;
    telnyxCallControlId?: string | null;
    telnyxCallLegId?: string | null;
    telnyxAgentCallControlId?: string | null;
    telnyxAgentCallLegId?: string | null;
    telnyxCallSessionId?: string | null;
    rawSummaryJson?: Record<string, unknown> | null;
    lead: {
      id: string;
      businessName?: string | null;
      contactName?: string | null;
      phoneNumber: string;
      city?: string | null;
      state?: string | null;
      niche?: string | null;
      website?: string | null;
      notes?: string | null;
    };
    recording?: {
      id: string;
      downloadUrl?: string | null;
      telnyxRecordingId: string;
      channels?: string | null;
      durationMillis?: number | null;
    } | null;
    transcript?: {
      id: string;
      status: "pending" | "completed" | "failed";
      text?: string | null;
    } | null;
    smsMessages: Array<{
      id: string;
      createdAt: string;
      text: string;
      status: string;
      fromNumber: string;
      toNumber: string;
    }>;
    notes: Array<{ id: string; body: string; createdAt: string }>;
  };
  webhookEvents: Array<{
    id: string;
    eventType: string;
    receivedAt: string;
    processingError?: string | null;
    payloadJson: unknown;
    signatureVerified: boolean;
  }>;
};

export default function CallDetailPage() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [smsText, setSmsText] = useState("");
  const [smsStatus, setSmsStatus] = useState<string | null>(null);
  const [messagingEnabled, setMessagingEnabled] = useState(false);
  const [sendingSms, setSendingSms] = useState(false);

  useEffect(() => {
    if (!params.id) {
      return;
    }

    async function loadData() {
      const response = await fetch(`/api/calls/${params.id}`, { cache: "no-store" });
      const payload = (await response.json()) as CallDetail;

      if (response.ok) {
        setDetail(payload);
      }
    }

    void loadData();
  }, [params.id]);

  useEffect(() => {
    if (!detail) {
      return;
    }

    const callAttempt = detail.callAttempt;
    const shouldPoll =
      ["dialing", "connected"].includes(callAttempt.status) ||
      !callAttempt.endedAt ||
      (callAttempt.recording == null && callAttempt.transcript == null) ||
      callAttempt.transcript?.status === "pending";

    if (!shouldPoll) {
      return;
    }

    const interval = window.setInterval(async () => {
      const response = await fetch(`/api/calls/${params.id}`, { cache: "no-store" });
      const payload = (await response.json()) as CallDetail;

      if (response.ok) {
        setDetail(payload);
      }
    }, 3000);

    return () => window.clearInterval(interval);
  }, [detail, params.id]);

  useEffect(() => {
    async function loadTemplate() {
      if (!detail?.callAttempt.lead) {
        return;
      }

      const response = await fetch("/api/settings", { cache: "no-store" });
      const payload = (await response.json()) as {
        settings?: {
          defaultFollowUpSmsTemplate?: string;
        };
        runtimeConfig?: {
          telnyxMessagingFromConfigured?: boolean;
        };
      };

      setMessagingEnabled(Boolean(payload.runtimeConfig?.telnyxMessagingFromConfigured));

      if (payload.settings?.defaultFollowUpSmsTemplate) {
        setSmsText(
          applyTemplateVariables(payload.settings.defaultFollowUpSmsTemplate, {
            businessName: detail.callAttempt.lead.businessName,
            contactName: detail.callAttempt.lead.contactName,
            city: detail.callAttempt.lead.city,
            state: detail.callAttempt.lead.state,
            niche: detail.callAttempt.lead.niche,
          }),
        );
      }
    }

    void loadTemplate();
  }, [detail?.callAttempt.lead]);

  const timelineItems = useMemo(() => detail?.webhookEvents ?? [], [detail]);

  async function sendSms() {
    if (!detail) {
      return;
    }

    setSendingSms(true);
    setSmsStatus("Sending...");

    try {
      const response = await fetch(`/api/calls/${detail.callAttempt.id}/send-sms`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: smsText,
        }),
      });

      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        setSmsStatus(payload.error ?? "SMS send failed");
        return;
      }

      setSmsStatus("SMS sent");

      const refreshed = await fetch(`/api/calls/${detail.callAttempt.id}`, { cache: "no-store" });
      const refreshedPayload = (await refreshed.json()) as CallDetail;

      if (refreshed.ok) {
        setDetail(refreshedPayload);
      }
    } finally {
      setSendingSms(false);
    }
  }

  if (!detail) {
    return <p className="text-sm text-slate-500">Loading call detail...</p>;
  }

  const { callAttempt } = detail;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Call Detail</CardTitle>
          <CardDescription>
            {callAttempt.lead.businessName ?? "Untitled business"} • {callAttempt.lead.phoneNumber}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1 text-sm">
            <p>
              <span className="font-medium">Status:</span> <Badge variant="secondary">{callAttempt.status}</Badge>
            </p>
            <p>
              <span className="font-medium">Outcome:</span> {callAttempt.outcome ?? "-"}
            </p>
            <p>
              <span className="font-medium">Started:</span> {callAttempt.startedAt ? format(new Date(callAttempt.startedAt), "PPpp") : "-"}
            </p>
            <p>
              <span className="font-medium">Answered:</span> {callAttempt.answeredAt ? format(new Date(callAttempt.answeredAt), "PPpp") : "-"}
            </p>
            <p>
              <span className="font-medium">Ended:</span> {callAttempt.endedAt ? format(new Date(callAttempt.endedAt), "PPpp") : "-"}
            </p>
            <p>
              <span className="font-medium">Ended by:</span> {callAttempt.endedBy ?? "-"}
            </p>
            <p>
              <span className="font-medium">Duration:</span> {callAttempt.durationSeconds ? `${callAttempt.durationSeconds}s` : "-"}
            </p>
            <p>
              <span className="font-medium">AMD:</span> {callAttempt.amdResult ?? "-"}
            </p>
          </div>
          <div className="space-y-1 text-sm">
            <p>
              <span className="font-medium">Lead:</span> {callAttempt.lead.contactName ?? "-"}
            </p>
            <p>
              <span className="font-medium">City/State:</span> {callAttempt.lead.city ?? "-"}, {callAttempt.lead.state ?? "-"}
            </p>
            <p>
              <span className="font-medium">Niche:</span> {callAttempt.lead.niche ?? "-"}
            </p>
            <p>
              <span className="font-medium">Operator notes:</span> {callAttempt.operatorNotes ?? callAttempt.lead.notes ?? "-"}
            </p>
            <p>
              <span className="font-medium">Callback at:</span> {callAttempt.callbackAt ? format(new Date(callAttempt.callbackAt), "PPpp") : "-"}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recording + Transcript</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {callAttempt.recording?.downloadUrl ? (
              <audio className="w-full" controls src={callAttempt.recording.downloadUrl} />
            ) : (
              <p className="text-sm text-slate-500">Recording pending or unavailable.</p>
            )}

            {callAttempt.transcript ? (
              <div className="rounded-md border border-slate-200 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Transcript status: {callAttempt.transcript.status}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm">
                  {callAttempt.transcript.text ??
                    (callAttempt.transcript.status === "failed"
                      ? "Transcript failed. Check webhook debug data."
                      : "Transcript pending...")}
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                Transcript unavailable. If this call was completed from the browser but no recording or transcript webhook arrived,
                verify the Telnyx connection webhook URL in Settings.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Manual follow-up SMS</CardTitle>
            <CardDescription>Send a one-off SMS from this call attempt.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="sms-text">SMS message</Label>
            <Textarea id="sms-text" value={smsText} onChange={(event) => setSmsText(event.target.value)} />
            <Button disabled={!messagingEnabled || !smsText.trim()} loading={sendingSms} onClick={() => void sendSms()}>
              Send follow-up SMS
            </Button>
            {!messagingEnabled ? (
              <p className="text-xs text-amber-700">Messaging is disabled: configure TELNYX_MESSAGING_FROM_NUMBER.</p>
            ) : null}
            {smsStatus ? <p className="text-xs text-slate-600">{smsStatus}</p> : null}

            {callAttempt.smsMessages.length > 0 ? (
              <div className="space-y-2 rounded-md border border-slate-200 p-2">
                <p className="text-xs font-medium">SMS history</p>
                {callAttempt.smsMessages.map((sms) => (
                  <div className="text-xs" key={sms.id}>
                    <p>{format(new Date(sms.createdAt), "PPpp")}</p>
                    <p>{sms.text}</p>
                    <p className="text-slate-500">Status: {sms.status}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Webhook timeline</CardTitle>
          <CardDescription>Chronological Telnyx events for traceability and debugging.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {timelineItems.length === 0 ? <p className="text-sm text-slate-500">No webhook events yet.</p> : null}
          {timelineItems.map((item) => (
            <Accordion collapsible key={item.id} type="single">
              <AccordionItem value={item.id}>
                <AccordionTrigger>
                  <div className="flex w-full items-center justify-between pr-4 text-left">
                    <span>{item.eventType}</span>
                    <span className="text-xs text-slate-500">{format(new Date(item.receivedAt), "PPpp")}</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <p className="mb-2 text-xs">Signature verified: {item.signatureVerified ? "yes" : "no"}</p>
                  {item.processingError ? <p className="mb-2 text-xs text-red-700">Processing error: {item.processingError}</p> : null}
                  <pre className="max-h-72 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                    {JSON.stringify(item.payloadJson, null, 2)}
                  </pre>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Debug</CardTitle>
        </CardHeader>
        <CardContent className="text-xs">
          <p>Connection ID: {callAttempt.telnyxConnectionId ?? "-"}</p>
          <p>Lead Call Control ID: {callAttempt.telnyxCallControlId ?? "-"}</p>
          <p>Lead Leg ID: {callAttempt.telnyxCallLegId ?? "-"}</p>
          <p>Agent Call Control ID: {callAttempt.telnyxAgentCallControlId ?? "-"}</p>
          <p>Agent Leg ID: {callAttempt.telnyxAgentCallLegId ?? "-"}</p>
          <p>Session ID: {callAttempt.telnyxCallSessionId ?? "-"}</p>
          <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-slate-100 p-3">
            {JSON.stringify(callAttempt.rawSummaryJson ?? {}, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

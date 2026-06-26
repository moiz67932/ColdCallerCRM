"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { format } from "date-fns";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type HistoryCall = {
  id: string;
  status: string;
  outcome?: string | null;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number | null;
  operatorNotes?: string | null;
  notes?: Array<{
    id: string;
    body?: string | null;
    createdAt: string;
  }>;
  lead: {
    businessName?: string | null;
    contactName?: string | null;
    phoneNumber: string;
    niche?: string | null;
    notes?: string | null;
    leadList: {
      id: string;
      name: string;
    };
  };
};

function getHistoryOutcomeLabel(call: HistoryCall) {
  if (call.outcome) {
    return call.outcome;
  }

  if (call.status === "voicemail_detected") {
    return "voicemail";
  }

  return call.status;
}

function getHistoryNote(call: HistoryCall) {
  return call.lead.notes?.trim() || call.operatorNotes?.trim() || call.notes?.find((note) => note.body?.trim())?.body?.trim() || "-";
}

function formatHistoryDate(value: string) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return { date: "-", time: "" };
  }

  return {
    date: format(date, "MMM d, yyyy"),
    time: format(date, "h:mm a"),
  };
}

export default function HistoryPage() {
  const [calls, setCalls] = useState<HistoryCall[]>([]);
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [leadListId, setLeadListId] = useState("all");
  const [niche, setNiche] = useState("");
  const [loading, setLoading] = useState(false);

  const leadLists = useMemo(() => {
    const map = new Map<string, string>();

    for (const call of calls) {
      map.set(call.lead.leadList.id, call.lead.leadList.name);
    }

    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [calls]);

  const loadCalls = useCallback(async () => {
    setLoading(true);
    const searchParams = new URLSearchParams();

    if (search) {
      searchParams.set("q", search);
    }

    if (outcome !== "all") {
      searchParams.set("outcome", outcome);
    }

    if (fromDate) {
      searchParams.set("from", fromDate);
    }

    if (toDate) {
      searchParams.set("to", toDate);
    }

    if (leadListId !== "all") {
      searchParams.set("leadListId", leadListId);
    }

    if (niche) {
      searchParams.set("niche", niche);
    }

    try {
      const response = await fetch(`/api/calls?${searchParams.toString()}`, {
        cache: "no-store",
      });

      const payload = (await response.json()) as { calls?: HistoryCall[] };

      if (response.ok && payload.calls) {
        setCalls(payload.calls);
      }
    } finally {
      setLoading(false);
    }
  }, [search, outcome, fromDate, toDate, leadListId, niche]);

  useEffect(() => {
    void loadCalls();
  }, [loadCalls]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Call History</CardTitle>
          <CardDescription>Filter by date, outcome, lead list, and niche. Open any row for full call detail.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <Input placeholder="Search lead / phone" value={search} onChange={(event) => setSearch(event.target.value)} />
            <Select value={outcome} onValueChange={setOutcome}>
              <SelectTrigger>
                <SelectValue placeholder="Outcome" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All outcomes</SelectItem>
                <SelectItem value="answered">Answered</SelectItem>
                <SelectItem value="voicemail">Voicemail</SelectItem>
                <SelectItem value="no_answer">No answer</SelectItem>
                <SelectItem value="not_interested">Not interested</SelectItem>
                <SelectItem value="callback">Callback</SelectItem>
                <SelectItem value="gatekeeper">Gatekeeper</SelectItem>
                <SelectItem value="bad_number">Bad number</SelectItem>
                <SelectItem value="interested">Interested</SelectItem>
                <SelectItem value="demo_requested">Demo requested</SelectItem>
              </SelectContent>
            </Select>
            <Select value={leadListId} onValueChange={setLeadListId}>
              <SelectTrigger>
                <SelectValue placeholder="Lead list" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All lead lists</SelectItem>
                {leadLists.map((list) => (
                  <SelectItem key={list.id} value={list.id}>
                    {list.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input placeholder="Niche" value={niche} onChange={(event) => setNiche(event.target.value)} />
            <Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
            <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
          </div>

          <div className="flex items-center gap-3">
            <Button loading={loading} onClick={() => void loadCalls()}>Apply Filters</Button>
            {loading ? <p className="text-sm text-slate-500">Refreshing call history...</p> : null}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Lead</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Niche</TableHead>
                <TableHead>List</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.map((call) => {
                const formattedDate = formatHistoryDate(call.createdAt);

                return (
                  <TableRow key={call.id}>
                    <TableCell className="min-w-32">
                      <Link className="inline-flex flex-col underline" href={`/history/${call.id}`}>
                        <span className="whitespace-nowrap">{formattedDate.date}</span>
                        {formattedDate.time ? <span className="whitespace-nowrap">{formattedDate.time}</span> : null}
                      </Link>
                    </TableCell>
                    <TableCell>{call.lead.businessName ?? "Untitled"}</TableCell>
                    <TableCell>{call.lead.phoneNumber}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{getHistoryOutcomeLabel(call)}</Badge>
                    </TableCell>
                    <TableCell>{call.lead.niche ?? "-"}</TableCell>
                    <TableCell>{call.lead.leadList.name}</TableCell>
                    <TableCell className="max-w-xs whitespace-pre-wrap break-words">{getHistoryNote(call)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

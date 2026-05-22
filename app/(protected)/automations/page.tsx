"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, CheckCircle2, ExternalLink, Play, RefreshCw, RotateCcw, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Batch = {
  id: string;
  name: string | null;
  status: string;
  requested_count: number;
  selected_count: number;
  completed_count: number;
  failed_count: number;
  skipped_count: number;
  max_concurrency: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type PreparedLead = {
  id: string;
  lead_id: string;
  business_name: string | null;
  status: string;
  is_demo_ready: boolean | null;
  demo_readiness_status?: string | null;
  source_website_url: string;
  last_scraped_at?: string | null;
  last_activated_at?: string | null;
  updated_at: string;
  services_count?: number;
  prices_count?: number;
  facts_count?: number;
  lead: {
    phone_number: string | null;
    city: string | null;
    state: string | null;
    niche: string | null;
  } | null;
};

type Summary = {
  total_leads: number;
  prepared_count: number;
  ready_to_activate_count: number;
  scraping_count: number;
  running_count?: number;
  failed_count: number;
  needs_scraping_count: number;
  last_batch?: Batch | null;
  batches: Batch[];
};

type FailedJob = {
  id: string;
  batch_id: string;
  lead_id: string;
  website_url: string | null;
  business_name: string | null;
  error: string | null;
  retry_count: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

const emptySummary: Summary = {
  total_leads: 0,
  prepared_count: 0,
  ready_to_activate_count: 0,
  scraping_count: 0,
  failed_count: 0,
  needs_scraping_count: 0,
  batches: [],
};

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusVariant(status: string) {
  if (["completed", "ready", "active"].includes(status)) return "default";
  if (["failed", "completed_with_errors"].includes(status)) return "outline";
  return "secondary";
}

export default function AutomationsPage() {
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [preparedLeads, setPreparedLeads] = useState<PreparedLead[]>([]);
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([]);
  const [requestedCount, setRequestedCount] = useState(10);
  const [maxConcurrency, setMaxConcurrency] = useState(2);
  const [skipPrepared, setSkipPrepared] = useState(true);
  const [rescrapeStale, setRescrapeStale] = useState(false);
  const [staleAfterDays, setStaleAfterDays] = useState(30);
  const [forceReprocess, setForceReprocess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const hasRunningBatch = useMemo(
    () => summary.batches.some((batch) => batch.status === "pending" || batch.status === "running"),
    [summary.batches],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setMessage(null);

    try {
      const [summaryResponse, preparedResponse, failedResponse] = await Promise.all([
        fetch("/api/automations/lead-demo-prep/summary", { cache: "no-store" }),
        fetch("/api/automations/lead-demo-prep/prepared-leads?limit=20", { cache: "no-store" }),
        fetch("/api/automations/lead-demo-prep/failed-jobs?limit=20", { cache: "no-store" }),
      ]);

      const summaryPayload = await summaryResponse.json();
      const preparedPayload = await preparedResponse.json();
      const failedPayload = await failedResponse.json();

      if (!summaryResponse.ok) throw new Error(summaryPayload.error ?? "Failed to load automation summary");
      if (!preparedResponse.ok) throw new Error(preparedPayload.error ?? "Failed to load prepared leads");
      if (!failedResponse.ok) throw new Error(failedPayload.error ?? "Failed to load failed jobs");

      setSummary(summaryPayload);
      setPreparedLeads(preparedPayload.prepared_leads ?? []);
      setFailedJobs(failedPayload.failed_jobs ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load automation data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!hasRunningBatch) return;
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [hasRunningBatch, refresh]);

  async function startBatch() {
    setStarting(true);
    setMessage(null);

    try {
      const response = await fetch("/api/automations/lead-demo-prep/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count: requestedCount,
          maxConcurrency: maxConcurrency,
          forceReprocess: forceReprocess || !skipPrepared,
          filters: {
            onlyUnprepared: skipPrepared,
            staleAfterDays: rescrapeStale ? staleAfterDays : null,
          },
        }),
      });
      const payload = await response.json();

      if (!response.ok) throw new Error(payload.error ?? "Failed to start automation batch");

      setMessage(
        payload.batch.selected_count > 0
          ? `Started scraping ${payload.batch.selected_count} unprepared lead${payload.batch.selected_count === 1 ? "" : "s"}.`
          : "No unprepared website leads were found.",
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to start automation batch");
    } finally {
      setStarting(false);
    }
  }

  async function activatePreparedLead(profile: PreparedLead) {
    setActionId(`activate-${profile.id}`);
    setMessage(null);

    try {
      const response = await fetch(`/api/leads/${profile.lead_id}/demo-agent/activate`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to activate demo");
      setMessage(`Activated demo for ${profile.business_name ?? "lead"}.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to activate demo");
    } finally {
      setActionId(null);
    }
  }

  async function rescrapePreparedLead(profile: PreparedLead) {
    setActionId(`rescrape-${profile.id}`);
    setMessage(null);

    try {
      const response = await fetch(`/api/automations/lead-demo-prep/leads/${profile.lead_id}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          website_url: profile.source_website_url,
          force_rescrape: true,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to re-scrape lead");
      setMessage(`Re-scrape started for ${profile.business_name ?? "lead"}.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to re-scrape lead");
    } finally {
      setActionId(null);
    }
  }

  async function retryFailedJob(job: FailedJob) {
    setActionId(`retry-${job.id}`);
    setMessage(null);

    try {
      const response = await fetch(`/api/automations/lead-demo-prep/jobs/${job.id}/retry`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to retry job");
      setMessage(`Retry started for ${job.business_name ?? "lead"}.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to retry job");
    } finally {
      setActionId(null);
    }
  }

  async function cancelBatch(batch: Batch) {
    setActionId(`cancel-${batch.id}`);
    setMessage(null);

    try {
      const response = await fetch(`/api/automations/lead-demo-prep/batches/${batch.id}/cancel`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to cancel batch");
      setMessage(`Cancelled ${batch.name ?? "automation batch"}. You can start a new batch now.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to cancel batch");
    } finally {
      setActionId(null);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Automations</p>
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Automations</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              Pre prepare clinic demo agents before outreach so activation is instant during calls.
            </p>
          </div>
          <Button onClick={() => void refresh()} loading={loading} variant="outline">
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Activity} title="Total leads" value={summary.total_leads} />
        <StatCard icon={CheckCircle2} title="Demo prepared" value={summary.prepared_count} />
        <StatCard icon={Play} title="Ready to activate" value={summary.ready_to_activate_count} />
        <StatCard icon={RotateCcw} title="Scraping in progress" value={summary.scraping_count} />
        <StatCard icon={XCircle} title="Needs scraping" value={summary.needs_scraping_count} />
        <StatCard icon={XCircle} title="Failed preparation" value={summary.failed_count} />
        <StatCard icon={Activity} title="Last batch run" value={summary.last_batch ? formatDate(summary.last_batch.created_at) : "-"} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Batch Preparation</CardTitle>
            <CardDescription>Only leads without a prepared profile for their current website are selected.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="requested-count">Number of leads to prepare</Label>
              <div className="grid grid-cols-4 gap-2">
                {[5, 10, 25, 50].map((count) => (
                  <Button key={count} onClick={() => setRequestedCount(count)} type="button" variant={requestedCount === count ? "default" : "outline"}>
                    {count}
                  </Button>
                ))}
              </div>
              <Input id="requested-count" min={1} max={100} type="number" value={requestedCount} onChange={(event) => setRequestedCount(Number(event.target.value))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="max-concurrency">Max concurrent scrapes</Label>
              <Input
                id="max-concurrency"
                min={1}
                max={5}
                type="number"
                value={maxConcurrency}
                onChange={(event) => setMaxConcurrency(Number(event.target.value))}
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-3">
              <Label htmlFor="skip-prepared">Skip already prepared leads</Label>
              <Switch checked={skipPrepared} id="skip-prepared" onCheckedChange={setSkipPrepared} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-3">
              <Label htmlFor="force-reprocess">Force re-scrape prepared leads</Label>
              <Switch checked={forceReprocess} id="force-reprocess" onCheckedChange={setForceReprocess} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-3">
              <Label htmlFor="stale-rescrape">Re scrape stale leads</Label>
              <Switch checked={rescrapeStale} id="stale-rescrape" onCheckedChange={setRescrapeStale} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="stale-days">Stale after days</Label>
              <Input
                disabled={!rescrapeStale}
                id="stale-days"
                min={1}
                max={365}
                type="number"
                value={staleAfterDays}
                onChange={(event) => setStaleAfterDays(Number(event.target.value))}
              />
            </div>
            <p className="text-xs text-slate-500">Only leads with websites will be selected. Prepared demos can be activated instantly in the calling workspace.</p>
            {hasRunningBatch ? <p className="text-xs text-amber-700">A batch is currently running. Cancel it from the table if you want to free the queue for a new run.</p> : null}
            <Button className="w-full" onClick={() => void startBatch()} loading={starting}>
              <Play className="mr-2 h-4 w-4" />
              Prepare Demo Profiles
            </Button>
            {message ? <p className="text-sm text-slate-600">{message}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Current / Recent Batches</CardTitle>
            <CardDescription>Batch records are stored in Supabase and update as each lead finishes.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Selected</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead>Skipped</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.batches.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-6 text-center text-slate-500" colSpan={8}>
                      No batches yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  summary.batches.map((batch) => (
                    <TableRow key={batch.id}>
                      <TableCell>
                        <p className="font-medium">{batch.name ?? "Demo preparation"}</p>
                        <p className="font-mono text-xs text-slate-500">{batch.id.slice(0, 8)}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(batch.status)}>{batch.status.replaceAll("_", " ")}</Badge>
                      </TableCell>
                      <TableCell>{batch.selected_count} / {batch.requested_count}</TableCell>
                      <TableCell>{batch.completed_count}</TableCell>
                      <TableCell>{batch.failed_count}</TableCell>
                      <TableCell>{batch.skipped_count}</TableCell>
                      <TableCell>{formatDate(batch.created_at)}</TableCell>
                      <TableCell>
                        {batch.status === "pending" || batch.status === "running" ? (
                          <Button loading={actionId === `cancel-${batch.id}`} onClick={() => void cancelBatch(batch)} size="sm" variant="outline">
                            <XCircle className="mr-1 h-3 w-3" />
                            Cancel
                          </Button>
                        ) : (
                          <span className="text-xs text-slate-400">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Prepared Leads</CardTitle>
          <CardDescription>These leads should activate quickly from the calling workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Demo readiness</TableHead>
                <TableHead>Extracted data</TableHead>
                <TableHead>Last scraped</TableHead>
                <TableHead>Last activated</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preparedLeads.length === 0 ? (
                <TableRow>
                  <TableCell className="py-6 text-center text-slate-500" colSpan={6}>
                    No prepared leads yet.
                  </TableCell>
                </TableRow>
              ) : (
                preparedLeads.map((profile) => (
                  <TableRow key={profile.id}>
                    <TableCell>
                      <p className="font-medium">{profile.business_name ?? "Untitled clinic"}</p>
                      <p className="max-w-[280px] truncate text-xs text-slate-500">{profile.source_website_url}</p>
                      <p className="text-xs text-slate-500">{[profile.lead?.city, profile.lead?.state, profile.lead?.niche].filter(Boolean).join(", ") || "-"}</p>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge variant={statusVariant(profile.status)}>{profile.status}</Badge>
                        <p className="text-xs text-slate-500">{profile.demo_readiness_status ?? (profile.is_demo_ready ? "ready" : "needs review")}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <p className="text-xs">Compact services: {profile.services_count ?? 0}</p>
                      <p className="text-xs">Prices: {profile.prices_count ?? 0}</p>
                      <p className="text-xs">Facts: {profile.facts_count ?? 0}</p>
                    </TableCell>
                    <TableCell>{formatDate(profile.last_scraped_at ?? profile.updated_at)}</TableCell>
                    <TableCell>{formatDate(profile.last_activated_at ?? null)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={!profile.is_demo_ready}
                          loading={actionId === `activate-${profile.id}`}
                          onClick={() => void activatePreparedLead(profile)}
                          size="sm"
                        >
                          <Play className="mr-1 h-3 w-3" />
                          Activate
                        </Button>
                        <Button loading={actionId === `rescrape-${profile.id}`} onClick={() => void rescrapePreparedLead(profile)} size="sm" variant="outline">
                          <RotateCcw className="mr-1 h-3 w-3" />
                          Re scrape
                        </Button>
                        <Link
                          className="inline-flex h-9 items-center justify-center rounded-md bg-slate-100 px-3 text-sm font-medium text-slate-900 hover:bg-slate-200"
                          href={`/queue?leadId=${profile.lead_id}`}
                        >
                          <ExternalLink className="mr-1 h-3 w-3" />
                          Workspace
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Failed Jobs</CardTitle>
          <CardDescription>Errors are saved with the job so they can be retried without selecting duplicate running work.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Website</TableHead>
                <TableHead>Error reason</TableHead>
                <TableHead>Retries</TableHead>
                <TableHead>Last attempted</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failedJobs.length === 0 ? (
                <TableRow>
                  <TableCell className="py-6 text-center text-slate-500" colSpan={6}>
                    No failed preparation jobs.
                  </TableCell>
                </TableRow>
              ) : (
                failedJobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <p className="font-medium">{job.business_name ?? "Untitled clinic"}</p>
                      <p className="font-mono text-xs text-slate-500">{job.lead_id.slice(0, 8)}</p>
                    </TableCell>
                    <TableCell>
                      <p className="max-w-[240px] truncate text-xs text-slate-500">{job.website_url ?? "-"}</p>
                    </TableCell>
                    <TableCell>
                      <p className="max-w-[360px] text-sm text-red-700">{job.error ?? "Preparation failed"}</p>
                    </TableCell>
                    <TableCell>{job.retry_count}</TableCell>
                    <TableCell>{formatDate(job.completed_at ?? job.started_at ?? job.created_at)}</TableCell>
                    <TableCell>
                      <Button loading={actionId === `retry-${job.id}`} onClick={() => void retryFailedJob(job)} size="sm" variant="outline">
                        <RotateCcw className="mr-1 h-3 w-3" />
                        Retry failed
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ icon: Icon, title, value }: { icon: typeof Activity; title: string; value: number | string }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardDescription>{title}</CardDescription>
        <Icon className="h-4 w-4 text-slate-500" />
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

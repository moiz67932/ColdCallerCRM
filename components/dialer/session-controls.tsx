"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {BudgetPreflight} from "./budget-preflight";
import { Button } from "@/components/ui/button";
import type { DialSession, SessionCommandResult, ParallelAttempt } from "@/lib/dialer/types";
import { defaultParallelOptions } from "@/lib/dialer/parallel-policy";

type Mode = "manual" | "power" | "parallel";
type Props = {
  ready: boolean;
  // Undefined means initial operator playback is still pending. Only an
  // explicit operator_ready acknowledgement can grant media in the database.
  operatorMediaReady?: boolean;
  idle: boolean;
  location?: string;
  onDispatch: (result: SessionCommandResult) => Promise<void>;
  onSession: (session: DialSession | null) => void;
  onModeChange?: (mode: Mode) => void;
  beforeAdvance: () => Promise<void>;
  onEndCall: () => Promise<void>;
  onSnapshot?: (snapshot: { attempts: ParallelAttempt[]; metrics: Record<string, number | null> }) => void;
};

export function SessionControls(props: Props) {
  const [mode, setMode] = useState<Mode>("manual");
  const [session, setSession] = useState<DialSession | null>(null);
  const [lists, setLists] = useState<Array<{ id: string; name: string }>>([]);
  const [listId, setListId] = useState("");
  const [parallelLocation, setParallelLocation] = useState("");
  const [lines, setLines] = useState(4);
  const [options, setOptions] = useState(defaultParallelOptions);
  const [parallelBlockers, setParallelBlockers] = useState<string[]>(["Provider readiness has not loaded."]);
  const [acceptance, setAcceptance] = useState<{id:string;list_id:string;time_zone:string;destinations:Array<{phone_number:string;time_zone:string}>;max_spend_cents:number;expires_at:string}|null>(null);
  const transportReady = useRef(false);
  const [timeZone, setTimeZone] = useState("America/New_York");
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState("");
  const [budgetReady,setBudgetReady]=useState(false);
  const [busy, setBusy] = useState(false);
  const [controllerId, setControllerId] = useState("");
  const controller = useRef("");
  const inFlight = useRef(false);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const current = useRef(props);
  useEffect(() => { current.current = props; });

  const acceptSession = useCallback((value: DialSession | null) => {
    setSession(value);
    if (value) current.current.onModeChange?.(value.mode);
    current.current.onSession(value && !["stopped", "completed"].includes(value.status) ? value : null);
  }, []);

  // Discover persisted sessions even in Manual Mode; a refresh never dispatches an existing attempt again.
  useEffect(() => {
    controller.current = sessionStorage.getItem("portive-controller") ?? crypto.randomUUID();
    sessionStorage.setItem("portive-controller", controller.current);
    const grantId = new URLSearchParams(window.location.search).get("parallelAcceptance");
    const query = grantId ? `?${new URLSearchParams({acceptanceGrantId:grantId,controllerId:controller.current})}` : "";
    void fetch(`/api/dial-sessions${query}`, { cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) { setError(data.error); return; }
      setControllerId(controller.current);
      setLists(data.lists ?? []);
      setParallelBlockers(data.capabilities?.parallelBlockers ?? ["Provider readiness unavailable."]);
      if(data.session?.mode==='parallel'&&data.session.parallel_options?.budgetVersion==='exposure-v1')setOptions({...defaultParallelOptions,...data.session.parallel_options});
      setListId(data.session?.selected_list_id ?? data.lists?.[0]?.id ?? "");
      setParallelLocation(data.session?.mode === "parallel" ? data.session.location ?? "" : "");
      if (data.acceptanceAuthorization && !data.session) {
        const approved = data.acceptanceAuthorization;
        setAcceptance(approved); setMode("parallel"); setListId(approved.list_id); setTimeZone(approved.time_zone);
        setLines(Math.max(2,approved.destinations.length));
        setOptions({...defaultParallelOptions,ringTimeout:15,maxCallSeconds:60,attemptLimit:approved.destinations.length,maxSpendCents:approved.max_spend_cents,autoContinue:false});
      }
      if (data.session) { acceptSession(data.session); setMode(data.session.mode); }
    }).catch(() => setError("Unable to recover dial sessions. Manual calling remains available."));
  }, [acceptSession]);

  const commandSessionId = session?.id;
  const commandMode = session?.mode;
  const commandStatus = session?.status;
  const commandController = session?.controller_id;
  const command = useCallback(async (action: string, options?: Record<string, unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (["next", "continue", "skip", "start"].includes(action)) await current.current.beforeAdvance();
      // The incoming operator INVITE can arrive before this HTTP request returns.
      if (action === "start" && options?.mode) current.current.onModeChange?.(options.mode as Mode);
      const response = await fetch("/api/dial-sessions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action, sessionId: commandSessionId, controllerId: controller.current,
          ready: current.current.ready && (commandMode !== "parallel" || current.current.operatorMediaReady !== false),
          transportReady: commandMode === "parallel" ? transportReady.current : true, location: current.current.location, ...options,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        const message = result.error ?? "Session command failed";
        const hint = message === "Selected list/location has no leads"
          ? " Choose a populated lead list or clear the Parallel location filter."
          : "";
        throw new Error(`HTTP ${response.status}: ${message}${hint}`);
      }
      acceptSession(result.session);
      setRecoveryPending(Boolean(result.recoveryPending));
      setError(result.warning ?? "");
      if (result.dispatch) await current.current.onDispatch(result);
    } catch (err) {
      setRecoveryPending(true);
      setError(err instanceof Error ? err.message : "Dial session failed");
      // A failed/uncertain dispatch is never retried. Keep its durable reservation for recovery.
    } finally { inFlight.current = false; setBusy(false); }
  }, [acceptSession, commandSessionId, commandMode]);

  useEffect(() => {
    if (!commandSessionId || ["completed", "stopped"].includes(commandStatus ?? "") || commandController !== controller.current) return;
    const timer = setInterval(() => {
      const deadline = Date.parse(String(session?.parallel_options?.deadlineAt ?? ""));
      if (commandMode === "parallel" && (commandStatus !== "running" || recoveryPending || Number.isFinite(deadline) && Date.now() >= deadline)) {
        // Observe durable recovery without extending a lease or waking the Worker.
        void fetch("/api/dial-sessions", { cache: "no-store" }).then(async r => {
          if (r.ok) {
            const data = await r.json(); acceptSession(data.session);
            if (!data.session) { setRecoveryPending(false); setError(""); }
          }
        }).catch(() => {});
        return;
      }
      const action = commandMode === "parallel" ? "heartbeat" : commandStatus === "running" && current.current.idle ? "next" : "heartbeat";
      void command(action);
    }, commandMode === "parallel" && (commandStatus !== "running" || recoveryPending) ? 15000 : 2500);
    return () => clearInterval(timer);
  }, [command, commandSessionId, commandStatus, commandController, commandMode, recoveryPending, acceptSession, session?.parallel_options?.deadlineAt]);

  const streamSessionId = session?.mode === "parallel" && !["completed", "stopped"].includes(session.status) ? session.id : null;
  useEffect(() => {
    if (!streamSessionId) return;
    let stream: EventSource;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    function connect() {
      if (disposed) return;
      stream = new EventSource(`/api/dial-sessions/${streamSessionId}/events`);
      stream.addEventListener("snapshot", (event) => {
        const snapshot = JSON.parse((event as MessageEvent).data);
        clearTimeout(renewal);
        transportReady.current = true;
        acceptSession(snapshot.session);
        current.current.onSnapshot?.(snapshot);
      });
      const failed = () => { transportReady.current = false; setError("Realtime session transport disconnected; new dialing is suspended."); };
      stream.addEventListener("transport_error", failed);
      stream.onerror = failed;
      stream.addEventListener("renew", () => {
        stream.close();
        // Keep the last confirmed snapshot through a bounded planned reconnect.
        // A failed reconnect still revokes transport before the 10s browser lease.
        renewal = setTimeout(failed, 5000);
        connect();
      });
    }
    connect();
    return () => { disposed = true; clearTimeout(renewal); transportReady.current = false; stream.close(); };
  }, [acceptSession, streamSessionId]);

  const active = session && !["completed", "stopped"].includes(session.status);
  const owned = !session || session.controller_id === controllerId;
  const restricted = Boolean(acceptance || session?.acceptance_grant_id);
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/90">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Calling mode</span>
        {(["manual", "power", "parallel"] as const).map((item) => (
          <Button key={item} size="sm" variant={mode === item ? "default" : "outline"} disabled={Boolean(active) || !props.idle}
            onClick={() => { current.current.onModeChange?.(item); setMode(item); }}>{item[0].toUpperCase() + item.slice(1)}</Button>
        ))}
        {session ? <span className="text-sm" role="status">{session.status.replaceAll("_", " ")} · {session.phase.replaceAll("_", " ")}{session.mode === "parallel" ? ` · operator ${session.operator_leg_state}` : ""}{session.reason ? ` · ${session.reason}` : ""}</span> : null}
      </div>
      {mode !== "manual" ? (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label>Lead list <select aria-label="Dial session lead list" className="rounded border bg-background p-2" disabled={Boolean(active) || restricted} value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">Choose list</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
            </select></label>
            {mode === "parallel" ? <label>Parallel location (optional) <input aria-label="Parallel location filter" className="rounded border bg-background p-2" placeholder="All locations in selected list" disabled={Boolean(active) || restricted} value={parallelLocation} onChange={(e) => setParallelLocation(e.target.value)} /></label> : null}
            <label>List local timezone <select aria-label="List local timezone" className="rounded border bg-background p-2" value={timeZone} disabled={Boolean(active) || restricted} onChange={(e) => setTimeZone(e.target.value)}>
              {["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"].map((zone) => <option key={zone}>{zone}</option>)}
            </select></label>
            {mode === "parallel" ? <label>Maximum lines <select aria-label="Maximum lines" className="rounded border bg-background p-2" value={lines} disabled={Boolean(active) || restricted} onChange={(e) => setLines(Number(e.target.value))}>{[2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select></label> : null}
            <label className="flex items-center gap-2"><input type="checkbox" checked={reviewed} disabled={Boolean(active)} onChange={(e) => setReviewed(e.target.checked)} />I reviewed this list’s eligibility, DNC screening and local calling restrictions.</label>
          </div>
          {mode === "parallel" ? <>
            {restricted ? <p role="status" className="text-sm text-amber-700">Restricted acceptance: one batch, no retry or resume, 120-second operator limit. {acceptance ? `Only ${acceptance.destinations.map(d=>`${d.phone_number} (${d.time_zone})`).join(", ")}; budget $${(acceptance.max_spend_cents/100).toFixed(2)}; authorization expires ${acceptance.expires_at}.` : "Use Stop after the controlled conversation and reconcile all legs."}</p> : parallelBlockers.length ? <div role="status" className="text-sm text-amber-700 dark:text-amber-300"><p>Parallel technical blockers:</p><ul className="list-inside list-disc">{parallelBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div> : <p className="text-sm text-green-600">Provider capacity, operator connection and credit are checked at Start and Resume.</p>}
            <div className="flex flex-wrap gap-3 text-sm">
              {([['ringTimeout','Ring timeout (seconds)',15,120],['maxCallSeconds','Maximum call seconds',30,1800],['batchDelaySeconds','Batch delay (seconds)',0,60],['attemptLimit','Attempt limit',1,500],['maxSpendCents','Maximum spend (cents)',1,100000]] as const).map(([key,label,min,max]) => <label key={key}>{label}<input className="ml-2 w-20 rounded border bg-background p-1" type="number" min={min} max={max} value={options[key]} disabled={Boolean(active) || restricted} onChange={(event) => setOptions((current) => ({ ...current, ...(key==="maxSpendCents"?{spendingApproved:false}:{}), [key]: Number(event.target.value), ...(["maxCallSeconds","ringTimeout"].includes(key)?{sessionSeconds:Math.max(current.sessionSeconds??0,(key==="maxCallSeconds"?Number(event.target.value):current.maxCallSeconds)+(key==="ringTimeout"?Number(event.target.value):current.ringTimeout)+60)}:{}) }))} /></label>)}
              <label><input type="checkbox" checked={options.autoContinue} disabled={Boolean(active) || restricted} onChange={(event) => setOptions((current) => ({ ...current, autoContinue: event.target.checked }))} /> Automatically continue after saved disposition</label>
              <label><input type="checkbox" checked={options.silentRingback} disabled={Boolean(active)} onChange={(event) => setOptions((current) => ({ ...current, silentRingback: event.target.checked }))} /> Silent local ringback</label>
              <span>Batch mode · Continuous refill unavailable</span>
            </div>
          </> : null}
          {mode === "parallel" && !restricted ? <BudgetPreflight listId={listId} parallelLocation={parallelLocation} timeZone={timeZone} lines={lines} options={options} sessionId={active?session?.id:undefined} onOptions={setOptions} onReady={setBudgetReady} onBlockers={setParallelBlockers}/> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={Boolean(active) || !props.ready || !props.idle || !reviewed || !listId || mode === "parallel" && !acceptance && (parallelBlockers.length > 0 || !budgetReady) || busy}
              onClick={() => void command("start", { listId, parallelLocation, timeZone, reviewed, mode, options, maxLines: mode === "parallel" ? lines : 1, ...(mode === "parallel" && acceptance ? {acceptanceGrantId:acceptance.id} : {}) })}>{mode === "parallel" && acceptance ? "Start approved acceptance batch" : "Start Session"}</Button>
            <Button size="sm" variant="outline" disabled={!active || !owned || busy || session.status !== "running"} onClick={() => void command("pause")}>Pause</Button>
            <Button size="sm" variant="outline" disabled={restricted || !active || !owned || busy || session.status !== "paused" || !props.ready || session.mode === "parallel" && props.operatorMediaReady !== true} onClick={() => void command("resume")}>Resume</Button>
            <Button size="sm" variant="destructive" disabled={!active || !owned || busy} onClick={() => void command("stop")}>Stop Session</Button>
            {session?.mode === "parallel" && !restricted ? <Button size="sm" variant="outline" disabled={busy || !owned || session.status !== "running" || !["awaiting_disposition", "ready"].includes(session.phase)} onClick={() => void command("continue")}>Continue next batch</Button> : null}
            <Button size="sm" variant="outline" disabled={!active || !owned || !session.active_call_id || busy || props.idle} onClick={() => void props.onEndCall()}>End Active Call</Button>
            <Button size="sm" variant="outline" disabled={!active || !owned || (session.mode === "parallel" ? session.phase !== "awaiting_disposition" : !props.idle) || busy} onClick={() => void command("skip")}>Skip Lead</Button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">One attempt per number per session · Configured attempt limit · Recipient-local calling policy applies. Use a list grouped by timezone; per-lead timeZone overrides are respected. Answered calls wait for a saved disposition or explicit skip. Pause preserves the live call.</p>
          {mode === "parallel" && !props.ready ? <p className="text-sm text-amber-600">Connect the operator softphone and allow microphone access before starting.</p> : null}
          {!owned && active ? <p className="text-sm text-amber-600">This session is controlled by another browser. Close it there or wait for recovery.</p> : null}
        </>
      ) : null}
      {error && mode !== "manual" ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}
    </div>
  );
}

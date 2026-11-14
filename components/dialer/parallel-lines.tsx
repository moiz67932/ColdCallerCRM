"use client";
import { useEffect, useState } from "react";
import type { ParallelAttempt } from "@/lib/dialer/types";

export function ParallelLines({ attempts, winner, metrics }: { attempts: ParallelAttempt[]; winner?: string | null; metrics?: Record<string, number | null> }) {
  const [now, setNow] = useState(0);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  return <div className="space-y-2 rounded-lg border border-slate-300 p-3 dark:border-slate-700" aria-label="Parallel live calls">
    <p className="text-sm font-medium">Parallel call lines</p>
    <div className="grid gap-2 sm:grid-cols-2">
      {attempts.map((attempt, index) => {
        const connected = attempt.id === winner && attempt.was_bridged_to_operator && !attempt.ended_at;
        const review = ["answer_collision", "answer_unknown"].includes(attempt.technical_state);
        const timerStart = attempt.was_bridged_to_operator ? attempt.bridged_at ?? attempt.started_at : attempt.ringing_at ?? attempt.started_at;
        const seconds = Math.max(0, Math.floor(((attempt.ended_at ? Date.parse(attempt.ended_at) : now || Date.parse(attempt.started_at)) - Date.parse(timerStart)) / 1000));
        return <div key={attempt.id} data-attempt-id={attempt.id} className={`min-w-0 rounded border p-2 text-xs ${connected ? "border-green-500 bg-green-500/10" : review ? "border-orange-500 bg-orange-500/10" : attempt.technical_state === "failed" ? "border-red-500" : attempt.ended_at ? "border-slate-500 opacity-70" : "border-blue-400"}`}>
          <p className="truncate font-semibold">LINE {index + 1} · {attempt.leads.business_name ?? "Business"}</p>
          <p>{attempt.leads.phone_number}</p><p className="truncate">{attempt.leads.lead_lists.name}</p>
          <p className="mt-1 font-medium">{connected ? "CONNECTED" : attempt.technical_state.replaceAll("_", " ")} · {Math.floor(seconds / 60).toString().padStart(2,"0")}:{(seconds % 60).toString().padStart(2,"0")}</p>
          <p>Classification: {attempt.answer_classification} {attempt.overflow_state ? `· Overflow: ${attempt.overflow_state}` : ""}</p>
          {attempt.outcome ? <p>Disposition: {attempt.outcome}</p> : null}
        </div>;
      })}
    </div>
    {metrics ? <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
      {Object.entries(metrics).map(([key,value]) => <span key={key}>{key.replaceAll("_"," ")}: {value ?? "not available"}</span>)}
    </div> : null}
  </div>;
}

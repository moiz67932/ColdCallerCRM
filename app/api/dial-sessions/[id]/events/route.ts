import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  const { id } = await context.params;
  const db = getSupabaseAdmin();
  const { data: session, error } = await db.from("dial_sessions").select("id,operator_id").eq("id", id).single();
  if (error || session?.operator_id !== "operator") return Response.json({ error: "Session not found" }, { status: 404 });
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let sending = false;
      let dirty = false;
      function send(event: string, data: unknown) {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      async function snapshot() {
        if (sending) { dirty = true; return; }
        sending = true;
        try {
          do {
            dirty = false;
            const { data, error } = await db.rpc("portive_parallel_snapshot", { p_session: id });
            if (error) throw new Error(error.message);
            send("snapshot", data);
          } while (dirty && !closed);
        } catch (error) { send("transport_error", { error: error instanceof Error ? error.message : "Snapshot failed" }); }
        finally { sending = false; }
      }
      const channel = db.channel(`parallel:${id}:${crypto.randomUUID()}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "dial_sessions", filter: `id=eq.${id}` }, () => { void snapshot(); })
        .on("postgres_changes", { event: "*", schema: "public", table: "call_attempts", filter: `dial_session_id=eq.${id}` }, () => { void snapshot(); })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void snapshot();
          else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) send("transport_error", { error: `Supabase Realtime ${status}` });
        });
      const ping = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n")); }, 15_000);
      // Renew before Vercel kills the function. The client treats planned renewal
      // separately from a lost transport and reconnects without replaying Start.
      const lifetime = setTimeout(() => { send("renew", {}); cleanup(); }, 240_000);
      cleanup = () => { if (closed) return; closed = true; clearInterval(ping); clearTimeout(lifetime); request.signal.removeEventListener("abort", cleanup); void db.removeChannel(channel); try { controller.close(); } catch { /* Native cancellation already closed the stream. */ } };
      request.signal.addEventListener("abort", cleanup, { once: true });
      void snapshot();
      if (request.signal.aborted) cleanup();
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}

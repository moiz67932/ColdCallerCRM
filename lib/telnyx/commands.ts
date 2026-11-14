import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Provider command_id deduplication has a finite window. This durable ledger has no
// automatic expiry: an ambiguous dial must be reconciled, never blindly placed again.
export async function executeCallControlCommand<T>(attemptId: string, action: string, send: () => Promise<T>): Promise<T> {
  const db = getSupabaseAdmin();
  const key = `${attemptId}:${action}`;
  const { error: insertError } = await db.from("dial_provider_commands").insert({
    command_key: key, attempt_id: attemptId, state: "executing",
  });
  if (insertError) {
    if (insertError.code !== "23505") throw new Error(insertError.message);
    const { data: existing, error } = await db.from("dial_provider_commands").select("state,response_json").eq("command_key", key).single();
    if (error) throw new Error(error.message);
    if (existing.state === "confirmed") return existing.response_json as T;
    throw new Error(`Call-control ${action} is already pending or uncertain. Inspect provider events before retrying.`);
  }
  try {
    const response = await send();
    const { error } = await db.from("dial_provider_commands").update({
      state: "confirmed", response_json: response ?? {},
    }).eq("command_key", key);
    if (error) throw new Error(error.message);
    return response;
  } catch (error) {
    await db.from("dial_provider_commands").update({ state: "uncertain" }).eq("command_key", key);
    throw error;
  }
}

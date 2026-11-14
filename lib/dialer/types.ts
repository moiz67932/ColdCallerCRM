export type DialSession = {
  id: string;
  controller_id: string;
  selected_list_id: string;
  mode: "power" | "parallel";
  max_lines: number;
  status: "running" | "paused" | "stopping" | "stopped" | "completed" | "unsafe";
  phase: "ready" | "calling" | "awaiting_disposition";
  active_call_id: string | null;
  heartbeat_at: string;
  reason: string | null;
  operator_call_control_id?: string | null;
  operator_leg_state?: string;
  browser_media_ready?: boolean;
  parallel_batch?: number;
  parallel_options?: Record<string, unknown>;
  reserved_cost_cents?: number;
};

export type ParallelAttempt = {
  id: string; lead_id: string; status: string; technical_state: string; answer_classification: string;
  started_at: string; ringing_at: string | null; ended_at: string | null; outcome: string | null;
  bridged_at?: string | null;
  parallel_batch: number; was_bridged_to_operator: boolean; overflow_state: string | null;
  leads: { business_name: string | null; phone_number: string; lead_lists: { name: string } };
};

export type SessionCommandResult = {
  session: DialSession;
  dispatch: boolean;
  attempt?: { id: string; lead_id: string; ended_at: string | null; answered_at: string | null };
  lead?: { id: string; phone_number: string };
  destination?: string;
  callerNumber?: string;
};

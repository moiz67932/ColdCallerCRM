// Two independent loops: slow provider HTTP requests cannot block answer deadlines.
async function run() {
  if (process.env.DIALER_ORCHESTRATION_BACKEND === "cloudflare") throw new Error("Cloudflare owns orchestration; do not run the Node watchdog");
  const secret = process.env.DIALER_WATCHDOG_SECRET;
  if (!secret || secret.length < 32) throw new Error("Set DIALER_WATCHDOG_SECRET to at least 32 random characters");
  const base = process.env.DIALER_INTERNAL_URL ?? "http://127.0.0.1:3000";
  async function request(commands: boolean) {
    const response = await fetch(`${base}/api/dial-sessions/sweep${commands ? "?commands=1" : ""}`, {
      method: "POST", headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(55_000),
    });
    if (!response.ok) throw new Error(`Dialer worker HTTP ${response.status}: ${await response.text()}`);
  }
  let inFlight = 0;
  setInterval(() => {
    if (inFlight >= 12) return;
    inFlight++;
    void request(true).catch(console.error).finally(() => { inFlight--; });
  }, 100);
  for (;;) {
    try { await request(false); } catch (error) { console.error("Dialer tick failed", error); }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
void run();

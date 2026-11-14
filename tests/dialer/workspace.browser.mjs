// Controlled UI checks. API fixtures never send requests to Telnyx or production Supabase.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseURL = process.env.PORTIVE_TEST_URL ?? "http://127.0.0.1:3210";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL });
try {
  const unauthorized = await context.request.post("/api/dial-sessions", { data: { action: "start", mode: "parallel", maxLines: 4 } });
  assert.equal(unauthorized.status(), 401);
  const sweep = await context.request.post("/api/dial-sessions/sweep");
  assert.equal(sweep.status(), 401);
  const login = await context.request.post("/api/auth/login", { data: { password: "portive-local-test-only" } });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const leads = ["first", "second"].map((id, index) => ({
    id, leadListId: "list", createdAt: "2026-11-01T00:00:00Z", businessName: `Business ${index + 1}`,
    phoneNumber: `+1212555010${index + 1}`, notes: "Saved server note", tags: [], callAttempts: [], followUps: [],
    leadList: { id: "list", name: "Test list", sourceFileName: "test.csv" },
  }));
  const notesSaved = [];
  let outboundRequests = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    let body;
    if (path === "/api/settings") body = { settings: { locations: [] }, runtimeConfig: { telnyxManualDialFlow: "browser_first", telnyxWebrtcCredentialConfigured: true } };
    else if (path === "/api/leads") body = { leads: structuredClone(leads) };
    else if (path === "/api/dial-sessions") {
      if (request.method() !== "GET") { outboundRequests++; body = { error: "Unexpected session dispatch" }; }
      else body = { session: null, lists: [{ id: "list", name: "Test list" }], capabilities: { parallel: false, parallelBlockers: ["Missing TELNYX_API_KEY.", "No controlled Telnyx verification report has been installed."] } };
    } else if (path.endsWith("/notes")) { notesSaved.push({ path, ...request.postDataJSON() }); body = { saved: true }; }
    else { outboundRequests++; return route.abort("blockedbyclient"); }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/queue");
  await page.getByText("Business 1", { exact: true }).first().waitFor();
  const noteBox = page.locator("#notes-box");
  await noteBox.fill("Receptionist: manager will call back");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  assert.equal(await noteBox.inputValue(), "Receptionist: manager will call back");
  await page.getByRole("button", { name: /Business 2/ }).click();
  await page.waitForFunction(() => document.querySelector("#notes-box")?.value === "Saved server note");
  assert(notesSaved.some((note) => note.path === "/api/leads/first/notes" && note.body === "Receptionist: manager will call back"));
  await page.getByRole("button", { name: /Business 1/ }).click();
  await page.waitForFunction(() => document.querySelector("#notes-box")?.value === "Receptionist: manager will call back");
  await page.getByRole("button", { name: "Power", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Start Session", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Parallel", exact: true }).click();
  await page.getByLabel("Maximum lines").selectOption("4");
  assert.equal(await page.getByRole("button", { name: "Start Session", exact: true }).isDisabled(), true);
  await page.getByText("Missing TELNYX_API_KEY.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Manual", exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => { throw new DOMException("Permission denied", "NotAllowedError"); } });
  });
  await page.getByRole("button", { name: "Connect softphone", exact: true }).click();
  await page.getByText(/Microphone blocked:/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Call", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Connect softphone", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), true);
  assert.equal(outboundRequests, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/tmp/portive-workspace-smoke.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")]
    .filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1)
    .slice(0, 12).map((node) => ({ tag: node.tagName, className: node.className, width: node.getBoundingClientRect().width })));
  if (overflow.length) console.log("Mobile overflow:", overflow);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  console.log("PASS: unauthenticated session/sweep rejected; notes survive refresh and attach to the correct lead; manual controls render; Power requires softphone; Parallel 4-line start blocked; mic denial prevents calls; no outbound requests or browser errors.");
} finally { await context.close(); await browser.close(); }

// Browser media only: generated audio, no microphone, provider, server or calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { chromium } from "playwright";

const source = readFileSync(new URL("../../lib/dialer/parallel-media.ts", import.meta.url), "utf8");
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  // Any unexpected network request fails rather than reaching a real service.
  await page.route("**/*", route => route.abort());
  await page.addScriptTag({ type: "module", content: script + "\nwindow.watchOperatorMedia = watchParallelOperatorMedia;" });
  await page.waitForFunction(() => Boolean(window.watchOperatorMedia));
  await page.evaluate(async () => {
    const context = new AudioContext();
    await context.resume();
    const oscillator = context.createOscillator();
    const destination = context.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start();
    const speaker = document.createElement("audio");
    document.body.append(speaker);
    const blocked = document.createElement("audio");
    blocked.play = () => Promise.reject(new DOMException("Fixture autoplay rejection", "NotAllowedError"));
    const rejected = [];
    const blockedMedia = window.watchOperatorMedia(blocked, destination.stream, status => rejected.push(status));
    await Promise.resolve(); await Promise.resolve();
    window.fixture = { context, oscillator, destination, speaker, blockedMedia, rejected, statuses: [] };
    window.fixture.media = window.watchOperatorMedia(speaker, destination.stream, status => window.fixture.statuses.push(status));
  });
  await page.waitForFunction(() => window.fixture.media.ready());
  assert.deepEqual(await page.evaluate(() => window.fixture.statuses), ["ready"], "initial buffering must never revoke media before first playback");
  assert.deepEqual(await page.evaluate(() => window.fixture.rejected), ["unavailable"]);
  assert.equal(await page.evaluate(() => window.fixture.blockedMedia.ready()), false);
  await page.evaluate(() => window.fixture.speaker.pause());
  await page.waitForFunction(() => window.fixture.statuses.at(-1) === "unavailable");
  assert.equal(await page.evaluate(() => window.fixture.media.ready()), false);
  await page.evaluate(() => window.fixture.speaker.play());
  await page.waitForFunction(() => window.fixture.media.ready());
  await page.evaluate(() => window.fixture.destination.stream.getAudioTracks()[0].stop());
  await page.waitForFunction(() => !window.fixture.media.ready());
  assert.equal(await page.evaluate(() => window.fixture.statuses.at(-1)), "unavailable");
  await page.evaluate(async () => {
    window.fixture.media.dispose(); window.fixture.blockedMedia.dispose();
    window.fixture.oscillator.stop(); await window.fixture.context.close();
  });
  assert.deepEqual(errors, []);
  console.log("PASS: real browser playback required; autoplay rejection, speaker pause and ended remote track revoke readiness. No microphone or telephony used.");
} finally { await browser.close(); }

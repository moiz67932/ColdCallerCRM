import assert from "node:assert/strict";
import test from "node:test";
import { watchParallelOperatorMedia, type ParallelMediaStatus } from "../../lib/dialer/parallel-media";

class Track extends EventTarget { readyState = "live"; enabled = true; muted = false; }
class Stream extends EventTarget {
  active = true;
  tracks = [new Track()];
  getAudioTracks() { return this.tracks; }
}
class Speaker extends EventTarget {
  srcObject: unknown = null; paused = true; muted = false; volume = 1; readyState = 4; error: unknown = null;
  start: () => Promise<void> = () => Promise.resolve();
  play() { this.paused = false; return this.start(); }
}
function fixture() {
  const speaker = new Speaker(), stream = new Stream(), statuses: ParallelMediaStatus[] = [];
  return { speaker, stream, statuses, observe: () => watchParallelOperatorMedia(speaker, stream, status => statuses.push(status)) };
}
const settled = async () => { await Promise.resolve(); await Promise.resolve(); };

test("initial waiting/stalled/emptied stay pending until successful playback", async () => {
  const f = fixture(); let complete!: () => void;
  f.speaker.start = () => new Promise(resolve => { complete = resolve; });
  const media = f.observe();
  for (const event of ["emptied", "waiting", "stalled"]) f.speaker.dispatchEvent(new Event(event));
  assert.equal(media.status(), "pending"); assert.equal(media.ready(), false);
  assert.deepEqual(f.statuses, []);
  f.speaker.dispatchEvent(new Event("playing")); complete(); await settled();
  assert.equal(media.ready(), true); assert.deepEqual(f.statuses, ["ready"]);
  f.speaker.dispatchEvent(new Event("waiting"));
  assert.equal(media.ready(), false); assert.equal(media.status(), "unavailable");
  media.dispose();
});

test("operator readiness waits for playback success, then requires live enabled audible tracks", async () => {
  const f = fixture(); let complete!: () => void;
  f.speaker.start = () => new Promise(resolve => { complete = resolve; });
  const media = f.observe();
  assert.equal(media.ready(), false); assert.deepEqual(f.statuses, []);
  complete(); await settled(); assert.equal(media.ready(), true);
  f.stream.tracks[0].enabled = false;
  assert.equal(media.ready(), false); assert.equal(f.statuses.at(-1), "unavailable");
  media.dispose();
});
test("autoplay rejection cannot acknowledge media and reports its loss", async () => {
  const f = fixture(); f.speaker.start = () => Promise.reject(new Error("Autoplay blocked"));
  const media = f.observe(); await settled();
  assert.equal(media.ready(), false); assert.deepEqual(f.statuses, ["unavailable"]);
  media.dispose();
});
test("pause, buffering, speaker errors and volume loss revoke ready media", async () => {
  for (const event of ["pause", "waiting", "stalled", "error", "ended", "emptied"]) {
    const f = fixture(), media = f.observe(); await settled(); assert.equal(media.ready(), true);
    f.speaker.dispatchEvent(new Event(event)); assert.equal(media.ready(), false, event);
    assert.equal(f.statuses.at(-1), "unavailable"); media.dispose();
  }
  for (const change of [(s: Speaker) => { s.muted = true; }, (s: Speaker) => { s.volume = 0; }]) {
    const f = fixture(), media = f.observe(); await settled(); change(f.speaker);
    f.speaker.dispatchEvent(new Event("volumechange")); assert.equal(media.ready(), false); media.dispose();
  }
});
test("track end/mute/removal and stream loss revoke readiness without an SDK call update", async () => {
  for (const loss of ["ended", "mute", "remove", "inactive"]) {
    const f = fixture(), media = f.observe(); await settled(); assert.equal(media.ready(), true);
    if (loss === "ended") { f.stream.tracks[0].readyState = "ended"; f.stream.tracks[0].dispatchEvent(new Event("ended")); }
    if (loss === "mute") { f.stream.tracks[0].muted = true; f.stream.tracks[0].dispatchEvent(new Event("mute")); }
    if (loss === "remove") { f.stream.tracks = []; f.stream.dispatchEvent(new Event("removetrack")); }
    if (loss === "inactive") { f.stream.active = false; f.stream.dispatchEvent(new Event("inactive")); }
    assert.equal(media.ready(), false, loss); assert.equal(f.statuses.at(-1), "unavailable"); media.dispose();
  }
});
test("late playback promises cannot restore readiness after pause or disposed stream replacement", async () => {
  for (const dispose of [false, true]) {
    const f = fixture(); let complete!: () => void;
    f.speaker.start = () => new Promise(resolve => { complete = resolve; });
    const media = f.observe();
    if (dispose) { media.dispose(); f.speaker.srcObject = new Stream(); }
    else f.speaker.dispatchEvent(new Event("pause"));
    complete(); await settled(); assert.equal(media.ready(), false); assert(!f.statuses.includes("ready"));
    media.dispose();
  }
});
test("a real playing event can recover media, but another stream or ended tracks cannot", async () => {
  const f = fixture(), media = f.observe(); await settled();
  f.speaker.dispatchEvent(new Event("waiting")); assert.equal(media.ready(), false);
  f.speaker.dispatchEvent(new Event("playing")); assert.equal(media.ready(), true);
  f.speaker.srcObject = new Stream(); assert.equal(media.ready(), false);
  f.speaker.srcObject = f.stream; f.stream.tracks[0].readyState = "ended";
  f.speaker.dispatchEvent(new Event("playing")); assert.equal(media.ready(), false); media.dispose();
});

class Peer extends EventTarget {
  connectionState = 'connecting';
  microphone = Object.assign(new Track(), { kind: 'audio' });
  getSenders() { return [{ track: this.microphone }]; }
  connect() { this.connectionState = 'connected'; this.dispatchEvent(new Event('connectionstatechange')); }
}
test('parked operator: playback before DTLS stays pending, connected mic permits a silent receiver', async () => {
  const f = fixture(), peer = new Peer();
  f.stream.tracks[0].muted = true; // No prospect has been bridged, so no inbound RTP.
  const media = watchParallelOperatorMedia(f.speaker, f.stream, s => f.statuses.push(s), peer);
  await settled();
  assert.equal(media.status(), 'pending');
  f.speaker.dispatchEvent(new Event('waiting'));
  assert.equal(media.status(), 'pending');
  peer.connect();
  assert.equal(media.ready(), true);
  assert.deepEqual(f.statuses, ['ready']);
  f.stream.tracks[0].dispatchEvent(new Event('mute'));
  assert.equal(media.ready(), true, 'parked silence cannot trigger a hangup');
  f.speaker.readyState = 1;
  f.speaker.dispatchEvent(new Event('waiting'));
  assert.equal(media.ready(), true, 'quiet parked buffering preserves established transport');
  peer.connectionState = 'disconnected'; peer.dispatchEvent(new Event('connectionstatechange'));
  assert.equal(media.ready(), false);
  assert.equal(media.status(), 'unavailable');
  media.dispose();
});
test('connected transport cannot hide missing microphone, stopped remote track or blocked speaker', async () => {
  for (const loss of ['microphone', 'remote', 'speaker']) {
    const f = fixture(), peer = new Peer(); peer.connect();
    const media = watchParallelOperatorMedia(f.speaker, f.stream, s => f.statuses.push(s), peer);
    await settled(); assert.equal(media.ready(), true);
    if (loss === 'microphone') peer.microphone.readyState = 'ended';
    if (loss === 'remote') f.stream.tracks[0].readyState = 'ended';
    if (loss === 'speaker') f.speaker.muted = true;
    assert.equal(media.ready(), false, loss); assert.equal(media.status(), 'unavailable'); media.dispose();
  }
});

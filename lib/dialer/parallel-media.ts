type MediaEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">;
type AudioTrack = MediaEvents & { readyState: string; enabled: boolean; muted: boolean };
type RemoteStream = MediaEvents & { active: boolean; getAudioTracks(): AudioTrack[] };
type Speaker = MediaEvents & {
  srcObject: unknown; paused: boolean; muted: boolean; volume: number; readyState: number;
  error: unknown; play(): Promise<void>;
};
export type ParallelMediaStatus = "pending" | "ready" | "unavailable";

// This observes the parked operator stream only. A connected SDK or an audio
// track object alone is not evidence that the browser can play remote audio.
export function watchParallelOperatorMedia(
  speaker: Speaker, stream: RemoteStream, onStatus: (status: ParallelMediaStatus) => void,
) {
  let disposed = false;
  let playbackSucceeded = false;
  let version = 0;
  let status: ParallelMediaStatus = "pending";
  let tracks: AudioTrack[] = [];
  const listeners: Array<() => void> = [];
  function listen(target: MediaEvents, name: string, handler: () => void) {
    target.addEventListener(name, handler);
    return () => target.removeEventListener(name, handler);
  }
  function check(lost = false) {
    if (disposed) return false;
    const currentTracks = stream.getAudioTracks();
    const ready = playbackSucceeded && stream.active && speaker.srcObject === stream && !speaker.paused &&
      !speaker.muted && speaker.volume > 0 && speaker.readyState >= 2 && !speaker.error &&
      currentTracks.length > 0 && currentTracks.every(t => t.readyState === "live" && t.enabled && !t.muted);
    const next = ready ? "ready" : lost || playbackSucceeded || status !== "pending" ? "unavailable" : "pending";
    if (status !== next) { status = next; onStatus(next); }
    return ready;
  }
  function losePlayback() { version++; playbackSucceeded = false; check(true); }
  function buffering() {
    // MediaStream playback normally emits waiting/emptied before its first
    // playing event. No established media has been lost during that startup.
    if (status === "pending" && !playbackSucceeded) return;
    losePlayback();
  }
  function playing() { playbackSucceeded = true; check(); }
  let trackListeners: Array<() => void> = [];
  function syncTracks() {
    trackListeners.forEach(remove => remove());
    tracks = stream.getAudioTracks();
    trackListeners = tracks.flatMap(track => [
      listen(track, "ended", () => { check(true); }),
      listen(track, "mute", () => { check(true); }),
      listen(track, "unmute", () => { check(); }),
    ]);
    check();
  }
  listeners.push(listen(speaker, "playing", playing));
  for (const name of ["pause", "ended", "error"]) {
    listeners.push(listen(speaker, name, losePlayback));
  }
  for (const name of ["emptied", "waiting", "stalled"]) listeners.push(listen(speaker, name, buffering));
  listeners.push(listen(speaker, "volumechange", () => { check(); }));
  listeners.push(listen(stream, "addtrack", syncTracks));
  listeners.push(listen(stream, "removetrack", syncTracks));
  listeners.push(listen(stream, "inactive", () => { check(true); }));
  syncTracks();
  speaker.srcObject = stream;
  const started = version;
  // Invalidate late promise completions after a loss or cleanup. They cannot
  // resurrect readiness for a paused player or an old stream/session.
  try {
    void speaker.play().then(() => {
      if (disposed || version !== started) return;
      playbackSucceeded = true;
      check();
    }).catch(() => { if (!disposed && version === started) losePlayback(); });
  } catch { losePlayback(); }
  return {
    ready: () => check(),
    status: () => status,
    dispose() {
      disposed = true; version++;
      listeners.forEach(remove => remove());
      trackListeners.forEach(remove => remove());
    },
  };
}

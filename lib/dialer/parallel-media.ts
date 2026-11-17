type MediaEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">;
type AudioTrack = MediaEvents & { readyState: string; enabled: boolean; muted: boolean };
type RemoteStream = MediaEvents & { active: boolean; getAudioTracks(): AudioTrack[] };
type Speaker = MediaEvents & {
  srcObject: unknown; paused: boolean; muted: boolean; volume: number; readyState: number;
  error: unknown; play(): Promise<void>;
};
type Peer = MediaEvents & {
  connectionState: string;
  getSenders(): Array<{ track: (AudioTrack & { kind: string }) | null }>;
};
export type ParallelMediaStatus = "pending" | "ready" | "unavailable";

// This observes the parked operator stream only. A connected SDK or an audio
// track object alone is not evidence that the browser can play remote audio.
export function watchParallelOperatorMedia(
  speaker: Speaker, stream: RemoteStream, onStatus: (status: ParallelMediaStatus) => void, peer?: Peer,
) {
  let disposed = false;
  let playbackSucceeded = false;
  let version = 0;
  let status: ParallelMediaStatus = "pending";
  let established = false;
  let tracks: AudioTrack[] = [];
  const listeners: Array<() => void> = [];
  function listen(target: MediaEvents, name: string, handler: () => void) {
    target.addEventListener(name, handler);
    return () => target.removeEventListener(name, handler);
  }
  function check(lost = false) {
    if (disposed) return false;
    const currentTracks = stream.getAudioTracks();
    const microphone = peer?.getSenders().find(sender => sender.track?.kind === "audio")?.track;
    const transportReady = !peer || peer.connectionState === "connected" && Boolean(microphone &&
      microphone.readyState === "live" && microphone.enabled && !microphone.muted);
    const ready = transportReady && playbackSucceeded && stream.active && speaker.srcObject === stream && !speaker.paused &&
      !speaker.muted && speaker.volume > 0 && (peer || speaker.readyState >= 2) && !speaker.error &&
      // A parked Telnyx call has no remote RTP until a prospect is bridged.
      // Receiver mute means no incoming packets, not a failed DTLS connection.
      currentTracks.length > 0 && currentTracks.every(t => t.readyState === "live" && t.enabled && (peer || !t.muted));
    if (ready) established = true;
    const next = ready ? "ready" : lost || established || status === "unavailable" ? "unavailable" : "pending";
    if (status !== next) { status = next; onStatus(next); }
    return ready;
  }
  function losePlayback() { version++; playbackSucceeded = false; check(true); }
  function buffering() {
    // Quiet parked media can buffer while DTLS and the microphone remain live.
    // Pause, autoplay rejection, ended tracks and connection loss still revoke.
    if (peer && playbackSucceeded) { check(); return; }
    // MediaStream playback normally emits waiting/emptied before its first
    // playing event. No established media has been lost during that startup.
    if (status === "pending" && !established) return;
    losePlayback();
  }
  function playing() { playbackSucceeded = true; check(); }
  let trackListeners: Array<() => void> = [];
  function syncTracks() {
    trackListeners.forEach(remove => remove());
    tracks = stream.getAudioTracks();
    trackListeners = tracks.flatMap(track => [
      listen(track, "ended", () => { check(true); }),
      listen(track, "mute", () => { check(!peer); }),
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
  if (peer) listeners.push(listen(peer, "connectionstatechange", () => {
    check(["failed", "closed", "disconnected"].includes(peer.connectionState));
  }));
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
    diagnostics: () => ({ status, connectionState: peer?.connectionState ?? "unknown",
      playbackSucceeded, paused: speaker.paused, speakerMuted: speaker.muted,
      volume: speaker.volume, readyState: speaker.readyState,
      remoteTracks: stream.getAudioTracks().length,
      remoteMuted: stream.getAudioTracks().some(t => t.muted) }),
    dispose() {
      disposed = true; version++;
      listeners.forEach(remove => remove());
      trackListeners.forEach(remove => remove());
    },
  };
}

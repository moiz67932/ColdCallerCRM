export type AudioRtp = { receivedPackets: number; sentPackets: number; receivedBytes: number; sentBytes: number };
// Packet totals prove transport activity, not that a person heard the speaker.
export function audioRtp(report: RTCStatsReport): AudioRtp {
  const result = { receivedPackets: 0, sentPackets: 0, receivedBytes: 0, sentBytes: 0 };
  report.forEach(row => {
    if ((row.kind ?? row.mediaType) !== 'audio' || row.isRemote) return;
    if (row.type === 'inbound-rtp') { result.receivedPackets += row.packetsReceived ?? 0; result.receivedBytes += row.bytesReceived ?? 0; }
    if (row.type === 'outbound-rtp') { result.sentPackets += row.packetsSent ?? 0; result.sentBytes += row.bytesSent ?? 0; }
  });
  return result;
}

/**
 * After a transfer the useful question is not how fast it went, but what
 * stopped it going faster. One number separates the two cases that matter.
 *
 * While sending we sample the data channel's outgoing buffer. If it is
 * routinely near empty, we could not produce bytes fast enough to keep the
 * channel busy and the limit is this machine - disk, CPU, or our own code. If
 * it is routinely full, the channel could not drain fast enough and the limit
 * is the path to the recipient: the sender's upload bandwidth, the recipient's
 * download bandwidth, or a relay in between.
 *
 * Consumer connections are very often asymmetric, so "we have gigabit" usually
 * describes the download side. The sender's upload is what bounds a transfer.
 */

export type CandidateKind = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

export interface TransportInfo {
  local: CandidateKind;
  remote: CandidateKind;
  relayed: boolean;
  /** The browser's own estimate of what the path will carry, bits per second. */
  availableOutgoingBitrate?: number;
  roundTripMs?: number;
}

export interface SendStats {
  bytes: number;
  seconds: number;
  bytesPerSecond: number;
  /** Share of sends that found the outgoing buffer nearly drained. */
  starvedPercent: number;
}

function kindOf(value: unknown): CandidateKind {
  return value === 'host' || value === 'srflx' || value === 'prflx' || value === 'relay'
    ? value
    : 'unknown';
}

/** Reads the candidate pair actually carrying traffic. */
export async function describeTransport(pc: RTCPeerConnection): Promise<TransportInfo | null> {
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return null;
  }

  const get = (id: unknown): Record<string, unknown> | undefined =>
    typeof id === 'string'
      ? (report.get(id) as Record<string, unknown> | undefined)
      : undefined;

  // Prefer the pair the transport names; fall back to the nominated one, which
  // is what browsers without selectedCandidatePairId expose.
  let pair: Record<string, unknown> | undefined;
  report.forEach((raw) => {
    const entry = raw as Record<string, unknown>;
    if (entry['type'] === 'transport') {
      const selected = get(entry['selectedCandidatePairId']);
      if (selected) pair = selected;
    }
  });
  if (!pair) {
    report.forEach((raw) => {
      const entry = raw as Record<string, unknown>;
      if (entry['type'] === 'candidate-pair' && entry['state'] === 'succeeded' && entry['nominated']) {
        pair = entry;
      }
    });
  }
  if (!pair) return null;

  const local = kindOf(get(pair['localCandidateId'])?.['candidateType']);
  const remote = kindOf(get(pair['remoteCandidateId'])?.['candidateType']);
  const bitrate = pair['availableOutgoingBitrate'];
  const rtt = pair['currentRoundTripTime'];

  return {
    local,
    remote,
    relayed: local === 'relay' || remote === 'relay',
    ...(typeof bitrate === 'number' ? { availableOutgoingBitrate: bitrate } : {}),
    ...(typeof rtt === 'number' ? { roundTripMs: rtt * 1000 } : {}),
  };
}

/**
 * Plain-language answer to "why was it not faster?". Deliberately cautious:
 * it reports which side of the channel was the constraint, and does not
 * pretend to know which hop on the network was responsible.
 */
export function explain(stats: SendStats, transport: TransportInfo | null): string {
  if (stats.starvedPercent >= 25) {
    return 'Limited by this device — reading from disk or encrypting could not '
      + 'keep the connection busy. A faster disk or a less busy machine would help.';
  }
  if (transport?.relayed) {
    return 'Limited by the relay — this pair could not connect directly, so every '
      + 'byte went through a TURN server and inherits its bandwidth.';
  }
  // A full buffer only says the channel could not drain faster. That covers
  // bandwidth, but also the CPU cost of encrypting on either end, so do not
  // name bandwidth as though it were the only candidate.
  return 'Limited by the connection, not by this device — the channel could not '
    + 'drain any faster. That is usually your upload speed (often far lower than '
    + 'your download speed), the recipient\'s download speed, or the route between '
    + 'you; on older machines it can also be the cost of encrypting the stream.';
}

/** One line for the UI, plus the detail behind it for the console. */
export function summarise(stats: SendStats, transport: TransportInfo | null): string[] {
  const mbps = (stats.bytesPerSecond / (1024 * 1024)).toFixed(1);
  const lines = [
    `Transfer: ${mbps} MB/s (${(stats.bytesPerSecond * 8 / 1e6).toFixed(0)} Mbit/s) over ${stats.seconds.toFixed(1)}s`,
    `Send buffer starved on ${stats.starvedPercent}% of writes`,
  ];
  if (transport) {
    lines.push(`Path: ${transport.local} ↔ ${transport.remote}${transport.relayed ? ' (relayed)' : ' (direct)'}`);
    if (transport.availableOutgoingBitrate !== undefined) {
      lines.push(`Browser estimate of available upload: ${(transport.availableOutgoingBitrate / 1e6).toFixed(0)} Mbit/s`);
    }
    if (transport.roundTripMs !== undefined) {
      lines.push(`Round trip: ${transport.roundTripMs.toFixed(0)} ms`);
    }
  }
  lines.push(explain(stats, transport));
  return lines;
}

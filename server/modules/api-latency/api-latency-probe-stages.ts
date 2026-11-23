/**
 * The probe's pure half: the request body it builds, the marks it reads and the
 * stage arithmetic it derives.
 *
 * Nothing here opens a socket. Splitting it out of `api-latency-probe.service.ts`
 * keeps that service on the socket orchestration — where a stage is marked — and
 * leaves the conversions that must be right (a reused connection reports `null`,
 * not `0`) readable and testable on their own.
 *
 * Consumers: `api-latency-probe.service.ts` (all of it) and the routes, which
 * clamp `uploadBytes` to {@link MAX_UPLOAD_BYTES}.
 */
import type {
  ApiLatencyProbeMode,
  ApiLatencyProbeResult,
  ApiLatencyStageTimings,
} from '@/shared/types.js';

/**
 * What the route may ask a probe to do; every field is transport-level only.
 *
 * Declared here rather than in the service so the direction of the dependency
 * stays one-way: the service imports these pure helpers, and this file imports
 * nothing but the shared wire types.
 */
export type ApiLatencyProbeInput = {
  mode: ApiLatencyProbeMode;
  stream: boolean;
  model?: string;
  uploadBytes?: number;
};

/** ~300 KB ≈ one large conversation turn, measured at ~5 s of upload here. */
export const DEFAULT_UPLOAD_BYTES = 300 * 1024;

/** Upper bound so a caller cannot turn the probe into a bandwidth test. */
export const MAX_UPLOAD_BYTES = 1024 * 1024;

const FILLER_LINE = 'The quick brown fox jumps over the lazy dog. ';

/**
 * Absolute marks, in ms from the start of the probe. Every value is optional
 * because a failed or timed-out probe simply never reaches later legs.
 */
export type ProbeMarks = {
  socket?: number;
  lookup?: number;
  tcp?: number;
  tls?: number;
  uploadDone?: number;
  firstByte?: number;
  firstToken?: number;
  end?: number;
};

/**
 * A leg's duration, or `null` when either end was never marked.
 *
 * The null matters: a pooled socket pays no DNS/TCP/TLS, and reporting `0` would
 * claim an impossible handshake instead of stating the leg was not measured.
 */
function elapsed(mark: number | undefined, since: number | undefined): number | null {
  if (mark === undefined || since === undefined) return null;
  return Math.max(0, Math.round(mark - since));
}

/**
 * Turn the absolute marks into the stage timings the page draws.
 *
 * Later legs fall back to the previous mark, so a probe that never saw a byte
 * still reports the connection cost it did pay rather than a wall of zeroes.
 */
export function toStageTimings(marks: ProbeMarks): ApiLatencyStageTimings {
  const connectedAt = marks.tls ?? marks.tcp ?? marks.socket;
  const uploadDoneAt = marks.uploadDone ?? connectedAt;
  const firstByteAt = marks.firstByte ?? uploadDoneAt;
  const endAt = marks.end ?? firstByteAt;

  return {
    dnsMs: elapsed(marks.lookup, marks.socket),
    tcpMs: elapsed(marks.tcp, marks.lookup ?? marks.socket),
    tlsMs: elapsed(marks.tls, marks.tcp ?? marks.socket),
    uploadMs: elapsed(uploadDoneAt, connectedAt) ?? 0,
    firstByteMs: elapsed(firstByteAt, uploadDoneAt) ?? 0,
    downloadMs: elapsed(endAt, firstByteAt) ?? 0,
    totalMs: endAt ?? 0,
  };
}

/** The request body one probe sends, plus its byte length for the upload reading. */
export function buildRequestBody(
  input: ApiLatencyProbeInput,
  model: string,
): { body: string; bytes: number } {
  const content: Array<{ type: 'text'; text: string }> = [];
  if (input.mode === 'upload') {
    const requested = input.uploadBytes ?? DEFAULT_UPLOAD_BYTES;
    const target = Math.min(Math.max(requested, 1_024), MAX_UPLOAD_BYTES);
    const repeats = Math.ceil(target / FILLER_LINE.length);
    content.push({ type: 'text', text: 'Summarize the following text in one word.' });
    content.push({ type: 'text', text: FILLER_LINE.repeat(repeats) });
  } else {
    content.push({ type: 'text', text: 'hi' });
  }

  const body = JSON.stringify({
    model,
    max_tokens: input.stream ? 16 : 4,
    stream: input.stream,
    messages: [{ role: 'user', content }],
  });
  return { body, bytes: Buffer.byteLength(body) };
}

/**
 * Watches the SSE stream for the first content delta.
 *
 * The gateway sends `message_start` and `ping` frames before any token, so the
 * first BYTE is not the first TOKEN — the difference between the two is exactly
 * the wait a user feels.
 */
export function createFirstTokenWatcher(onFirstToken: () => void): (chunk: string) => void {
  let seen = false;
  return (chunk: string) => {
    if (seen) return;
    if (chunk.includes('"type":"content_block_delta"') || chunk.includes('"type": "content_block_delta"')) {
      seen = true;
      onFirstToken();
    }
  };
}

/** A failed sample that never reached the network; every connection leg is "not measured". */
export function unwiredSample(
  id: string,
  at: string,
  input: ApiLatencyProbeInput,
  model: string,
  requestBytes: number,
  error: string,
): ApiLatencyProbeResult {
  return {
    id,
    at,
    ok: false,
    mode: input.mode,
    stream: input.stream,
    model,
    transport: 'fresh',
    status: null,
    requestBytes,
    responseBytes: 0,
    timings: {
      dnsMs: null,
      tcpMs: null,
      tlsMs: null,
      uploadMs: 0,
      firstByteMs: 0,
      downloadMs: 0,
      totalMs: 0,
    },
    firstTokenMs: null,
    error,
  };
}

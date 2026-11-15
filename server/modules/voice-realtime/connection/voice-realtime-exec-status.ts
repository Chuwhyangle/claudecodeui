import { Buffer } from 'node:buffer';

import type {
  VoiceRealtimeExecPhase,
  VoiceRealtimeExecStatus,
  VoiceRealtimeExecStatusPatch,
  VoiceRealtimeExecStatusReading,
  VoiceRealtimePendingInteraction,
  VoiceRealtimeRunDigest,
} from "./voice-realtime-contract.js";

// S-A's execution-status line: the per-connection aggregator and its bounded renderer.


// ---- S-A: the execution-status line (SPEC `voice-realtime-persistent-control-SPEC.md` §8.3) ----

/**
 * The most UTF-8 bytes ONE injected status line may take, marker included (SPEC §8.3's "注入行 ≤
 * 200 字节"). The line is built from bounded, sanitized fields, so this bound is the belt to
 * construction's braces: it holds even if a future field (a tool name, say) grows.
 */
export const VOICE_REALTIME_STATUS_MAX_BYTES = 200;

/**
 * How many status lines ONE run may put on the wire (SPEC §8.3's "总注入次数 ≤ 8 / run"). The eighth
 * is the last: it carries the `(+N more)` marker and then the run is silent until a new run begins.
 * §8.3 registers this as a SAFETY CAP, not an optimum — the per-injection cost was never measured
 * (G-5), so it may only be widened once that reading exists.
 */
export const VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN = 8;

/**
 * The S-A rate window (SPEC §8.3: "最多 1 次 / 2 s"). A change opens the window; everything that
 * changes inside it collapses to the latest reading and none is queued — so a burst of state changes
 * costs one `session.update`, not one each.
 */
export const VOICE_REALTIME_STATUS_RATE_MS = 2000;

/** `setTimeout`'s ceiling. A window configured "infinite" is clamped here rather than wrapping to 1 ms. */
export const VOICE_MAX_TIMER_DELAY_MS = 2_147_483_647;


/**
 * One field of the injected line, sanitized to the alphabet the shape allows and cut to `maxChars`.
 *
 * This is the WHOLE defence against the line carrying something it must not (SPEC §8.4: never a
 * session body, a file path or the user's own words): only `[\w.:-]` survives, so a `runId` that
 * somehow held a path or a sentence comes out as an opaque token — or as `-` when nothing is left.
 */
function voiceStatusField(value: string, maxChars: number): string {
  const kept = value.replace(/[^\w.:-]+/g, '');
  return kept === '' ? '-' : kept.slice(0, maxChars);
}

/**
 * One RunDigest text field, sanitized to the alphabet the injected line allows and cut to `maxChars`.
 *
 * STRICTER THAN {@link voiceStatusField}, and for a reason the digest's own content makes concrete:
 * the `.` that field keeps is exactly what lets a filename through (`…proxy.service.ts`, which §8.4
 * forbids on the line), and a digest summary is the person's own words, so only `[\w:-]` survives
 * here. A CJK sentence, a `/path`, or anything else outside that comes out as `-` — never the words
 * themselves. The line's separate `.ts`/`/`-free assertion is the reading that holds this.
 */
function voiceDigestField(value: string, maxChars: number): string {
  const kept = value.replace(/[^\w:-]+/g, '');
  return kept === '' ? '-' : kept.slice(0, maxChars);
}

/**
 * The RunDigest tail of the status line, or `''` when there is no digest to show.
 *
 * Appended AFTER `ageMs=` so the byte cap eats the digest before it eats the staleness reading (§8.4
 * names `ageMs` the load-bearing one). Deliberately free of `/`, `\`, `.` and CJK — the count:last
 * pairs use `:` rather than `/`, which the line's `queued=<n>/<n>B` field is the only place allowed
 * to carry — so a line this renders is still within the same alphabet the rest of the line is.
 */
function renderRunDigest(digest: VoiceRealtimeRunDigest | null): string {
  if (digest === null) {
    return '';
  }
  const last = (value: string | null, max: number): string => (value === null ? '-' : voiceDigestField(value, max));
  const count = (value: number | null): string => (value === null ? '?' : String(value));
  return (
    ` cov=${digest.covers.count}:${last(digest.covers.last, 12)}` +
    ` qns=${count(digest.queuedNotStarted.count)}:${last(digest.queuedNotStarted.last, 12)}` +
    ` act=${digest.lastCliActivity.tool === null ? '-' : voiceDigestField(digest.lastCliActivity.tool, 16)}` +
    ` fresh=${digest.freshness === null ? '-' : digest.freshness}`
  );
}

/**
 * The run id a `session_send` result names, or `null` when it names none.
 *
 * Read defensively: the result is the executor's own `unknown` (a `queued: true` delivery has no run
 * at all, and the MCP gateway's shape is not this module's to police), so anything that is not a
 * non-empty string is "no run" rather than a guess. `null` is also what a NEW run is detected from —
 * a result that names the same run as last time is the same run, not a restart.
 */
export function runIdOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) {
    return null;
  }
  const runId = (result as { runId?: unknown }).runId;
  return typeof runId === 'string' && runId !== '' ? runId : null;
}

/**
 * Builds the per-connection execution-status aggregator (SPEC §8.2's L3 single source).
 *
 * NOT A POLLER. Every field is folded in from an event the proxy already handles, and nothing here
 * reads the clock except to stamp `at` and to measure `elapsedMs`/`ageMs` at render time — which is
 * what makes the reading a thing that CHANGES rather than a snapshot taken on a schedule.
 *
 * `now` is injectable so a criterion can drive a stale reading deterministically; production takes
 * `Date.now`.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (the connection handler) and
 * `tests/voice-realtime-status-injection.test.ts`.
 */
export function createVoiceRealtimeExecStatus(now: () => number = Date.now): VoiceRealtimeExecStatus {
  let phase: VoiceRealtimeExecPhase = 'idle';
  let runId: string | null = null;
  let runStartedAt: number | null = null;
  let queuedItems = 0;
  let queuedBytes = 0;
  let queuedKnown = true;
  let pendingInteraction: VoiceRealtimePendingInteraction | null = null;
  /**
   * The last digest sample, stamped with the epoch ms it was taken. The stored value carries no
   * `freshness` of its own: it is derived from `sampledAt` at read time, so an unrefreshed sample
   * ages rather than freezing on the number it had when it was folded in.
   */
  let digest: (Omit<VoiceRealtimeRunDigest, 'freshness'> & { sampledAt: number }) | null = null;
  let statusSeq = 0;
  let at = 0;
  /** Whether a run has started or messages wait — before that there is no line at all. */
  let started = false;

  const keyOf = (): string =>
    [phase, runId ?? '-', queuedKnown ? 'k' : '?', queuedItems, queuedBytes, pendingInteraction?.requestId ?? '-'].join(
      '|',
    );
  let currentKey = keyOf();

  const reading = (): VoiceRealtimeExecStatusReading => ({
    phase,
    runId,
    elapsedMs: runStartedAt === null ? 0 : Math.max(0, now() - runStartedAt),
    queuedItems,
    queuedBytes,
    queuedKnown,
    pendingInteraction,
    digest:
      digest === null
        ? null
        : {
            covers: digest.covers,
            queuedNotStarted: digest.queuedNotStarted,
            lastCliActivity: digest.lastCliActivity,
            freshness: Math.max(0, now() - digest.sampledAt),
          },
    statusSeq,
    at,
  });

  const update = (patch: VoiceRealtimeExecStatusPatch): { changed: boolean; newRun: boolean } => {
    const before = currentKey;
    let newRun = false;
    if ('runId' in patch) {
      const next = patch.runId ?? null;
      if (next !== null && next !== runId) {
        newRun = true;
        runStartedAt = now();
      }
      runId = next;
    }
    if (patch.phase !== undefined) phase = patch.phase;
    if (patch.queuedItems !== undefined) queuedItems = Math.max(0, Math.trunc(patch.queuedItems));
    if (patch.queuedBytes !== undefined) queuedBytes = Math.max(0, Math.trunc(patch.queuedBytes));
    if (patch.queuedKnown !== undefined) queuedKnown = patch.queuedKnown;
    if ('pendingInteraction' in patch) pendingInteraction = patch.pendingInteraction ?? null;
    // The digest is folded OUTSIDE the dedup key on purpose: it carries no field `keyOf` reads, so a
    // sample that moves content-with-nothing-else is `changed: false` and arms nothing (@@SPEC §8.3).
    if (patch.digest !== undefined) {
      const prior = digest;
      digest = {
        covers: patch.digest.covers ?? prior?.covers ?? { count: 0, last: null },
        queuedNotStarted: patch.digest.queuedNotStarted ?? prior?.queuedNotStarted ?? { count: null, last: null },
        lastCliActivity: patch.digest.lastCliActivity ?? prior?.lastCliActivity ?? { tool: null },
        sampledAt: now(),
      };
    }
    if (phase !== 'idle' || runId !== null || queuedItems > 0) started = true;

    currentKey = keyOf();
    if (currentKey === before) {
      return { changed: false, newRun };
    }
    statusSeq += 1;
    at = now();
    return { changed: true, newRun };
  };

  const render = (nowMs: number, marker?: { more: number }) => {
    const current = reading();
    if (!started) {
      return { key: '', text: '', reading: current };
    }
    const pending =
      current.pendingInteraction === null
        ? '-'
        : `${voiceStatusField(current.pendingInteraction.requestId, 12)}/${voiceStatusField(
            current.pendingInteraction.toolName,
            16,
          )}`;
    // A depth with no readable CLI term is stated as unknown, not as the L3-only number it would
    // otherwise print: "queued=0/0B" while the session holds messages is the exact lie §18.5 names.
    const queueReading =
      current.queuedKnown === false
        ? 'queued=unknown'
        : `queued=${current.queuedItems}/${current.queuedBytes}B`;
    const body =
      `[exec] phase=${current.phase} run=${current.runId === null ? '-' : voiceStatusField(current.runId, 16)}` +
      ` statusSeq=${current.statusSeq} elapsed=${Math.round(current.elapsedMs / 1000)}s ${queueReading}` +
      ` pending=${pending} at=${current.at} ageMs=${Math.max(0, nowMs - current.at)}` +
      renderRunDigest(current.digest);
    // The marker is appended AFTER the cap is applied to the body, not inside it: the cap notice is
    // the last thing a run says, so it is the one thing that must survive the byte bound. Measured in
    // bytes so the two halves together are still ≤ {@link VOICE_REALTIME_STATUS_MAX_BYTES}.
    const markerText = marker === undefined ? '' : ` (+${marker.more} more)`;
    const bodyCap = VOICE_REALTIME_STATUS_MAX_BYTES - Buffer.byteLength(markerText, 'utf8');
    let text = body;
    if (Buffer.byteLength(text, 'utf8') > bodyCap) {
      text = Buffer.from(text, 'utf8').subarray(0, Math.max(0, bodyCap)).toString('utf8');
    }
    text += markerText;
    return { key: currentKey, text, reading: current };
  };

  return { hasState: () => started, key: () => currentKey, reading, update, render };
}

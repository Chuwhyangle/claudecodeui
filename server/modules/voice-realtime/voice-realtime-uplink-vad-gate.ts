// The streaming head-keep gate (scheme §5) and the exit path's order (scheme §6.3).
//
// WHY THIS IS ITS OWN FILE. The grid, the classifier and the verdict vocabulary live in the pure module
// beside it (`voice-realtime-uplink-vad.ts`), which is contractually ALLOCATION-FREE and reaches for no
// production path — its criterion greps that module for a `Buffer.from(` call site and requires zero.
// The streaming gate cannot live there: it decodes one browser frame back to PCM to feed the classifier,
// so it allocates. Splitting the two keeps the classifier's contract readable as a contract, and it
// mirrors the STS gate beside it (`voice-realtime-silence-tail.ts`) — the other standalone file that owns
// its own base64 decode for exactly this reason.
//
// Consumers: `voice-realtime-ws-proxy.service.ts` (the continuous audio branch and the exit path), and
// this module's seam criterion.

import {
  UPLINK_VAD_FRAME_BYTES,
  UPLINK_VAD_GRID,
  UplinkVadGridError,
  bypassedVerdict,
  type UplinkVadClassifier,
  type UplinkVadFrameVerdict,
} from './voice-realtime-uplink-vad.js';

// ── the head-keep streaming gate (scheme §5) ──────────────────────────────────────────────────────
//
// WHAT `applyUplinkVadMask` IS NOT. That function masks a WHOLE clip against a WHOLE verdict array —
// the batch reading an offline study takes. The relay has neither: frames arrive one at a time from the
// browser, and the two windowed backends answer LATE (see the file header), so a streaming caller cannot
// zip a frame against a verdict that does not exist yet. This section is the streaming form of §5's
// three rules, and it is the surface the production seam (`voice-realtime-ws-proxy.service.ts`) drives.
//
// WHY THE GATE BUFFERS. A verdict for grid frame `k` arrives zero-to-two frames after frame `k` was
// pushed, and the rules are PER-FRAME-CAUSAL (`seenSpeech`, and how far into the non-speech segment we
// are), so no frame may be emitted until every frame before it is final. The gate therefore holds the
// frames whose verdicts are still pending, and emits the contiguous run from the head each time a
// verdict lets it — which is what keeps the emitted stream in the browser's own frame order.

/** The grid's frame duration in milliseconds — the one time quantum §2 uses. */
export const UPLINK_VAD_FRAME_MS = UPLINK_VAD_GRID.frameMs;

/**
 * The `+1` in `a = silence_duration_ms + 1 frame`.
 *
 * The shipped `silence_duration_ms` (400) sits exactly on the upstream `server_vad`'s `>=` closure
 * boundary, so the extra frame is boundary insurance, not a measured requirement — §10's sweep found a
 * minimum reliable `a` at `≤ 400 ms`. Kept named rather than folded into the arithmetic so the reason
 * survives a reader who wonders why it is not simply `silence_duration_ms / 20`.
 */
export const UPLINK_VAD_HEAD_BOUNDARY_FRAMES = 1;

/**
 * Derives the head-keep window `a`, in FRAMES, from the RESOLVED `turn_detection.silence_duration_ms`.
 *
 * ⛔ MUST be derived from the resolved value and never hard-coded: `voice-realtime-turn-detection.ts` is
 * the single source of that number, and a deployment that sets
 * `VOICE_REALTIME_TURN_DETECTION_SILENCE_MS=800` must move this window with it (the criterion's false
 * form pins exactly this by writing a literal and watching the window stop following).
 */
export function uplinkHeadKeepFrames(
  silenceDurationMs: number,
  frameMs: number = UPLINK_VAD_FRAME_MS,
): number {
  return Math.round(silenceDurationMs / frameMs) + UPLINK_VAD_HEAD_BOUNDARY_FRAMES;
}

/**
 * What the gate decided for one frame.
 *
 * `send-real` and `send-head-kept` put the SAME bytes on the wire — they are two names for one action,
 * kept apart only so the log can say how many frames the head-keep rule paid for rather than reporting
 * a single opaque "sent" count.
 */
export type UplinkVadGateAction =
  /** A judged-speech frame (or one the mask kept), forwarded as it arrived. */
  | 'send-real'
  /** A frame inside a non-speech segment's opening `a` window, forwarded as it arrived. */
  | 'send-head-kept'
  /** Dropped: a first-segment frame, or a non-speech frame past the `a` window. */
  | 'drop';

/** The gate's cumulative readings, for the one line a connection logs. */
export type UplinkVadGateStats = {
  /** Frames the gate let cross the wire. */
  sent: number;
  /** Of those, the ones a non-speech segment's opening `a` window paid for. */
  headKept: number;
  /** Frames the gate withheld. */
  dropped: number;
  /** Frame verdicts that came from NO model — an unavailable backend, or a frame never judged. */
  bypassed: number;
};

/** The frames one `observe`/`flush` call lets cross the wire, in order, plus the cumulative readings. */
export type UplinkVadGateDecision = { frames: string[] } & UplinkVadGateStats;

/** How a gate is built. Both fields are required: `a` is never defaulted, it is derived or supplied. */
export type UplinkVadGateOptions = {
  /** The per-stream classifier. Stateful, so ONE belongs to one connection's gate (see the module header). */
  classifier: UplinkVadClassifier;
  /** The RESOLVED `turn_detection.silence_duration_ms` `a` is derived from. */
  silenceDurationMs: number;
};

/**
 * One connection's gate: the streaming form of §5, buffering frames whose verdicts have not landed.
 *
 * Cheap in the default deployment, because a connection without the seam never builds one (the proxy's
 * `uplinkVad === null` fast path) — the state here is only ever allocated for a connection that asked
 * for the gate.
 */
export type UplinkVadGate = {
  /** The head-keep window, in frames — `a` for the resolved silence duration. Exposed for the log/reading. */
  readonly aFrames: number;
  /** Whether any speech frame has been judged yet; the first-segment rule keys on it. */
  readonly seenSpeech: boolean;
  /**
   * Feeds one browser frame and returns every frame that has become emittable BECAUSE of it.
   *
   * The frames returned are not necessarily THIS frame's: the lagging backends settle an EARLIER frame
   * here, and the gate emits the contiguous final run from its head. A caller therefore forwards
   * whatever comes back, in order, and need not know which frame settled.
   */
  observe(audio: string): Promise<UplinkVadGateDecision>;
  /** Ends the stream: judges every frame still pending (bypassed, if too late) and returns the tail. */
  flush(): Promise<UplinkVadGateDecision>;
  /** Releases the classifier's session. Idempotent. */
  close(): Promise<void>;
};

/** One browser frame held until its verdict is final, carrying the caller's own payload untouched. */
type PendingFrame = { audio: string; verdict: UplinkVadFrameVerdict | null };

/**
 * Decodes one browser frame to grid PCM, or reports that it is not one.
 *
 * `null` is the honest reading for anything not exactly one grid frame — empty, non-base64, or a
 * different length. Such a frame is forwarded UNJUDGED by {@link createUplinkVadGate.observe} and never
 * fed to the classifier, because the classifier's frame counter and this gate's index space would
 * otherwise diverge and every later verdict would be attributed to the wrong audio.
 */
function decodeUplinkVadFrame(audio: string): Buffer | null {
  if (audio.length === 0) {
    return null;
  }
  const pcm = Buffer.from(audio, 'base64');
  return pcm.length === UPLINK_VAD_FRAME_BYTES ? pcm : null;
}

/**
 * Builds one connection's head-keep gate (scheme §5), driven by the classifier that was handed in.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (the continuous audio branch and the exit path), and
 * this module's seam criterion. The three rules are implemented EXACTLY as §5 states them, and the two
 * properties the scheme calls structural — no synthesis, and the first-segment drop — are properties of
 * this loop rather than promises about it: no branch here builds a frame (`frame.audio` is the caller's
 * own base64) and the first-segment arm returns `'drop'` before the `a` window is ever consulted.
 */
export function createUplinkVadGate(options: UplinkVadGateOptions): UplinkVadGate {
  const aFrames = uplinkHeadKeepFrames(options.silenceDurationMs);
  const classifier = options.classifier;
  /** Frames held until their verdict is final, oldest first. `baseIndex` is `pending[0]`'s grid index. */
  const pending: PendingFrame[] = [];
  let baseIndex = 0;
  /** The causal state: whether a speech frame has been seen, and how far into the current quiet run. */
  let seenSpeech = false;
  let nonSpeechRunIndex = 0;
  const stats: UplinkVadGateStats = { sent: 0, headKept: 0, dropped: 0, bypassed: 0 };
  let closed = false;

  /** Files one final verdict against the pending frame it names. */
  const assign = (verdict: UplinkVadFrameVerdict): void => {
    const slot = verdict.frameIndex - baseIndex;
    if (slot < 0 || slot >= pending.length) {
      // A verdict for a frame already emitted (or one this gate never held) — ignored rather than
      // crashing, so a classifier that re-answers cannot take the relay down.
      return;
    }
    pending[slot]!.verdict = verdict;
  };

  /** Emits every frame from the head whose verdict is final, stepping the causal state as it goes. */
  const drain = (): UplinkVadGateDecision => {
    const frames: string[] = [];
    let emitted = 0;
    while (emitted < pending.length) {
      const frame = pending[emitted] as PendingFrame;
      const verdict = frame.verdict;
      if (verdict === null) {
        break; // The lag: nothing beyond an unknown frame is final, so the run stops here.
      }
      // FAIL-OPEN: a bypassed verdict (an unavailable backend, or a frame never judged) counts as
      // speech, so the frame crosses — the one direction a VAD must never get wrong.
      const speech = verdict.bypassed || verdict.speech;
      let action: UplinkVadGateAction;
      if (speech) {
        seenSpeech = true;
        nonSpeechRunIndex = 0;
        action = 'send-real';
      } else if (!seenSpeech) {
        action = 'drop'; // §5.1: the first non-speech segment, before any speech, is dropped whole.
      } else {
        const inHead = nonSpeechRunIndex < aFrames;
        nonSpeechRunIndex += 1;
        action = inHead ? 'send-head-kept' : 'drop';
      }
      if (verdict.bypassed) {
        stats.bypassed += 1;
      }
      if (action === 'drop') {
        stats.dropped += 1;
      } else {
        if (action === 'send-head-kept') {
          stats.headKept += 1;
        }
        stats.sent += 1;
        frames.push(frame.audio); // The caller's OWN base64 — never re-encoded, never synthesized.
      }
      emitted += 1;
    }
    if (emitted > 0) {
      pending.splice(0, emitted);
      baseIndex += emitted;
    }
    return { frames, ...stats };
  };

  return {
    get aFrames(): number {
      return aFrames;
    },
    get seenSpeech(): boolean {
      return seenSpeech;
    },

    async observe(audio: string): Promise<UplinkVadGateDecision> {
      const pcm = decodeUplinkVadFrame(audio);
      if (pcm === null) {
        // Unjudgeable audio is the identity relay's frame: forwarded as it arrived, and kept out of the
        // index space entirely so a later verdict cannot be attributed to the wrong frame.
        stats.sent += 1;
        return { frames: [audio], ...stats };
      }
      // Pushed BEFORE `classify`, because the WebRTC backend settles this very frame immediately and
      // `assign` needs the slot to exist. The proxy serialises `observe`, so the last push is always
      // this frame and the catch below can pop it.
      pending.push({ audio, verdict: null });
      let verdict: UplinkVadFrameVerdict | null = null;
      try {
        verdict = await classifier.classify(pcm);
      } catch (error) {
        if (error instanceof UplinkVadGridError) {
          // The decoder said grid and the classifier disagreed — a divergence, so the frame is
          // forwarded unjudged rather than dropped, and the slot is removed so the index space holds.
          pending.pop();
          stats.sent += 1;
          return { frames: [audio], ...stats };
        }
        throw error;
      }
      if (verdict !== null) {
        assign(verdict);
      }
      return drain();
    },

    async flush(): Promise<UplinkVadGateDecision> {
      const tail = await classifier.flush();
      for (const verdict of tail) {
        assign(verdict);
      }
      // Whatever is still pending was never judged by any window: bypass it HERE, in frame order, rather
      // than leaving a `null` the drain loop would stop on forever.
      for (let slot = 0; slot < pending.length; slot += 1) {
        if ((pending[slot] as PendingFrame).verdict === null) {
          (pending[slot] as PendingFrame).verdict = bypassedVerdict(
            baseIndex + slot,
            'the stream ended before any window covering this frame was run, so it is left unjudged ' +
              'rather than zero-padded',
          );
        }
      }
      return drain();
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await classifier.close();
    },
  };
}

// ── the exit path's ORDER (scheme §6.3) ───────────────────────────────────────────────────────────
//
// The exit sequence itself lives in the proxy (it has the transport and the sockets). What lives here
// is the ORDER that sequence must have, as a pure predicate, so the criterion can read it off an
// observed event sequence and so the false form — closing without the commit pair — is one call away
// from red.

/**
 * The steps the exit path takes, in the order §6.3 requires.
 *
 * `bounded-wait` sends nothing — it is the wait for the endpoint's own `committed`/transcription before
 * the socket goes — but it is a step in the sequence because omitting it is exactly the defect §6.3
 * names ("裸 commit + 立即关闭会丢掉刚 flush 出来的回答").
 */
export const UPLINK_VAD_EXIT_STEPS = [
  'input_audio_buffer.commit',
  'response.create',
  'bounded-wait',
  'socket-close',
] as const;

export type UplinkVadExitStep = (typeof UPLINK_VAD_EXIT_STEPS)[number];

/**
 * Whether an OBSERVED step sequence is in §6.3's order: every step that appears must appear in the
 * canonical relative order. Steps may be ABSENT — the false form has only `socket-close` — but they may
 * never be out of order, so `socket-close` before `response.create` reads as false here.
 */
export function uplinkVadExitIsWellFormed(observed: readonly string[]): boolean {
  let cursor = -1;
  for (const step of observed) {
    const at = UPLINK_VAD_EXIT_STEPS.indexOf(step as UplinkVadExitStep);
    if (at === -1 || at < cursor) {
      return false;
    }
    cursor = at;
  }
  return true;
}

/**
 * Whether an observed sequence is the COMPLETE exit: both the commit and the `response.create` are
 * present, and both precede the socket close. This is §6.3's 正常形态; the false form (a bare close)
 * fails it.
 */
export function uplinkVadExitHasCommitAndResponse(observed: readonly string[]): boolean {
  if (!uplinkVadExitIsWellFormed(observed)) {
    return false;
  }
  const commit = observed.indexOf('input_audio_buffer.commit');
  const response = observed.indexOf('response.create');
  const close = observed.indexOf('socket-close');
  return commit !== -1 && response !== -1 && close !== -1 && commit < response && response < close;
}

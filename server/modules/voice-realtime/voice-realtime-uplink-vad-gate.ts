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
// three rules — plus the pre-roll that repairs the onset those rules would otherwise clip — and it is the
// surface the production seam (`voice-realtime-ws-proxy.service.ts`) drives.
//
// WHY THE GATE BUFFERS. A verdict for grid frame `k` arrives zero-to-two frames after frame `k` was
// pushed, and the rules are PER-FRAME-CAUSAL (`seenSpeech`, and how far into the non-speech segment we
// are), so no frame may be emitted until every frame before it is final. The gate therefore holds the
// frames whose verdicts are still pending, and emits the contiguous run from the head each time a
// verdict lets it — which is what keeps the emitted stream in the browser's own frame order.
//
// THE ONSET DEFECT THE PRE-ROLL REPAIRS. Because the classifier answers late, a syllable's first frames
// are judged against windows that do not yet cover it and come back non-speech; §5 then drops them, and
// the onset is clipped by however many frames the classifier was behind. The 2026-10-14 evening
// measurement found onsets clipped by 80–100 ms. See {@link UPLINK_VAD_PRE_ROLL_MS}.

/** The grid's frame duration in milliseconds — the one time quantum §2 uses. */
export const UPLINK_VAD_FRAME_MS = UPLINK_VAD_GRID.frameMs;

/**
 * The `+1` in `a = silence_duration_ms + 1 frame`.
 *
 * The shipped `silence_duration_ms` sat exactly on the upstream `server_vad`'s `>=` closure boundary when
 * the gate landed, so the extra frame was boundary insurance, not a measured requirement — §10's sweep
 * found a minimum reliable `a` at `≤ 400 ms`. Kept named rather than folded into the arithmetic so the
 * reason survives a reader who wonders why it is not simply `silence_duration_ms / 20`.
 *
 * RE-CHECKED AGAINST THE 800 ms SHIPPED WINDOW (2026-10-15, the fragment-hold task). It is still
 * insurance and still `1`: the closure no longer rests on it at all, because the 200 ms
 * {@link UPLINK_VAD_TAIL_MARGIN_MS} already puts `a` a whole margin PAST the upstream's window
 * (51 frames = 1020 ms against a 800 ms silence). The frame is kept because removing it would move `a`
 * below the platform's own boundary by 20 ms for no gain, and because `a` must stay `> silence` by
 * construction — see {@link uplinkHeadKeepFrames}.
 */
export const UPLINK_VAD_HEAD_BOUNDARY_FRAMES = 1;

/**
 * The shipped pre-roll window `P`, in MILLISECONDS — how far back an onset reaches for frames the gate
 * had already dropped.
 *
 * WHY THE RULE EXISTS. The classifier answers LATE (see the module header), so the frame it first calls
 * speech is a few frames after the syllable actually began; without a pre-roll those leading frames —
 * judged non-speech and dropped — are gone, and the onset is clipped. The 2026-10-14 evening measurement
 * (`experiments/voice-uplink-vad-preroll-replay`, connection `af12cbaf-…`) found three onsets clipped by
 * 80–100 ms. 200 ms covers the measured clipping with headroom while costing, over that recording's 31
 * onsets, about +9% of the frames already sent.
 *
 * Kept as MILLISECONDS and derived to frames by {@link uplinkPreRollFrames}, exactly as `a` is: the
 * frame arithmetic follows the time budget rather than being frozen to it.
 */
export const UPLINK_VAD_PRE_ROLL_MS = 200;

/**
 * Derives the pre-roll window `P`, in FRAMES, from a millisecond budget.
 *
 * `Math.round` rather than a floor for the same reason {@link uplinkHeadKeepFrames} rounds: a deployment
 * that sets a budget between frame boundaries gets the nearer whole frame, not a silently truncated one.
 * `0` is meaningful and returns `0` — a deployment that wants the pre-existing behaviour (no replay) sets
 * it to zero, and the gate then buffers nothing.
 */
export function uplinkPreRollFrames(
  preRollMs: number,
  frameMs: number = UPLINK_VAD_FRAME_MS,
): number {
  return Math.round(preRollMs / frameMs);
}

/**
 * Extra kept tail, in MILLISECONDS, on top of the silence window.
 *
 * The upstream `server_vad` hears much of what silero calls non-speech (breath, room noise) as speech, so
 * a tail of exactly `silence_duration_ms` often leaves the turn open until the NEXT utterance's pre-roll
 * closes it — and a turn closed that late is never answered, so its words are never relayed. Replaying 37
 * recorded utterances against the real upstream (`experiments/voice-realtime-stop-latency`, 2026-10-14):
 * a 420 ms tail closed 28/37 within 8 s, a 620 ms tail 36/37. Padding with digital zeros instead closed
 * only 16/37, so the margin must be real audio.
 */
const UPLINK_VAD_TAIL_MARGIN_MS = 200;

/**
 * Derives the head-keep window `a`, in FRAMES, from the RESOLVED `turn_detection.silence_duration_ms`
 * plus {@link UPLINK_VAD_TAIL_MARGIN_MS}.
 *
 * ⛔ MUST be derived from the resolved value and never hard-coded: `voice-realtime-turn-detection.ts` is
 * the single source of that number, and a deployment that sets
 * `VOICE_REALTIME_TURN_DETECTION_SILENCE_MS=800` must move this window with it (the criterion's false
 * form pins exactly this by writing a literal and watching the window stop following).
 *
 * ⛔ AND THE WINDOW GETS NO KNOB OF ITS OWN — the 2026-10-15 ruling, re-made when the shipped silence
 * window moved 400 → 800 (`gap-live-voice-turn-detection-silence-in-settings-file-default-800`). There
 * was a moment when "the tail and the silence window might want to be tuned separately" looked
 * reasonable; it is not, for three reasons, and this is where they live so the next person who wants the
 * knob has to delete this paragraph on purpose:
 *
 *   ① The `+1` boundary frame in `a` was INSURANCE AGAINST the upstream's `>=` closure semantics
 *      ({@link UPLINK_VAD_HEAD_BOUNDARY_FRAMES}). A second, independent tail knob would silently move the
 *      relationship it insures — the margin would stop being derived from the number it must exceed, and
 *      the next person to change the silence window would have to know to change the tail too. Moving the
 *      shipped window to 800 is exactly the case that would have gone wrong: `a` must follow to 51.
 *   ② An independent knob admits INCONSISTENT combinations — a tail that is not `silence + margin` — and
 *      the inconsistent form is the one §5's scheme records as the failure mode: when the kept tail is
 *      exactly the silence window the turn stays open until the NEXT utterance's pre-roll closes it, and
 *      a turn closed that late is never answered, so its words are never relayed (see
 *      {@link UPLINK_VAD_TAIL_MARGIN_MS}).
 *   ③ The derived value is SELF-CONSISTENT at 800, so there is nothing to tune: `a = round(1000/20) + 1
 *      = 51` frames, and the hold-open cap stays above it ({@link UPLINK_VAD_HOLD_OPEN_MAX_MS} → 100
 *      frames, so the hold is still enabled and still bounded). The 400 → 800 move needed no second
 *      number.
 *
 * The delivery form is therefore VERIFY + PIN, not a new option: the criterion asserts the derived
 * readings (`uplinkHeadKeepFrames(800) === 51`, `uplinkHeadKeepFrames(400) === 31`), so anyone adding a
 * separate knob has to delete those assertions first.
 */
export function uplinkHeadKeepFrames(
  silenceDurationMs: number,
  frameMs: number = UPLINK_VAD_FRAME_MS,
): number {
  return Math.round((silenceDurationMs + UPLINK_VAD_TAIL_MARGIN_MS) / frameMs) + UPLINK_VAD_HEAD_BOUNDARY_FRAMES;
}

/**
 * The longest a non-speech run may keep crossing the wire, in MILLISECONDS, while the upstream says its
 * turn is still open — `a` included.
 *
 * WHY. A fixed tail cannot be long enough: the upstream `server_vad` hears part of any real tail as
 * speech, and once the gate stops sending, the upstream's audio clock stops with it, so the turn stays
 * open until the next utterance arrives (live test 2026-10-15, connection 73f2622b: a ~3 s sentence
 * closed 16 s after it began). Past `a` the gate therefore keeps forwarding real audio for as long as
 * the upstream's turn is open, and at this cap asks the relay to commit the turn itself. Extra audio is
 * paid only while the upstream has not closed; the cap bounds both the cost and the worst-case delay.
 */
export const UPLINK_VAD_HOLD_OPEN_MAX_MS = 2_000;

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
  /** A non-speech frame past `a`, forwarded because the upstream's turn is still open (below the cap). */
  | 'send-held-open'
  /** Dropped: a first-segment frame, or a non-speech frame past the `a` window. */
  | 'drop';

/** The gate's cumulative readings, for the one line a connection logs. */
export type UplinkVadGateStats = {
  /** Frames the gate let cross the wire, INCLUDING the ones the pre-roll replayed (see `preRoll`). */
  sent: number;
  /** Of those, the ones a non-speech segment's opening `a` window paid for. */
  headKept: number;
  /** Of those, the ones sent past `a` because the upstream's turn was still open — the hold's cost. */
  heldOpen: number;
  /** Frames the gate withheld — the dropped frames no pre-roll reached back for. */
  dropped: number;
  /** Frame verdicts that came from NO model — an unavailable backend, or a frame never judged. */
  bypassed: number;
  /**
   * Of `sent`, the frames the PRE-ROLL replayed from the discarded tail of a non-speech run, emitted
   * just before the onset that ended it. A `preRoll` frame was withheld when the drain judged it and
   * crosses here instead, so it counts in `sent` and NOT in `dropped`: `sent + dropped` still partitions
   * the judged frames, and the count agrees with the byte accounting (`droppedBytes = In − Out`).
   */
  preRoll: number;
};

/**
 * The frames one `observe`/`flush` call lets cross the wire, in order, plus the cumulative readings.
 *
 * `closeTurn` is `true` on the one call whose drain reached the hold-open cap with the upstream's turn
 * still open: the caller then commits the turn (`input_audio_buffer.commit` + `response.create`).
 */
export type UplinkVadGateDecision = { frames: string[]; closeTurn: boolean } & UplinkVadGateStats;

/** How a gate is built. `a` is never defaulted, it is derived or supplied; `P` defaults to the shipped budget. */
export type UplinkVadGateOptions = {
  /** The per-stream classifier. Stateful, so ONE belongs to one connection's gate (see the module header). */
  classifier: UplinkVadClassifier;
  /** The RESOLVED `turn_detection.silence_duration_ms` `a` is derived from. */
  silenceDurationMs: number;
  /**
   * The pre-roll budget, in MILLISECONDS, {@link uplinkPreRollFrames} derives `P` from. Defaults to
   * {@link UPLINK_VAD_PRE_ROLL_MS}; `0` turns the pre-roll off entirely (no ring, no replay).
   */
  preRollMs?: number;
  /**
   * The hold-open cap, in MILLISECONDS — see {@link UPLINK_VAD_HOLD_OPEN_MAX_MS}, the default. A cap at
   * or below `a` turns the hold off: the gate keeps exactly `a` and never asks for a close.
   */
  holdOpenMaxMs?: number;
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
  /** The pre-roll window, in frames — `P`. `0` when the pre-roll is turned off. Exposed for the reading. */
  readonly preRollFrames: number;
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
  /**
   * The upstream opened (`speech_started`) or closed (`speech_stopped`/`committed`) its turn. Read at
   * drain time, so it governs every quiet frame drained after it.
   */
  noteUpstreamTurn(open: boolean): void;
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
 * this module's seam criterion. The three §5 rules are implemented EXACTLY as §5 states them, and the two
 * properties the scheme calls structural — no synthesis, and the first-segment drop — remain properties of
 * this loop rather than promises about it: no branch here builds a frame (`frame.audio` is the caller's
 * own base64, including every pre-roll frame) and the first-segment arm returns `'drop'` before the `a`
 * window is ever consulted.
 *
 * THE PRE-ROLL (added 2026-10-14; see the defect in the module header). A dropped frame is not discarded
 * outright: the last `P` of them are kept in a ring, and when a speech frame follows a dropped one the ring
 * is replayed, in arrival order, immediately before it — the classifier's lag is what clipped the onset.
 * The ring is CLEARED on every send, so it can only ever hold the dropped tail of the run that ends AT the
 * onset: a gap shorter than `a + P` replays only what was actually dropped (never a frame that already
 * crossed as head-keep), and a frame is never replayed twice.
 */
export function createUplinkVadGate(options: UplinkVadGateOptions): UplinkVadGate {
  const aFrames = uplinkHeadKeepFrames(options.silenceDurationMs);
  const preRollFrames = uplinkPreRollFrames(options.preRollMs ?? UPLINK_VAD_PRE_ROLL_MS);
  const holdOpenFrames = Math.round((options.holdOpenMaxMs ?? UPLINK_VAD_HOLD_OPEN_MAX_MS) / UPLINK_VAD_FRAME_MS);
  const holdOpenEnabled = holdOpenFrames > aFrames;
  let upstreamTurnOpen = false;
  /** Whether the current quiet run already asked for a close; re-armed by the next speech frame. */
  let closeRequested = false;
  const classifier = options.classifier;
  /** Frames held until their verdict is final, oldest first. `baseIndex` is `pending[0]`'s grid index. */
  const pending: PendingFrame[] = [];
  let baseIndex = 0;
  /** The causal state: whether a speech frame has been seen, and how far into the current quiet run. */
  let seenSpeech = false;
  let nonSpeechRunIndex = 0;
  /**
   * The last `P` DROPPED frames, in arrival order — the pre-roll ring. It is cleared on every send, so it
   * holds only the dropped tail of the run ending at the next onset (and never a head-kept frame). The
   * entries are the caller's own payloads; nothing here re-encodes or synthesizes.
   */
  const preRollRing: string[] = [];
  const stats: UplinkVadGateStats = { sent: 0, headKept: 0, heldOpen: 0, dropped: 0, bypassed: 0, preRoll: 0 };
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
    let closeTurn = false;
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
        closeRequested = false;
        action = 'send-real';
      } else if (!seenSpeech) {
        action = 'drop'; // §5.1: the first non-speech segment, before any speech, is dropped whole.
      } else {
        const runIndex = nonSpeechRunIndex;
        nonSpeechRunIndex += 1;
        if (runIndex < aFrames) {
          action = 'send-head-kept';
        } else if (holdOpenEnabled && upstreamTurnOpen && runIndex < holdOpenFrames) {
          action = 'send-held-open';
        } else {
          action = 'drop';
          if (holdOpenEnabled && upstreamTurnOpen && !closeRequested) {
            closeRequested = true;
            closeTurn = true;
          }
        }
      }
      if (verdict.bypassed) {
        stats.bypassed += 1;
      }
      if (action === 'drop') {
        stats.dropped += 1;
        // Keep the dropped frame for a possible pre-roll, capped at `P` (the ring never grows past it).
        if (preRollFrames > 0) {
          preRollRing.push(frame.audio);
          if (preRollRing.length > preRollFrames) {
            preRollRing.shift();
          }
        }
      } else {
        // THE PRE-ROLL: an onset that follows dropped frames replays them first, oldest first. This is
        // the only place a frame crosses the wire out of the order the drain reached it, and it is still
        // the browser's order — every ring entry arrived before {@link frame} and after the last send.
        // A replayed frame MOVES from `dropped` to `sent`: it was withheld when the drain judged it and
        // it crosses now, so `sent + dropped` still partitions the judged frames and the count agrees
        // with the byte accounting (`droppedBytes = In − Out`). `preRoll` is the breakdown of how much
        // of `sent` the repair paid for.
        if (action === 'send-real' && preRollRing.length > 0) {
          for (const replayed of preRollRing) {
            stats.dropped -= 1;
            stats.sent += 1;
            stats.preRoll += 1;
            frames.push(replayed);
          }
        }
        // Every send clears the ring: a head-kept frame was never dropped, so it must never be replayed,
        // and the run the ring was tracking is over.
        preRollRing.length = 0;
        if (action === 'send-head-kept') {
          stats.headKept += 1;
        } else if (action === 'send-held-open') {
          stats.heldOpen += 1;
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
    return { frames, closeTurn, ...stats };
  };

  return {
    get aFrames(): number {
      return aFrames;
    },
    get preRollFrames(): number {
      return preRollFrames;
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
        return { frames: [audio], closeTurn: false, ...stats };
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
          return { frames: [audio], closeTurn: false, ...stats };
        }
        throw error;
      }
      if (verdict !== null) {
        assign(verdict);
      }
      return drain();
    },

    noteUpstreamTurn(open: boolean): void {
      upstreamTurnOpen = open;
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

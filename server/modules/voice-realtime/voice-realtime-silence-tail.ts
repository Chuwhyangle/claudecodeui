/**
 * Silence Tail Suppression (STS): the upload state machine that stops putting an idle
 * microphone's silence on the wire, in continuous mode only.
 *
 * WHY THIS EXISTS. The continuous wire uploads the RAW microphone — silence included — because the
 * endpoint's own `server_vad` is the only thing that can end an utterance there, and it ends one by
 * hearing silence. The cost is the microphone's every quiet second. Measured on the AC-363 probe
 * (`docs/operations/voice-realtime-silence-tail-suppression-probe.md`, V-8): 25.4 s of uplink for a
 * 34.5 s session — of which 43.4 % was audio the endpoint never needed.
 *
 * WHY SUPPRESSION IS A STATE MACHINE AND NOT A FILTER. Silence cannot simply be dropped: the endpoint
 * measures its silence threshold ON THE AUDIO IT RECEIVED (AC-363 V-1: the time base is AUDIO-time —
 * every trigger happened at or below the number of silence milliseconds actually sent, never past
 * it), so a client that stops transmitting does not "give" the endpoint silence, it gives it nothing
 * and the turn never closes. So every suppression must pay for itself twice:
 *
 *     streaming  →  tail(T)  →  suppressed  →  streaming
 *                    │              │              │
 *     forward every  │  T ms of the │  stop; hold    │  flush the pre-roll P, then
 *     frame          │  REAL noise  │  the pre-roll  │  forward frame by frame again
 *
 * The `tail` is what closes the turn upward: T ms of the microphone's own noise, which the endpoint
 * counts as silence and cuts on. The pre-roll is what keeps the next utterance whole: the frames
 * withheld while suppressed are still available when speech returns, so the endpoint hears the
 * first syllable and not the second.
 *
 * WHY THE DETECTOR IS DELIBERATELY BIASED TOWARD SPEECH. Misjudging silence is a CORRECTNESS defect
 * — the user's words are dropped, upstream, where no retry can recover them. Misjudging speech is a
 * COST defect — silence is uploaded that did not need to be. Every threshold below is therefore set
 * to fire LATER than the truth, never earlier (decision doc §10.4 S-5: 误判静音率 = 0 is the hard
 * requirement; 误判语音率 is recorded only).
 *
 * WHY IT IS SWITCHABLE AND OFF BY DEFAULT. Decision doc §10.5 H-S2: until the AC-363 readings support
 * S-1/S-3/S-4 the feature stays off, and turning it on is a person's decision. With
 * {@link SILENCE_TAIL_ENV} unset the proxy never builds a gate and the continuous wire forwards
 * exactly the frames it forwarded before this module existed (§10.4 S-6).
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts`, which builds one gate per continuous connection and
 * forwards whatever it returns; `server/index.ts`, which resolves the switch; and this module's
 * criterion (`tests/voice-realtime-silence-tail-suppression.test.ts`).
 */

// ── parameters (decision doc §10.4 S-7: every default cites the AC-363 reading it came from) ──────

/**
 * `T` — how much of the microphone's REAL noise still crosses the wire after an utterance ends.
 *
 * AC-363 V-1's frame-boundary scan (D = 400 ms, synthetic noise) is the reading: 400 ms of real
 * silence did NOT trigger `speech_stopped`, 500 ms did. The report's `T 推荐` takes the smallest of
 * its `{1, 2, 3} s` candidates that clears that 500 ms lower bound with margin, and this is it —
 * `T = 1 s`, i.e. 2× the measured boundary.
 */
export const DEFAULT_SILENCE_TAIL_MS = 1_000;

/**
 * `P` — how much audio before a resumed utterance is held and replayed, so the first syllable is not
 * the casualty of the frame that resumed the stream.
 *
 * AC-363's `P 推荐` reads **不足以推荐** ("not enough to recommend one"): the V-3 arm ran P = 500 ms
 * and could not distinguish `{300, 500, 800} ms`. 500 ms is therefore the probe's own arm value, NOT
 * a reading-backed optimum — it is recorded here as such so nobody later mistakes it for one.
 */
export const DEFAULT_SILENCE_TAIL_PREROLL_MS = 500;

/**
 * How long the upstream may go without receiving anything before this gate writes one keepalive.
 *
 * AC-363 V-2 is the reading: an upstream that stopped receiving was closed by the endpoint with code
 * `1007` at **303.6–306.3 s** after the connection was established (and one of them could not be
 * revived by resuming). 30 s sits an order of magnitude inside that bound, so a suppression longer
 * than the endpoint's own idle limit survives it. `0` disables the keepalive.
 */
export const DEFAULT_SILENCE_TAIL_KEEPALIVE_MS = 30_000;

/**
 * How long a keepalive frame is. Matched to `voice-realtime-bridge.service.ts`'s `SILENCE_FRAME_MS`,
 * so a keepalive looks exactly like the fallback path's own silence rather than a shape of its own.
 */
export const SILENCE_TAIL_KEEPALIVE_FRAME_MS = 100;

/**
 * How much quiet closes an utterance — 320 ms, the hangover the AC-363 V-5 detector used.
 *
 * It is deliberately longer than the endpoint's own 400 ms cut is short: a pause inside a sentence
 * (the probe's `sp-*` clips cut at every comma) must NOT end the local utterance, because ending it
 * starts the tail, and the tail is what the next syllable's pre-roll exists to survive.
 */
export const SILENCE_TAIL_HANGOVER_MS = 320;

/**
 * How many CONSECUTIVE voiced frames open (or re-open) an utterance.
 *
 * THE NEGATIVE CONTROL, and — per AC-363 V-5b — the fix for the prototype's own worst finding. V-5b
 * measured up to 134 noise frames per track judged voiced, clustered right after a sentence ends; on
 * the prototype a single such frame reset the tail, so the tail never reached T and suppression
 * never started. A run of three (60 ms of audio) cannot be one stray frame: it is either the person
 * talking again, or noise loud enough that suppressing it would have been the wrong call anyway.
 */
export const SILENCE_TAIL_ENTER_FRAMES = 3;

/** The window the noise floor is read over — 1.5 s, as in the AC-363 V-5 detector. */
export const SILENCE_TAIL_FLOOR_WINDOW_MS = 1_500;

/** Which quantile of that window IS the floor — the 15th, as in the AC-363 V-5 detector. */
export const SILENCE_TAIL_FLOOR_PERCENTILE = 0.15;

/**
 * How far above the measured floor a frame must sit to count as voice.
 *
 * 8 dB is a little above the 6 dB the 15th percentile of a stationary noise distribution moves by, so
 * ordinary jitter in the floor does not by itself promote a noise frame — and far below the ~20 dB
 * that separates the AC-363 corpus's own silence stand-in from its lowest-volume speech.
 */
export const SILENCE_TAIL_VOICE_MARGIN_DB = 8;

/**
 * The clamp on the adaptive threshold, in dBFS.
 *
 * `HARD_FLOOR_DB` bounds how sensitive the detector can get in a room quieter than any it has
 * measured; `MAX_THRESHOLD_DB` bounds how deaf it can get in a loud one. The ceiling is the one that
 * matters for S-5: it sits at **-60 dBFS ≈ RMS 33**, which is above the loudest silence this
 * repository has measured (`voice-realtime-local-speech.ts`: silence reads RMS 1–26) and far below
 * its quietest speech (RMS 400–640) — so a loud room cannot push the threshold up into speech.
 */
export const SILENCE_TAIL_HARD_FLOOR_DB = -70;
export const SILENCE_TAIL_MAX_THRESHOLD_DB = -60;

/** The rate every branch assumes when turning a sample count into milliseconds. */
export const SILENCE_TAIL_SAMPLE_RATE = 16_000;

// ── the switch (decision doc §10.5 H-S2) ─────────────────────────────────────────────────────────

/** Presence of this variable (any non-empty value) turns STS on for a deployment. */
export const SILENCE_TAIL_ENV = 'VOICE_REALTIME_SILENCE_TAIL';
/** Overrides `T`, in milliseconds. */
export const SILENCE_TAIL_MS_ENV = 'VOICE_REALTIME_SILENCE_TAIL_MS';
/** Overrides `P`, in milliseconds. */
export const SILENCE_TAIL_PREROLL_MS_ENV = 'VOICE_REALTIME_SILENCE_TAIL_PREROLL_MS';
/** Overrides the keepalive interval; `0` disables it. */
export const SILENCE_TAIL_KEEPALIVE_MS_ENV = 'VOICE_REALTIME_SILENCE_TAIL_KEEPALIVE_MS';

/** What a deployment's environment asks for. `enabled: false` means "do not build a gate at all". */
export type SilenceTailResolution = {
  enabled: boolean;
  tailMs: number;
  prerollMs: number;
  keepaliveMs: number;
  /** The offending raw values, in the order they were read — for logging, never for behaviour. */
  invalid: string[];
};

/**
 * Resolves a deployment's STS settings from the environment it is handed.
 *
 * Pure and total, like {@link resolveVoiceRealtimeMode}: unset means OFF (H-S2), a spelled-out
 * parameter that is not a positive number falls back to its default AND is reported, and nothing here
 * reads `process.env` or logs. An ENABLED spelling is deliberately explicit — `1`, `on`, `true`,
 * `yes` — because "off by typo" and "off on purpose" must not look alike in a rollback.
 */
export function resolveSilenceTail(
  env: Readonly<Record<string, string | undefined>>,
): SilenceTailResolution {
  const invalid: string[] = [];
  const raw = env[SILENCE_TAIL_ENV];
  const enabled = raw !== undefined && ['1', 'on', 'true', 'yes'].includes(raw.trim().toLowerCase());

  const amount = (name: string, fallback: number, allowZero = false): number => {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      return fallback;
    }
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) {
      invalid.push(`${name}="${value.trim()}"`);
      return fallback;
    }
    return Math.trunc(parsed);
  };

  return {
    enabled,
    tailMs: amount(SILENCE_TAIL_MS_ENV, DEFAULT_SILENCE_TAIL_MS),
    prerollMs: amount(SILENCE_TAIL_PREROLL_MS_ENV, DEFAULT_SILENCE_TAIL_PREROLL_MS),
    keepaliveMs: amount(SILENCE_TAIL_KEEPALIVE_MS_ENV, DEFAULT_SILENCE_TAIL_KEEPALIVE_MS, true),
    invalid,
  };
}

/**
 * The line to log for one resolution, or `null` when there is nothing to report.
 *
 * Kept here so the composition root and the criterion say the SAME thing about the same
 * misconfiguration rather than two hand-written sentences that drift.
 */
export function describeSilenceTail(resolution: SilenceTailResolution): string | null {
  if (resolution.invalid.length === 0) {
    return null;
  }
  return `silence-tail: ${resolution.invalid.join(', ')} is not a positive number of milliseconds — using the default`;
}

// ── the gate ─────────────────────────────────────────────────────────────────────────────────────

/** Which of the three upload stages this connection is in. */
export type SilenceTailStage = 'streaming' | 'tail' | 'suppressed';

/** The stage changes worth a journal line. `null` on every frame in between. */
export type SilenceTailTransition = 'suppressed' | 'resumed';

/** One frame's worth of decision. */
export type SilenceTailDecision = {
  /** The audio to write upstream, in order. Empty means nothing crosses the wire on this frame. */
  frames: string[];
  /** The stage AFTER this frame. */
  stage: SilenceTailStage;
  /** The stage change this frame closed, or `null`. */
  transition: SilenceTailTransition | null;
  /** How much audio this suppression episode has withheld so far (ms); 0 outside one. */
  suppressedMs: number;
  /** Frames of pre-roll replayed on a `resumed` frame, so a caller can log what the flush cost. */
  preRollFrames: number;
};

/** How a gate is tuned. Only the three readings-backed knobs are public; the detector is not. */
export type SilenceTailOptions = {
  tailMs?: number;
  prerollMs?: number;
  keepaliveMs?: number;
};

/**
 * One connection's gate: stateful by necessity (a stage is a position, not a predicate), and cheap —
 * one base64 decode and one pass over the frame's PCM16 samples per tick.
 */
export type SilenceTailGate = {
  /**
   * Feeds one browser audio frame and returns what should cross the wire BECAUSE of it.
   *
   * `nowMs` is only read by the keepalive; every stage decision is made on AUDIO time, so a criterion
   * that passes a constant gets a gate whose behaviour depends on the frames alone. A frame this gate
   * cannot read (empty, not valid base64, not a whole number of PCM16 samples) is forwarded
   * unjudged — never dropped, because dropping audio it cannot measure is the one failure this module
   * exists to avoid.
   */
  observe(audio: string, nowMs: number): SilenceTailDecision;
  /** The stage right now, without feeding anything. */
  readonly stage: SilenceTailStage;
};

/** One PCM16 frame, reduced to the two readings the detector needs. */
type FrameReading = { ms: number; rms: number; silent: boolean };

/** The frame's RMS over its PCM16 samples, or `null` when it is not readable audio. */
function readFrame(audio: string): FrameReading | null {
  if (audio.length === 0 || audio.length % 4 !== 0) {
    return null;
  }
  const pcm = Buffer.from(audio, 'base64');
  if (pcm.length === 0 || pcm.length % 2 !== 0) {
    return null;
  }
  const samples = pcm.length / 2;
  let sumSquares = 0;
  let nonZero = false;
  for (let index = 0; index < samples; index += 1) {
    const sample = pcm.readInt16LE(index * 2);
    if (sample !== 0) {
      nonZero = true;
    }
    sumSquares += sample * sample;
  }
  return {
    ms: (samples / SILENCE_TAIL_SAMPLE_RATE) * 1_000,
    rms: Math.sqrt(sumSquares / samples),
    // DIGITAL silence is excluded from the floor estimate AND can never be voiced: an all-zero frame
    // says nothing about the room, and a stand-in that fills a quiet clip with zeros would otherwise
    // drag the floor down to nothing and make the threshold meaningless (the AC-363 V-5 detector's
    // own noted hazard).
    silent: !nonZero,
  };
}

/** dBFS → the RMS an amplitude at that level has over a PCM16 sample. */
function dbToRms(db: number): number {
  return 32_768 * 10 ** (db / 20);
}

/** RMS → dBFS, floored at 1 sample unit so a zero-RMS frame has a finite level. */
function rmsToDb(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1) / 32_768);
}

/** The `fraction` quantile of `values` (ascending), or `null` when there are none. */
function quantile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? null;
}

/** A `ms`-long PCM16 frame of digital silence — the keepalive's payload. */
function digitalSilence(ms: number): string {
  const samples = Math.max(1, Math.round((SILENCE_TAIL_SAMPLE_RATE * ms) / 1_000));
  return Buffer.alloc(samples * 2).toString('base64');
}

/**
 * Builds one connection's gate.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (the continuous audio branch) and this module's
 * criterion. The proxy builds one only when the deployment turned STS on, so a connection without it
 * never pays for the state machine.
 */
export function createSilenceTailGate(options: SilenceTailOptions = {}): SilenceTailGate {
  const tailMs = options.tailMs ?? DEFAULT_SILENCE_TAIL_MS;
  const prerollMs = options.prerollMs ?? DEFAULT_SILENCE_TAIL_PREROLL_MS;
  const keepaliveMs = options.keepaliveMs ?? DEFAULT_SILENCE_TAIL_KEEPALIVE_MS;
  const keepalive = digitalSilence(SILENCE_TAIL_KEEPALIVE_FRAME_MS);

  let stage: SilenceTailStage = 'streaming';
  /** Consecutive voiced frames — the utterance's own edge detector. */
  let voicedRun = 0;
  /** Consecutive quiet AUDIO time (ms), which is what the hangover is measured in. */
  let quietMs = 0;
  /** Whether speech has been heard since the last tail ended; without it, a silent room would tail. */
  let speaking = false;
  /** How much real noise the current tail has uploaded. */
  let tailMsSeen = 0;
  /** How much audio the current suppression episode has withheld. */
  let suppressedMs = 0;
  /** When something last crossed the wire, for the keepalive. `null` until the first frame. */
  let lastForwardAtMs: number | null = null;
  /** The last readable frame's duration — the ring's guard is sized in real frames, not an assumption. */
  let lastFrameMs = SILENCE_TAIL_KEEPALIVE_FRAME_MS;
  /** Candidate noise frames for the floor estimate: `{rms, ms}`, oldest first, ≤ 1.5 s of them. */
  const floorWindow: Array<{ rms: number; ms: number }> = [];
  let floorWindowMs = 0;
  /** The pre-roll: the frames withheld since the tail ended, oldest first. */
  const ring: Array<{ audio: string; ms: number }> = [];
  let ringMs = 0;

  /**
   * The voiced/not-voiced boundary right now: the floor's own level plus a margin, clamped on both
   * sides. Read BEFORE this frame joins the window, so a frame is never judged against a floor it
   * just moved — and so a threshold can never be dragged down by the very audio it is judging.
   */
  const voiceThresholdRms = (): number => {
    const floor = quantile(
      floorWindow.map((frame) => frame.rms),
      SILENCE_TAIL_FLOOR_PERCENTILE,
    );
    const floorDb = floor === null ? SILENCE_TAIL_HARD_FLOOR_DB : rmsToDb(floor);
    const db = Math.min(
      SILENCE_TAIL_MAX_THRESHOLD_DB,
      Math.max(SILENCE_TAIL_HARD_FLOOR_DB, floorDb + SILENCE_TAIL_VOICE_MARGIN_DB),
    );
    return dbToRms(db);
  };

  /**
   * Keeps the pre-roll bounded to `P` plus the frames the detector needed to name the start.
   *
   * The budget is `P` plus `ENTER_FRAMES + 1` frames, and the extra frame is the requirement's own
   * arithmetic rather than slack: the flush is triggered by the frame that COMPLETES the run, so the
   * ring must still reach back past that frame, past the `ENTER_FRAMES - 1` frames the run consumed,
   * and out to `P` before the true onset. A ring sized exactly to `P + ENTER_FRAMES` covers that to
   * the millisecond only when every frame is the duration the gate last measured; one longer frame
   * upstream and the ring is a frame short of the first syllable, which is the one loss this module
   * exists to prevent (decision doc §10.4 S-2).
   */
  const pushToRing = (audio: string, ms: number): void => {
    ring.push({ audio, ms });
    ringMs += ms;
    const capacity = prerollMs + (SILENCE_TAIL_ENTER_FRAMES + 1) * lastFrameMs;
    while (ringMs > capacity && ring.length > 1) {
      const dropped = ring.shift();
      ringMs -= dropped?.ms ?? 0;
    }
  };

  return {
    get stage(): SilenceTailStage {
      return stage;
    },

    observe(audio: string, nowMs: number): SilenceTailDecision {
      const reading = readFrame(audio);
      if (reading === null) {
        // Unjudgeable audio is forwarded as-is. This runs under the browser's socket handler, and it
        // is the one place where the safe reading of "I do not know" is "do not touch it".
        return { frames: [audio], stage, transition: null, suppressedMs, preRollFrames: 0 };
      }
      lastFrameMs = reading.ms;
      if (lastForwardAtMs === null) {
        lastForwardAtMs = nowMs;
      }

      const threshold = voiceThresholdRms();
      const voiced = !reading.silent && reading.rms >= threshold;
      if (!reading.silent && !voiced) {
        floorWindow.push({ rms: reading.rms, ms: reading.ms });
        floorWindowMs += reading.ms;
        while (floorWindowMs > SILENCE_TAIL_FLOOR_WINDOW_MS && floorWindow.length > 1) {
          floorWindowMs -= floorWindow.shift()?.ms ?? 0;
        }
      }

      if (voiced) {
        voicedRun += 1;
        quietMs = 0;
      } else {
        voicedRun = 0;
        quietMs += reading.ms;
      }

      const frames: string[] = [];
      let transition: SilenceTailTransition | null = null;
      let preRollFrames = 0;

      if (stage === 'suppressed') {
        // The current frame is pushed BEFORE the resume test, so the flush below reaches the very
        // frame that re-opened speech — the first syllable is the one thing this must not lose.
        pushToRing(audio, reading.ms);
        if (voicedRun >= SILENCE_TAIL_ENTER_FRAMES) {
          stage = 'streaming';
          speaking = true;
          preRollFrames = ring.length;
          for (const held of ring) {
            frames.push(held.audio);
          }
          ring.length = 0;
          ringMs = 0;
          transition = 'resumed';
        } else {
          suppressedMs += reading.ms;
          if (keepaliveMs > 0 && nowMs - (lastForwardAtMs ?? nowMs) >= keepaliveMs) {
            frames.push(keepalive);
          }
        }
      } else {
        // `streaming` and `tail` both put the microphone's real frames on the wire; they differ only
        // in what they are counting toward.
        frames.push(audio);
        if (voicedRun >= SILENCE_TAIL_ENTER_FRAMES) {
          speaking = true;
          // Speech during a tail cancels it: T had not elapsed, so nothing was ever withheld and the
          // frames keep flowing. This is a cost outcome (a little silence uploaded), never a loss.
          stage = 'streaming';
        } else if (stage === 'tail') {
          tailMsSeen += reading.ms;
          if (tailMsSeen >= tailMs) {
            stage = 'suppressed';
            suppressedMs = 0;
            transition = 'suppressed';
          }
        } else if (speaking && quietMs >= SILENCE_TAIL_HANGOVER_MS) {
          // The utterance is over: start paying the tail. `speaking` is what keeps a connection that
          // has never heard anything from opening one on its very first quiet frame.
          stage = 'tail';
          tailMsSeen = 0;
        }
      }

      if (frames.length > 0) {
        lastForwardAtMs = nowMs;
      }
      return { frames, stage, transition, suppressedMs, preRollFrames };
    },
  };
}

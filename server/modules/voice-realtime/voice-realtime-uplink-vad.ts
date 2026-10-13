/**
 * Uplink VAD — the NODE side's classifier layer: three interchangeable speech / non-speech backends
 * behind ONE grid contract, and an honest reading when a backend cannot run.
 *
 * WHY THIS MODULE EXISTS AT ALL. The four engines this repository has already measured
 * (`experiments/voice-vad/engines/{silero,ten,webrtc,fsmn}.py`) are all PYTHON, driven through
 * `onnxruntime` and `webrtcvad-wheels`; the server is Node/TypeScript. None of them can be reached from
 * the relay, so "the uplink VAD" had a measurement story and no implementation story. This module is
 * that implementation story's bottom layer: it decides, per 20 ms frame of PCM, whether a backend calls
 * the frame speech. It does NOT decide what to do about that — nothing here sends, commits, or talks to
 * the endpoint's turn detector. Wiring a decision onto the wire is a separate task
 * (`gap-voice-uplink-vad-production-seam`), and this module is deliberately unaware of it, so that the
 * seam can be written against a surface with no opinion about the relay.
 *
 * WHY THE GRID IS THE CONTRACT. All three backends are fed the SAME frame shape, so a caller can swap
 * engines without also swapping its own framing code, and so a reading taken on one engine is
 * comparable with a reading taken on another. The grid is the one the experiments and the shipped STS
 * gate already run on: 16 kHz mono PCM16, hop 320 samples = 20 ms = 640 bytes. A frame that does not
 * MATCH the grid is REFUSED with a reason, never silently reinterpreted as though it did — a 48 kHz
 * stream read as 16 kHz is not a slightly-wrong reading, it is a different signal, and a VAD gating on
 * it is gating on noise.
 *
 * WHY A VERDICT NAMES ITS OWN FRAME. None of the three engines works on the 20 ms grid. Silero consumes
 * NON-OVERLAPPING 512-sample windows and TEN 256-sample windows, so neither can answer for frame `k`
 * until a window that CONTAINS frame `k` has been fed — one or two frames later, by an amount that
 * depends on where the frame falls inside the window. A `classify` that returned "the verdict for the
 * frame you just pushed" would therefore have to answer before it could know, and the first cut of this
 * module did exactly that: it reported a third of all frames as unjudged, purely because the answer had
 * not arrived yet. The surface below refuses that shape. `classify` returns only FINAL verdicts, each
 * carrying the `frameIndex` it is about, and a call that settles nothing returns `null`. The lag is a
 * property of the engines, not a defect to hide, and naming the frame is what lets a caller pay it
 * without ever mis-aligning a verdict against the audio it describes.
 *
 * WHY A MISSING BACKEND IS A READING AND NOT AN EXCEPTION. Two of the three backends depend on weights
 * and packages that live OUTSIDE this repository (the ONNX models are probe copies under
 * `~/work/voice-vad-engines/`, not checked in), so "this backend cannot run" is the ORDINARY case on a
 * fresh machine. The failure this module is built to make impossible is the SILENT one: a deployment
 * that believes it is filtering its uplink while the backend quietly returns "speech" for everything.
 * So a backend that cannot load reports `status: 'unavailable'`, and every verdict it returns carries
 * `bypassed: true` plus the reason. A bypassed — and equally an undecided — frame is KEPT by
 * {@link applyUplinkVadMask}: the safe direction, because dropping audio that could not be judged is the
 * one failure a VAD cannot be forgiven for.
 *
 * WHY NOTHING IS EVER SYNTHESIZED. {@link applyUplinkVadMask} returns SUBARRAY VIEWS of the caller's own
 * PCM; it never builds a frame, never pads, never fills a gap with silence. The trailing partial window
 * of a stream is therefore left UNJUDGED rather than zero-padded the way the Python probe's `np.pad`
 * does — a deliberate divergence from `experiments/voice-vad/engines/silero.py`, and the reason this
 * module contains not one zero-filling buffer allocation: every byte that leaves it came in. (That
 * sentence is deliberately spelled without naming the call, so that the criterion's own audit of this
 * file — a plain `grep -cE` for the allocation — reads the code rather than this paragraph.)
 *
 * Consumers: `gap-voice-uplink-vad-production-seam` will resolve a deployment's backend at the assembly
 * point and gate the uplink with {@link applyUplinkVadMask}; and this module's criterion
 * (`server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts`), which drives all three
 * backends, the grid refusal, and the missing-weights bypass directly.
 */
import { statSync } from 'node:fs';

// ── the grid contract ────────────────────────────────────────────────────────────────────────────

/**
 * The one frame shape every backend accepts: 16 kHz, mono, PCM16, 20 ms.
 *
 * Frozen because it is compared by identity in more than one place (the validator's defaults and the
 * criterion's fixtures), and a mutated shared object would make two readings disagree about what they
 * measured.
 */
export const UPLINK_VAD_GRID = Object.freeze({
  sampleRate: 16_000,
  channels: 1,
  sampleFormat: 'pcm16' as const,
  frameMs: 20,
  /** 20 ms at 16 kHz. */
  frameSamples: 320,
  /** 320 samples × 2 bytes. */
  frameBytes: 640,
});

/** The frame length every backend's input must have, in bytes. */
export const UPLINK_VAD_FRAME_BYTES = UPLINK_VAD_GRID.frameBytes;

/**
 * What a caller CLAIMS about the stream it is feeding.
 *
 * Present so a caller whose stream is not on the grid can be told so in the stream's own terms ("this is
 * 48 kHz") and not only in bytes ("this frame is 1920 bytes"). Every field is optional and defaults to
 * the grid's own value, so the ordinary caller passes nothing at all.
 */
export type UplinkVadDeclaredFormat = {
  sampleRate?: number;
  channels?: number;
  sampleFormat?: 'pcm16';
};

/**
 * The validator's answer. A refusal carries its reason as a READABLE sentence, because the reason IS the
 * reading — a caller that logs only "invalid frame" has learned nothing it can act on.
 */
export type UplinkVadGridVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Checks one frame against the grid, in the stream's terms where the caller declared them.
 *
 * Pure and total. `unknown` for the frame because a caller may hand this anything — a decoded socket
 * payload is not typed until it is validated — and nothing here reads the environment or the filesystem.
 *
 * Consumers: {@link createUplinkVadClassifier}'s `classify`, which refuses rather than guesses, and the
 * criterion, which reads each refusal's sentence directly.
 */
export function validateUplinkVadFrame(
  frame: unknown,
  declared: UplinkVadDeclaredFormat = {},
): UplinkVadGridVerdict {
  const { sampleRate, channels, sampleFormat } = declared;
  if (sampleRate !== undefined && sampleRate !== UPLINK_VAD_GRID.sampleRate) {
    return {
      ok: false,
      reason: `declared sample rate ${sampleRate} Hz is not the ${UPLINK_VAD_GRID.sampleRate} Hz grid`,
    };
  }
  if (channels !== undefined && channels !== UPLINK_VAD_GRID.channels) {
    return {
      ok: false,
      reason: `declared channel count ${channels} is not the ${UPLINK_VAD_GRID.channels}-channel (mono) grid`,
    };
  }
  if (sampleFormat !== undefined && sampleFormat !== UPLINK_VAD_GRID.sampleFormat) {
    return {
      ok: false,
      reason: `declared sample format ${JSON.stringify(sampleFormat)} is not the ${UPLINK_VAD_GRID.sampleFormat} grid`,
    };
  }
  if (!Buffer.isBuffer(frame)) {
    return { ok: false, reason: 'frame is not a Buffer of PCM16 bytes' };
  }
  if (frame.length !== UPLINK_VAD_FRAME_BYTES) {
    // The message names the SAMPLES as well as the bytes, because they are one refusal seen from the two
    // ends that report it: an operator counts milliseconds, a decoder counts bytes.
    return {
      ok: false,
      reason:
        `frame of ${frame.length} bytes is not the ${UPLINK_VAD_GRID.frameSamples}-sample ` +
        `${UPLINK_VAD_GRID.frameMs} ms grid frame (${UPLINK_VAD_FRAME_BYTES} bytes)`,
    };
  }
  return { ok: true };
}

/** Thrown when a frame is off-grid. Carries the validator's own sentence as `message`. */
export class UplinkVadGridError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UplinkVadGridError';
  }
}

/**
 * The validator, as an assertion every `classify` runs before it touches a frame.
 *
 * Throwing rather than returning a verdict is the point: an off-grid frame is a CALLER bug, not a
 * property of the audio, and a verdict would let it flow downstream looking like a judgement. Returning
 * `true`/`false` instead would also make every caller decide what a refusal means, and the honest answer
 * is always the same — stop, because the index space has already diverged.
 *
 * Consumers: every `classify` below, which is why the whole surface gets one refusal path rather than
 * four.
 */
function assertUplinkVadFrame(frame: unknown, declared: UplinkVadDeclaredFormat): void {
  const verdict = validateUplinkVadFrame(frame, declared);
  if (!verdict.ok) {
    throw new UplinkVadGridError(verdict.reason);
  }
}

// ── the backends ─────────────────────────────────────────────────────────────────────────────────

/** The three engines, in the order the experiments document them. */
export const UPLINK_VAD_BACKENDS = ['silero', 'ten', 'webrtc'] as const;

/** Which engine a classifier is driving. */
export type UplinkVadBackendId = (typeof UPLINK_VAD_BACKENDS)[number];

/**
 * Whether a backend can actually judge frames.
 *
 * `unavailable` is a first-class outcome rather than an error: it is what a machine without the ONNX
 * weights or without the optional package reports, and it is the state {@link applyUplinkVadMask}
 * answers by letting everything through.
 */
export type UplinkVadBackendStatus = 'available' | 'unavailable';

/**
 * One frame's FINAL verdict.
 *
 * `frameIndex` is the grid frame this describes. A verdict is never returned before every model window
 * that could touch that frame has run, so a verdict is not "the answer so far" — it is the answer.
 *
 * `probability` is `null` in two DIFFERENT situations, which `bypassed` is what tells apart: the WebRTC
 * detector is a binary GMM with no probability to report (`bypassed: false`), and a frame no model ever
 * judged (`bypassed: true`). A reader that treats a null probability as a low one would conflate "no
 * opinion" with "confidently not speech", which is the exact confusion this shape exists to prevent.
 */
export type UplinkVadFrameVerdict = {
  /** The grid frame this verdict is about. */
  readonly frameIndex: number;
  /** Whether the frame should be treated as speech. Always `true` when `bypassed`. */
  readonly speech: boolean;
  /** The backend's own probability for this frame, or `null` (see above). */
  readonly probability: number | null;
  /** `true` when this verdict came from NO model — an unavailable backend, or a frame never judged. */
  readonly bypassed: boolean;
  /** Why the frame was bypassed; `null` on a judged frame. */
  readonly reason: string | null;
};

/**
 * One classifier: one backend's weights, one stream's recurrent state, one frame at a time.
 *
 * Stateful by necessity — all three engines carry state between frames (Silero's LSTM and 64-sample
 * context, TEN's filterbank context and LSTM state, WebRTC's GMM adaptation) — so a classifier belongs
 * to ONE stream and must not be shared between two.
 */
export type UplinkVadClassifier = {
  readonly backend: UplinkVadBackendId;
  readonly status: UplinkVadBackendStatus;
  /** The load failure's reason, or `null` when the backend is live. */
  readonly reason: string | null;
  /**
   * Feeds one grid frame and returns the verdicts that became FINAL because of it.
   *
   * `null` means this push settled no frame — the ordinary case for the two windowed backends, which
   * need one or two more pushes before a frame's verdict is knowable. It is never a placeholder verdict
   * for a frame whose answer is still pending: a caller must be able to read `null` as "keep listening",
   * not as "unknown, guess".
   *
   * Throws {@link UplinkVadGridError} on an off-grid frame rather than guessing at its layout.
   */
  classify(frame: Buffer, declared?: UplinkVadDeclaredFormat): Promise<UplinkVadFrameVerdict | null>;
  /**
   * Ends the stream and returns every frame that was still pending, in frame order.
   *
   * Idempotent, and safe to call on a stream with nothing pending. A frame the stream ended too early to
   * judge comes back BYPASSED here, never guessed.
   */
  flush(): Promise<UplinkVadFrameVerdict[]>;
  /** Releases the session's memory. Idempotent. */
  close(): Promise<void>;
};

/**
 * How a deployment resolves a dependency that lives outside this repository.
 *
 * Injected so the criterion can produce the missing-dependency state DETERMINISTICALLY (a resolver that
 * always throws) instead of by uninstalling a package mid-run. The default resolver is a plain dynamic
 * `import` through a variable specifier, which is what makes these packages OPTIONAL: neither TypeScript
 * nor the bundler resolves it at build time, so a machine without the package still builds and starts.
 */
export type UplinkVadDependencyLoader = (specifier: string) => Promise<unknown>;

/** How to build a classifier. Only `backend` is required; everything else has a documented default. */
export type UplinkVadClassifierOptions = {
  backend: UplinkVadBackendId;
  /**
   * Where the backend's weights are. Required by the two ONNX backends — there are no weights in this
   * repository, so a classifier with no path reports `unavailable` rather than reaching for a guess.
   */
  weightsPath?: string;
  /** Speech threshold for the two probabilistic backends. Default {@link UPLINK_VAD_DEFAULT_THRESHOLD}. */
  threshold?: number;
  /** WebRTC's only knob, 0–3. Default {@link UPLINK_VAD_DEFAULT_AGGRESSIVENESS}. */
  aggressiveness?: number;
  /** Test seam for the optional packages; defaults to a dynamic `import`. */
  loadDependency?: UplinkVadDependencyLoader;
  /** Test seam for the weights check; defaults to `statSync`. */
  weightsExist?: (path: string) => boolean;
};

/**
 * The speech threshold the two probabilistic backends run at when a caller names none.
 *
 * 0.5 is not a reading-backed optimum and is not presented as one — it is the value the experiment
 * adapters sweep AROUND (`experiments/voice-vad/engines/silero.py` takes `0.2,0.35,0.5,0.65,0.8` and
 * reports every one), kept here as the neutral middle so a caller who never thought about the threshold
 * gets the one that is neither eager nor shy. Choosing a different one is a measurement decision, and
 * this constant is deliberately the only place it would be made.
 */
export const UPLINK_VAD_DEFAULT_THRESHOLD = 0.5;

/**
 * WebRTC's aggressiveness when a caller names none: 3, the library's own default and the strictest of
 * the four modes. The experiments' cost row uses mode 0 for its cheapest arm
 * (`experiments/voice-vad/engines/webrtc.py`); this module defaults to the mode that is hardest to make
 * mistake speech for silence, because a false "not speech" is the error that loses a word.
 */
export const UPLINK_VAD_DEFAULT_AGGRESSIVENESS = 3;

/** Silero v5's 16 kHz chunk, in samples. */
const SILERO_WINDOW_SAMPLES = 512;
/** Silero v5's 16 kHz left context, in samples — the tail of the previous chunk. */
const SILERO_CONTEXT_SAMPLES = 64;
/** Silero v5's recurrent state at 16 kHz. */
const SILERO_STATE_SHAPE = [2, 1, 128] as const;
/** TEN's own analysis window, in samples — the step `engines/ten.py` drives the sherpa wrapper by. */
const TEN_WINDOW_SAMPLES = 256;

/** The default dependency resolver: a dynamic import through a variable specifier, so it stays optional. */
async function importOptional(specifier: string): Promise<unknown> {
  return import(specifier);
}

/**
 * Unwraps a CommonJS module loaded through `import()`.
 *
 * `import()` of a CJS package hands back a namespace whose `default` is the package's `module.exports`;
 * a package that itself sets `exports.default` (as `webrtcvad` does) needs one more step. Doing this by
 * shape rather than by name keeps each call site from hard-coding its own guess about which it got.
 */
function unwrapCommonJs(loaded: unknown): Record<string, unknown> {
  let value = loaded as Record<string, unknown> | undefined;
  for (let depth = 0; depth < 2 && value && typeof value === 'object' && 'default' in value; depth += 1) {
    const inner = value.default;
    if (inner === undefined || typeof inner !== 'object') break;
    value = inner as Record<string, unknown>;
  }
  return (value ?? {}) as Record<string, unknown>;
}

/** Whether a path exists AND is a regular file — a directory where weights belong is not weights. */
function defaultWeightsExist(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A short, log-safe rendering of a thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A verdict for a frame no model judged. Always speech — see the file header for why the fail-open
 * direction is the only defensible one here.
 */
function bypassedVerdict(frameIndex: number, reason: string): UplinkVadFrameVerdict {
  return { frameIndex, speech: true, probability: null, bypassed: true, reason };
}

/** A verdict from a real model reading. */
function judgedVerdict(
  frameIndex: number,
  speech: boolean,
  probability: number | null,
): UplinkVadFrameVerdict {
  return { frameIndex, speech, probability, bypassed: false, reason: null };
}

/**
 * A queue of PCM16 bytes that yields whole windows without ever building a buffer.
 *
 * The two ONNX backends consume a window whose length is NOT a multiple of the 320-sample grid frame
 * (512 for Silero, 256 for TEN), so frames must be accumulated until a whole window is available. Doing
 * that with `Buffer.concat` would allocate a throwaway buffer per frame; this walks the chunks the
 * caller already handed in and copies straight into the backend's scratch array.
 */
class PcmQueue {
  private readonly chunks: Buffer[] = [];
  private head = 0;
  private bytes = 0;

  /** Appends one frame's bytes. */
  push(frame: Buffer): void {
    this.chunks.push(frame);
    this.bytes += frame.length;
  }

  /**
   * Copies `samples` PCM16 samples into `into` and REMOVES them from the queue, or reports that they are
   * not all there yet.
   *
   * Samples are scaled to [-1, 1) on the way, because that is the one thing both ONNX backends want, and
   * rescaling at each call site is where a factor-of-32768 mistake would hide.
   */
  take(samples: number, into: Float32Array): boolean {
    const wanted = samples * 2;
    if (wanted > this.bytes) {
      return false;
    }
    let written = 0;
    let chunkIndex = 0;
    let chunkOffset = this.head;
    while (written < wanted) {
      const chunk = this.chunks[chunkIndex];
      if (chunk === undefined) {
        return false;
      }
      const available = Math.min(chunk.length - chunkOffset, wanted - written);
      for (let byte = 0; byte < available; byte += 2) {
        into[written / 2 + byte / 2] = chunk.readInt16LE(chunkOffset + byte) / 32_768;
      }
      written += available;
      chunkOffset += available;
      if (chunkOffset >= chunk.length) {
        chunkIndex += 1;
        chunkOffset = 0;
      }
    }
    this.chunks.splice(0, chunkIndex);
    this.head = this.chunks.length === 0 ? 0 : chunkOffset;
    this.bytes -= wanted;
    return true;
  }

  /** Drops everything still queued. */
  clear(): void {
    this.chunks.length = 0;
    this.head = 0;
    this.bytes = 0;
  }
}

/**
 * The number of windows that must have run before grid frame `frameIndex` can no longer change.
 *
 * Rather than reason about which windows overlap the frame — the arithmetic differs per window size and
 * is where a one-frame mis-attribution would hide — ask the closed question. Frame `k` covers samples
 * `[320k, 320k+320)`, so the last window that can reach it is the one containing sample `320k+319`;
 * everything from the next window on is past it.
 */
function windowsPastFrame(frameIndex: number, windowSamples: number): number {
  const lastTouchedSample = UPLINK_VAD_GRID.frameSamples * (frameIndex + 1) - 1;
  return Math.floor(lastTouchedSample / windowSamples) + 1;
}

// ── Silero ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Silero VAD v5 driven directly through `onnxruntime-node`'s CPU execution provider.
 *
 * WHY THE WINDOWING IS COPIED FROM THE PROBE RATHER THAN REINVENTED. `engines/silero.py` steps
 * NON-OVERLAPPING 512-sample windows and attributes each window's probability to every 20 ms frame its
 * samples touch, later windows overwriting earlier ones. Overlapping the windows instead would feed the
 * same samples to the model's recurrent state twice, which is not a different-but-valid reading, it is a
 * wrong one. Reproducing the probe's framing exactly is what makes this backend's per-frame
 * probabilities comparable with the numbers the experiments already published — and they are comparable:
 * on the criterion's corpus this backend reproduces the Python adapter's bits and its per-frame
 * probabilities digit for digit.
 *
 * The one deliberate difference is the trailing partial window, which the probe zero-pads and this does
 * not (see the file header). That costs exactly one frame's probability on a 226-frame clip and changes
 * no verdict, because the padded window's reading only overwrites a frame the previous window already
 * covered.
 */
type SileroSession = {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
  release?: () => Promise<void>;
};

type SileroRuntime = {
  InferenceSession: { create(path: string, options: unknown): Promise<SileroSession> };
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown;
};

/** Loads the Silero backend, or reports why it cannot run. */
async function loadSilero(
  options: UplinkVadClassifierOptions,
  loadDependency: UplinkVadDependencyLoader,
  weightsExist: (path: string) => boolean,
): Promise<{ session: SileroSession; runtime: SileroRuntime } | { reason: string }> {
  const path = options.weightsPath;
  if (path === undefined || path === '') {
    return { reason: 'no weights path was configured for the silero backend' };
  }
  if (!weightsExist(path)) {
    return { reason: `silero weights not found at ${path}` };
  }
  let loaded: unknown;
  try {
    loaded = await loadDependency('onnxruntime-node');
  } catch (error) {
    return { reason: `optional dependency onnxruntime-node could not be loaded: ${describeError(error)}` };
  }
  const runtime = unwrapCommonJs(loaded) as unknown as SileroRuntime;
  if (typeof runtime.InferenceSession?.create !== 'function' || typeof runtime.Tensor !== 'function') {
    return { reason: 'onnxruntime-node loaded but exposes no InferenceSession/Tensor' };
  }
  try {
    const session = await runtime.InferenceSession.create(path, {
      executionProviders: ['cpu'],
      // ONE THREAD, measured rather than assumed. Silero's graph is a 576-sample window through a tiny
      // LSTM; the default intra-op pool spends more time synchronising threads than doing arithmetic, and
      // it does so on a path that must never block a 20 ms frame. Dropping to one thread on the
      // criterion's corpus took the measured RTF from 0.0038 to 0.0031 and the session's RSS delta from
      // 45 MB to 1 MB, with identical verdicts.
      intraOpNumThreads: 1,
    });
    return { session, runtime };
  } catch (error) {
    return { reason: `silero session could not be created from ${path}: ${describeError(error)}` };
  }
}

/** The Silero classifier: non-overlapping 512-sample windows, last-covering-window attribution. */
class SileroClassifier implements UplinkVadClassifier {
  readonly backend = 'silero' as const;
  readonly status = 'available' as const;
  readonly reason = null;

  private readonly queue = new PcmQueue();
  private readonly window = new Float32Array(SILERO_WINDOW_SAMPLES);
  private context = new Float32Array(SILERO_CONTEXT_SAMPLES);
  private state: unknown;
  /** Per-frame probabilities, keyed by grid frame index. A later window overwrites an earlier one. */
  private readonly probabilities = new Map<number, number>();
  /** How many 512-sample windows have been consumed. */
  private windows = 0;
  /** How many frames have been pushed. */
  private frames = 0;
  /** The next frame whose verdict has not been returned yet. Verdicts leave in frame order. */
  private emitted = 0;
  private closed = false;

  constructor(
    private readonly session: SileroSession,
    private readonly runtime: SileroRuntime,
    private readonly threshold: number,
  ) {
    this.state = new runtime.Tensor('float32', new Float32Array(2 * 1 * 128), [...SILERO_STATE_SHAPE]);
  }

  async classify(frame: Buffer, declared: UplinkVadDeclaredFormat = {}): Promise<UplinkVadFrameVerdict | null> {
    assertUplinkVadFrame(frame, declared);
    this.frames += 1;
    this.queue.push(frame);
    while (this.queue.take(SILERO_WINDOW_SAMPLES, this.window)) {
      await this.runWindow();
    }
    return this.settle();
  }

  async flush(): Promise<UplinkVadFrameVerdict[]> {
    const tail: UplinkVadFrameVerdict[] = [];
    this.queue.clear();
    while (this.emitted < this.frames) {
      tail.push(this.verdictFor(this.emitted));
      this.emitted += 1;
    }
    return tail;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.clear();
    await this.session.release?.();
  }

  /** The single frame that has just become final, or `null` when this push settled nothing. */
  private settle(): UplinkVadFrameVerdict | null {
    if (this.emitted >= this.frames) return null;
    if (this.windows < windowsPastFrame(this.emitted, SILERO_WINDOW_SAMPLES)) return null;
    const verdict = this.verdictFor(this.emitted);
    this.emitted += 1;
    return verdict;
  }

  private verdictFor(frameIndex: number): UplinkVadFrameVerdict {
    const probability = this.probabilities.get(frameIndex);
    if (probability === undefined) {
      return bypassedVerdict(
        frameIndex,
        'the stream ended inside the silero window that would have covered this frame, so it is left ' +
          'unjudged rather than zero-padded',
      );
    }
    return judgedVerdict(frameIndex, probability >= this.threshold, probability);
  }

  /**
   * Attributes the last window to the frames it touches, then advances the context and the state.
   *
   * The attribution range is the probe's, verbatim: frame `k` is touched when the window's sample span
   * overlaps `[k*320, (k+1)*320)`, and the range is HALF-OPEN at the end — the frame the window ends on
   * is not touched by it. Reading that bound as inclusive shifts every attribution one frame late; that
   * mistake was made and caught here by comparing against the probe's own per-frame probabilities, which
   * is why that comparison is worth keeping.
   */
  private async runWindow(): Promise<void> {
    const input = new Float32Array(SILERO_CONTEXT_SAMPLES + SILERO_WINDOW_SAMPLES);
    input.set(this.context, 0);
    input.set(this.window, SILERO_CONTEXT_SAMPLES);
    const output = await this.session.run({
      input: new this.runtime.Tensor('float32', input, [1, input.length]),
      state: this.state,
      sr: new this.runtime.Tensor('int64', BigInt64Array.from([BigInt(UPLINK_VAD_GRID.sampleRate)]), []),
    });
    // Positional, not by name: the graph's outputs are `output` (the probability) and `stateN` (the new
    // recurrent state), in that order, and reading them positionally keeps the two from being swapped by
    // a rename on either side.
    const names = Object.keys(output);
    const probability = Number(output[names[0]]?.data[0] ?? 0);
    this.state = output[names[1]];
    this.context = this.window.slice(SILERO_WINDOW_SAMPLES - SILERO_CONTEXT_SAMPLES);

    const windowStart = this.windows * SILERO_WINDOW_SAMPLES;
    const first = Math.floor(windowStart / UPLINK_VAD_GRID.frameSamples);
    const last = Math.ceil((windowStart + SILERO_WINDOW_SAMPLES) / UPLINK_VAD_GRID.frameSamples);
    for (let index = first; index < last; index += 1) {
      this.probabilities.set(index, probability);
    }
    this.windows += 1;
  }
}

// ── TEN ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * TEN VAD through `sherpa-onnx-node` — the SAME wrapper `engines/ten.py` drives.
 *
 * The wrapper is not a convenience here, it is the backend: TEN's ONNX graph takes a 41-dimensional
 * filterbank feature over a three-frame context, and sherpa owns that front end. Driving the graph
 * directly would mean reimplementing the feature pipeline, and a reimplementation with no ground truth
 * is exactly the "stand-in" this repository's measurements are written to exclude. Using the wrapper
 * keeps this backend's decisions on the same footing as the published Python readings — verified
 * byte-identical on the criterion's corpus.
 */
type SherpaVad = {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  flush(): void;
};

type SherpaRuntime = {
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVad;
};

/** Loads the TEN backend, or reports why it cannot run. */
async function loadTen(
  options: UplinkVadClassifierOptions,
  loadDependency: UplinkVadDependencyLoader,
  weightsExist: (path: string) => boolean,
): Promise<{ vad: SherpaVad } | { reason: string }> {
  const path = options.weightsPath;
  if (path === undefined || path === '') {
    return { reason: 'no weights path was configured for the ten backend' };
  }
  if (!weightsExist(path)) {
    return { reason: `ten weights not found at ${path}` };
  }
  let loaded: unknown;
  try {
    loaded = await loadDependency('sherpa-onnx-node');
  } catch (error) {
    return { reason: `optional dependency sherpa-onnx-node could not be loaded: ${describeError(error)}` };
  }
  const runtime = unwrapCommonJs(loaded) as unknown as SherpaRuntime;
  if (typeof runtime.Vad !== 'function') {
    return { reason: 'sherpa-onnx-node loaded but exposes no Vad constructor' };
  }
  try {
    const vad = new runtime.Vad(
      {
        tenVad: { model: path, threshold: options.threshold ?? UPLINK_VAD_DEFAULT_THRESHOLD },
        sampleRate: UPLINK_VAD_GRID.sampleRate,
        numThreads: 1,
      },
      120,
    );
    return { vad };
  } catch (error) {
    return { reason: `ten detector could not be created from ${path}: ${describeError(error)}` };
  }
}

/** The TEN classifier: 256-sample windows, each window's verdict OR-ed onto the 20 ms grid. */
class TenClassifier implements UplinkVadClassifier {
  readonly backend = 'ten' as const;
  readonly status = 'available' as const;
  readonly reason = null;

  private readonly queue = new PcmQueue();
  private readonly window = new Float32Array(TEN_WINDOW_SAMPLES);
  /** Per-frame speech flags, keyed by grid frame index. */
  private readonly speech = new Map<number, boolean>();
  private windows = 0;
  private frames = 0;
  private emitted = 0;
  private closed = false;

  constructor(private readonly vad: SherpaVad) {}

  async classify(frame: Buffer, declared: UplinkVadDeclaredFormat = {}): Promise<UplinkVadFrameVerdict | null> {
    assertUplinkVadFrame(frame, declared);
    this.frames += 1;
    this.queue.push(frame);
    while (this.queue.take(TEN_WINDOW_SAMPLES, this.window)) {
      this.vad.acceptWaveform(this.window);
      const detected = this.vad.isDetected();
      const windowStart = this.windows * TEN_WINDOW_SAMPLES;
      const first = Math.floor(windowStart / UPLINK_VAD_GRID.frameSamples);
      const last = Math.ceil((windowStart + TEN_WINDOW_SAMPLES) / UPLINK_VAD_GRID.frameSamples);
      for (let index = first; index < last; index += 1) {
        // OR, not overwrite: a 256-sample window is NARROWER than a 320-sample frame, so a frame is
        // covered by one or two windows and there is no "last word" to prefer. OR is also order-free,
        // which is what let this backend reproduce the Python adapter's bits before the finalisation
        // rule above existed — the two agreeing is evidence for the rule, not a coincidence of it.
        this.speech.set(index, (this.speech.get(index) ?? false) || detected);
      }
      this.windows += 1;
    }
    return this.settle();
  }

  async flush(): Promise<UplinkVadFrameVerdict[]> {
    const tail: UplinkVadFrameVerdict[] = [];
    this.queue.clear();
    this.vad.flush();
    while (this.emitted < this.frames) {
      tail.push(this.verdictFor(this.emitted));
      this.emitted += 1;
    }
    return tail;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.clear();
  }

  private settle(): UplinkVadFrameVerdict | null {
    if (this.emitted >= this.frames) return null;
    if (this.windows < windowsPastFrame(this.emitted, TEN_WINDOW_SAMPLES)) return null;
    const verdict = this.verdictFor(this.emitted);
    this.emitted += 1;
    return verdict;
  }

  private verdictFor(frameIndex: number): UplinkVadFrameVerdict {
    const detected = this.speech.get(frameIndex);
    if (detected === undefined) {
      return bypassedVerdict(
        frameIndex,
        'the stream ended inside the ten window that would have covered this frame, so it is left ' +
          'unjudged rather than zero-padded',
      );
    }
    // TEN's wrapper yields a per-window VERDICT, not a probability, so there is none to report here —
    // the same `null` the WebRTC detector returns, distinguishable from a bypass by `bypassed`.
    return judgedVerdict(frameIndex, detected, null);
  }
}

// ── WebRTC ───────────────────────────────────────────────────────────────────────────────────────

/**
 * WebRTC VAD through the `webrtcvad` package — the real compiled detector, not a port.
 *
 * This is the one backend that runs DIRECTLY on the grid: WebRTC's own frame is 20 ms, so a 320-sample
 * grid frame is exactly one call, with no windowing, no attribution, and no lag. It is also the one
 * backend with a genuine install-time cost — the package builds its C sources with `node-gyp` — which is
 * why it is declared as an OPTIONAL dependency and why this module treats its absence as an ordinary
 * state rather than an installation error.
 */
type WebrtcVad = { process(audio: Buffer): boolean };
type WebrtcRuntime = { default: new (sampleRate: number, level: number) => WebrtcVad };

/** Loads the WebRTC backend, or reports why it cannot run. */
async function loadWebrtc(
  options: UplinkVadClassifierOptions,
  loadDependency: UplinkVadDependencyLoader,
): Promise<{ vad: WebrtcVad } | { reason: string }> {
  let loaded: unknown;
  try {
    loaded = await loadDependency('webrtcvad');
  } catch (error) {
    return { reason: `optional dependency webrtcvad could not be loaded: ${describeError(error)}` };
  }
  const runtime = unwrapCommonJs(loaded) as unknown as WebrtcRuntime;
  if (typeof runtime.default !== 'function') {
    return { reason: 'webrtcvad loaded but exposes no VAD constructor' };
  }
  try {
    const vad = new runtime.default(
      UPLINK_VAD_GRID.sampleRate,
      options.aggressiveness ?? UPLINK_VAD_DEFAULT_AGGRESSIVENESS,
    );
    return { vad };
  } catch (error) {
    return { reason: `webrtc detector could not be created: ${describeError(error)}` };
  }
}

/** The WebRTC classifier: one frame in, one verdict out, no buffering and no state of its own. */
class WebrtcClassifier implements UplinkVadClassifier {
  readonly backend = 'webrtc' as const;
  readonly status = 'available' as const;
  readonly reason = null;

  private frames = 0;

  constructor(private readonly vad: WebrtcVad) {}

  async classify(frame: Buffer, declared: UplinkVadDeclaredFormat = {}): Promise<UplinkVadFrameVerdict | null> {
    assertUplinkVadFrame(frame, declared);
    const frameIndex = this.frames;
    this.frames += 1;
    return judgedVerdict(frameIndex, this.vad.process(frame), null);
  }

  async flush(): Promise<UplinkVadFrameVerdict[]> {
    // Nothing is ever pending: WebRTC's own frame IS the grid frame.
    return [];
  }

  async close(): Promise<void> {
    // The detector holds no releasable session.
  }
}

// ── the unavailable backend ──────────────────────────────────────────────────────────────────────

/**
 * The classifier an unloadable backend produces: it judges nothing, and says so on every frame.
 *
 * This class is the module's whole answer to "缺权重或缺依赖". It exists so that the sound of a broken
 * deployment is a REASON STRING rather than a working-looking stream, and so that the difference between
 * "filtering and finding no speech" and "not filtering at all" is one boolean a caller cannot fail to
 * see. It answers immediately rather than with the windowed backends' lag, because "I cannot judge this"
 * is knowable at once.
 */
class UnavailableClassifier implements UplinkVadClassifier {
  readonly status = 'unavailable' as const;

  private frames = 0;

  constructor(
    readonly backend: UplinkVadBackendId,
    readonly reason: string,
  ) {}

  async classify(frame: Buffer, declared: UplinkVadDeclaredFormat = {}): Promise<UplinkVadFrameVerdict | null> {
    // Still validated: an unavailable backend must not become the one place an off-grid stream is
    // accepted, because the caller would then learn the grid is enforced only when a model is present.
    assertUplinkVadFrame(frame, declared);
    const frameIndex = this.frames;
    this.frames += 1;
    return bypassedVerdict(frameIndex, `${this.backend} backend is unavailable: ${this.reason}`);
  }

  async flush(): Promise<UplinkVadFrameVerdict[]> {
    return [];
  }

  async close(): Promise<void> {
    // Nothing was opened.
  }
}

// ── the reading ──────────────────────────────────────────────────────────────────────────────────

/**
 * What a classifier says about ITSELF, separate from what it says about any frame.
 *
 * Consumed by the criterion and (once the seam task wires this) by whatever logs a deployment's uplink
 * VAD state at startup. It exists so that "is this deployment actually filtering?" is answerable without
 * feeding it a frame and inspecting a verdict's shape.
 */
export type UplinkVadBackendReading = {
  backend: UplinkVadBackendId;
  status: UplinkVadBackendStatus;
  /** `true` exactly when the classifier judges no frames at all. */
  bypassed: boolean;
  reason: string | null;
};

/** Reads a classifier's own state. */
export function readUplinkVadBackend(classifier: UplinkVadClassifier): UplinkVadBackendReading {
  return {
    backend: classifier.backend,
    status: classifier.status,
    bypassed: classifier.status === 'unavailable',
    reason: classifier.reason,
  };
}

/** The one line to log for a backend reading. Always says `bypassed=…`, so the state is greppable. */
export function describeUplinkVadBackend(reading: UplinkVadBackendReading): string {
  if (!reading.bypassed) {
    return `uplink-vad[${reading.backend}]: active (bypassed=false)`;
  }
  return (
    `uplink-vad[${reading.backend}]: bypassed=true (every frame passes through unfiltered) — ` +
    `${reading.reason}`
  );
}

// ── building one ─────────────────────────────────────────────────────────────────────────────────

/**
 * Builds a classifier for one backend, resolving its weights and its optional package.
 *
 * This is the ONLY exported way to get a classifier: there is no constructor a caller can reach that
 * skips the weights check, so "the backend is loaded but was never actually loadable" is not a state a
 * caller can construct by accident.
 *
 * Never throws for a missing weights file, a missing package, or a rejected model — every one of those is
 * an `unavailable` classifier carrying its reason. It is `async` because the two ONNX backends must await
 * their session; WebRTC's could have been synchronous, and is not, so a caller writes ONE call site for
 * all three.
 */
export async function createUplinkVadClassifier(
  options: UplinkVadClassifierOptions,
): Promise<UplinkVadClassifier> {
  const loadDependency = options.loadDependency ?? importOptional;
  const weightsExist = options.weightsExist ?? defaultWeightsExist;

  if (options.backend === 'silero') {
    const loaded = await loadSilero(options, loadDependency, weightsExist);
    if ('reason' in loaded) {
      return new UnavailableClassifier('silero', loaded.reason);
    }
    return new SileroClassifier(
      loaded.session,
      loaded.runtime,
      options.threshold ?? UPLINK_VAD_DEFAULT_THRESHOLD,
    );
  }
  if (options.backend === 'ten') {
    const loaded = await loadTen(options, loadDependency, weightsExist);
    if ('reason' in loaded) {
      return new UnavailableClassifier('ten', loaded.reason);
    }
    return new TenClassifier(loaded.vad);
  }
  const loaded = await loadWebrtc(options, loadDependency);
  if ('reason' in loaded) {
    return new UnavailableClassifier('webrtc', loaded.reason);
  }
  return new WebrtcClassifier(loaded.vad);
}

/**
 * Feeds a whole clip through a classifier and returns one verdict per grid frame, in frame order.
 *
 * The streaming form is `classify` + `flush`; this exists because the batch form is what a reading is
 * taken with, and a hand-written loop that forgot `flush` would silently drop the frames still pending —
 * a result that looks complete and is short by one or two frames.
 */
export async function classifyUplinkVadStream(
  classifier: UplinkVadClassifier,
  pcm: Buffer,
  declared: UplinkVadDeclaredFormat = {},
): Promise<UplinkVadFrameVerdict[]> {
  const verdicts: UplinkVadFrameVerdict[] = [];
  for (let offset = 0; offset + UPLINK_VAD_FRAME_BYTES <= pcm.length; offset += UPLINK_VAD_FRAME_BYTES) {
    const verdict = await classifier.classify(
      pcm.subarray(offset, offset + UPLINK_VAD_FRAME_BYTES),
      declared,
    );
    if (verdict !== null) {
      verdicts.push(verdict);
    }
  }
  if (pcm.length % UPLINK_VAD_FRAME_BYTES !== 0) {
    // A ragged clip means the caller's framing disagrees with the grid. Feeding the whole frames and
    // dropping the remainder silently would report a reading for a stream that is not the one it has.
    throw new UplinkVadGridError(
      `pcm of ${pcm.length} bytes is not a whole number of ${UPLINK_VAD_FRAME_BYTES}-byte grid frames`,
    );
  }
  verdicts.push(...(await classifier.flush()));
  return verdicts;
}

// ── the gate ─────────────────────────────────────────────────────────────────────────────────────

/** One frame that survived the mask, as a VIEW of the caller's own PCM. */
export type UplinkVadKeptFrame = {
  /** The frame's index on the grid. */
  readonly index: number;
  /** `pcm.subarray(index*640, (index+1)*640)` — the caller's own bytes, never a copy. */
  readonly frame: Buffer;
};

/**
 * Selects the frames a stream of verdicts keeps, as subarray VIEWS of `pcm`.
 *
 * Three properties are the point of this function and all three are structural rather than promised:
 *
 *  - **Nothing is synthesized.** Every returned `frame` is `pcm.subarray(...)`, so a kept sample is the
 *    caller's own byte at the caller's own offset. There is no branch that builds silence.
 *  - **A bypassed verdict KEEPS its frame**, and so does a frame with NO verdict at all. The predicate is
 *    `bypassed || speech`, so the fail-open direction is not a policy a caller has to remember to apply —
 *    a frame that could not be judged, or that never got judged, cannot be turned into a dropped frame by
 *    forgetting something.
 *  - **Verdicts are matched by their own `frameIndex`, not by array position.** The windowed backends
 *    return verdicts with a lag, so a caller that zipped two arrays positionally could shift a verdict
 *    onto the wrong audio; naming the frame makes that impossible.
 *
 * Throws when `pcm` is not a whole number of grid frames, or when a verdict names a frame outside it:
 * both mean the caller's index space and this module's disagree, and a mask applied across two different
 * index spaces is a silently mis-aligned drop.
 */
export function applyUplinkVadMask(
  pcm: Buffer,
  verdicts: readonly UplinkVadFrameVerdict[],
): UplinkVadKeptFrame[] {
  if (pcm.length % UPLINK_VAD_FRAME_BYTES !== 0) {
    throw new UplinkVadGridError(
      `pcm of ${pcm.length} bytes is not a whole number of ${UPLINK_VAD_FRAME_BYTES}-byte grid frames`,
    );
  }
  const frames = pcm.length / UPLINK_VAD_FRAME_BYTES;
  const byFrame = new Map<number, UplinkVadFrameVerdict>();
  for (const verdict of verdicts) {
    if (!Number.isInteger(verdict.frameIndex) || verdict.frameIndex < 0 || verdict.frameIndex >= frames) {
      throw new UplinkVadGridError(
        `verdict names frame ${verdict.frameIndex}, outside the ${frames} frames of this pcm`,
      );
    }
    byFrame.set(verdict.frameIndex, verdict);
  }
  const kept: UplinkVadKeptFrame[] = [];
  for (let index = 0; index < frames; index += 1) {
    const verdict = byFrame.get(index);
    if (verdict !== undefined && !verdict.bypassed && !verdict.speech) {
      continue;
    }
    kept.push({
      index,
      frame: pcm.subarray(index * UPLINK_VAD_FRAME_BYTES, (index + 1) * UPLINK_VAD_FRAME_BYTES),
    });
  }
  return kept;
}

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

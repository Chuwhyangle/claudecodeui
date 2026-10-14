// The uplink VAD's PRODUCTION ARM POINT: the environment switch that turns the continuous wire's
// per-frame speech gate on, and the connection-level state machine that decides, per frame, whether
// there is a classifier to consult at all.
//
// WHY THIS IS ITS OWN FILE. The classifier (`voice-realtime-uplink-vad.ts`) is contractually pure — its
// criterion greps that module for allocation primitives and for any mention of the production seam, and
// both counts must be zero. This file names production and decodes nothing; putting it there would make
// that module's own contract self-contradictory. The streaming gate is a third file for the same reason
// (it decodes base64), so the three sit side by side: pure classifier · streaming gate · production arm.
//
// WHY THE STATE MACHINE EXISTS AT ALL. Two facts the seam alone could not express:
//
//   1. THE CLASSIFIER IS BUILT ASYNCHRONOUSLY, but the assembly point (`server/index.ts`) is a
//      synchronous function handed one classifier per connection. `createUplinkVadClassifier` must await
//      an ONNX session or a `node-gyp`-built package, so a connection that asked for the gate is
//      necessarily `loading` for its first frames. Those frames must cross UNJUDGED — immediately, not
//      buffered — because holding a person's first words while a model warms up is the one failure mode
//      an uplink gate must never introduce.
//   2. A BACKEND THAT IS UNLOADABLE IS A CONNECTION-LEVEL FACT, not a per-frame verdict. An unavailable
//      backend (`status: 'unavailable'`) withholds nothing, but a reader of the per-frame verdicts alone
//      cannot tell "this deployment is filtering and finding no speech" from "this deployment is not
//      filtering at all" (the same confusion `UplinkVadBackendReading` exists to prevent).
//
// Consumers:
//   · `server/index.ts` — resolves the environment once per connection and builds one arm point, which
//     it hands to the proxy as the seam's classifier.
//   · `voice-realtime-ws-proxy.service.ts` — reads the arm point's state per frame, forwards through it,
//     and flips it to `failed` when the backend throws (the fail-safe bypass).
//   · `server/modules/voice-realtime/tests/voice-realtime-uplink-vad-arm-point.test.ts` — the criterion.

import {
  UPLINK_VAD_BACKENDS,
  bypassedVerdict,
  createUplinkVadClassifier,
  type UplinkVadBackendId,
  type UplinkVadClassifier,
  type UplinkVadClassifierOptions,
  type UplinkVadDeclaredFormat,
  type UplinkVadFrameVerdict,
} from './voice-realtime-uplink-vad.js';

// ── the environment switch ────────────────────────────────────────────────────────────────────────

/** The switch: `off` (the shipped state) or one of the three backend names. */
export const VOICE_REALTIME_UPLINK_VAD_ENV = 'VOICE_REALTIME_UPLINK_VAD';

/** Where Silero/TEN read their `.onnx` weights from. WebRTC needs none. */
export const VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH_ENV = 'VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH';

/** The spelling that means "do not build a gate" — the default a deployment that configured nothing gets. */
export const UPLINK_VAD_OFF = 'off';

/**
 * What a deployment's environment asks for.
 *
 * `enabled` is the whole decision: `false` means the proxy takes the `=== null` fast path and the wire
 * is byte-for-byte the relay it was before this feature existed. `invalid` carries the offending raw
 * value when the environment named something this module does not know, so a typo is REPORTED rather
 * than silently passing for a working switch (the shape `resolveVoiceRealtimeMode` established).
 */
export type UplinkVadArmResolution = {
  enabled: boolean;
  /** The backend the environment named, or `null` when the gate is off. */
  backend: UplinkVadBackendId | null;
  /** The weights path as the environment spelled it; `''` when unset (Silero/TEN then report unavailable). */
  weightsPath: string;
  /** The offending raw value, or `null`. Non-null implies `enabled === false`. */
  invalid: string | null;
};

/**
 * Resolves the switch and the weights path. Pure: takes the environment as an argument, so a criterion
 * drives every spelling without touching `process.env`.
 *
 * `off` and "unset" are the SAME state — the shipped one — and both are silent. An unknown value is
 * reported through `invalid`, which is what keeps a typo from passing for a working configuration.
 */
export function resolveUplinkVad(env: NodeJS.ProcessEnv): UplinkVadArmResolution {
  const weightsPath = (env[VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH_ENV] ?? '').trim();
  const raw = env[VOICE_REALTIME_UPLINK_VAD_ENV];
  const value = raw === undefined ? '' : raw.trim().toLowerCase();
  if (value === '' || value === UPLINK_VAD_OFF) {
    return { enabled: false, backend: null, weightsPath, invalid: null };
  }
  if ((UPLINK_VAD_BACKENDS as readonly string[]).includes(value)) {
    return { enabled: true, backend: value as UplinkVadBackendId, weightsPath, invalid: null };
  }
  return { enabled: false, backend: null, weightsPath, invalid: raw as string };
}

/**
 * The one line to log for a resolution, or `null` when there is nothing to say.
 *
 * Silence on "off" is deliberate, exactly as the STS switch is silent when unconfigured: a deployment
 * that named nothing must not read a line about a gate it never asked for. A typo, by contrast, does
 * read one — that line is the whole point of the `invalid` field.
 */
export function describeUplinkVad(resolution: UplinkVadArmResolution): string | null {
  if (resolution.invalid !== null) {
    return (
      `uplink-vad: ${VOICE_REALTIME_UPLINK_VAD_ENV}="${resolution.invalid}" is not one of ` +
      `${UPLINK_VAD_OFF}/${UPLINK_VAD_BACKENDS.join('/')} — using the default (${UPLINK_VAD_OFF})`
    );
  }
  if (!resolution.enabled) {
    return null;
  }
  return (
    `uplink-vad: ${VOICE_REALTIME_UPLINK_VAD_ENV}=${resolution.backend} requested` +
    (resolution.weightsPath === '' ? '' : ` weights=${resolution.weightsPath}`)
  );
}

// ── the connection-level state machine ────────────────────────────────────────────────────────────

/**
 * One connection's uplink-VAD state.
 *
 * `disabled` is the seam's absence (`uplinkVad === undefined`), so a connection in that state never
 * builds an arm point at all; the other four are the arm point's own.
 */
export type UplinkVadConnectionState = 'disabled' | 'loading' | 'ready' | 'bypassed' | 'failed';

/**
 * One connection's arm point: the backend classifier plus the state that says whether it may be consulted.
 *
 * It IS an {@link UplinkVadClassifier} — same `backend`/`status`/`classify`/`flush`/`close` surface — so
 * the gate (`voice-realtime-uplink-vad-gate.ts`) and the proxy's seam type need no special case to hold
 * one. The extra `state` is what the proxy reads to decide whether a frame may go through the gate at
 * all, and `markFailed` is how the proxy records a backend failure the classifier could not.
 */
export type UplinkVadArmPoint = UplinkVadClassifier & {
  /** The connection-level state. Read per frame by the proxy; logged on every transition. */
  readonly state: UplinkVadConnectionState;
  /** Why the state is not `ready`; `null` exactly when it is. */
  readonly stateReason: string | null;
  /**
   * Degrades the connection for good: from here every frame passes through unjudged and the backend is
   * never consulted again. Idempotent, and one-way — a backend that failed once is not retried.
   */
  markFailed(reason: string): void;
};

/** How to build an arm point. */
export type UplinkVadArmPointOptions = {
  backend: UplinkVadBackendId;
  /** Silero/TEN's weights; omitted, those two report unavailable rather than guessing a path. */
  weightsPath?: string;
  threshold?: number;
  aggressiveness?: number;
  /** The connection's log sink, so every transition is visible where the connection's other lines go. */
  log?: (line: string) => void;
  /**
   * Test seam: how the backend classifier is built. Defaults to {@link createUplinkVadClassifier}, so a
   * criterion can drive the four states deterministically without a model or a weights file.
   */
  createClassifier?: (options: UplinkVadClassifierOptions) => Promise<UplinkVadClassifier>;
};

/** A backend failure's message, for a log line and a state reason. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds one connection's arm point and starts its backend load.
 *
 * The load runs in the background: the returned object is immediately usable and starts `loading`, and
 * the load's outcome moves it to `ready` or `bypassed`. A load that REJECTS is treated as `failed` —
 * the same fail-safe posture as a runtime throw, because the connection must not be left holding a
 * classifier that will never arrive.
 */
export function createUplinkVadArmPoint(options: UplinkVadArmPointOptions): UplinkVadArmPoint {
  const build = options.createClassifier ?? createUplinkVadClassifier;
  let state: UplinkVadConnectionState = 'loading';
  let stateReason: string | null = 'the classifier is still being constructed';
  let classifier: UplinkVadClassifier | null = null;
  let closed = false;
  /** Frames this arm point has been asked about — the index space of the verdicts IT returns. */
  let frames = 0;
  /**
   * The backend's own index of the first frame it judged, or `-1` until it judges one.
   *
   * The backend's counter starts at 0 on ITS first frame, while this arm point has already answered
   * `loading`/`bypassed` frames — and those answers were bypassed verdicts carrying THIS arm point's
   * indices. Verdicts are therefore rebased onto the arm point's index space, which is the one the
   * gate's buffered frames are keyed by; without it a verdict would be filed against the wrong frame
   * and the gate's head would stall forever.
   */
  let backendOffset = -1;

  const transition = (next: UplinkVadConnectionState, reason: string | null): void => {
    state = next;
    stateReason = reason;
    options.log?.(
      `uplink_vad: state=${next} backend=${options.backend}` +
        (reason === null ? '' : ` reason=${reason}`),
    );
  };

  // The connection is BORN LOADING — the backend is built asynchronously just below — and that birth is
  // announced like any other transition, so the state is readable from the connection's own log from
  // frame zero. Without this, `loading` would be the one state a reader could only infer.
  transition('loading', 'the classifier is still being constructed');

  void build({
    backend: options.backend,
    ...(options.weightsPath === undefined || options.weightsPath === ''
      ? {}
      : { weightsPath: options.weightsPath }),
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    ...(options.aggressiveness === undefined ? {} : { aggressiveness: options.aggressiveness }),
  })
    .then((loaded) => {
      if (closed || state === 'failed') {
        // The connection ended (or degraded) while the classifier was loading. Release it here: the
        // session this load just opened must not outlive the connection that asked for it.
        void loaded.close().catch(() => undefined);
        return;
      }
      classifier = loaded;
      if (loaded.status === 'unavailable') {
        transition('bypassed', loaded.reason ?? `${options.backend} reported unavailable`);
      } else {
        transition('ready', null);
      }
    })
    .catch((error) => {
      transition('failed', `the classifier could not be built: ${describeError(error)}`);
    });

  return {
    backend: options.backend,

    // `loading` reads as `available` to `readUplinkVadBackend`: the backend has not said otherwise yet,
    // and the `state` field — logged beside it and readable by the criterion — is the honest reading.
    // The two failure states read as `unavailable`, which is what they are.
    get status(): 'available' | 'unavailable' {
      return state === 'bypassed' || state === 'failed' ? 'unavailable' : 'available';
    },

    get reason(): string | null {
      return stateReason;
    },

    get state(): UplinkVadConnectionState {
      return state;
    },

    get stateReason(): string | null {
      return stateReason;
    },

    markFailed(reason: string): void {
      if (state === 'failed') {
        return;
      }
      transition('failed', reason);
    },

    async classify(
      frame: Buffer,
      declared?: UplinkVadDeclaredFormat,
    ): Promise<UplinkVadFrameVerdict | null> {
      const index = frames;
      frames += 1;
      if (state === 'ready' && classifier !== null) {
        if (backendOffset < 0) {
          backendOffset = index;
        }
        const verdict = await classifier.classify(frame, declared);
        // A backend error is NOT caught here: the proxy owns the fail-safe policy (forward the frame,
        // then pass every later frame straight through), and it can only apply it to an error it sees.
        return verdict === null ? null : { ...verdict, frameIndex: verdict.frameIndex + backendOffset };
      }
      // `loading`, `bypassed` or `failed` — there is no model to consult. The frame is BYPASSED, i.e.
      // forwarded immediately and unjudged: fail-open, the one direction an uplink VAD must never get
      // wrong. It is an answer on this same tick, never a promise to answer later, so nothing buffers.
      return bypassedVerdict(index, `uplink VAD is ${state}: ${stateReason ?? 'no classifier'}`);
    },

    async flush(): Promise<UplinkVadFrameVerdict[]> {
      if (state !== 'ready' || classifier === null) {
        return [];
      }
      const offset = backendOffset < 0 ? 0 : backendOffset;
      const tail = await classifier.flush();
      return tail.map((verdict) => ({ ...verdict, frameIndex: verdict.frameIndex + offset }));
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      if (classifier !== null) {
        try {
          await classifier.close();
        } catch {
          // A backend that cannot release must not keep a dead connection's socket open.
        }
      }
      // A classifier still loading is released by the load continuation above, which sees `closed`.
    },
  };
}

// ── the proxy's two readings ──────────────────────────────────────────────────────────────────────

/**
 * The arm point hiding inside a seam's classifier, or `null` when the classifier is a plain one.
 *
 * The seam's type is `UplinkVadClassifier` (the probe and the seam criteria inject hand-built ones), so
 * the state machine is detected by its one distinguishing member rather than by a widened seam type that
 * every caller would then have to satisfy.
 */
export function readUplinkVadArmPoint(classifier: UplinkVadClassifier): UplinkVadArmPoint | null {
  return typeof (classifier as Partial<UplinkVadArmPoint>).markFailed === 'function'
    ? (classifier as UplinkVadArmPoint)
    : null;
}

/**
 * The connection-level state of a seam's classifier. A classifier that is not an arm point reads as
 * `ready` — it is a hand-injected backend (the seam criteria's) with no state machine to be in.
 */
export function readUplinkVadState(classifier: UplinkVadClassifier | null): UplinkVadConnectionState {
  if (classifier === null) {
    return 'disabled';
  }
  return readUplinkVadArmPoint(classifier)?.state ?? 'ready';
}

/** Degrades an arm point to `failed`; a plain classifier has no state to degrade, so this is a no-op. */
export function markUplinkVadFailed(classifier: UplinkVadClassifier | null, reason: string): void {
  if (classifier === null) {
    return;
  }
  readUplinkVadArmPoint(classifier)?.markFailed(reason);
}

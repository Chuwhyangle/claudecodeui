/**
 * The ordered step table for `/voice-realtime`'s CONNECTION LIFECYCLE.
 *
 * The inbound-frame extension point (`voice-realtime-frame-registry.ts`) gave the proxy's
 * LEAVES a registration slot. What stayed hard-coded was the TRUNK: the cross-cutting
 * things a connection does at fixed moments — what happens once the upstream handshake
 * settles, around every inbound frame, at the model-stop fence, when an instruction goes
 * upstream, and on the way out. Each of those was an `if`/call sequence inside
 * `handleVoiceRealtimeConnection`, so a new lifecycle concern meant another edit to the
 * 6.5k-line centre.
 *
 * This seam is the trunk's registration slot. A timing names a moment in the connection's
 * life; a step is `{ timing, name, label, source, run(context) }`; the table is an ORDERED
 * list per timing, and registration order IS execution order. The shipped steps live in
 * `voice-realtime-trunk-step-handlers.ts`, a sibling file; the proxy only builds the
 * context and traverses the table.
 *
 * ## Why this is a table and not a set of replaceable callbacks
 *
 * One callback per timing would be an R1 extraction: the centre would still name each
 * step, and the file would keep growing with every new concern. Here a timing holds a
 * LIST, several steps may run at one moment in a declared order, `unregister` removes one,
 * and a step registered from outside this module is what the connection runs. That is what
 * makes "add a lifecycle step" a change in a sibling file rather than in the centre.
 *
 * ## Dispatch when nothing is registered
 *
 * `run` iterates whatever is registered and returns the steps it ran. An EMPTY timing runs
 * nothing and reports that — it does not throw and it does not fall back to a built-in
 * body, exactly as `VoiceRealtimeFrameRegistry.dispatch` returns `null` rather than
 * inventing a handler. That is what makes the negative control meaningful: unregister a
 * step, run the timing again, and its body must not run.
 *
 * ## The context
 *
 * A step receives the connection-scoped ports it may reach plus a per-timing `payload`.
 * The payload is the timing's own reading (and, where the step DECIDES, the field it
 * writes back: the parsed frame at `before-frame`, the fence's decision at
 * `interrupt-decision`, whether a `session.update` left at `status-injection`). Steps
 * cannot reach any other connection private — the same discipline the frame registry
 * states for its handlers.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (builds the context and traverses at
 * each timing), `voice-realtime-trunk-step-handlers.ts` (the shipped registrations) and
 * `tests/voice-realtime-trunk-steps.test.ts` (the criterion).
 */
import type { RealtimeBridge } from './voice-realtime-bridge.service.js';
import type { UplinkVadGate } from './voice-realtime-uplink-vad-gate.js';
import type {
  ModelInterruptDecision,
  VoiceRealtimeInboundFrame,
  VoiceRealtimeOutboundFrame,
  VoiceRealtimeProxySeams,
} from './voice-realtime-ws-proxy.service.js';

/**
 * The moments in a connection's life the table can hold steps for.
 *
 * Named for the MOMENT, not for what a particular step does — a timing is a place in the
 * lifecycle, and several unrelated concerns may register at one place.
 *
 *  - `after-handshake` — the upstream session has settled: open, or unreachable.
 *  - `before-frame` — one raw browser frame arrived, not yet parsed or routed.
 *  - `after-frame` — one parsed frame has been dispatched to the frame registry.
 *  - `interrupt-decision` — the model asked for a stop; the fence decides abort vs covered.
 *  - `status-injection` — the composed instructions (context pack + status line) go upstream.
 *  - `before-close` — the connection is on its way out, before the socket is closed.
 */
export type VoiceRealtimeTrunkTiming =
  | 'after-handshake'
  | 'before-frame'
  | 'after-frame'
  | 'interrupt-decision'
  | 'status-injection'
  | 'before-close';

/** Every timing, in lifecycle order — the shape of the trunk this seam makes extensible. */
export const VOICE_REALTIME_TRUNK_TIMINGS: readonly VoiceRealtimeTrunkTiming[] = [
  'after-handshake',
  'before-frame',
  'after-frame',
  'interrupt-decision',
  'status-injection',
  'before-close',
];

/**
 * The reading each timing hands its steps.
 *
 * Mutable fields are the two the DEFAULT steps write back into the centre's control flow —
 * the parsed frame (`before-frame`) and the fence's decision (`interrupt-decision`) — plus
 * `sent` at `status-injection`. Everything else is a reading the step may consume.
 */
export type VoiceRealtimeTrunkPayloads = {
  /** `connected` is `bridge.state === 'open'` at the moment the handshake settled. */
  'after-handshake': { readonly connected: boolean };
  /** The raw browser message, and the frame the parse step produced (`null` = drop it). */
  'before-frame': { readonly raw: unknown; frame: VoiceRealtimeInboundFrame | null };
  /** The frame the connection just routed through the frame registry. */
  'after-frame': { readonly frame: VoiceRealtimeInboundFrame };
  /** The fence's own inputs, and the decision the table produced. */
  'interrupt-decision': {
    readonly triggerSeq: number | null;
    readonly coveredSeqs: ReadonlySet<number>;
    readonly abortedTriggerSeq: number | null;
    decision: ModelInterruptDecision | null;
  };
  /** The instruction text composed for this injection, and whether a frame left upstream. */
  'status-injection': { readonly instructions: string; sent: boolean };
  /** How many browser audio frames this connection received, for the exit's own log lines. */
  'before-close': { readonly audioFramesFromBrowser: number };
};

/**
 * What a registered step may reach.
 *
 * Only the connection-scoped ports a lifecycle step has ever needed: the injected seams,
 * the downlink, the bridge, the connection's terminal operation, the instruction
 * advertiser and the uplink gate. Each is the SAME value the centre holds — this is a
 * view, not a second copy, so a step and the centre cannot disagree about the connection.
 */
export type VoiceRealtimeTrunkContext<T extends VoiceRealtimeTrunkTiming = VoiceRealtimeTrunkTiming> = {
  readonly timing: T;
  readonly seams: VoiceRealtimeProxySeams;
  readonly send: (frame: VoiceRealtimeOutboundFrame) => void;
  readonly bridge: RealtimeBridge;
  readonly teardown: () => void;
  readonly advertiseInstructions: () => boolean;
  readonly uplinkVad: UplinkVadGate | null;
  readonly payload: VoiceRealtimeTrunkPayloads[T];
};

/**
 * One registered step.
 *
 * `name` is stable within its timing (registering the same name again REPLACES that slot
 * in place, so a criterion's probe can stand in for a shipped step without moving the
 * order), `label` is the registration's own name, and `source` is the file the step was
 * defined in — the value the criterion compares with the proxy's own path to prove a step
 * came from outside it.
 */
export type VoiceRealtimeTrunkStep<T extends VoiceRealtimeTrunkTiming = VoiceRealtimeTrunkTiming> = {
  readonly name: string;
  readonly timing: T;
  readonly label: string;
  readonly source: string;
  readonly run: (context: VoiceRealtimeTrunkContext<T>) => void;
};

/**
 * The ordered table of lifecycle steps, one list per timing.
 *
 * `register` appends at the end of its timing's list, or replaces the step of the same
 * name in the slot it already holds. `unregister` removes one. `run` is the only execution
 * path: it walks the registered steps for one timing IN ORDER, so "which step runs first"
 * is the table's answer rather than the centre's.
 */
export class VoiceRealtimeTrunkStepRegistry {
  private readonly table = new Map<VoiceRealtimeTrunkTiming, VoiceRealtimeTrunkStep[]>();

  /** Adds a step at the end of its timing, or replaces the same-named step in place. */
  register<T extends VoiceRealtimeTrunkTiming>(step: VoiceRealtimeTrunkStep<T>): VoiceRealtimeTrunkStepRegistry {
    const steps = this.table.get(step.timing) ?? [];
    // The table is deliberately heterogeneous — one list holds steps of every timing — so a
    // timing-specific step is stored in its erased form. Erasing HERE (once per registration)
    // is what lets each step DECLARE its precise context type at the site it is written.
    const erased = step as unknown as VoiceRealtimeTrunkStep;
    const existing = steps.findIndex((candidate) => candidate.name === step.name);
    if (existing >= 0) {
      steps[existing] = erased;
    } else {
      steps.push(erased);
    }
    this.table.set(step.timing, steps);
    return this;
  }

  /** Removes the named step from a timing. Returns whether one was registered. */
  unregister(timing: VoiceRealtimeTrunkTiming, name: string): boolean {
    const steps = this.table.get(timing);
    if (steps === undefined) {
      return false;
    }
    const index = steps.findIndex((candidate) => candidate.name === name);
    if (index < 0) {
      return false;
    }
    steps.splice(index, 1);
    return true;
  }

  /** The steps registered for a timing, in execution order (a snapshot, never the live list). */
  stepsFor(timing: VoiceRealtimeTrunkTiming): readonly VoiceRealtimeTrunkStep[] {
    return [...(this.table.get(timing) ?? [])];
  }

  /** The names registered for a timing, in execution order. */
  names(timing: VoiceRealtimeTrunkTiming): string[] {
    return this.stepsFor(timing).map((step) => step.name);
  }

  /**
   * Runs every step registered for `timing`, in order, and returns the ones that ran.
   *
   * An empty timing runs nothing and returns `[]` — no throw, no built-in fallback.
   */
  run<T extends VoiceRealtimeTrunkTiming>(
    timing: T,
    context: VoiceRealtimeTrunkContext<T>,
  ): readonly VoiceRealtimeTrunkStep<T>[] {
    const steps = this.stepsFor(timing) as unknown as readonly VoiceRealtimeTrunkStep<T>[];
    for (const step of steps) {
      step.run(context);
    }
    return steps;
  }
}

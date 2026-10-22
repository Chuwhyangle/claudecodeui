/**
 * The shipped CONNECTION-LIFECYCLE steps for the `/voice-realtime` proxy.
 *
 * Every body in this file was moved here from `voice-realtime-ws-proxy.service.ts`, where
 * it ran inline at a fixed moment of a connection's life. The move is a pure displacement:
 * the expressions, the field reads and the early returns are the originals, with the
 * connection's locals now reached through the explicit context the table defines. The
 * criterion `tests/voice-realtime-trunk-steps.test.ts` drives a real connection and counts
 * how many times a probe registered from its own file runs at each timing.
 *
 * Two PURE functions moved with their bodies because a step body needs them and a value
 * import back into the proxy would close a module cycle (the proxy imports this file):
 * {@link readVoiceRealtimeInboundFrame} (the `before-frame` parse) and
 * {@link decideModelInterrupt} (the `interrupt-decision` fence). Both are still exported
 * from `voice-realtime-ws-proxy.service.ts` by re-export, so no caller changed.
 *
 * Registration lives here rather than in the proxy: {@link createDefaultVoiceRealtimeTrunkSteps}
 * builds a fresh table and registers every step below IN LIFECYCLE ORDER, so the shipped
 * trunk is assembled by a file beside the proxy. The proxy imports only the factory — it
 * never names a step body.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (its per-connection table defaults to
 * {@link createDefaultVoiceRealtimeTrunkSteps}) and the criterion above.
 */
import { fileURLToPath } from 'node:url';

import {
  VoiceRealtimeTrunkStepRegistry,
  type VoiceRealtimeTrunkContext,
  type VoiceRealtimeTrunkStep,
  type VoiceRealtimeTrunkTiming,
} from './voice-realtime-trunk-steps.js';
import type { ModelInterruptDecision, VoiceRealtimeInboundFrame } from './voice-realtime-ws-proxy.service.js';

/**
 * The file this step set was defined in.
 *
 * Read off the module's own URL rather than spelled as a literal, so the criterion can
 * compare it with the proxy's own source path without either side hard-coding a checkout
 * location.
 */
const STEPS_SOURCE = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// The two pure rules the trunk's steps run in place
// ---------------------------------------------------------------------------

/**
 * Parses one raw browser frame.
 *
 * Returns `null` for anything this handler does not understand. A malformed or
 * unknown frame is dropped rather than answered: the browser speaks a protocol
 * this server owns, so an unknown frame is a version mismatch, and replying to
 * every one of them would turn a mismatch into a frame storm.
 */
export function readVoiceRealtimeInboundFrame(raw: unknown): VoiceRealtimeInboundFrame | null {
  if (typeof raw !== 'string') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const frame = parsed as Record<string, unknown>;
  // The segmented-relay offer. `protocol` is read as a string and nothing more: whether it is a
  // token this proxy speaks is the HANDLER's decision, because that depends on the connection's mode
  // — the reader stays a pure shape-check so both answers are observable from one parsed frame.
  if (frame.type === 'hello' && typeof frame.protocol === 'string') {
    return { type: 'hello', protocol: frame.protocol };
  }

  // A `seq` makes an audio frame a segment's; its absence keeps the continuous path.
  // A non-integer `seq` is dropped rather than coerced: guessing an idempotency key is
  // worse than refusing the frame, which the browser already treats as unacknowledged.
  if (frame.type === 'audio' && typeof frame.audio === 'string') {
    // The rate the client declared, when it declared a usable one. Absent stays ABSENT (not defaulted
    // here): only the first audio frame's rate reaches the capture's header, and it is the capture, not
    // this reader, that knows what "no rate declared" means. Adding the key only when present is also
    // what keeps this reader's output identical for every existing caller that deep-compares it.
    const rate: { sourceRate?: number } =
      typeof frame.sourceRate === 'number' && Number.isFinite(frame.sourceRate) && frame.sourceRate > 0
        ? { sourceRate: frame.sourceRate }
        : {};
    if (frame.seq === undefined) {
      return { type: 'audio', audio: frame.audio, ...rate };
    }
    return Number.isInteger(frame.seq)
      ? { type: 'audio', audio: frame.audio, seq: frame.seq as number, ...rate }
      : null;
  }

  if (frame.type === 'segment_start' && Number.isInteger(frame.seq)) {
    return {
      type: 'segment_start',
      seq: frame.seq as number,
      ...(typeof frame.startedAtMs === 'number' ? { startedAtMs: frame.startedAtMs } : {}),
    };
  }

  if (frame.type === 'segment_end' && Number.isInteger(frame.seq)) {
    const reason = frame.reason;
    return {
      type: 'segment_end',
      seq: frame.seq as number,
      ...(typeof frame.durationMs === 'number' ? { durationMs: frame.durationMs } : {}),
      ...(reason === 'gap' || reason === 'max' || reason === 'end' ? { reason } : {}),
    };
  }

  if (frame.type === 'context' && typeof frame.text === 'string') {
    // `chars`/`rows` are the browser's own accounting and are logged, so they are read as given and
    // defaulted rather than validated: a frame with the text is usable, and refusing it over a
    // mis-counted integer would drop the context the text carries.
    return {
      type: 'context',
      text: frame.text,
      chars: typeof frame.chars === 'number' && Number.isFinite(frame.chars) ? frame.chars : frame.text.length,
      rows: typeof frame.rows === 'number' && Number.isFinite(frame.rows) ? frame.rows : 0,
    };
  }

  // The narrator queue's pacing ack. Like `hello`'s protocol, the id is read as a string and nothing
  // more: whether it names the utterance standing NOW is the QUEUE's decision (a stale ack must not
  // advance it), not this shape-check's.
  if (frame.type === 'narrator_done' && typeof frame.utteranceId === 'string') {
    return { type: 'narrator_done', utteranceId: frame.utteranceId };
  }

  // The answer to one `run_output_request`. The id and the text are both required: a reply that
  // cannot name its request cannot be matched to a run, and an empty text is the page saying this
  // turn produced nothing visible (a real reading, not a malformed frame).
  if (frame.type === 'run_output' && typeof frame.requestId === 'string' && typeof frame.text === 'string') {
    return { type: 'run_output', requestId: frame.requestId, text: frame.text };
  }

  if (frame.type === 'close') {
    return { type: 'close' };
  }

  return null;
}

/**
 * The interrupt FENCE (SPEC §0.3 D-7 / §18.4 G2, GOAL-041 AC-343): does this model-initiated stop
 * run, or is it the debounce `covered`?
 *
 * WHY A FENCE AT ALL. The model can call `session_interrupt` for a sentence whose command the
 * CURRENT run has already dequeued into its turn — an E-2 self-answer, or a retry after the
 * `TOOL_LOOP_GUARD` — and stopping a run for an utterance it is already answering is the
 * repeat-interrupt thrash D-7 exists to forbid. Two readings rule that out, and one of them is
 * enough:
 *
 *   · COVERED — `max(coveredSeqs) >= triggerSeq`. The trigger utterance's command reached the host's
 *     `started` state, so the run already carries it (SPEC §18.3: `covers` from `command_lifecycle`
 *     `started` events, joined through the `commandUuid → utteranceSeq` map). Because `utteranceSeq`
 *     only ever grows and the model always triggers on the LATEST utterance, no earlier-starting
 *     sentence can stand in for a later one: `max(covers) >= triggerSeq` is exactly "the trigger
 *     sentence is already inside the run".
 *   · IDEMPOTENT — `abortedTriggerSeq === triggerSeq`. The SAME call repeated after it already ran is
 *     not a second stop. This is the ONLY guard a session with no lifecycle channel has, which is the
 *     documented degradation for a non-resident connection (see `HostCommandLifecycleReading`).
 *
 * `triggerSeq === null` means no non-empty utterance has been heard, so there is no sentence to
 * fence on and the path is exactly the pre-fence one — a bare stop still aborts.
 *
 * Exported and pure so a criterion can drive the fence's own decision directly, including the false
 * form that must redden: with BOTH guards neutralized (`coveredSeqs` empty, `abortedTriggerSeq`
 * null) the same input decides `abort` every time — two aborts for the one sentence, which is what
 * removing the fence would do (SPEC §18.7 F3).
 */
export function decideModelInterrupt(input: {
  triggerSeq: number | null;
  coveredSeqs: ReadonlySet<number>;
  abortedTriggerSeq: number | null;
}): ModelInterruptDecision {
  if (input.triggerSeq === null) {
    return 'abort';
  }
  if (input.abortedTriggerSeq === input.triggerSeq) {
    return 'covered';
  }
  let maxCovered: number | null = null;
  for (const seq of input.coveredSeqs) {
    if (maxCovered === null || seq > maxCovered) {
      maxCovered = seq;
    }
  }
  if (maxCovered !== null && maxCovered >= input.triggerSeq) {
    return 'covered';
  }
  return 'abort';
}

// ---------------------------------------------------------------------------
// The shipped steps
// ---------------------------------------------------------------------------

/** The shutdown clauses a failed upstream keeps: the page is told, and the connection ends. */
const TRANSPORT_UNREACHABLE_MESSAGE = 'The Realtime upstream could not be reached.';

/**
 * THE UPSTREAM SESSION, once the handshake settles.
 *
 * `whenConnected()` never rejects — it resolves on `open` or once the bridge has exhausted
 * its attempts and closed — so the state is what decides whether there is a session to
 * advertise. Sending an update on a closed bridge would be dropped silently and leave the
 * browser listening to nothing.
 */
function runAfterHandshake(
  context: VoiceRealtimeTrunkContext<'after-handshake'>,
): void {
  if (!context.payload.connected) {
    context.send({ type: 'error', code: 'TRANSPORT', message: TRANSPORT_UNREACHABLE_MESSAGE });
    context.teardown();
    return;
  }
  // The session is opened with the instructions AS THEY STAND: whatever context pack the browser
  // has sent by now. A pack that arrives after this point is applied by its own frame handler.
  context.advertiseInstructions();
}

/**
 * THE PARSE, before anything is routed.
 *
 * The raw message is a string on the wire; `Buffer` arrives when the socket hands one over,
 * which is why the coercion is part of the step rather than the caller's. `frame` stays
 * `null` for a malformed or unknown message, and the connection drops it — the same silent
 * drop the reader's own contract states.
 */
function runBeforeFrame(context: VoiceRealtimeTrunkContext<'before-frame'>): void {
  const raw = context.payload.raw;
  context.payload.frame = readVoiceRealtimeInboundFrame(
    Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : String(raw),
  );
}

/**
 * THE FENCE, at the model's stop.
 *
 * Writing the decision into the payload is the whole step: the connection reads it back and
 * takes the `covered` early return or the abort path. An EMPTY `interrupt-decision` table
 * leaves `decision` at `null`, which reads as "not covered" — the pre-fence path, a bare
 * stop still aborting.
 */
function runInterruptDecision(context: VoiceRealtimeTrunkContext<'interrupt-decision'>): void {
  context.payload.decision = decideModelInterrupt({
    triggerSeq: context.payload.triggerSeq,
    coveredSeqs: context.payload.coveredSeqs,
    abortedTriggerSeq: context.payload.abortedTriggerSeq,
  });
}

/**
 * THE INJECTION, when the composed instructions go upstream.
 *
 * The connection composes (settings + context pack + status line); this step is the wire.
 * `sent` is the same reading the caller's log lines and status bookkeeping are keyed on.
 */
function runStatusInjection(context: VoiceRealtimeTrunkContext<'status-injection'>): void {
  context.bridge.sendSessionUpdate(context.payload.instructions);
  context.payload.sent = true;
}

/**
 * THE CAPTURE'S LAST WORDS, on the connection's way out.
 *
 * The recorder patches the WAV's size fields and appends the final frame/byte/duration
 * reading. A no-op with no capture wired, and fail-open with one — a capture that cannot be
 * closed must not keep a dead connection's microphone open (why this runs before the socket
 * close, with the rest of the teardown).
 */
function runBeforeClose(context: VoiceRealtimeTrunkContext<'before-close'>): void {
  context.seams.audioCapture?.finalize();
}

/**
 * Types ONE entry of the table: the step declares its own timing's context, and this helper
 * returns it in the table's erased shape (the table holds steps of every timing, so its element
 * type is the union; the erasure is the same trade the frame registry makes with its `frame: any`).
 */
function defineTrunkStep<T extends VoiceRealtimeTrunkTiming>(
  step: VoiceRealtimeTrunkStep<T>,
): VoiceRealtimeTrunkStep {
  return step as unknown as VoiceRealtimeTrunkStep;
}

/**
 * The shipped table, in lifecycle order.
 *
 * `after-frame` has NO shipped step on purpose: it is the pure extension timing — the place
 * a per-frame observation registers — and the criterion proves it live by registering its
 * probe there and counting exactly one call per dispatched frame.
 */
export const VOICE_REALTIME_TRUNK_STEPS: readonly VoiceRealtimeTrunkStep[] = [
  defineTrunkStep({
    timing: 'after-handshake',
    name: 'upstream-session',
    label: 'voice-realtime.trunk.after-handshake.upstream-session',
    source: STEPS_SOURCE,
    run: runAfterHandshake,
  }),
  defineTrunkStep({
    timing: 'before-frame',
    name: 'parse-inbound-frame',
    label: 'voice-realtime.trunk.before-frame.parse-inbound-frame',
    source: STEPS_SOURCE,
    run: runBeforeFrame,
  }),
  defineTrunkStep({
    timing: 'interrupt-decision',
    name: 'model-interrupt-fence',
    label: 'voice-realtime.trunk.interrupt-decision.model-interrupt-fence',
    source: STEPS_SOURCE,
    run: runInterruptDecision,
  }),
  defineTrunkStep({
    timing: 'status-injection',
    name: 'session-update',
    label: 'voice-realtime.trunk.status-injection.session-update',
    source: STEPS_SOURCE,
    run: runStatusInjection,
  }),
  defineTrunkStep({
    timing: 'before-close',
    name: 'finalize-audio-capture',
    label: 'voice-realtime.trunk.before-close.finalize-audio-capture',
    source: STEPS_SOURCE,
    run: runBeforeClose,
  }),
];

/**
 * Builds a fresh table with the shipped steps registered, in the order above.
 *
 * A fresh registry per connection, exactly like the frame registry's default: a criterion
 * registers a probe over it without touching another connection, and unregistering a
 * shipped step affects only the connection that was handed the table.
 */
export function createDefaultVoiceRealtimeTrunkSteps(): VoiceRealtimeTrunkStepRegistry {
  const registry = new VoiceRealtimeTrunkStepRegistry();
  for (const step of VOICE_REALTIME_TRUNK_STEPS) {
    registry.register(step);
  }
  return registry;
}

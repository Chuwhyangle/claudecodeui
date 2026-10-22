/**
 * The registration and dispatch seam for the `/voice-realtime` proxy's inbound frames.
 *
 * `voice-realtime-ws-proxy.service.ts` is the module's god file: every Live Voice
 * feature lands another `if (frame.type === …)` arm in the one `socket.on('message')`
 * callback. This seam is the first cut out of it. An inbound frame is now a handler
 * with a name, a label, a source and a `handle(context, state, frame)` body; the
 * shipped set lives in `voice-realtime-frame-handlers.ts`, a sibling file, and the
 * proxy routes every parsed frame through {@link VoiceRealtimeFrameRegistry.dispatch}
 * without naming a single frame body of its own.
 *
 * ## Why the handler gets a context and a state object rather than the connection
 *
 * The moved bodies were closures over the connection's local variables. Splitting them
 * out would have meant either handing the handler the whole enclosing function (there is
 * no object to hand) or silently rewriting the bodies. Instead the connection builds two
 * explicit arguments:
 *
 * - {@link VoiceRealtimeFrameContext} — the seams, the downlink, the bridge, the gates
 *   and the small set of connection-scoped operations a frame body may call. These are
 *   the values the old bodies closed over; nothing else about the connection is reachable.
 * - {@link VoiceRealtimeFrameConnectionState} — the readings a frame body WRITES
 *   (`contextText`, the audio-frame counter, the speaker-shadow one-line latch and the
 *   outstanding `run_output` request). The proxy passes an accessor-backed view of its own
 *   locals, so the rest of the connection keeps reading the same variables.
 *
 * A handler therefore cannot reach a connection private it did not receive as data —
 * the same discipline the resident-driver outcome registries state for their handlers.
 *
 * ## Dispatch when nothing is registered
 *
 * `dispatch` returns `null` rather than throwing, exactly as those registries do. A frame
 * with no handler is dropped, which is what the proxy already did for an unknown frame
 * (the reader returns `null` for those). That is also what makes the negative control
 * meaningful: unregister a handler, dispatch again, and its body must not run.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (the dispatch half),
 * `voice-realtime-frame-handlers.ts` (the registration half) and
 * `tests/voice-realtime-frame-registry.test.ts` (the criterion).
 */
import type { RealtimeBridge } from './voice-realtime-bridge.service.js';
import type { LocalSpeechBoundary, LocalSpeechGate } from './voice-realtime-local-speech.js';
import type { SilenceTailGate, SilenceTailOptions } from './voice-realtime-silence-tail.js';
import type { SpeakerWindowAccumulator } from './voice-realtime-speaker-seam.js';
import type { UplinkVadGate } from './voice-realtime-uplink-vad-gate.js';
import type {
  VoiceRealtimeInboundFrame,
  VoiceRealtimeNarratorQueue,
  VoiceRealtimeOutboundFrame,
  VoiceRealtimeProxySeams,
} from './voice-realtime-ws-proxy.service.js';

/**
 * The inbound frame kinds the registry dispatches.
 *
 * One name per branch that used to be inlined in `handleVoiceRealtimeConnection`:
 * the segmented-relay offer (`hello`), the three segment frames
 * (`segment_start`/`audio`/`segment_end`), the context pack (`context`), the
 * narrator's pacing ack (`narrator_done`), the run-end summary answer
 * (`run_output`) and the browser's own teardown (`close`). The union is closed on
 * purpose: a new frame kind is a new name here and a new handler beside it, which
 * is the visible diff this extension point exists to produce.
 */
export type VoiceRealtimeFrameName = VoiceRealtimeInboundFrame['type'];

/** The parsed frame a handler of `TName` receives — narrowed from the wire union. */
export type VoiceRealtimeFramePayload<TName extends VoiceRealtimeFrameName> = Extract<
  VoiceRealtimeInboundFrame,
  { type: TName }
>;

/**
 * The one `run_output` request outstanding for a connection.
 *
 * `generation` and `runId` are what a late answer is matched against; the proxy's
 * request/timer bookkeeping owns the record, and the handler only reads and clears it.
 */
export type VoiceRealtimeRunOutputPending = {
  requestId: string;
  generation: number;
  runId: string | null;
};

/**
 * The connection readings an inbound-frame handler writes.
 *
 * These used to be `let` locals in `handleVoiceRealtimeConnection`. They are handed
 * to the handler explicitly because they are the only connection state a body mutates;
 * everything else it needs is a seam or a function on the context.
 */
export type VoiceRealtimeFrameConnectionState = {
  /** The C2 context pack this connection was sent, or `''` before it arrives. */
  contextText: string;
  /** The browser's own char/row accounting for that pack, kept for the journal only. */
  contextChars: number;
  contextRows: number;
  /** How many browser `audio` frames have arrived, for the sparse heartbeat line. */
  audioFramesFromBrowser: number;
  /** One-line latch for a broken speaker-shadow reader, so it cannot flood the journal. */
  speakerObserveFailureLogged: boolean;
  /** The one `run_output` request outstanding for this connection, or `null`. */
  runOutputPending: VoiceRealtimeRunOutputPending | null;
};

/**
 * The connection seams an inbound-frame handler is allowed to reach.
 *
 * Deliberately only the ports and connection-scoped operations the moved bodies used:
 * the injected seams, the downlink, the resolved mode, the bridge, the narrator queue,
 * the gates and their feeders, the run-end summary request pair, the per-segment
 * bookkeeping maps, and the connection's two terminal operations. None of these is
 * driver state; the readings a handler mutates are passed as the second argument.
 *
 * `contextMaxChars` is a construction constant (the cap the old `context` branch read
 * from the proxy module). It is handed in rather than imported so this file and its
 * sibling handler file have no runtime edge back into `voice-realtime-ws-proxy.service.ts`
 * — the proxy imports the handlers, so a value import back would close a module cycle.
 */
export type VoiceRealtimeFrameContext = {
  readonly seams: VoiceRealtimeProxySeams;
  readonly send: (frame: VoiceRealtimeOutboundFrame) => void;
  readonly segmentedRelay: boolean;
  readonly contextMaxChars: number;
  readonly bridge: RealtimeBridge;
  readonly narratorQueue: VoiceRealtimeNarratorQueue | null;
  readonly advertiseInstructions: () => boolean;
  readonly clearRunOutputRequest: () => void;
  readonly summarizeRunOutput: (
    generation: number,
    runId: string | null,
    output: string,
  ) => Promise<void>;
  readonly segmentFrameCounts: Map<number, number>;
  readonly endedSegmentSeqs: Set<number>;
  readonly noteUserSpokeForNarrator: () => void;
  readonly speakerWindows: SpeakerWindowAccumulator | null;
  readonly localSpeechGate: LocalSpeechGate;
  readonly reportLocalSpeechBoundary: (boundary: LocalSpeechBoundary | null) => void;
  readonly silenceTail: SilenceTailGate | null;
  readonly silenceTailOptions: SilenceTailOptions | null;
  readonly uplinkVad: UplinkVadGate | null;
  readonly enqueueUplinkVad: (audio: string) => void;
  readonly teardown: () => void;
  readonly exitUplinkVad: () => Promise<void>;
};

/**
 * One registered inbound-frame handler.
 *
 * `label` is the registration's own name (distinct from the frame kind it answers, so
 * a probe can replace a shipped handler and still say who it is), and `source` is the
 * file the handler was defined in — the value the criterion compares with the proxy's
 * own path to prove the handler came from outside it.
 *
 * `frame` is typed `any` for the same reason the resident-driver outcome handlers type
 * their payload that way: the shipped array is heterogeneous, and each named function
 * above states its own precise `VoiceRealtimeFramePayload<TName>` signature.
 */
export type VoiceRealtimeFrameHandler<TName extends VoiceRealtimeFrameName = VoiceRealtimeFrameName> = {
  readonly name: TName;
  readonly label: string;
  readonly source: string;
  readonly handle: (
    context: VoiceRealtimeFrameContext,
    state: VoiceRealtimeFrameConnectionState,
    frame: any,
  ) => void;
};

/** What one dispatch answered, and which handler answered it. */
export type VoiceRealtimeFrameDispatch = {
  readonly handler: VoiceRealtimeFrameHandler;
};

/**
 * A registry of inbound-frame handlers, keyed by the frame kind each answers.
 *
 * `register` replaces an existing handler for the same kind (that is how a criterion
 * installs a probe over the shipped one) and `unregister` removes it. `dispatch` is
 * the only execution path: without a registered handler it returns `null` and never
 * calls anything.
 */
export class VoiceRealtimeFrameRegistry {
  private readonly handlers = new Map<VoiceRealtimeFrameName, VoiceRealtimeFrameHandler>();

  /** Installs (or replaces) the handler for the frame kind it names; returns this registry. */
  register(handler: VoiceRealtimeFrameHandler): VoiceRealtimeFrameRegistry {
    this.handlers.set(handler.name, handler);
    return this;
  }

  /** Removes the handler for a frame kind. Returns whether one was registered. */
  unregister(name: VoiceRealtimeFrameName): boolean {
    return this.handlers.delete(name);
  }

  /** Whether a frame kind currently has a handler. */
  has(name: VoiceRealtimeFrameName): boolean {
    return this.handlers.has(name);
  }

  /** The handler for a frame kind, or `null` when none is registered. */
  handlerFor(name: VoiceRealtimeFrameName): VoiceRealtimeFrameHandler | null {
    return this.handlers.get(name) ?? null;
  }

  /** The frame kinds that currently have a handler, in registration order. */
  names(): VoiceRealtimeFrameName[] {
    return [...this.handlers.keys()];
  }

  /**
   * Runs the handler registered for `name` and reports which one answered.
   *
   * `null` means "nothing is registered for this frame kind" — the handler was never
   * registered or was unregistered — and in that case no handler body runs. The proxy
   * treats that as "this frame did nothing", which is the same conservative answer the
   * reader gives an unknown frame.
   */
  dispatch<TName extends VoiceRealtimeFrameName>(
    name: TName,
    context: VoiceRealtimeFrameContext,
    state: VoiceRealtimeFrameConnectionState,
    frame: VoiceRealtimeFramePayload<TName>,
  ): VoiceRealtimeFrameDispatch | null {
    const handler = this.handlerFor(name);
    if (!handler) {
      return null;
    }
    handler.handle(context, state, frame);
    return { handler };
  }
}

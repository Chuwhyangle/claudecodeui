/**
 * The Realtime bridge: a small, transport-injected state machine that opens a
 * WebSocket-like session, tells it what tools exist (`session.update`), forwards
 * audio frames, and routes the function calls the model emits to an injected
 * executor — all without ever touching a real socket.
 *
 * WHY TRANSPORT-INJECTED. `docs/proposals/voice-native-control-plane.md` wants
 * the bridge's BEHAVIOUR to be provable before any real Qwen/DashScope adapter
 * exists. So the socket is a `RealtimeTransport` the caller supplies: production
 * will hand it a real WS client (out of scope here), and the criteria hand it a
 * fake server, which makes the whole thing offline. Nothing in this module
 * reaches `fetch`, `WebSocket`, `http`, or `ws` — the module imports only a
 * type, so there is no network path to reach at all.
 *
 * WHY THE GUARDS ARE SHAPED THE WAY THEY ARE. Three things can go wrong at a
 * live socket — the connection drops, an executor throws, the server sends an
 * event type this bridge does not know — and NONE of them may kill the process,
 * because the process also carries every other session. Each is therefore
 * wrapped by {@link guardSync}/{@link guardAsync} and turned into ONE `onError`
 * call carrying an identifiable `code`. `tests/
 * voice-realtime-bridge.false-forms.test.ts` proves the guards are load-bearing
 * by deleting them from a copy of this file and requiring each scenario to
 * redden. Consumers: discovered through this module's barrel and wired (in a
 * later task) to a real Realtime client; the criteria drive it over a fake.
 */
import type { RealtimeToolDescriptor } from './voice-realtime-tools.js';

/** The bridge's connection state. `open` is the only state a message may arrive in. */
export type RealtimeBridgeState = 'connecting' | 'open' | 'closing' | 'closed';

/**
 * One tool as `session.update` advertises it.
 *
 * `parameters` is the tool's declared raw input shape. A production adapter
 * serializes that shape to JSON Schema on the way out; this task's fake server
 * only records what it was handed, so the shape travels as itself.
 */
export type RealtimeFunctionDeclaration = {
  type: 'function';
  name: string;
  description: string;
  parameters: unknown;
};

/** A client→server message. The session configuration and a pass-through audio frame. */
export type RealtimeClientMessage =
  | { type: 'session.update'; session: { instructions: string; tools: readonly RealtimeFunctionDeclaration[] } }
  | { type: 'input_audio_buffer.append'; audio: string }
  | { type: 'function_call_output'; callId: string; output: unknown };

/** A server→client function call, before its arguments are parsed. */
export type RealtimeFunctionCall = {
  type: 'function_call';
  callId: string;
  name: string;
  arguments: string;
};

/** Any server→client message. Unknown `type`s are reported, never crashed on. */
export type RealtimeServerMessage = { type: string } & Record<string, unknown>;

/**
 * The endpoint's own protocol traffic that this bridge does not act on.
 *
 * WHY THIS SET EXISTS, AND WHY IT IS NOT A CATCH-ALL. The endpoint narrates its
 * whole turn — session lifecycle, item lifecycle, response lifecycle, streaming
 * text, server-side VAD — and none of it is a failure. Treating it as one is
 * what made every real session die immediately: the `session.update` this bridge
 * sends on connect is answered with `session.updated`, and that reply alone was
 * reported as an unknown event. Meanwhile the criteria's stand-in spoke only
 * `response.function_call_arguments.done`, so no test could see it.
 *
 * The members are exactly what the endpoint was OBSERVED to send, enumerated from
 * the preserved live capture rather than from documentation — see
 * `experiments/voice-realtime-ambiguity/real-trace/qwen38-omni-realtime-trace.json`.
 * A type NOT in here is still reported: the reading keeps its meaning, and in
 * particular `response.audio_transcript.delta` (an OpenAI-shaped name this
 * endpoint never emits) remains a genuine `UNKNOWN_EVENT`.
 */
const TOLERATED_ENDPOINT_EVENTS: ReadonlySet<string> = new Set([
  // Session lifecycle — `session.updated` answers our own `session.update`.
  'session.created',
  'session.updated',
  // Item lifecycle.
  'conversation.item.created',
  // Server-side VAD narrating the user's own speech.
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  // The model's turn: lifecycle, parts, and its streaming text.
  'response.created',
  'response.done',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.text.delta',
  'response.text.done',
  // The tool call's incremental half; the completed call arrives as
  // `function_call` and IS acted on.
  'response.function_call_arguments.delta',
]);

/**
 * The WebSocket client the bridge drives. Production supplies a real one; the
 * criteria supply a fake server. `subscribe`/`onClose` return unsubscribe
 * functions so the bridge can detach on a deliberate close.
 */
export type RealtimeTransport = {
  open(): Promise<void>;
  close(): Promise<void>;
  send(message: RealtimeClientMessage): void;
  subscribe(handler: (message: RealtimeServerMessage) => void): () => void;
  onClose(handler: () => void): () => void;
};

/** The injected executor: one handler per tool NAME — the routing table. */
export type RealtimeToolExecutor = Readonly<
  Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>
>;

/**
 * One failure the bridge survived, as it is reported to `onError`.
 *
 * Every member carries a discriminator (`code`) plus the fields a caller needs
 * to tell one from another — the "可辨识的错误信息" the criterion reads.
 */
export type RealtimeBridgeError =
  | { code: 'CONNECTION_FAILED'; attempt: number; maxAttempts: number; cause: unknown }
  | { code: 'CONNECTION_LOST'; attempt: number; maxAttempts: number; willRetry: boolean }
  | { code: 'UNKNOWN_EVENT'; eventType: string }
  | { code: 'UNKNOWN_TOOL'; tool: string; callId: string }
  | { code: 'MALFORMED_FUNCTION_CALL'; callId: string; reason: string }
  | { code: 'TOOL_EXECUTION_FAILED'; tool: string; callId: string; cause: unknown }
  | { code: 'SEND_FAILED'; cause: unknown }
  | { code: 'DISPATCH_FAILED'; cause: unknown };

/**
 * One interim-or-final transcription of the user's OWN audio, as the endpoint
 * reports it (GOAL-033 / AC-317).
 *
 * THIS IS DISPLAY-ONLY AND MUST NEVER BECOME MODEL INPUT. The model receives the
 * raw audio stream; this text exists so the transcript can show the user what was
 * heard. Keeping it a separate channel — its own hook, its own outbound frame —
 * is what makes that structural rather than a convention someone can quietly
 * break: nothing here is ever routed into a `function_call`'s arguments.
 *
 * `itemId` is the endpoint's grouping key. Every `delta` for one utterance
 * carries the SAME id and the running text; the `completed` event closes it with
 * the final text. A consumer must therefore treat successive same-id captions as
 * replacements, not appends, or one utterance renders as many duplicated bubbles.
 */
export type RealtimeCaption = {
  /** The endpoint's grouping key for one spoken utterance. */
  itemId: string;
  /** The running text (`delta`) or the final text (`completed`). */
  text: string;
  /** `true` on the closing `completed` event, `false` on every `delta`. */
  final: boolean;
};

/** The hooks a caller uses to observe the bridge: state transitions, survived failures, and captions. */
export type RealtimeBridgeHooks = {
  onStateChange?: (next: RealtimeBridgeState, previous: RealtimeBridgeState) => void;
  onError?: (error: RealtimeBridgeError) => void;
  /** One interim-or-final transcription of the user's audio. Display-only — see {@link RealtimeCaption}. */
  onCaption?: (caption: RealtimeCaption) => void;
};

/** How `connect` is configured. `maxConnectAttempts` bounds the initial connect AND reconnects. */
export type RealtimeBridgeOptions = {
  hooks?: RealtimeBridgeHooks;
  /** Total socket opens allowed across this bridge's life, initial connect included. Default 3. */
  maxConnectAttempts?: number;
};

/** The handle `connect` returns. */
export type RealtimeBridge = {
  readonly state: RealtimeBridgeState;
  /** How many times the transport's `open` has been called (the initial connect included). */
  readonly openAttempts: number;
  /**
   * Resolves when the bridge first reaches `open`, or when it has exhausted its
   * attempts and reached `closed`. The shipped implementation NEVER rejects — a
   * rejection from this promise means the error guard was removed.
   */
  whenConnected(): Promise<void>;
  sendSessionUpdate(instructions: string): void;
  sendAudioFrame(audio: string): void;
  close(): Promise<void>;
};

/** A failure the bridge itself raises, carrying the `onError` payload it maps to. */
class RealtimeBridgeFault extends Error {
  constructor(readonly bridgeError: RealtimeBridgeError) {
    super(bridgeError.code);
    this.name = 'RealtimeBridgeFault';
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function normalizeError(error: unknown): RealtimeBridgeError {
  return error instanceof RealtimeBridgeFault ? error.bridgeError : { code: 'DISPATCH_FAILED', cause: error };
}

/**
 * Runs one synchronous step, routing a throw to `onError`.
 *
 * Its body is the synchronous half of the error guard the AC-4 false form
 * deletes; keep the two lines of `try`/`catch` exactly as written.
 */
function guardSync(body: () => void, onError: (error: unknown) => void): void {
  try {
    body();
  } catch (error) {
    onError(error);
  }
}

/**
 * Runs one asynchronous step, routing a rejection to `onError`.
 *
 * Its body is the asynchronous half of the error guard the AC-4 false form
 * deletes; keep the two lines of `try`/`catch` exactly as written.
 */
async function guardAsync(body: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
  try {
    await body();
  } catch (error) {
    onError(error);
  }
}

/**
 * Opens a Realtime bridge over `transport`, advertising `tools` and routing
 * function calls to `executor`.
 *
 * Consumers: this module's barrel (and, in a later task, a real Realtime
 * client); the criteria drive it over a fake transport.
 */
export function connect(
  transport: RealtimeTransport,
  tools: readonly RealtimeToolDescriptor[],
  executor: RealtimeToolExecutor,
  options: RealtimeBridgeOptions = {},
): RealtimeBridge {
  const hooks = options.hooks ?? {};
  const maxConnectAttempts = options.maxConnectAttempts ?? 3;
  const toolDeclarations: RealtimeFunctionDeclaration[] = tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));

  let state: RealtimeBridgeState = 'connecting';
  let openAttempts = 0;
  let deliberateClose = false;
  /**
   * The `instructions` the caller last advertised, or `null` until they do.
   *
   * A realtime session is PER-SOCKET: the endpoint's `session.update` (instructions
   * plus the tool declarations the model may call) does not survive the socket that
   * carried it. So a reconnect has to re-establish it, and this is the bridge's
   * memory of what to re-establish (see {@link readvertiseSession}). It stays `null`
   * on the initial connect, which is what keeps the reconnect-only traffic honest.
   */
  let lastSessionInstructions: string | null = null;

  const setState = (next: RealtimeBridgeState): void => {
    if (next === state) return;
    const previous = state;
    state = next;
    hooks.onStateChange?.(next, previous);
  };
  const emitError = (error: RealtimeBridgeError): void => {
    hooks.onError?.(error);
  };

  // ----- the message loop -----

  /** Guards ONE server event. A malformed one is reported, never allowed to escape. */
  function dispatchSafely(message: RealtimeServerMessage): void {
    guardSync(
      () => dispatch(message),
      (error) => emitError(normalizeError(error)),
    );
  }

  function dispatch(message: RealtimeServerMessage): void {
    if (message.type === 'function_call') {
      handleFunctionCall(message as RealtimeFunctionCall);
      return;
    }
    // Normal traffic from the endpoint that this bridge does not act on. It is
    // TOLERATED rather than reported: these are the endpoint answering us and
    // narrating its own turn, not failures, and faulting on them kills a session
    // that is working. `session.updated` is the reply to the `session.update`
    // WE send on connect — so before this, every real session died on its first
    // handshake reply, while the criteria's stand-in (which spoke only
    // `response.function_call_arguments.done`) never showed it.
    if (TOLERATED_ENDPOINT_EVENTS.has(message.type)) {
      return;
    }
    // The user's own audio, transcribed. Recognised rather than reported: a
    // continuous-capture session emits these constantly, so routing them to the
    // error channel (as this bridge did before AC-317) would leave the browser
    // holding a stream of unexplained failures for a session that is working.
    if (message.type === 'conversation.item.input_audio_transcription.delta') {
      handleCaption(message, false);
      return;
    }
    if (message.type === 'conversation.item.input_audio_transcription.completed') {
      handleCaption(message, true);
      return;
    }
    // Any event type this bridge does not know: reported, not fatal.
    throw new RealtimeBridgeFault({ code: 'UNKNOWN_EVENT', eventType: String(message.type) });
  }

  /**
   * Routes one transcription event to `onCaption`.
   *
   * The endpoint's field names differ between the two events and neither is
   * self-describing: a `delta` carries the running text in `stash` (its `text`
   * field is present but EMPTY on every delta — confirmed against the preserved
   * live capture in `experiments/voice-realtime-ambiguity/real-trace/`), while
   * `completed` carries the final text in `transcript`. Reading `text` here would
   * produce an empty caption on every interim event.
   *
   * A caption that does not conform is DROPPED, not escalated. It is display-only
   * and non-actionable, so reporting it would spend the error channel — which the
   * browser renders as a session failure — on something the session survives.
   */
  function handleCaption(message: RealtimeServerMessage, final: boolean): void {
    const itemId = message.item_id;
    const text = final ? message.transcript : message.stash;
    if (typeof itemId !== 'string' || typeof text !== 'string') {
      return;
    }
    hooks.onCaption?.({ itemId, text, final });
  }

  function handleFunctionCall(call: RealtimeFunctionCall): void {
    if (typeof call.name !== 'string' || typeof call.callId !== 'string' || typeof call.arguments !== 'string') {
      throw new RealtimeBridgeFault({ code: 'MALFORMED_FUNCTION_CALL', callId: String(call.callId), reason: 'missing callId/name/arguments' });
    }
    // The routing table lookup: the tool NAME the model chose selects its executor.
    const handler = executor[call.name];
    if (handler === undefined) {
      throw new RealtimeBridgeFault({ code: 'UNKNOWN_TOOL', tool: call.name, callId: call.callId });
    }
    const args = parseFunctionCallArguments(call);
    let result: unknown;
    try {
      result = handler(args);
    } catch (cause) {
      throw new RealtimeBridgeFault({ code: 'TOOL_EXECUTION_FAILED', tool: call.name, callId: call.callId, cause });
    }
    if (isThenable(result)) {
      result.then(
        (value) => sendFunctionCallOutput(call, value),
        (cause) => emitError({ code: 'TOOL_EXECUTION_FAILED', tool: call.name, callId: call.callId, cause }),
      );
      return;
    }
    sendFunctionCallOutput(call, result);
  }

  /** Parses the wire's JSON `arguments`, preserving field order (never re-keys or reorders). */
  function parseFunctionCallArguments(call: RealtimeFunctionCall): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments);
    } catch (cause) {
      throw new RealtimeBridgeFault({ code: 'MALFORMED_FUNCTION_CALL', callId: call.callId, reason: `arguments are not JSON: ${String(cause)}` });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new RealtimeBridgeFault({ code: 'MALFORMED_FUNCTION_CALL', callId: call.callId, reason: 'arguments must be a JSON object' });
    }
    return parsed as Record<string, unknown>;
  }

  function sendFunctionCallOutput(call: RealtimeFunctionCall, output: unknown): void {
    try {
      transport.send({ type: 'function_call_output', callId: call.callId, output });
    } catch (cause) {
      emitError({ code: 'SEND_FAILED', cause });
    }
  }

  // ----- the connection loop -----

  /** Tries one socket open. A failure is reported and answered `false`, never thrown. */
  async function attemptOpen(): Promise<boolean> {
    openAttempts += 1;
    let opened = false;
    await guardAsync(
      async () => {
        await transport.open();
        opened = true;
      },
      (cause) => {
        emitError({ code: 'CONNECTION_FAILED', attempt: openAttempts, maxAttempts: maxConnectAttempts, cause });
      },
    );
    return opened;
  }

  /**
   * Re-advertises the session on a socket that came up AFTER a drop.
   *
   * The reconnect loop re-dials; the new socket knows nothing, so the bridge
   * re-sends the instructions and tool declarations the caller last advertised.
   * Nothing is sent on the initial connect — `lastSessionInstructions` is still
   * `null` then — so this adds traffic ONLY to a reconnect, and a drop before the
   * caller ever advertised anything stays a pure reconnect. Runs through the same
   * error guard as every other step on the loop, so a send failure is reported
   * rather than escaping the `void`-started `openLoop()`.
   */
  function readvertiseSession(): void {
    const instructions = lastSessionInstructions;
    if (instructions === null) return;
    guardSync(
      () => transport.send({ type: 'session.update', session: { instructions, tools: toolDeclarations } }),
      (error) => emitError(normalizeError(error)),
    );
  }

  /**
   * Drives attempts until the socket is open or the budget is spent, then settles.
   * Resolves on `open` or `closed`; it rejects only if the guard was removed.
   */
  async function openLoop(): Promise<void> {
    for (;;) {
      if (openAttempts >= maxConnectAttempts) {
        setState('closing');
        setState('closed');
        return;
      }
      const opened = await attemptOpen();
      if (opened) {
        if (deliberateClose) return;
        setState('open');
        // A socket that came up after a drop has no session of its own.
        readvertiseSession();
        return;
      }
    }
  }

  /** An UNEXPECTED close (the server dropped us). A deliberate `close()` never lands here. */
  function handleTransportClose(): void {
    if (deliberateClose || state === 'closed' || state === 'closing') return;
    const willRetry = openAttempts < maxConnectAttempts;
    emitError({ code: 'CONNECTION_LOST', attempt: openAttempts, maxAttempts: maxConnectAttempts, willRetry });
    if (!willRetry) {
      setState('closing');
      setState('closed');
      return;
    }
    setState('connecting');
    void openLoop();
  }

  const unsubscribeMessages = transport.subscribe(dispatchSafely);
  const unsubscribeClose = transport.onClose(handleTransportClose);
  const connection = openLoop();

  return {
    get state(): RealtimeBridgeState {
      return state;
    },
    get openAttempts(): number {
      return openAttempts;
    },
    whenConnected: () => connection,
    sendSessionUpdate(instructions: string): void {
      // Remembered so a reconnect can re-advertise it: the session lives with the socket.
      lastSessionInstructions = instructions;
      transport.send({ type: 'session.update', session: { instructions, tools: toolDeclarations } });
    },
    sendAudioFrame(audio: string): void {
      transport.send({ type: 'input_audio_buffer.append', audio });
    },
    async close(): Promise<void> {
      deliberateClose = true;
      setState('closing');
      await transport.close();
      unsubscribeMessages();
      unsubscribeClose();
      setState('closed');
    },
  };
}

/**
 * A SCRIPTED stand-in for the DashScope Realtime endpoint — the shared, offline upstream a
 * Live Voice scenario is written against.
 *
 * WHY IT EXISTS. The repository had two stand-ins and neither could carry a scenario. The
 * frozen fixture (`voice-realtime-dashscope-harness.ts`) answers each client frame with ONE
 * fixed reaction, and each real-browser e2e spec hand-rolls its own upstream. So the endpoint
 * events that actually caused production incidents — the endpoint's own `error`, a
 * `response.text.done` where the model answers instead of calling the tool
 * (`MODEL_TEXT_REPLY`), a session that drops — had no stand-in at all, which is why they were
 * only ever found in a journal. This module makes those events scriptable.
 *
 * WHAT IT IS NOT. It never opens a socket and never reads a credential. It is a
 * {@link DashscopeSocketFactory} — exactly the seam the transport's own guard treats as "no
 * real endpoint, no credential": a transport handed this factory and an empty api key dials
 * without complaint, while the same transport WITHOUT the factory refuses with
 * `MISSING_API_KEY`. `dialedUrl` below records which address it dialled, so a scenario can
 * prove the frames it saw came from this script and not from the network.
 *
 * WHAT THE SCRIPT OWNS. Everything after the handshake. `session.update` is still answered
 * with `session.created`/`session.updated` (the transport does not reach `open` without
 * them, and every scenario needs an open session), and every other thing the endpoint says
 * comes from {@link ScriptedUpstream.runScript}. A tool result is acknowledged with
 * `response.done` by default, so the model is never left waiting on a call it made.
 *
 * Consumed by `voice-realtime-scripted-scenarios.test.ts`.
 */
import type { DashscopeSocket, DashscopeSocketFactory } from '../index.js';

/**
 * The address a scripted run dials. Deliberately unroutable: nothing resolves `.invalid`, so
 * even a mistaken real dial could not leave the host.
 */
export const SCRIPTED_ENDPOINT_URL = 'ws://scripted.invalid/api-ws/v1/realtime';

/** One step of a scenario's endpoint script. */
export type ScriptedEndpointEvent = {
  /** The DashScope wire frame to hand the transport, verbatim. */
  wire: Record<string, unknown>;
  /**
   * How long to wait before it, measured from the previous event. The wait is a real
   * macrotask boundary even at 0, so a delivery the previous event started can settle before
   * the next one is announced — the endpoint's own spacing, in miniature.
   */
  afterMs?: number;
};

/** What a scripted run exposes: the factory the transport dials, both traffic logs, the script. */
export type ScriptedUpstream = {
  /** Inject this as the transport's `socketFactory`. */
  readonly socketFactory: DashscopeSocketFactory;
  /** Every client frame the transport emitted, in order. */
  readonly clientFrames: Array<Record<string, unknown>>;
  /** Every endpoint frame this stand-in emitted, in order. */
  readonly endpointFrames: Array<Record<string, unknown>>;
  /** The URL the transport dialled, or `null` before it dialled. */
  readonly dialedUrl: string | null;
  /** The headers the transport dialled with — proof of what credential (if any) was used. */
  readonly dialedHeaders: Readonly<Record<string, string>> | null;
  /** The armed protocol state machine, or `null` when this connection was left to its own script. */
  readonly protocol: ScriptedProtocolState | null;
  /** Says one frame as the endpoint would, right now. */
  emit(wire: Record<string, unknown>): void;
  /** Says every frame of a script, each after its own delay, in order. Resolves on the last. */
  runScript(events: readonly ScriptedEndpointEvent[]): Promise<void>;
  /** Ends the connection as a network loss would — the socket closes without being asked to. */
  drop(): void;
};

/** The stand-in's knobs. */
export type ScriptedUpstreamOptions = {
  /** The session id this endpoint claims. */
  sessionId?: string;
  /** Acknowledge a tool result with `response.done`, as the real endpoint does. Default `true`. */
  answerToolResults?: boolean;
  /** Dial attempts that fail before one opens, so a reconnect path can be driven. Default 0. */
  failOpens?: number;
  /**
   * Arms the {@link ScriptedProtocolState} for this connection (see
   * {@link createScriptedProtocolState}). ABSENT BY DEFAULT, and that is the contract: with no
   * `protocol` every frame below is byte-for-byte what this stand-in said before the machine
   * existed, so every existing scenario keeps its own script and its own reading.
   */
  protocol?: ScriptedProtocolOptions;
};

const DEFAULT_SCRIPTED_SESSION_ID = 'sess_scripted_0000000000000000';

/** A macrotask boundary, so pending deliveries settle between two scripted events. */
function yieldToEventLoop(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds the scripted stand-in. */
export function createScriptedUpstream(options: ScriptedUpstreamOptions = {}): ScriptedUpstream {
  const sessionId = options.sessionId ?? DEFAULT_SCRIPTED_SESSION_ID;
  const answerToolResults = options.answerToolResults ?? true;

  const clientFrames: Array<Record<string, unknown>> = [];
  const endpointFrames: Array<Record<string, unknown>> = [];
  let socket: DashscopeSocket | null = null;
  let dialedUrl: string | null = null;
  let dialedHeaders: Readonly<Record<string, string>> | null = null;
  let createdAnnounced = false;
  let remainingFailingOpens = options.failOpens ?? 0;
  /**
   * The armed machine for the CURRENT connection. Rebuilt on every dial, so a reconnect starts
   * from a clean session — its own `turn_detection` reading is re-established by the `session.update`
   * the transport replays. `null` when no `protocol` was configured.
   */
  let protocol: ScriptedProtocolState | null = null;

  /** Says one frame, recording it whether or not a socket is attached yet. */
  function emit(wire: Record<string, unknown>): void {
    endpointFrames.push(wire);
    socket?.onmessage?.({ data: JSON.stringify(wire) });
  }

  const socketFactory: DashscopeSocketFactory = (url, headers) => {
    dialedUrl = url;
    dialedHeaders = headers;
    if (remainingFailingOpens > 0) {
      remainingFailingOpens -= 1;
      // A refused dial: the failure arrives on the next tick, as a real socket's would.
      const refused: DashscopeSocket = {
        send() {},
        close() {},
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      queueMicrotask(() => refused.onerror?.(new Error(`scripted endpoint: dial refused`)));
      return refused;
    }
    const active: DashscopeSocket = {
      send(data: string) {
        // Record the transport's own frame first, then answer the two frames the endpoint
        // must answer for a session to exist at all. Everything else is the script's to say.
        const frame = JSON.parse(data) as Record<string, unknown>;
        clientFrames.push(frame);
        // The armed machine answers the frames a real endpoint reacts to (a commit, a
        // `response.create`, a cancel). Disarmed, this loop never runs and nothing below changes.
        if (protocol !== null) {
          for (const answer of protocol.receive(frame)) emit(answer);
        }
        if (frame.type === 'session.update') {
          if (!createdAnnounced) {
            createdAnnounced = true;
            emit({
              type: 'session.created',
              session: { id: sessionId, object: 'realtime.session', model: 'scripted-model', modalities: ['text'] },
            });
          }
          emit({ type: 'session.updated', session: { id: sessionId, object: 'realtime.session', modalities: ['text'] } });
          return;
        }
        if (answerToolResults && frame.type === 'conversation.item.create') {
          const item = frame.item as Record<string, unknown> | undefined;
          if (item?.type === 'function_call_output') {
            emit({ type: 'response.done', response: { id: 'resp_scripted_0000', status: 'completed' } });
          }
        }
      },
      close() {
        active.onclose?.({ code: 1000, reason: 'the client closed the connection' });
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    socket = active;
    protocol = options.protocol === undefined ? null : createScriptedProtocolState(options.protocol);
    // The transport attaches its handlers synchronously after the factory returns, so opening
    // on the next microtask is after they are attached.
    queueMicrotask(() => active.onopen?.({}));
    return active;
  };

  return {
    socketFactory,
    clientFrames,
    endpointFrames,
    get dialedUrl(): string | null {
      return dialedUrl;
    },
    get dialedHeaders(): Readonly<Record<string, string>> | null {
      return dialedHeaders;
    },
    // A GETTER, not a copy: the machine is built inside `socketFactory`, so a plain property would
    // freeze this at `null` and say a reconnected run has no machine when it has a fresh one.
    get protocol(): ScriptedProtocolState | null {
      return protocol;
    },
    emit,
    async runScript(events: readonly ScriptedEndpointEvent[]): Promise<void> {
      for (const event of events) {
        await yieldToEventLoop(event.afterMs ?? 0);
        emit(event.wire);
      }
      // One more boundary, so the delivery the LAST event started has settled before the
      // caller starts asserting.
      await yieldToEventLoop(0);
    },
    drop(): void {
      socket?.onclose?.({ code: 1006, reason: 'the scripted endpoint dropped the connection' });
    },
  };
}

// --------------------------- the endpoint's own event vocabulary ---------------------------

/**
 * One interim transcription. The running words travel in `stash` while `text` stays EMPTY —
 * that asymmetry is the real endpoint's, and reading `text` here would produce an empty
 * caption on every interim event (`voice-realtime-bridge.service.ts`'s `handleCaption`).
 */
export function captionDelta(itemId: string, stash: string): Record<string, unknown> {
  return { type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, text: '', stash };
}

/** One closed utterance. The final words travel in `transcript`. */
export function captionCompleted(itemId: string, transcript: string): Record<string, unknown> {
  return { type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript };
}

/** The model's tool call. `arguments` is a JSON STRING on the wire, never an object. */
export function functionCall(name: string, args: Record<string, unknown>, callId: string): Record<string, unknown> {
  return { type: 'response.function_call_arguments.done', call_id: callId, name, arguments: JSON.stringify(args) };
}

/**
 * The model's tool call with `arguments` it never managed to finish — a call the endpoint really does
 * put on the wire when a generation is cut off mid-arguments.
 *
 * WHY IT IS A SEPARATE BUILDER AND NOT `functionCall` WITH A BAD OBJECT. {@link functionCall} takes a
 * Record and stringifies it, so the only thing it can produce is valid JSON of an object; a stand-in
 * written with it can never reach the bridge's `MALFORMED_FUNCTION_CALL` throw. This one takes the
 * RAW string, so the caller states the broken shape itself — `'{"intent": '` (not JSON at all) or
 * `'[]'` (JSON, but not an object) — which are the two shapes the bridge refuses
 * (`voice-realtime-bridge.service.ts`). The transport deliberately does NOT report either one
 * (`validateDeclaredCall` answers `null` for both), so the bridge is the single reporter and the page
 * sees exactly one `recoverable: true` error frame.
 *
 * Its consumers are the criteria that inject that fault: `e2e/voiceRealtimeScriptedUpstream.ts`
 * re-exports this vocabulary verbatim for the browser specs, and
 * `e2e/voice-realtime-intent-control.spec.ts` (case 6) is the one that sends both shapes at a
 * correction.
 */
export function malformedFunctionCall(
  name: string,
  rawArguments: string,
  callId: string,
): Record<string, unknown> {
  return { type: 'response.function_call_arguments.done', call_id: callId, name, arguments: rawArguments };
}

/** The endpoint reporting its own failure — the shape the bridge turns into `UPSTREAM_ERROR`. */
export function endpointError(code: string, message: string): Record<string, unknown> {
  return { type: 'error', error: { code, message } };
}

/**
 * The endpoint's own failure as the REAL upstream frames it: the KIND travels in `error.type`
 * (`invalid_request_error`, `InternalError.Algo.InvalidParameter`, …), not in `error.code`.
 *
 * The distinction is load-bearing. `endpointError` above writes `code`, which the bridge's
 * `UPSTREAM_ERROR` handler DOES read — so a stand-in written with it proves nothing about the
 * frames the real endpoint sends. The 2026-10-12 journal (`ef9daacd`) logged the empty-buffer
 * refusal as `{"type":"invalid_request_error","message":"Error committing input audio buffer: …"}`:
 * a `type`, and no `code` at all. A stand-in that has to reproduce that frame needs the same field.
 *
 * `code` is optional and additive, for a frame that carries both.
 */
export function upstreamError(type: string, message: string, code?: string): Record<string, unknown> {
  return { type: 'error', error: { type, ...(code === undefined ? {} : { code }), message } };
}

/** The endpoint acknowledging a `response.cancel`: the response it stopped, and nothing else. */
export function responseCancelled(responseId: string | null = null): Record<string, unknown> {
  return { type: 'response.cancelled', response: { id: responseId } };
}

/**
 * The model REPLYING IN TEXT instead of calling the tool — `MODEL_TEXT_REPLY`.
 *
 * Not a hypothetical: on 2026-10-11 a real Live Voice session lost six of seven utterances
 * this way (the model answered "OK" instead of calling `session_send`, even with
 * `tool_choice: required`). The bridge treats a non-empty reply as a fault, and no stand-in
 * could produce it before this builder.
 */
export function modelTextReply(text: string, responseId?: string): Record<string, unknown> {
  // `responseId` is optional and additive: a reply that names the response it closes is how the
  // bridge tells the model's expected remark on a tool result (a follow-up) from a real reply.
  return responseId === undefined ? { type: 'response.text.done', text } : { type: 'response.text.done', text, response_id: responseId };
}

/** A spoken segment the endpoint could not transcribe — `TRANSCRIPTION_FAILED`. */
export function transcriptionFailed(itemId: string, message: string): Record<string, unknown> {
  return { type: 'conversation.item.input_audio_transcription.failed', item_id: itemId, error: { message } };
}

// ------------------- the endpoint's turn narration (replay of a recorded session) -------------------
//
// The frames below are TOLERATED by the bridge (it does not act on most of them), but their ORDER
// relative to the commit, the transcript and the model's call is what a recorded session's journal
// shows — so a replay of that journal has to be able to say them. Shapes follow the real wire as the
// 2026-10-12 journal (`ef9daacd`) logged it.

/** The endpoint accepting a commit: the audio is now an input item. */
export function audioCommitted(itemId: string, previousItemId: string | null = null): Record<string, unknown> {
  return { type: 'input_audio_buffer.committed', item_id: itemId, previous_item_id: previousItemId };
}

/** A user audio item entering the conversation (`conversation.item.created`, role `user`). */
export function userItemCreated(itemId: string, previousItemId: string | null = null): Record<string, unknown> {
  return {
    type: 'conversation.item.created',
    previous_item_id: previousItemId,
    item: { id: itemId, object: 'realtime.item', type: 'message', role: 'user', status: 'completed', content: [{ type: 'input_audio' }] },
  };
}

/** The endpoint's own detector announcing speech — on a manual-commit wire, a sign its VAD is on. */
export function speechStarted(itemId: string | null = null): Record<string, unknown> {
  return { type: 'input_audio_buffer.speech_started', audio_start_ms: 0, item_id: itemId };
}

/** A model response beginning. */
export function responseCreated(responseId: string): Record<string, unknown> {
  return { type: 'response.created', response: { id: responseId, object: 'realtime.response', status: 'in_progress' } };
}

/** A model response finishing. `usage`, when given, rides inside `response` — the endpoint's own cost block. */
export function responseDone(responseId: string, usage?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'response.done',
    response: {
      id: responseId,
      object: 'realtime.response',
      status: 'completed',
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

// --------------------------- the endpoint's protocol state machine ---------------------------
//
// WHAT THIS IS. The builders above let a scenario SAY a frame. They cannot make a scenario REACT,
// and the endpoints that caused incidents react to what the client actually sent: a commit lands on
// a buffer the endpoint's own detector was already holding and is refused; an item is transcribed
// three commits after it was created. Replaying a journal by hand-writing every frame cannot show
// whether the CLIENT caused the endpoint's answer, because the answer is chosen by the scenario.
//
// The machine below is the endpoint's own side of the protocol, as a PURE reducer: hand it a client
// frame, get back the endpoint frames to say. It opens no socket, reads no clock and touches no
// credential, so the same object drives the in-process stand-in ({@link createScriptedUpstream}'s
// `protocol` option) and the real `ws` server in `e2e/voiceRealtimeScriptedUpstream.ts`.
//
// WHAT MAKES IT A FALSIFIABLE STAND-IN AND NOT ANOTHER SCRIPT. Its reactions are a function of the
// session's CURRENT `turn_detection`, read off every `session.update` the client sends. A session
// that keeps its own detector off (the segmented path's switch, `session.turn_detection: null`)
// gets manual commits; a session whose detector is on gets the endpoint's VAD — the refusal, the
// `speech_started`, and the item the endpoint created by itself. So a scenario that arms the machine
// and sends nothing but its own real frames reproduces the 2026-10-12 defect EXACTLY WHEN the
// client re-opens the detector, and reproduces the fixed wire when it does not. That is what makes
// `e2e/voice-realtime-segmented-replay-20261012.spec.ts`'s variant R a reading of the product
// rather than a reading of its own script.

/**
 * When one input item's transcript reaches the client.
 *
 * The real endpoint transcribes asynchronously, and the ledger at
 * `~/.cloudcli/voice-realtime-log/ef9daacd-*.jsonl` shows all five shapes: a `completed` beside the
 * commit that created the item; one several commits later; one arriving after a LATER item's own
 * transcript (what an out-of-order relay looks like from the wire); one that never comes; and a
 * `transcription.failed`.
 */
export type ScriptedTranscriptPlan =
  /** Lands in the same answer as the commit that created the item. */
  | { kind: 'on-time'; text: string }
  /** Lands `commits` commits after its own (`1` = with the next commit). */
  | { kind: 'after'; commits: number; text: string }
  /** Lands with the commit whose zero-based ordinal is `ordinal` — earlier or later than its own. */
  | { kind: 'at-commit'; ordinal: number; text: string }
  /** Never transcribed at all. */
  | { kind: 'never' }
  /** The endpoint reports it could not transcribe the item. */
  | { kind: 'failed'; message: string };

/** What an answered `response.create` says — the three shapes the model's turn takes. */
export type ScriptedAnswer =
  /** A tool call: `response.created` · `response.function_call_arguments.done` · `response.done`. */
  | { kind: 'function_call'; name: string; args: Record<string, unknown> }
  /** The model replying in text — the `response.text.done` the bridge reports as `MODEL_TEXT_REPLY`. */
  | { kind: 'text'; text: string }
  /** The endpoint opens and closes the response saying nothing at all. */
  | { kind: 'none' };

/** Whether a `response.create` is answered, and whether the session's own detector can swallow it. */
export type ScriptedResponsePolicy =
  /** Answered with the plan's (or the machine's) {@link ScriptedAnswer}. */
  | 'answer'
  /** No frame at all — the response the client asked for is silently dropped. */
  | 'withhold'
  /** Answered only while the session's detector is OFF; swallowed (nothing) while it is ON. */
  | 'swallow-under-vad';

/** One commit's script: the item it creates, its transcript, and the response that follows it. */
export type ScriptedCommitPlan = {
  /** The item id this commit creates. Default `item_scripted_<ordinal>`. */
  itemId?: string;
  /** When (and whether) the item is transcribed. Default: never. */
  transcript?: ScriptedTranscriptPlan;
  /** What the `response.create` that follows this commit gets. Default: the machine's policy. */
  response?: ScriptedResponsePolicy;
  /** What an answered response says. Default: the machine's answer. */
  answer?: ScriptedAnswer;
  /** Announce `input_audio_buffer.speech_started` for this commit, as a live detector would. */
  speechStarted?: boolean;
};

/** The knobs of the endpoint's protocol state machine. Every one is optional. */
export type ScriptedProtocolOptions = {
  /** The detector the session starts with, before any `session.update`. Default `'server_vad'`. */
  initialTurnDetection?: 'server_vad' | null;
  /**
   * Whether a commit made while the session's own detector is ON is refused with the endpoint's
   * `buffer too small, or have no audio` error. Default `true` — the real refusal, verbatim from
   * the 2026-10-12 journal.
   */
  refuseEmptyBufferUnderVad?: boolean;
  /** The per-commit script, consumed one entry per `input_audio_buffer.commit`. */
  commits?: readonly ScriptedCommitPlan[];
  /** The policy for a `response.create` no commit plan claims. Default `'answer'`. */
  response?: ScriptedResponsePolicy;
  /** The answer for a `response.create` no commit plan claims. Default `{ kind: 'none' }`. */
  answer?: ScriptedAnswer;
  /**
   * What a `function_call_output`'s synthesized resume `response.create` is answered with. Default
   * `{ kind: 'none' }` — the endpoint closes the turn without the model saying anything, which is
   * NOT the journal's `"OK"` (`MODEL_TEXT_REPLY`): a scenario that wants that reply asks for it.
   */
  toolResumeAnswer?: ScriptedAnswer;
  /** Attached to every `response.done` the machine emits — the endpoint's own usage block. */
  responseUsage?: Record<string, unknown>;
};

/** The endpoint's protocol, as an object a transport-agnostic caller drives by handing it frames. */
export type ScriptedProtocolState = {
  /** Hands one client frame in; returns the endpoint frames to say back, in order. */
  receive(frame: Record<string, unknown>): Array<Record<string, unknown>>;
  /** The `turn_detection` the session currently has, read off every `session.update` it received. */
  readonly turnDetection: 'server_vad' | null;
  /** How many `input_audio_buffer.commit` frames the machine has answered. */
  readonly committed: number;
  /** Every input item id the machine has created, in order. */
  readonly items: ReadonlyArray<string>;
};

/**
 * The real endpoint's refusal, verbatim, when a commit lands on a buffer its own detector was
 * already holding — the message the 2026-10-12 journal logged (07:47:49.034Z).
 */
const EMPTY_BUFFER_MESSAGE = 'Error committing input audio buffer: buffer too small, or have no audio.';

/** Whether a `turn_detection` value off the wire means the session's own detector is on. */
const detectorIsOn = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'server_vad';

/**
 * Builds the endpoint's protocol state machine.
 *
 * Consumed by {@link createScriptedUpstream} (its `protocol` option), directly by
 * `voice-realtime-scripted-upstream-state.test.ts`, and re-exported for
 * `e2e/voiceRealtimeScriptedUpstream.ts`.
 */
export function createScriptedProtocolState(options: ScriptedProtocolOptions = {}): ScriptedProtocolState {
  const plans = options.commits ?? [];
  const defaultPolicy = options.response ?? 'answer';
  const defaultAnswer = options.answer ?? ({ kind: 'none' } as const);
  const toolResumeAnswer = options.toolResumeAnswer ?? ({ kind: 'none' } as const);
  const refuseUnderVad = options.refuseEmptyBufferUnderVad ?? true;

  // `=== undefined`, NOT `??`: an explicit `null` is the whole point of this option — a session that
  // starts with its detector OFF — and `null ?? 'server_vad'` would silently turn it back on.
  let turnDetection: 'server_vad' | null =
    options.initialTurnDetection === undefined ? 'server_vad' : options.initialTurnDetection;
  let committed = 0;
  let responseSeq = 0;
  let lastResponseId: string | null = null;
  /** Set by a tool result the client returned; the NEXT `response.create` is its synthesized resume. */
  let awaitingToolResume = false;
  /** The plan of the commit most recently created — what the next non-resume `response.create` is about. */
  let current: ScriptedCommitPlan | undefined;
  const items: string[] = [];
  /** Transcripts a plan placed on a LATER commit's answer (a late/out-of-order relay). */
  const deferred: Array<{ at: number; itemId: string; plan: ScriptedTranscriptPlan }> = [];

  /**
   * The frames one transcript plan says when it comes DUE, or `[]` for a plan that never speaks.
   *
   * `after`/`at-commit` are scheduling kinds — the caller stores them until their ordinal arrives
   * and then calls this — so they land here, not below: a deferred plan that rendered as `[]` would
   * schedule a transcript and then say nothing, which is the `never` case by accident.
   */
  function transcriptNow(itemId: string, plan: ScriptedTranscriptPlan): Array<Record<string, unknown>> {
    if (plan.kind === 'on-time' || plan.kind === 'after' || plan.kind === 'at-commit') {
      return [captionCompleted(itemId, plan.text)];
    }
    if (plan.kind === 'failed') return [transcriptionFailed(itemId, plan.message)];
    return [];
  }

  /** The frames one `response.create` gets, and the `response.id` it opened (for a later cancel). */
  function answerCreate(policy: ScriptedResponsePolicy, answer: ScriptedAnswer): Array<Record<string, unknown>> {
    if (policy === 'withhold') return [];
    if (policy === 'swallow-under-vad' && turnDetection !== null) return [];
    const id = `resp_scripted_${responseSeq}`;
    responseSeq += 1;
    lastResponseId = id;
    const frames: Array<Record<string, unknown>> = [responseCreated(id)];
    if (answer.kind === 'function_call') frames.push(functionCall(answer.name, answer.args, `call_scripted_${responseSeq}`));
    else if (answer.kind === 'text') frames.push(modelTextReply(answer.text, id));
    frames.push(responseDone(id, options.responseUsage));
    return frames;
  }

  /** The endpoint's answer to one `input_audio_buffer.commit`. */
  function onCommit(): Array<Record<string, unknown>> {
    const ordinal = committed;
    committed += 1;
    const plan = plans[ordinal] ?? {};
    current = plan;
    const itemId = plan.itemId ?? `item_scripted_${ordinal}`;
    const previous = items.length > 0 ? items[items.length - 1]! : null;
    items.push(itemId);

    const frames: Array<Record<string, unknown>> = [];
    if (turnDetection !== null && refuseUnderVad) {
      // The detector owns the buffer. The client's commit lands on an utterance the endpoint is
      // still holding and is refused; the endpoint then says the item its OWN detector created for
      // the audio it kept — the exact three frames the 2026-10-12 journal logged after seq1.
      frames.push(upstreamError('invalid_request_error', EMPTY_BUFFER_MESSAGE));
      frames.push(speechStarted(itemId));
      frames.push(userItemCreated(itemId, previous));
    } else {
      frames.push(audioCommitted(itemId, previous));
      frames.push(userItemCreated(itemId, previous));
      if (plan.speechStarted) frames.push(speechStarted(itemId));
    }

    // This commit's own transcript (if it is due now), then anything an EARLIER item parked on this
    // ordinal — so a plan's late transcript follows the transcript of the item created here.
    const transcript = plan.transcript ?? ({ kind: 'never' } as const);
    if (transcript.kind === 'on-time' || transcript.kind === 'failed') frames.push(...transcriptNow(itemId, transcript));
    else if (transcript.kind === 'after') deferred.push({ at: ordinal + transcript.commits, itemId, plan: transcript });
    else if (transcript.kind === 'at-commit') deferred.push({ at: transcript.ordinal, itemId, plan: transcript });
    for (let i = deferred.length - 1; i >= 0; i -= 1) {
      if (deferred[i]!.at === ordinal) {
        const due = deferred.splice(i, 1)[0]!;
        frames.push(...transcriptNow(due.itemId, due.plan));
      }
    }
    return frames;
  }

  function receive(frame: Record<string, unknown>): Array<Record<string, unknown>> {
    switch (frame.type) {
      case 'session.update': {
        const session = frame.session as Record<string, unknown> | undefined;
        if (session !== undefined && 'turn_detection' in session) {
          turnDetection = detectorIsOn(session.turn_detection) ? 'server_vad' : null;
        }
        return [];
      }
      case 'input_audio_buffer.commit':
        return onCommit();
      case 'conversation.item.create': {
        const item = frame.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call_output') awaitingToolResume = true;
        return [];
      }
      case 'response.create': {
        if (awaitingToolResume) {
          awaitingToolResume = false;
          return answerCreate('answer', toolResumeAnswer);
        }
        return answerCreate(current?.response ?? defaultPolicy, current?.answer ?? defaultAnswer);
      }
      case 'response.cancel':
        return [responseCancelled(lastResponseId)];
      default:
        return [];
    }
  }

  return {
    receive,
    get turnDetection(): 'server_vad' | null {
      return turnDetection;
    },
    get committed(): number {
      return committed;
    },
    get items(): ReadonlyArray<string> {
      return items;
    },
  };
}

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

/** The endpoint reporting its own failure — the shape the bridge turns into `UPSTREAM_ERROR`. */
export function endpointError(code: string, message: string): Record<string, unknown> {
  return { type: 'error', error: { code, message } };
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

/** A model response finishing. */
export function responseDone(responseId: string): Record<string, unknown> {
  return { type: 'response.done', response: { id: responseId, object: 'realtime.response', status: 'completed' } };
}

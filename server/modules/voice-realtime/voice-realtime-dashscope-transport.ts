/**
 * The real DashScope WebSocket transport for the Realtime bridge.
 *
 * WHY THIS FILE EXISTS. `voice-realtime-bridge.service.ts` is deliberately
 * transport-injected: it speaks a WebSocket-shaped interface but never opens a
 * socket itself, so the bridge's behaviour is provable offline. This file is the
 * ONE place that turns that interface into a real socket: it dials DashScope's
 * Qwen realtime endpoint, translates the bridge's client messages into
 * DashScope's OpenAPI dialect (the "widely used realtime event form"), and
 * translates the server's events back into the bridge's vocabulary. The bridge
 * is reused byte-for-byte — its `connect()` is called with this transport as the
 * injected seam.
 *
 * WHY THE TRANSLATION IS NOT PASS-THROUGH. The two sides disagree on three
 * shapes, and each disagreement is a place a naive adapter would silently drop
 * traffic:
 *
 *  - `session.update`: the bridge hands over a flat tool declaration
 *    (`{ type, name, description, parameters }`); DashScope wants the OpenAI
 *    nesting (`{ type: 'function', function: { name, description, parameters } }`).
 *  - `function_call_output`: the bridge emits one message; DashScope needs the
 *    result wrapped as a `conversation.item.create` with a `function_call_output`
 *    item, THEN a `response.create` to resume the turn.
 *  - server → client: DashScope announces a tool call through
 *    `response.function_call_arguments.done` (and, in some dialects,
 *    `response.output_item.done` carrying a `function_call` item); the bridge's
 *    routing key is a message of `type: 'function_call'` with `callId`/`name`/
 *    `arguments`. Both deliveries are normalised here, de-duplicated by
 *    `call_id`, because a duplicate would make the bridge send the tool output
 *    twice.
 *
 * WHY THE MODEL IS AN OPTION. `DEFAULT_DASHSCOPE_REALTIME_MODEL` is the model
 * the GOAL-030 tasks name (`qwen3-omni-flash-realtime`). That model accepts the
 * connection and transcribes real audio, but it does NOT accept `session.tools`
 * — it answers a tool-shaped request in plain text instead of emitting a
 * function call. Provider-side function calling requires the tool-capable
 * sibling (`qwen3.5-omni-flash-realtime`); `experiments/voice-realtime-ambiguity/
 * real-trace/README.md` records both live connections. The model is therefore a
 * config option rather than a constant, so a caller can pick the tool-capable
 * model without a code change.
 *
 * WHY THE SOCKET IS INJECTED. `socketFactory` is the seam the criteria use: the
 * shipping default dials with `ws`, while `tests/` injects an in-process fake WS
 * server so the whole round trip — connect, `session.update`, audio frames,
 * function call, `function_call_output` — runs with zero real network. The same
 * seam makes the live trace reproducible and lets the AC-4 false form replay a
 * recorded trace against the fixture.
 *
 * Consumers: the module barrel (`index.ts`), the voice-realtime criteria
 * (`tests/voice-realtime-dashscope-transport*.test.ts`), and the manual live
 * capture (`experiments/voice-realtime-ambiguity/real-trace/capture-live.mjs`).
 */
import { WebSocket } from 'ws';

import type {
  RealtimeClientMessage,
  RealtimeFunctionDeclaration,
  RealtimeServerMessage,
  RealtimeTransport,
} from './voice-realtime-bridge.service.js';

/** DashScope's Qwen realtime WebSocket endpoint (China/Beijing region). */
export const DASHSCOPE_REALTIME_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';

/**
 * The model name the GOAL-030 tasks name. See the file header: it connects and
 * transcribes, but rejects `session.tools`, so a caller that needs provider-side
 * function calling passes `model: 'qwen3.5-omni-flash-realtime'`.
 */
export const DEFAULT_DASHSCOPE_REALTIME_MODEL = 'qwen3-omni-flash-realtime';

/**
 * The subset of the WHATWG WebSocket the transport drives. `ws`'s `WebSocket`
 * implements it, and the criteria's fake implements it too — so the transport
 * never mentions `ws` outside the default factory.
 */
export type DashscopeSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
};

/** Opens one socket. `headers` carries the bearer credential (never a query param). */
export type DashscopeSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => DashscopeSocket;

/**
 * One raw wire frame, observed as it crosses the socket.
 *
 * The transport never needs this; the manual live capture uses it to record the
 * real exchange that AC-308's real half has to preserve. `direction` is from the
 * transport's point of view.
 */
export type DashscopeWireObserver = (observation: {
  direction: 'sent' | 'received';
  atMs: number;
  wire: unknown;
}) => void;

/** A failure the transport itself raises. Never fatal to the process; routed to `onError`. */
export type DashscopeTransportError =
  | { code: 'MISSING_API_KEY' }
  | { code: 'SOCKET_NOT_OPEN'; messageType: string }
  | { code: 'SEND_FAILED'; cause: unknown }
  | { code: 'MALFORMED_SERVER_FRAME'; cause: unknown };

/** How the transport is configured. Every field has a shipping default except the credential. */
export type DashscopeTransportOptions = {
  /** Bearer credential. Defaults to `process.env.DASHSCOPE_API_KEY`. Never logged, never traced. */
  apiKey?: string;
  /** WebSocket endpoint. Defaults to {@link DASHSCOPE_REALTIME_ENDPOINT}. */
  endpoint?: string;
  /** Model name in the `?model=` query. Defaults to {@link DEFAULT_DASHSCOPE_REALTIME_MODEL}. */
  model?: string;
  /**
   * Wire-level `session` fields merged UNDER the bridge's `instructions`/`tools`.
   * The defaults make the session text-only with server VAD, which is what the
   * bridge's message set (session.update / audio append / function output) can drive.
   */
  sessionDefaults?: Readonly<Record<string, unknown>>;
  /** Socket opener. Defaults to a real `ws` client; the criteria inject a fake. */
  socketFactory?: DashscopeSocketFactory;
  /** Raw-frame tap for the manual live trace. */
  observer?: DashscopeWireObserver;
  /** Where transport-level failures go. A test can assert nothing escaped. */
  onError?: (error: DashscopeTransportError) => void;
};

/**
 * The transport the bridge drives, plus the two readings a criterion asserts on.
 *
 * `state` is the socket's own state (not the bridge's), so a test can tell "the
 * transport is open" from "the bridge thinks it is open".
 */
export type DashscopeTransport = RealtimeTransport & {
  readonly state: 'idle' | 'connecting' | 'open' | 'closed';
  /** The final URL the socket was dialled with, credential excluded. */
  readonly url: string;
};

/** The shipping session defaults: text-only output, server VAD, PCM16 in / PCM24 out. */
const DEFAULT_SESSION_DEFAULTS: Readonly<Record<string, unknown>> = {
  modalities: ['text'],
  input_audio_format: 'pcm16',
  output_audio_format: 'pcm24',
  turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 },
};

/** One bridge tool declaration as DashScope's `session.tools[]` carries it (OpenAI nesting). */
function toWireTool(declaration: RealtimeFunctionDeclaration): unknown {
  return {
    type: 'function',
    function: {
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.parameters,
    },
  };
}

/** A tool result as DashScope's `function_call_output` item carries it (a JSON string). */
function toWireOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output ?? null);
}

/**
 * Translates ONE bridge message into the DashScope frames it becomes (one or two).
 *
 * `instructions`/`tools` are written AFTER the spread so a caller's
 * `sessionDefaults` can never shadow the bridge's own session body.
 */
export function toDashscopeFrames(
  message: RealtimeClientMessage,
  sessionDefaults: Readonly<Record<string, unknown>>,
): unknown[] {
  switch (message.type) {
    case 'session.update': {
      const session: Record<string, unknown> = {
        ...sessionDefaults,
        instructions: message.session.instructions,
      };
      // An empty `tools` array is rejected by some dialects; omit it when there is nothing to advertise.
      if (message.session.tools.length > 0) {
        session.tools = message.session.tools.map(toWireTool);
      }
      return [{ type: 'session.update', session }];
    }
    case 'input_audio_buffer.append':
      return [{ type: 'input_audio_buffer.append', audio: message.audio }];
    case 'function_call_output':
      return [
        {
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: message.callId, output: toWireOutput(message.output) },
        },
        { type: 'response.create' },
      ];
  }
}

/** Reads a function call out of a `function_call` output item, or `null` if it is not one. */
function functionCallFromItem(item: unknown): RealtimeServerMessage | null {
  if (typeof item !== 'object' || item === null) return null;
  const call = item as Record<string, unknown>;
  if (call.type !== 'function_call') return null;
  if (typeof call.call_id !== 'string' || typeof call.name !== 'string') return null;
  return {
    type: 'function_call',
    callId: call.call_id,
    name: call.name,
    arguments: typeof call.arguments === 'string' ? call.arguments : '{}',
  };
}

/**
 * Translates ONE DashScope server frame into the bridge's vocabulary.
 *
 * Returns `null` for a frame that carries no event the bridge can act on (a
 * non-object, or a function-call delivery missing its identifying fields), which
 * is the only case the transport drops. Every other frame is forwarded with its
 * real `type` preserved, so the bridge's "unknown event is reported, never
 * fatal" path stays honest — the transport never decides for the bridge that an
 * event is unimportant.
 *
 * Exported so the AC-308 false forms can drive the normalisation directly.
 */
export function toBridgeEvent(wire: unknown): RealtimeServerMessage | null {
  if (typeof wire !== 'object' || wire === null) return null;
  const frame = wire as Record<string, unknown>;
  if (typeof frame.type !== 'string') return null;

  if (frame.type === 'response.function_call_arguments.done') {
    if (typeof frame.call_id !== 'string' || typeof frame.name !== 'string' || typeof frame.arguments !== 'string') {
      return null;
    }
    return { type: 'function_call', callId: frame.call_id, name: frame.name, arguments: frame.arguments };
  }
  if (frame.type === 'response.output_item.done') {
    const call = functionCallFromItem(frame.item);
    if (call !== null) return call;
  }
  return frame as RealtimeServerMessage;
}

/**
 * Builds the transport. Production passes only a credential; the criteria pass a
 * `socketFactory` and no credential, so the whole round trip stays offline.
 */
export function createDashscopeTransport(options: DashscopeTransportOptions = {}): DashscopeTransport {
  const endpoint = options.endpoint ?? DASHSCOPE_REALTIME_ENDPOINT;
  const model = options.model ?? DEFAULT_DASHSCOPE_REALTIME_MODEL;
  const sessionDefaults = options.sessionDefaults ?? DEFAULT_SESSION_DEFAULTS;
  const apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? '';
  const url = `${endpoint}?model=${encodeURIComponent(model)}`;

  let state: DashscopeTransport['state'] = 'idle';
  let socket: DashscopeSocket | null = null;
  let deliberateClose = false;
  const messageHandlers = new Set<(message: RealtimeServerMessage) => void>();
  const closeHandlers = new Set<() => void>();
  /** Tool calls already delivered, so the two DashScope deliveries never double-fire. */
  const deliveredCalls = new Set<string>();

  const emitError = (error: DashscopeTransportError): void => {
    options.onError?.(error);
  };

  /** The default opener: a real `ws` client carrying the credential as a header. */
  const dialSocket: DashscopeSocketFactory = (target, headers) =>
    new WebSocket(target, { headers }) as unknown as DashscopeSocket;

  /** One inbound frame: parse, normalise, de-duplicate, fan out. Never throws out of the socket handler. */
  function handleInbound(raw: unknown): void {
    try {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      const wire: unknown = JSON.parse(text);
      options.observer?.({ direction: 'received', atMs: Date.now(), wire });
      const event = toBridgeEvent(wire);
      if (event === null) return;
      if (event.type === 'function_call') {
        // De-duplicate on the call id when the frame carries one. A frame whose
        // call id is missing or non-string is NOT dropped here: the bridge owns
        // validating it, and it must be the one to report `MALFORMED_FUNCTION_CALL`.
        const callId = event.callId;
        if (typeof callId === 'string') {
          if (deliveredCalls.has(callId)) return;
          deliveredCalls.add(callId);
        }
      }
      for (const handler of [...messageHandlers]) handler(event);
    } catch (cause) {
      emitError({ code: 'MALFORMED_SERVER_FRAME', cause });
    }
  }

  return {
    get state(): DashscopeTransport['state'] {
      return state;
    },
    get url(): string {
      return url;
    },

    async open(): Promise<void> {
      if (state === 'open') return;
      if (state === 'connecting') {
        // A second `open()` while dialling joins the same attempt rather than
        // opening a second socket: the bridge retries only after a failure, so
        // this is the "already in flight" case.
        return;
      }
      const factory = options.socketFactory;
      if (factory === undefined && apiKey === '') {
        state = 'closed';
        emitError({ code: 'MISSING_API_KEY' });
        throw new Error('DASHSCOPE_API_KEY is required to open the real DashScope realtime transport');
      }
      state = 'connecting';
      deliberateClose = false;
      const active = (factory ?? dialSocket)(url, apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` });
      socket = active;
      await new Promise<void>((resolve, reject) => {
        active.onopen = () => {
          state = 'open';
          resolve();
        };
        active.onerror = (event) => {
          if (state !== 'open') {
            state = 'closed';
            reject(event instanceof Error ? event : new Error('DashScope realtime socket failed to open'));
          }
        };
        active.onclose = () => {
          const wasOpen = state === 'open';
          state = 'closed';
          socket = null;
          if (!wasOpen) {
            reject(new Error('DashScope realtime socket closed before it opened'));
            return;
          }
          if (!deliberateClose) {
            for (const handler of [...closeHandlers]) handler();
          }
        };
        active.onmessage = (event) => handleInbound(event.data);
      });
    },

    async close(): Promise<void> {
      deliberateClose = true;
      const active = socket;
      socket = null;
      state = 'closed';
      if (active !== null) {
        try {
          active.close(1000, 'client closed');
        } catch (cause) {
          emitError({ code: 'SEND_FAILED', cause });
        }
      }
    },

    send(message: RealtimeClientMessage): void {
      if (state !== 'open' || socket === null) {
        emitError({ code: 'SOCKET_NOT_OPEN', messageType: message.type });
        throw new Error(`DashScope realtime transport is not open (state=${state})`);
      }
      let frames: unknown[];
      try {
        frames = toDashscopeFrames(message, sessionDefaults);
      } catch (cause) {
        emitError({ code: 'SEND_FAILED', cause });
        throw cause instanceof Error ? cause : new Error(String(cause));
      }
      for (const frame of frames) {
        try {
          options.observer?.({ direction: 'sent', atMs: Date.now(), wire: frame });
          socket.send(JSON.stringify(frame));
        } catch (cause) {
          emitError({ code: 'SEND_FAILED', cause });
          throw cause instanceof Error ? cause : new Error(String(cause));
        }
      }
    },

    subscribe(handler: (message: RealtimeServerMessage) => void): () => void {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },

    onClose(handler: () => void): () => void {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
  };
}

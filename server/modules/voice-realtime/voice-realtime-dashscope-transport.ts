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
 * WHY INBOUND CALLS ARE VALIDATED HERE. The model is an untrusted peer: it can
 * name a tool that was never advertised, or hand a declared tool arguments that
 * violate the schema the session advertised. The bridge already refuses a name
 * with no executor, but nothing checks the ARGUMENTS against the declaration, so
 * a schema-violating call would otherwise reach the executor unchecked. The
 * transport is the only seam that sees BOTH the `session.update` it forwarded
 * (name → declared parameter shape) and the inbound call, so it records the
 * advertised tools and rejects a call that names an unadvertised tool
 * (`UNDECLARED_TOOL`) or violates a declared parameter shape
 * (`TOOL_ARGUMENT_SCHEMA_VIOLATION`) — both reported through `onError`, never
 * routed to the executor. The check goes live only once a `session.update` has
 * been forwarded: a session that advertised nothing has no whitelist to enforce,
 * so the transport does not invent one. Non-object / non-JSON arguments are left
 * to the bridge (`MALFORMED_FUNCTION_CALL`), which owns that report.
 *
 * KNOWN LIMITATION (AC-308 AC11, recorded so it is NOT mistaken for a bug).
 * `tool_choice: required` (and DashScope's equivalent setting) does NOT guarantee
 * the model calls a tool on every turn — the model may answer in text instead.
 * This is a property of the endpoint, not a defect to "fix" here, and it must NOT
 * be worked around by feeding this harness only inputs that always trigger a
 * call: the live trace's `functionCalls[]` is whatever the model actually chose,
 * and `capture-live.ts` exits non-zero rather than retry-until-it-calls.
 *
 * WHY THE MODEL IS AN OPTION. `DEFAULT_DASHSCOPE_REALTIME_MODEL` is the model
 * GOAL-030 formally adopts (`qwen3.8-omni-flash-realtime`): live, it honours
 * `session.tools`, emits a real endpoint-assigned `function_call`, accepts the
 * `function_call_output` backfill and continues the same turn. Its `session.update`
 * requires an explicit `voice: "Tina"` (see the `voice` option below). The earlier
 * alias `qwen3-omni-flash-realtime` connects and transcribes real audio but does
 * NOT accept `session.tools` — it answers a tool-shaped request in plain text
 * instead of emitting a function call — so it is kept only as historical evidence
 * (`experiments/voice-realtime-ambiguity/real-trace/named-model-connect.json`),
 * never as the default. The model stays a config option so a caller can pick any
 * sibling without a code change.
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
import { z } from 'zod';

// THE REGISTRY IS ENTERED BEFORE THE RULE MODULE, and the order is load-bearing rather than
// cosmetic. `asrRegistry.ts` reads this provider module's exports while its own table evaluates,
// and the provider module imports the registry back, so entering the cycle from the provider side
// meets that table half-built and throws `Cannot access 'dashscopeOmniId' before initialization`
// (measured: importing the provider without the registry first exits 1 with exactly that error).
// The side-effect import below makes the registry — and with it every registered adapter —
// evaluate first; `voice.module.ts` and `voice-dashscope-usage.test.ts` follow the same discipline
// for the same cycle.
import '../../../shared/asr/asrRegistry.js';
// The endpoint's own hostname, read from the endpoint rule's SINGLE source: AC-140 holds that no
// shipping file outside the rule module spells the addresses this service is reached at, so the
// literal lives there and this transport composes its URL from it rather than typing it again.
import { PUBLIC_HOSTNAME } from '../../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.js';

import type {
  RealtimeClientMessage,
  RealtimeFunctionCall,
  RealtimeFunctionDeclaration,
  RealtimeServerMessage,
  RealtimeTransport,
} from './voice-realtime-bridge.service.js';

/**
 * DashScope's Qwen realtime WebSocket endpoint (China/Beijing region).
 *
 * COMPOSED FROM THE RULE MODULE'S `PUBLIC_HOSTNAME`, never a second literal. AC-140 holds that the
 * addresses this service is reached at are spelled in exactly ONE shipping file, so the hostname is
 * READ out of `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts` (the module that also
 * owns `allowedBaseUrl`) and the URL is built from it. The exported value is BYTE-IDENTICAL to the
 * address this transport dialled before the hostname moved to the rule module — the WS path
 * (`/api-ws/v1/realtime`) is unchanged and the host is the same one the rule module exports — and
 * this file contains no copy of the hostname at all; the transport's own tests pin that composition
 * so a future hard-coded hostname here reds rather than quietly restoring the second copy.
 */
export const DASHSCOPE_REALTIME_ENDPOINT = `wss://${PUBLIC_HOSTNAME}/api-ws/v1/realtime`;

/**
 * The model GOAL-030 formally adopts. See the file header: it honours
 * `session.tools`, emits a real `function_call`, and requires an explicit
 * `voice: "Tina"`. A caller may override it (e.g. the tool-capable sibling
 * `qwen3.5-omni-flash-realtime`, or the tools-rejecting historical alias).
 */
export const DEFAULT_DASHSCOPE_REALTIME_MODEL = 'qwen3.8-omni-flash-realtime';

/** The `voice` the adopted target model requires, recorded here so it is never silent. */
export const DEFAULT_DASHSCOPE_REALTIME_VOICE = 'Tina';

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
  | { code: 'MALFORMED_SERVER_FRAME'; cause: unknown }
  /** The model named a tool the session never advertised. Rejected, never routed. */
  | { code: 'UNDECLARED_TOOL'; tool: string; callId: string }
  /** The call's arguments violate the declared parameter shape. Rejected, never routed. */
  | { code: 'TOOL_ARGUMENT_SCHEMA_VIOLATION'; tool: string; callId: string; reason: string };

/** How the transport is configured. Every field has a shipping default except the credential. */
export type DashscopeTransportOptions = {
  /** Bearer credential. Defaults to `process.env.DASHSCOPE_API_KEY`. Never logged, never traced. */
  apiKey?: string;
  /** WebSocket endpoint. Defaults to {@link DASHSCOPE_REALTIME_ENDPOINT}. */
  endpoint?: string;
  /** Model name in the `?model=` query. Defaults to {@link DEFAULT_DASHSCOPE_REALTIME_MODEL}. */
  model?: string;
  /**
   * Session `voice`. The adopted target model requires an explicit
   * `voice: "Tina"` (see {@link DEFAULT_DASHSCOPE_REALTIME_VOICE}); other models
   * use the endpoint default. Merged into the session body `session.update`
   * carries. Omitted by default, so a caller that does not need it is unaffected.
   */
  voice?: string;
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
 * Validates one inbound call's arguments against the parameter shape advertised
 * for its tool, returning a human-readable reason or `null` when they conform.
 *
 * `shape` is the tool's declared raw input shape — the same `z.ZodRawShape` the
 * bridge advertised in `session.update` — so the check binds to the ACTUAL
 * declaration rather than a second, drift-prone copy. Exported so the AC-308 AC10
 * false forms can drive it directly.
 */
export function argumentSchemaViolation(
  shape: Readonly<Record<string, unknown>>,
  args: Record<string, unknown>,
): string | null {
  const result = z.object(shape as unknown as z.ZodRawShape).safeParse(args);
  if (result.success) return null;
  return result.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/**
 * Builds the transport. Production passes only a credential; the criteria pass a
 * `socketFactory` and no credential, so the whole round trip stays offline.
 */
export function createDashscopeTransport(options: DashscopeTransportOptions = {}): DashscopeTransport {
  const endpoint = options.endpoint ?? DASHSCOPE_REALTIME_ENDPOINT;
  const model = options.model ?? DEFAULT_DASHSCOPE_REALTIME_MODEL;
  const baseSessionDefaults = options.sessionDefaults ?? DEFAULT_SESSION_DEFAULTS;
  // `voice` is a first-class option (the adopted model needs `voice: "Tina"`), so
  // it merges over whatever session body the caller supplied.
  const sessionDefaults: Readonly<Record<string, unknown>> =
    options.voice === undefined ? baseSessionDefaults : { ...baseSessionDefaults, voice: options.voice };
  const apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? '';
  const url = `${endpoint}?model=${encodeURIComponent(model)}`;

  let state: DashscopeTransport['state'] = 'idle';
  let socket: DashscopeSocket | null = null;
  let deliberateClose = false;
  const messageHandlers = new Set<(message: RealtimeServerMessage) => void>();
  const closeHandlers = new Set<() => void>();
  /** Tool calls already delivered, so the two DashScope deliveries never double-fire. */
  const deliveredCalls = new Set<string>();
  /** Tools THIS transport has advertised: name → the declared raw parameter shape. */
  const declaredTools = new Map<string, Readonly<Record<string, unknown>>>();

  const emitError = (error: DashscopeTransportError): void => {
    options.onError?.(error);
  };

  /** The default opener: a real `ws` client carrying the credential as a header. */
  const dialSocket: DashscopeSocketFactory = (target, headers) =>
    new WebSocket(target, { headers }) as unknown as DashscopeSocket;

  /** Records the tools a forwarded `session.update` advertised, so inbound calls can be checked. */
  function recordDeclaredTools(message: RealtimeClientMessage): void {
    if (message.type !== 'session.update') return;
    declaredTools.clear();
    for (const tool of message.session.tools) {
      declaredTools.set(tool.name, tool.parameters as Readonly<Record<string, unknown>>);
    }
  }

  /**
   * Checks one inbound call against the tools this transport advertised, returning
   * the error to report (and withhold) or `null` when the call may be forwarded.
   *
   * With nothing advertised there is no whitelist to enforce; that only happens
   * when no `session.update` was ever forwarded, which no real session does.
   */
  function validateDeclaredCall(call: { name: string; callId: string; arguments: string }): DashscopeTransportError | null {
    if (declaredTools.size === 0) return null;
    const shape = declaredTools.get(call.name);
    if (shape === undefined) {
      return { code: 'UNDECLARED_TOOL', tool: call.name, callId: call.callId };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments);
    } catch {
      // Not JSON: the bridge owns that report (`MALFORMED_FUNCTION_CALL`); do not double-report.
      return null;
    }
    // A non-object argument is the bridge's malformed-call domain too — defer.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const reason = argumentSchemaViolation(shape, parsed as Record<string, unknown>);
    if (reason === null) return null;
    return { code: 'TOOL_ARGUMENT_SCHEMA_VIOLATION', tool: call.name, callId: call.callId, reason };
  }

  /** One inbound frame: parse, normalise, validate, de-duplicate, fan out. Never throws out of the socket handler. */
  function handleInbound(raw: unknown): void {
    try {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      const wire: unknown = JSON.parse(text);
      options.observer?.({ direction: 'received', atMs: Date.now(), wire });
      const event = toBridgeEvent(wire);
      if (event === null) return;
      if (event.type === 'function_call') {
        // Validate BEFORE de-duplicating: a rejected call must not claim its call
        // id, or a later corrected delivery of the same id would be dropped.
        const rejection = validateDeclaredCall(event as RealtimeFunctionCall);
        if (rejection !== null) {
          emitError(rejection);
          return;
        }
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
      // A forwarded `session.update` is exactly what makes the advertised tool set
      // knowable, so the whitelist/schema check turns on from here.
      recordDeclaredTools(message);
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

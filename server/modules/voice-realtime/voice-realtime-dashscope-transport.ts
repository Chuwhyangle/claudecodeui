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
 * WHY THE TRANSPORT OWNS THE RESPONSE-CONCURRENCY STATE. The endpoint runs
 * server-side VAD, so IT can start a response (`response.created`) at the same
 * moment the client decides to resume the turn after a tool result. A second
 * `response.create` then is rejected with `error: "Conversation already has an
 * active response"` — the exact frame `experiments/voice-realtime-ambiguity/
 * real-trace/qwen38-omni-realtime-trace.json` recorded live (exchange index 44:
 * the client sent its own `response.create` one millisecond before the server's
 * first response completed). The transport synthesizes that `response.create`
 * for every `function_call_output`, so it is the layer that must not let it
 * race: it keeps a NAMED in-flight-response state ({@link
 * DashscopeResponseConcurrency}, read off `response.created` / `response.done`),
 * holds the synthesized `response.create` back while one is in flight, and
 * flushes it — coalesced — when that response completes. A conflict frame the
 * endpoint reports anyway is attributed here as the `RESPONSE_CONCURRENCY_CONFLICT`
 * transport error and ABSORBED, never forwarded: the transport is the only layer
 * holding the state that makes the frame attributable, so it is the layer that
 * answers for it. (That is the one deliberate exception to "the transport never
 * decides for the bridge that an event is unimportant", and it exists because
 * the alternative — the bridge reporting a known, survivable race as an
 * unexplained event — is strictly less honest.)
 *
 * WHY A RECONNECT REPLAYS UNACKED OUTPUTS. A `function_call_output` is not done
 * when it leaves the socket: the endpoint acknowledges it with a
 * `conversation.item.created` item carrying the same `call_id` (the trace's index
 * 43). A drop between "sent" and "acknowledged" would silently lose the tool
 * result and stall the turn, so the transport keeps the unacknowledged outputs
 * keyed by `call_id` and replays them, once each, when a socket comes back up.
 * The `call_id` key IS the de-duplication: an output the endpoint already
 * acknowledged was removed, so a reconnect can never re-send it and make the
 * model process the same result twice. (A `response.create` still held by the
 * gate when the socket dies is dropped with it: the unacknowledged result's
 * replay re-synthesizes one, and the endpoint's own VAD resumes the turn.)
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
  | { code: 'TOOL_ARGUMENT_SCHEMA_VIOLATION'; tool: string; callId: string; reason: string }
  /**
   * The endpoint reported that a `response.create` raced a response it already
   * had in flight. Absorbed here (never forwarded), because the in-flight state
   * above is what makes this frame attributable to the race rather than to an
   * unexplained server failure.
   */
  | { code: 'RESPONSE_CONCURRENCY_CONFLICT'; message: string };

/**
 * The transport's explicit "is a response currently in flight?" reading — the
 * named state this task's AC1 requires to exist and to be consulted before a
 * new `response.create` goes out.
 *
 * `activeResponseId` is the id of the response the endpoint last announced
 * (`response.created`) and has not yet completed (`response.done`); `null` means
 * none is in flight. `deferredResponseCreates` counts the synthesized
 * `response.create`s held back because one was — they are flushed, coalesced,
 * the moment that response completes.
 */
export type DashscopeResponseConcurrency = {
  readonly activeResponseId: string | null;
  readonly deferredResponseCreates: number;
};

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
  /**
   * The live in-flight-response reading. A state that exists only in the
   * transport's head is not observable, and this one has to be: it is what stops
   * a resume racing the endpoint's own VAD response. Consumers: the
   * connection-resilience criterion (`tests/voice-realtime-connection-resilience
   * .test.ts`); production never has to read it.
   */
  readonly responseConcurrency: DashscopeResponseConcurrency;
};

/** The shipping session defaults: text-only output, server VAD, PCM16 in / PCM24 out. */
const DEFAULT_SESSION_DEFAULTS: Readonly<Record<string, unknown>> = {
  modalities: ['text'],
  input_audio_format: 'pcm16',
  output_audio_format: 'pcm24',
  turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 },
  // THE ADOPTED MODEL REQUIRES AN EXPLICIT VOICE, AND ITS ABSENCE FAILS LATE.
  // Left unset the endpoint falls back to its own default (`Chelsie`) and rejects
  // the session only when a response is created:
  //   <400> InternalError.Algo.InvalidParameter: Voice 'Chelsie' is not supported.
  // By then `session.update` has been accepted and the user's audio is even being
  // transcribed — so it presents as "it hears me but never answers", then a dropped
  // socket, and nothing points at a missing voice. It lives in the DEFAULTS rather
  // than staying a caller-supplied option for exactly that reason: a caller who
  // forgets it gets no error at construction time, only a dead session.
  voice: DEFAULT_DASHSCOPE_REALTIME_VOICE,
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
 * True for the `response.create` frame the transport synthesizes for a tool
 * result — the one frame the in-flight gate holds back.
 */
function isResponseCreateFrame(frame: unknown): boolean {
  return typeof frame === 'object' && frame !== null && (frame as { type?: unknown }).type === 'response.create';
}

/** The `response.id` a `response.created` / `response.done` frame carries, or `null`. */
function responseIdIn(frame: RealtimeServerMessage): string | null {
  const response = frame.response as { id?: unknown } | undefined;
  return typeof response?.id === 'string' ? response.id : null;
}

/** The `error.message` an endpoint `error` frame carries, or `null` when it carries none. */
function serverErrorMessage(frame: RealtimeServerMessage): string | null {
  const error = frame.error as { message?: unknown } | undefined;
  return typeof error?.message === 'string' ? error.message : null;
}

/**
 * True when an inbound frame is the endpoint reporting that a `response.create`
 * raced a response it already had in flight — the live trace's index 44.
 *
 * Matched on the endpoint's own wording because that wording IS the evidence:
 * the frame carries no machine-readable code, and a broader match (any `error`)
 * would swallow failures this transport must surface rather than absorb.
 */
function isActiveResponseConflict(frame: RealtimeServerMessage): boolean {
  if (frame.type !== 'error') return false;
  const message = serverErrorMessage(frame);
  return message !== null && /already has an active response/i.test(message);
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
 * Rewrites numeric STRINGS to numbers where — and only where — the declared field is a number.
 *
 * Models routinely write `"waitSeconds": "120"`. The value is unambiguous, the schema is the
 * thing that is strict, and rejecting it cost a real turn (and a red error on the user's bar)
 * for nothing. A field is only touched when the string fails its schema AND the number parses
 * as a finite value that passes it, so nothing the schema accepts is ever altered.
 *
 * Returns the (possibly new) arguments and whether anything changed.
 */
function coerceNumericStrings(
  shape: Readonly<Record<string, unknown>>,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const field = shape[key] as z.ZodType | undefined;
    if (typeof value !== 'string' || field === undefined || value.trim() === '') continue;
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber)) continue;
    if (!field.safeParse(value).success && field.safeParse(asNumber).success) {
      next[key] = asNumber;
      changed = true;
    }
  }
  return { args: next, changed };
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
  /** Rejections already reported, so a call delivered twice is reported once. */
  const reportedRejections = new Set<string>();
  /** Tools THIS transport has advertised: name → the declared raw parameter shape. */
  const declaredTools = new Map<string, Readonly<Record<string, unknown>>>();
  /**
   * The named in-flight-response state (AC1): the id of the response the endpoint
   * last announced and has not completed, or `null`. Read off the normalised
   * inbound event, so both DashScope deliveries count, and consulted by
   * {@link sendClientFrames} before any synthesized `response.create` goes out.
   */
  let activeResponseId: string | null = null;
  /** How many `response.create`s that gate is holding; flushed, coalesced, on `response.done`. */
  let deferredResponseCreates = 0;
  /**
   * Tool results sent but not yet acknowledged by the endpoint, keyed by
   * `call_id`. A reconnect replays exactly these (see {@link replayUnackedOutputs});
   * an acknowledged one was removed, which is the whole de-duplication.
   */
  const unackedOutputs = new Map<string, Extract<RealtimeClientMessage, { type: 'function_call_output' }>>();

  const emitError = (error: DashscopeTransportError): void => {
    // The endpoint delivers one call twice (arguments.done and output_item.done) and a rejected
    // call deliberately does not claim its call id, so the same rejection arrives twice. Report
    // it once per call and reason.
    if (error.code === 'TOOL_ARGUMENT_SCHEMA_VIOLATION' || error.code === 'UNDECLARED_TOOL') {
      const key = `${error.code}:${error.callId}:${'reason' in error ? error.reason : ''}`;
      if (reportedRejections.has(key)) return;
      reportedRejections.add(key);
    }
    options.onError?.(error);
  };

  /** The default opener: a real `ws` client carrying the credential as a header. */
  const dialSocket: DashscopeSocketFactory = (target, headers) =>
    new WebSocket(target, { headers }) as unknown as DashscopeSocket;

  /** Writes one wire frame, reporting a socket failure as `SEND_FAILED` and re-throwing it. */
  function sendFrame(frame: unknown): void {
    const active = socket;
    if (active === null) {
      emitError({ code: 'SOCKET_NOT_OPEN', messageType: String((frame as { type?: unknown }).type ?? 'unknown') });
      throw new Error('DashScope realtime transport has no open socket');
    }
    try {
      options.observer?.({ direction: 'sent', atMs: Date.now(), wire: frame });
      active.send(JSON.stringify(frame));
    } catch (cause) {
      emitError({ code: 'SEND_FAILED', cause });
      throw cause instanceof Error ? cause : new Error(String(cause));
    }
  }

  /**
   * Puts one client message's wire frames on the socket, holding the synthesized
   * `response.create` back while a response is in flight (AC1's gate). The held
   * creates are coalesced: N tool results resolved during one response become ONE
   * resume, which is all the endpoint needs to continue the turn.
   */
  function sendClientFrames(frames: readonly unknown[]): void {
    for (const frame of frames) {
      if (isResponseCreateFrame(frame) && activeResponseId !== null) {
        deferredResponseCreates += 1;
        continue;
      }
      sendFrame(frame);
    }
  }

  /**
   * Flushes the coalesced `response.create` once the response it was held behind
   * completed. A socket that died in between is reported by `sendFrame`
   * (`SEND_FAILED`) and otherwise ignored: a lost resume is not a malformed
   * frame, and the reconnect path re-drives the turn.
   */
  function flushDeferredResponseCreates(): void {
    if (deferredResponseCreates === 0) return;
    deferredResponseCreates = 0;
    try {
      sendFrame({ type: 'response.create' });
    } catch {
      // Already reported as SEND_FAILED; the socket is down.
    }
  }

  /**
   * Replays the tool results the endpoint never acknowledged, once each.
   *
   * Called right after a socket comes up. An acknowledged result was deleted from
   * {@link unackedOutputs}, so a reconnect can never re-send one and make the model
   * process the same result twice; an unacknowledged one stays queued until it is
   * acknowledged, so a drop before the ack loses nothing. A socket that dies
   * mid-replay stops the walk — the still-queued results are retried next time.
   */
  function replayUnackedOutputs(): void {
    if (unackedOutputs.size === 0) return;
    for (const message of [...unackedOutputs.values()]) {
      try {
        sendClientFrames(toDashscopeFrames(message, sessionDefaults));
      } catch {
        return;
      }
    }
  }

  /** Marks a tool result acknowledged once the endpoint echoes its item back. */
  function acknowledgeOutput(event: RealtimeServerMessage): void {
    const item = event.item as { type?: unknown; call_id?: unknown } | undefined;
    if (item?.type !== 'function_call_output' || typeof item.call_id !== 'string') return;
    unackedOutputs.delete(item.call_id);
  }

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
    const coerced = coerceNumericStrings(shape, parsed as Record<string, unknown>);
    if (coerced.changed) {
      // Forward the corrected arguments, not the original text: the executor reads them.
      (call as { arguments: string }).arguments = JSON.stringify(coerced.args);
    }
    const reason = argumentSchemaViolation(shape, coerced.args);
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
      // AC1: the endpoint's response lifecycle IS the in-flight state. Both the
      // gate in `sendClientFrames` and the conflict absorption below read it.
      if (event.type === 'response.created') {
        activeResponseId = responseIdIn(event);
      } else if (event.type === 'response.done') {
        activeResponseId = null;
        flushDeferredResponseCreates();
      } else if (isActiveResponseConflict(event)) {
        // Absorbed, never forwarded: this is the race the in-flight state exists to
        // prevent, and the endpoint can report it about a response it has already
        // completed — which is exactly why the recorded frame lands AFTER
        // `response.done`. The transport owns the state that makes it attributable,
        // so the transport answers for it.
        emitError({ code: 'RESPONSE_CONCURRENCY_CONFLICT', message: serverErrorMessage(event) ?? '' });
        return;
      } else if (event.type === 'conversation.item.created') {
        // The endpoint echoing a tool result back is its acknowledgement of it.
        acknowledgeOutput(event);
      }
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
    get responseConcurrency(): DashscopeResponseConcurrency {
      return { activeResponseId, deferredResponseCreates };
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
          // The endpoint's response lifecycle died with this socket. A fresh socket
          // starts idle, and any create the gate was still holding is dropped with
          // it (an unacknowledged result's replay re-synthesizes one).
          activeResponseId = null;
          deferredResponseCreates = 0;
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
      // A socket is up: resume the logical session by replaying every tool result
      // the endpoint never acknowledged, once each.
      replayUnackedOutputs();
    },

    async close(): Promise<void> {
      deliberateClose = true;
      const active = socket;
      socket = null;
      state = 'closed';
      // A deliberate close ends the logical session: there is nothing to resume.
      unackedOutputs.clear();
      activeResponseId = null;
      deferredResponseCreates = 0;
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
      // Remember the tool result until the endpoint acknowledges it, so a drop
      // before the ack replays it instead of losing it. Registered BEFORE the send,
      // so an endpoint that acknowledges synchronously still clears it.
      if (message.type === 'function_call_output') {
        unackedOutputs.set(message.callId, message);
      }
      sendClientFrames(frames);
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

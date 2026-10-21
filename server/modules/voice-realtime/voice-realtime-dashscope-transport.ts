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
  RealtimeCloseDetail,
  RealtimeFunctionCall,
  RealtimeFunctionDeclaration,
  RealtimeServerMessage,
  RealtimeTransport,
} from './voice-realtime-bridge.service.js';
import { DEFAULT_TURN_DETECTION } from './voice-realtime-turn-detection.js';

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
 * The DashScope alias host, re-exported as the IN-SERVER seam for the module's other shipping
 * leaves: `voice-realtime-summary.ts` and `voice-realtime-tts.ts` compose their HTTP endpoints from
 * it. The hostname itself still lives ONCE, in the endpoint rule module — this is a binding, not a
 * copy.
 *
 * WHY THEY READ IT HERE RATHER THAN FROM THE RULE MODULE DIRECTLY. AC-394's
 * `unresolvedInternalBudget` counts every static import of the repo-root `shared/` tree from a
 * non-test `server/` file (the scanner walks `server/` only, so the target never resolves), and the
 * budget is a ratchet. This module already pays the registry + rule-module imports that its own
 * composition needs (see the ordering comment above); a second and third pair in the sibling leaves
 * would push the reading from 19 to 23 and red the ratchet. Reading the same in-server binding
 * keeps the budget at its pinned value while the single-source rule holds: no leaf spells the host,
 * and the registry-first evaluation order established above covers these consumers too.
 */
export { PUBLIC_HOSTNAME as DASHSCOPE_PUBLIC_HOSTNAME };

/**
 * Price of `qwen3.8-omni-flash-realtime`, in CNY per 1,000 tokens, as billed in October 2026
 * (text input 0.0015, audio input 0.006, text output 0.0045). Used ONLY to estimate spend for the
 * guard and the log; the invoice is the authority and these will go stale if the price changes.
 */
const PRICE_CNY_PER_1K = { textInput: 0.0015, audioInput: 0.006, textOutput: 0.0045 } as const;

/**
 * Estimated cost, in CNY, of one `response.done`'s `usage` object. Unknown shapes cost 0 (the guard
 * must never fire on data it cannot read).
 *
 * Consumers: this transport's spend guard and `server/index.ts`'s usage log line.
 */
export function estimateRealtimeCostCny(usage: unknown): number {
  const u = (usage ?? {}) as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { audio_tokens?: unknown; text_tokens?: unknown };
  };
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  const audio = typeof u.input_tokens_details?.audio_tokens === 'number' ? u.input_tokens_details.audio_tokens : 0;
  const text = typeof u.input_tokens_details?.text_tokens === 'number' ? u.input_tokens_details.text_tokens : Math.max(0, input - audio);
  return (
    (text * PRICE_CNY_PER_1K.textInput + audio * PRICE_CNY_PER_1K.audioInput + output * PRICE_CNY_PER_1K.textOutput) / 1000
  );
}

/**
 * The text-token level past which one connection's running context is big enough that EVERY
 * subsequent `response.done` reprocesses (and is billed for) that whole accumulated history — a
 * realtime session's own cost shape, not a bug. Below this a long exchange is cheap; above it the
 * marginal cost of one more turn keeps climbing. Observation only: nothing here closes a
 * connection or drops a frame, it just names the threshold a human-facing log line can check
 * against before someone goes looking for "why did this call get expensive".
 */
export const CONTEXT_BUDGET_WARNING_TOKENS = 5000;

/**
 * The cadence of the outbound audio heartbeat, counted in 20 ms frames.
 *
 * 250 frames is 5.00 s of audio — deliberately the SAME cadence as the relay's own
 * `from-browser audio frames=` line (`voice-realtime-ws-proxy.service.ts`), so the two records are
 * read against each other directly: the browser line says what arrived, this one says what went
 * out and what the socket had not written yet. A cadence that differed would need converting, and
 * the conversion is where a 50-second discrepancy hides.
 */
export const UPSTREAM_AUDIO_HEARTBEAT_FRAMES = 250;

/**
 * The decoded PCM byte length of one base64 frame, read off the encoded length rather than by
 * decoding it — this runs once per 20 ms of audio, and the answer is exact for well-formed base64.
 * The heartbeat reports DECODED bytes because that is the unit the endpoint is sent; the encoded
 * text is a third larger, so reporting it would overstate every reading.
 */
function base64DecodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/**
 * Reads one `response.done`'s cumulative text/audio token reading and says whether this
 * connection has crossed {@link CONTEXT_BUDGET_WARNING_TOKENS}. `usage.input_tokens_details` is
 * already a running total for the whole connection (confirmed against a real Aliyun bill line,
 * not assumed) — so a single response's own reading is the connection's current context size,
 * not a delta. Unknown shapes read as zero, matching {@link estimateRealtimeCostCny}'s fail-open
 * rule: a budget check must never throw on data it cannot parse.
 */
export function contextBudgetStatus(usage: unknown): { textTokens: number; audioTokens: number; overBudget: boolean; thresholdTokens: number } {
  const u = (usage ?? {}) as {
    input_tokens?: unknown;
    input_tokens_details?: { audio_tokens?: unknown; text_tokens?: unknown };
  };
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const audio = typeof u.input_tokens_details?.audio_tokens === 'number' ? u.input_tokens_details.audio_tokens : 0;
  const text = typeof u.input_tokens_details?.text_tokens === 'number' ? u.input_tokens_details.text_tokens : Math.max(0, input - audio);
  return { textTokens: text, audioTokens: audio, overBudget: text >= CONTEXT_BUDGET_WARNING_TOKENS, thresholdTokens: CONTEXT_BUDGET_WARNING_TOKENS };
}

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
  /**
   * Bytes handed to `send` that the socket has NOT yet written to the wire. `ws`'s own reading,
   * passed through untouched.
   *
   * OPTIONAL, and its absence is a READING rather than a zero: a stand-in socket that cannot know
   * reports nothing, and {@link DashscopeTransportOptions.log}'s heartbeat says `n/a` for it. A
   * fabricated `0` would be indistinguishable from a healthy empty buffer, which is the one
   * confusion that line exists to remove.
   */
  readonly bufferedAmount?: number;
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
  /**
   * The stored DashScope key is the frontend's masked placeholder (••••••••) — the settings page
   * renders a saved key as bullets, and that masked form was written back to the store. Dialling
   * with it is a guaranteed 401 that reads as "could not reach upstream"; naming it here lets the
   * page say "misconfigured" instead of "connection failed".
   */
  | { code: 'MASKED_API_KEY' }
  /**
   * The estimated spend of this connection crossed a configured limit. Reported once; the consumer is
   * expected to END the session. A model that retries a tool call in a loop spends ~¥0.0045 every
   * 0.65 s, which no per-request check can see — only the running cost can.
   */
  | { code: 'SPEND_LIMIT'; scope: 'window' | 'total'; cny: number; limitCny: number; windowMs?: number }
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

/**
 * The DashScope credential a Live Voice realtime connection dials with, resolved from the user's
 * saved setting alone. The deployment's `DASHSCOPE_API_KEY` environment variable is deliberately
 * NOT read here anymore (2026-10-19 ruling): the user's own key is the only source, so a missing or
 * wrong value surfaces as a clear credential error instead of silently falling back to a deployment
 * key the operator may not have meant for this user.
 *
 * An unset or whitespace-only value resolves to `''` so the transport's own `MISSING_API_KEY` guard
 * still fires; a masked placeholder (••••••••) is passed through unchanged so the transport's
 * `MASKED_API_KEY` guard names it.
 *
 * Consumers: `server/index.ts` at the realtime assembly point (through this module's barrel), and
 * `tests/voice-realtime-api-key-resolution.test.ts`.
 */
export function resolveRealtimeApiKey(userDashscopeApiKey: string | undefined): string {
  return userDashscopeApiKey?.trim() ?? '';
}

/**
 * Whether a stored DashScope key is the frontend's masked placeholder — every character a bullet
 * (`•`). The settings page renders a saved key that way, so a value that round-tripped the
 * masked form is not a credential at all; a whitespace-only or empty string is NOT masked (that is
 * "unset", judged by {@link MISSING_API_KEY} before this).
 */
export function isMaskedDashscopeApiKey(apiKey: string): boolean {
  const trimmed = apiKey.trim();
  return trimmed.length > 0 && [...trimmed].every((ch) => ch === '•');
}

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
  /**
   * Whether the deployment asks the model to SPEAK after a delivered tool result. Default true,
   * the endpoint's normal tool-call loop (the model remarks "OK" on the result). A pure relay has
   * nothing to say about the result, and each spoken turn re-reads the WHOLE session context
   * (measured: 4 of 8 responses in a recorded four-instruction session were only the model
   * remarking "sent"), so the voice connection declares `false` when its tool-result wording asks
   * for silence (`VOICE_REALTIME_CLOSING_TURN=silent`).
   *
   * IT DOES NOT GATE THE TOOL-RESUME `response.create`. That create is protocol-mandatory — the
   * endpoint only drains the resumed turn when it is asked to run one — and suppressing it leaked
   * one orphan turn per tool result until `Turn queue overflow: capacity=8` rejected the ninth
   * user turn and the whole session went silent (2026-10-18 journals). The transport therefore
   * ALWAYS sends the synthesized resume; whether the model says anything is carried by the prompt
   * (the `silent` wording asks it to say nothing), never by the wire. The option stays as the
   * deployment's DECLARED intent so the composition root still names one closing-turn value where
   * the prompt seam is composed; the send path does not read it.
   */
  respondToToolOutputs?: boolean;
  /** Socket opener. Defaults to a real `ws` client; the criteria inject a fake. */
  socketFactory?: DashscopeSocketFactory;
  /** Raw-frame tap for the manual live trace. */
  observer?: DashscopeWireObserver;
  /**
   * Spend guard. `maxCnyPerWindow` is the most the connection may spend inside any `windowMs` (default
   * 30 s) and `maxCnyTotal` the most it may spend in all; either, when crossed, reports `SPEND_LIMIT`
   * once. Costs are ESTIMATED from each `response.done`'s usage (see {@link estimateRealtimeCostCny}).
   */
  spendGuard?: { maxCnyPerWindow?: number; windowMs?: number; maxCnyTotal?: number };
  /** Where transport-level failures go. A test can assert nothing escaped. */
  onError?: (error: DashscopeTransportError) => void;
  /**
   * Where the transport's periodic reading of its OWN outbound audio goes — one line per
   * {@link UPSTREAM_AUDIO_HEARTBEAT_FRAMES} frames of audio written to the socket.
   *
   * It lives on the transport because the fact it reports lives here: only this layer can couple
   * "audio the relay pushed" with "audio the socket has not written yet", and that pairing is what
   * tells a delay that is upstream's from a delay that is ours. The relay's journal drops
   * `input_audio_buffer.append` outright, so without this line nothing on disk records WHEN audio
   * crossed the server→upstream wire — measured 2026-10-12, when a 118 s upstream silence left
   * ~50 s of audio unaccountable between the transport and the endpoint.
   *
   * Optional: a caller that passes none gets the transport it had, byte for byte.
   */
  log?: (line: string) => void;
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

/**
 * The shipping session defaults: text-only output, server VAD, PCM16 in / PCM24 out.
 *
 * EXPORTED so the ONE assembly point that composes a deployment's session body
 * (`server/index.ts`, `buildVoiceRealtimeSeams`) can spread these and replace only
 * `turn_detection` with its resolved value, rather than re-listing the formats, modalities and voice
 * here and in the handler and letting the two lists drift.
 */
export const DEFAULT_SESSION_DEFAULTS: Readonly<Record<string, unknown>> = {
  modalities: ['text'],
  input_audio_format: 'pcm16',
  output_audio_format: 'pcm24',
  // THE DETECTOR'S PARAMETERS HAVE ONE SOURCE, NOT TWO. This field used to be a second literal
  // copy of `DEFAULT_TURN_DETECTION`; it now IS that object, so the fallback the transport uses
  // when no caller passes `sessionDefaults` and the value `resolveTurnDetection` hands a deployment
  // that configures nothing cannot disagree — they are the same frozen object (AC5).
  turn_detection: DEFAULT_TURN_DETECTION,
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

/**
 * The wire ceiling for one tool result (chars of the serialised string, AC-xxx). `session_send`'s
 * own `{accepted, instruction}` acks are a few hundred chars and never approach this; it exists
 * for the read tools (`session_get`, `run_get`) whose builders are the MCP gateway's own
 * generic-sized ones, shared with non-voice callers, with no voice-specific size limit of their
 * own. Every `function_call_output` becomes a PERMANENT, ever-reprocessed part of the realtime
 * conversation (no `conversation.item.delete`/`truncate` exists on this wire, see the file-level
 * comment), so an oversized one does not cost once — it costs on every later response in the same
 * connection.
 */
export const TOOL_OUTPUT_MAX_CHARS = 2000;

/**
 * A tool result as DashScope's `function_call_output` item carries it (a JSON string), capped at
 * {@link TOOL_OUTPUT_MAX_CHARS}. Truncation REPLACES the payload with a small, clearly-marked
 * stand-in rather than silently cutting the JSON string mid-structure (which would hand the model
 * invalid JSON) — `truncated: true` and the real `originalChars` count are visible to both the
 * model and a journal reader, so a caller never mistakes a capped result for a complete one.
 */
function toWireOutput(output: unknown): string {
  const raw = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  if (raw.length <= TOOL_OUTPUT_MAX_CHARS) return raw;
  return JSON.stringify({
    truncated: true,
    originalChars: raw.length,
    maxChars: TOOL_OUTPUT_MAX_CHARS,
    preview: raw.slice(0, TOOL_OUTPUT_MAX_CHARS),
  });
}

/**
 * The `turn_detection` a LOGICAL session has been switched to by `session.turn_detection`, as the
 * transport remembered it — `undefined` while no switch has been sent on this session.
 *
 * A full `session.update` is the one frame that can CONTRADICT the switch: it re-states the whole
 * session body, `turn_detection` included, so a session that had turned the endpoint's own detector
 * off got it switched back on by the next update. In the 2026-10-12 segmented run (journal
 * `ef9daacd`) the state injection did exactly that ~100 ms after the first commit: from then on the
 * endpoint reported `speech_started` and never `speech_stopped`, so the segment the client committed
 * on top of that open utterance was refused with `buffer too small, or have no audio` and the
 * response that should have followed never came. Passing the remembered value in here is what makes
 * every later full update re-state the switch instead of the default.
 */
export type TurnDetectionSwitch = 'server_vad' | null | undefined;

/**
 * Adds the one detector field the relay MUST set on every `session.update`: `interrupt_response`.
 *
 * THE ENDPOINT'S DEFAULT IS `true`, AND IT IS THE LOSS MECHANISM THIS RULE EXISTS FOR. With it, a
 * response in flight is CANCELLED the moment the person speaks again — measured on the 2026-10-17
 * replay as 8 of 24 responses cancelled — and whatever the model had not relayed for the earlier
 * utterance never reaches the session. Setting it `false` is the live measurement that reduced that
 * to 0 of 30 (SPEC §「配套设置」); the omission-fill rule then covers what the model still omits.
 *
 * WHY IT IS APPLIED HERE, PER FRAME, RATHER THAN ONLY IN THE DEFAULTS. The segmented path re-states
 * the whole session body on every later full update and on reconnect (see {@link TurnDetectionSwitch}),
 * and a deployment may hand in its own `sessionDefaults`; forcing the field at the one composer every
 * full/partial update passes through is what makes "every `session.update` carries it" a property of
 * the wire rather than of a particular caller. `turn_detection: null` stays null: the segmented relay
 * owns its utterance boundaries and has no detector object to annotate.
 */
function withInterruptResponse(turnDetection: unknown): unknown {
  if (turnDetection === null || typeof turnDetection !== 'object' || Array.isArray(turnDetection)) {
    return turnDetection;
  }
  return { ...(turnDetection as Record<string, unknown>), interrupt_response: false };
}

/**
 * Translates ONE bridge message into the DashScope frames it becomes (one or two).
 *
 * `instructions`/`tools` are written AFTER the spread so a caller's
 * `sessionDefaults` can never shadow the bridge's own session body.
 *
 * `switchedTurnDetection` is the session's own detector switch (see {@link TurnDetectionSwitch}),
 * applied over `sessionDefaults` on the full-update path so a body composed after the switch cannot
 * turn the endpoint's detector back on. Every other message ignores it: the switch only ever travels
 * as `session.turn_detection`, which is the ONE door to `turn_detection: null` (see
 * `voice-realtime-turn-detection.ts`).
 */
export function toDashscopeFrames(
  message: RealtimeClientMessage,
  sessionDefaults: Readonly<Record<string, unknown>>,
  switchedTurnDetection?: TurnDetectionSwitch,
): unknown[] {
  switch (message.type) {
    case 'session.update': {
      const session: Record<string, unknown> = {
        ...sessionDefaults,
        // THE SWITCH OUTRANKS THE DEFAULTS. Removing this line is the pre-2026-10-12 behaviour: a
        // full update re-states `sessionDefaults.turn_detection` (the deployment's `server_vad`)
        // and silently re-opens the detector the segmented path had turned off.
        ...(switchedTurnDetection === undefined ? {} : { turn_detection: switchedTurnDetection }),
        instructions: message.session.instructions,
      };
      // Every full update re-states `interrupt_response:false` — including the later ones the
      // segmented path sends after its switch and the reconnect's own re-advertisement. Applied to
      // the COMPOSED value, so the switch (`null`) still wins and the switch-spread's absence is
      // still observable as "the deployment's own detector came back".
      if (session.turn_detection !== undefined) {
        session.turn_detection = withInterruptResponse(session.turn_detection);
      }
      // An empty `tools` array is rejected by some dialects; omit it when there is nothing to advertise.
      if (message.session.tools.length > 0) {
        session.tools = message.session.tools.map(toWireTool);
      }
      return [{ type: 'session.update', session }];
    }
    // The detector switch is a partial `session.update`: the defaults (voice, formats,
    // modalities) stay, only `turn_detection` changes. It therefore carries no
    // `instructions`/`tools`, and cannot blank a session body already advertised.
    case 'session.turn_detection':
      return [
        {
          type: 'session.update',
          session: {
            ...sessionDefaults,
            // A switch back ON carries the field too; the segmented path's `null` stays null.
            turn_detection: withInterruptResponse(message.turnDetection),
          },
        },
      ];
    case 'input_audio_buffer.append':
      return [{ type: 'input_audio_buffer.append', audio: message.audio }];
    // The two frames that close a manually segmented utterance. They travel 1:1 — this
    // dialect names them exactly as the bridge does. Only meaningful once the session's own
    // VAD has been turned off (the bridge sends `session.turn_detection: null` when the
    // client opens its first segment): with the endpoint's own VAD on, a commit on top of
    // it closes an utterance the VAD was already closing.
    case 'input_audio_buffer.commit':
      return [{ type: 'input_audio_buffer.commit' }];
    case 'response.create':
      return [{ type: 'response.create' }];
    case 'function_call_output': {
      const item = {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: message.callId, output: toWireOutput(message.output) },
      };
      return message.resume === false ? [item] : [item, { type: 'response.create' }];
    }
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
 * The `call_id` an endpoint `Unknown function call id` frame names, or `null` when
 * the frame is not one.
 *
 * WHAT THIS FRAME MEANS, measured 2026-10-14. When the person speaks again while a
 * tool result is on its way, the endpoint no longer holds the call the result
 * answers, and says so by name. The result is then stranded: the model never reads
 * it, and the browser is told the upstream failed — twice, because the endpoint
 * follows this frame with {@link isRejectedFunctionCallOutputResume} in the SAME
 * millisecond (observed: 8 pairs in one connection, journal `b5d01c21`; reproduced
 * on demand by `experiments/voice-realtime-function-call-output-race/probe.mts`).
 *
 * Matched on the endpoint's own wording for the same reason as
 * {@link isActiveResponseConflict}: the frame carries no machine-readable code, and
 * a broader match (any `error`) would swallow failures this transport must surface.
 * The `call_id` is READ OUT of the wording rather than taken from `error.param`,
 * which is absent on the real frames this matches (verified against the probe's
 * recorded pair).
 */
function rejectedFunctionCallOutputCallId(frame: RealtimeServerMessage): string | null {
  if (frame.type !== 'error') return null;
  const message = serverErrorMessage(frame);
  if (message === null) return null;
  const match = /Unknown function call id:\s*(\S+)/i.exec(message);
  return match === null ? null : match[1]!;
}

/**
 * True for the frame that PAIRS with {@link rejectedFunctionCallOutputCallId} — the
 * endpoint reporting that the `response.create` which followed the rejected output
 * has no valid input to answer.
 *
 * It is the tail of one event, not a second failure: the two arrive together, name
 * no `call_id` at all, and a browser shown both would be told twice about one
 * stranding. Absorbing the pair also keeps the run's error count equal to the
 * number of real strandings, which is what a journal is read for.
 */
function isRejectedFunctionCallOutputResume(frame: RealtimeServerMessage): boolean {
  if (frame.type !== 'error') return false;
  const message = serverErrorMessage(frame);
  return message !== null && /Cannot create response after rejected function_call_output/i.test(message);
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
 * What became of ONE tool call, as this transport observed it.
 *
 * WHY A LEDGER AND NOT A FLAG. A tool result is a message about an EARLIER turn, and the
 * endpoint answers it only while that turn is still the live one. Once the person speaks
 * again the endpoint stops holding the call, and the result becomes an error the browser
 * has no action for. Telling "this result still belongs to the live turn" from "the turn
 * it answers is over" needs a state that outlives the single `send` call, so it is kept
 * here, keyed by the endpoint's own `call_id`:
 *
 *   - `pending`     — the call was delivered to the bridge; no result sent yet. This is the
 *                     state in which a new user turn can still be answered by NOT sending.
 *   - `output-sent` — the result is on the wire, unacknowledged. Nothing local can recall it.
 *   - `acked`       — the endpoint echoed the result item back; the model will read it.
 *   - `rejected`    — the endpoint named the call as unknown. It never reached the model.
 *   - `superseded`  — a new user turn had already begun, so the result was NOT sent.
 *
 * `turnSeq` is {@link createDashscopeTransport}'s user-turn counter as it stood when the
 * call was DELIVERED, and it is what makes `pending` decidable: a live counter greater
 * than it means the turn this call belongs to has been superseded by a later one.
 *
 * The ledger only ever records; no state here is read by anything but the two decisions in
 * {@link createDashscopeTransport.send} and {@link createDashscopeTransport}'s inbound path,
 * and every transition that changes what the browser sees also leaves a `log` line, so a
 * journal can be read without guessing.
 */
type FunctionCallReceiptState = 'pending' | 'output-sent' | 'acked' | 'rejected' | 'superseded';
type FunctionCallReceipt = { readonly state: FunctionCallReceiptState; readonly turnSeq: number };

/**
 * How many receipts one connection keeps. A terminal receipt is a historical reading, so
 * the oldest terminal ones are dropped first and the live ones (`pending`, `output-sent`)
 * are never evicted; a connection that somehow has this many live calls keeps them all.
 */
const MAX_CALL_RECEIPTS = 256;

/**
 * Builds the transport. Production passes only a credential; the criteria pass a
 * `socketFactory` and no credential, so the whole round trip stays offline.
 */
export function createDashscopeTransport(options: DashscopeTransportOptions = {}): DashscopeTransport {
  const endpoint = options.endpoint ?? DASHSCOPE_REALTIME_ENDPOINT;
  const model = options.model ?? DEFAULT_DASHSCOPE_REALTIME_MODEL;
  const baseSessionDefaults = options.sessionDefaults ?? DEFAULT_SESSION_DEFAULTS;
  // `voice` is a first-class option (the adopted model needs `voice: "Tina"`), so it
  // merges over whatever session body the caller supplied. `turn_detection` is
  // deliberately NOT an option: the manually segmented path flips it per CONNECTION,
  // lazily, once the client proves it owns the utterance boundaries — see the bridge's
  // `session.turn_detection` message.
  const sessionDefaults: Readonly<Record<string, unknown>> = {
    ...baseSessionDefaults,
    ...(options.voice === undefined ? {} : { voice: options.voice }),
  };
  const apiKey = options.apiKey ?? '';
  const url = `${endpoint}?model=${encodeURIComponent(model)}`;

  let state: DashscopeTransport['state'] = 'idle';
  let socket: DashscopeSocket | null = null;
  let deliberateClose = false;
  /**
   * The detector switch this LOGICAL session has been given, or `undefined` while it still runs on
   * the deployment's own default. Written by {@link DashscopeTransport.send} when a
   * `session.turn_detection` goes out, and read back into every later full `session.update` (see
   * {@link TurnDetectionSwitch}) so nothing composed after the switch can re-open the detector.
   *
   * IT OUTLIVES A SOCKET ON PURPOSE. A drop does not end the logical session — the transport is
   * dialled again and the bridge re-establishes the session on the new socket — and a connection
   * that has begun to segment owns its utterance boundaries for its whole life (the bridge's own
   * `segmentsStarted` reading). Clearing this on `onclose` would leave the reconnect's
   * re-advertisement, which goes out BEFORE the bridge's post-reconnect `session.turn_detection`,
   * carrying `server_vad` — re-opening the detector on the exact frame that re-establishes the
   * session, which is the defect this state exists to close.
   */
  let switchedTurnDetection: TurnDetectionSwitch;
  /** Cumulative audio pushed onto the socket, for {@link upstreamAudioHeartbeat}. */
  let audioFramesSent = 0;
  let audioBytesSent = 0;
  const messageHandlers = new Set<(message: RealtimeServerMessage) => void>();
  const closeHandlers = new Set<(detail?: RealtimeCloseDetail) => void>();

  /**
   * The close frame's own `code`/`reason`, read off the `CloseEvent` — or an empty detail when the
   * socket carried none (an abnormal termination reports `1006` with no frame at all, and a
   * non-conforming event object has neither).
   *
   * THIS IS THE READING THE 2026-10-13 FORENSICS TASK ADDED. This `onclose` used to ignore its event
   * entirely, so every drop reached the bridge — and the journal — as the same bare "the socket
   * closed", with `1006` (abnormal) indistinguishable from the endpoint's own `1007
   * response_idle_timeout`. Reading the event is the whole change: nothing here branches on the
   * values, they are handed to the bridge's close listeners and nowhere else.
   */
  function readCloseDetail(event: unknown): RealtimeCloseDetail {
    if (event === null || typeof event !== 'object') {
      return {};
    }
    const raw = event as { code?: unknown; reason?: unknown };
    return {
      ...(typeof raw.code === 'number' ? { code: raw.code } : {}),
      ...(typeof raw.reason === 'string' && raw.reason !== '' ? { reason: raw.reason } : {}),
    };
  }
  /**
   * Listeners told each time a synthesized tool-resume `response.create` ACTUALLY
   * leaves the socket. Registered by the bridge, whose follow-up credit must track
   * the create that was truly sent rather than the tool result that hoped for one.
   */
  const synthesizedResumeHandlers = new Set<() => void>();
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
  /**
   * The tool-call RECEIPT ledger: what became of each call this logical session
   * carried. See {@link FunctionCallReceipt}.
   */
  const callReceipts = new Map<string, FunctionCallReceipt>();
  /**
   * How many user turns have BEGUN on this logical session — the clock the receipt
   * ledger is read against.
   *
   * It is a COUNTER, not a timestamp, because the fact that matters is ordinal:
   * "a turn began after this call was delivered" is exactly "the sequence moved",
   * and comparing counters cannot be fooled by two events inside one millisecond
   * (the live journal has a result and the interrupting `speech_started` 1 ms
   * apart, so a timestamp comparison would have to pick a tie-break rule that no
   * reading supports).
   *
   * Counted from BOTH readings the endpoint gives that a person has taken the
   * turn back: its own detector's `input_audio_buffer.speech_started`, and the
   * `conversation.item.created` of a user `message`. Neither alone is enough — a
   * deployment with the endpoint's detector off (the segmented path) never sees
   * the first, and a barge-in can produce the second without a fresh start event.
   */
  let userTurnSeq = 0;

  // ---- spend guard ---------------------------------------------------------------------------
  const spendEntries: Array<{ at: number; cny: number }> = [];
  let spendTotalCny = 0;
  let spendTripped = false;

  /** Adds one `response.done`'s estimated cost and trips the guard once a limit is crossed. */
  function chargeSpendGuard(wire: unknown): void {
    const guard = options.spendGuard;
    if (guard === undefined || spendTripped) return;
    const frame = wire as { type?: unknown; response?: { usage?: unknown } } | null;
    if (frame?.type !== 'response.done') return;
    const cost = estimateRealtimeCostCny(frame.response?.usage);
    if (cost <= 0) return;
    const now = Date.now();
    const windowMs = guard.windowMs ?? 30_000;
    spendEntries.push({ at: now, cny: cost });
    while (spendEntries.length > 0 && now - spendEntries[0]!.at > windowMs) spendEntries.shift();
    spendTotalCny += cost;
    const inWindow = spendEntries.reduce((sum, entry) => sum + entry.cny, 0);
    if (guard.maxCnyPerWindow !== undefined && inWindow > guard.maxCnyPerWindow) {
      spendTripped = true;
      emitError({ code: 'SPEND_LIMIT', scope: 'window', cny: inWindow, limitCny: guard.maxCnyPerWindow, windowMs });
    } else if (guard.maxCnyTotal !== undefined && spendTotalCny > guard.maxCnyTotal) {
      spendTripped = true;
      emitError({ code: 'SPEND_LIMIT', scope: 'total', cny: spendTotalCny, limitCny: guard.maxCnyTotal });
    }
  }

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
   *
   * THE RESUME IS ALWAYS SENT. `respondToToolOutputs: false` means the deployment does not want
   * the model to SPEAK about a tool result; it does NOT mean the frame may be dropped. DashScope
   * requires a `response.create` after a `function_call_output` to resume the turn, and an
   * unresumed turn stays queued upstream. Dropping the frame for every result filled the
   * endpoint's 8-turn queue and rejected the ninth user turn — `Turn queue overflow: capacity=8`,
   * after which the session produced no transcription and no delivery at all (2026-10-18
   * journals). The silence the flag asks for is already carried by the prompt wording; the frame
   * itself is protocol traffic.
   *
   * The gate is `synthesizedToolResume`'s, and ONLY that. A `response.create` the CLIENT
   * asked for — the manual-segment path's, which follows one `input_audio_buffer.commit`
   * one-for-one — is not a resume of somebody else's turn and must go out even when this
   * connection suppresses tool-output resumes: swallowing it would leave a committed
   * segment with no response, and deferring it would break the "one create per segment"
   * pairing the segmented criterion reads. Both call sites today pass `true`; the
   * segmented path passes `false`.
   */
  function sendClientFrames(frames: readonly unknown[], synthesizedToolResume: boolean): void {
    for (const frame of frames) {
      const synthesizedCreate = synthesizedToolResume && isResponseCreateFrame(frame);
      if (synthesizedCreate && activeResponseId !== null) {
        deferredResponseCreates += 1;
        continue;
      }
      sendFrame(frame);
      countUpstreamAudioFrame(frame);
      // The resume is only "expected" once it is genuinely out: a frame held by the
      // in-flight gate must NOT notify here — the flush below is the point that
      // notifies for a deferred one.
      if (synthesizedCreate) notifySynthesizedToolResume();
    }
  }

  /**
   * Counts one outbound audio frame and writes the heartbeat every
   * {@link UPSTREAM_AUDIO_HEARTBEAT_FRAMES} of them.
   *
   * Called where a frame has GENUINELY left — after `sendFrame` in {@link sendClientFrames}, so a
   * frame a gate held back or dropped is not counted. Counting a frame the endpoint never received
   * would make the reading say the relay pushed audio it did not, which is the opposite of the
   * question this line answers.
   *
   * `buffered=` is the socket's own reading, taken NOW rather than accumulated: it is a level, not
   * a total, and a level that climbs across heartbeats is audio the relay accepted and had not
   * delivered. A socket that cannot report one says `n/a` — a fabricated zero would be
   * indistinguishable from a healthy empty buffer.
   */
  function countUpstreamAudioFrame(frame: unknown): void {
    const wire = frame as { type?: unknown; audio?: unknown };
    if (wire.type !== 'input_audio_buffer.append' || typeof wire.audio !== 'string') {
      return;
    }
    audioFramesSent += 1;
    audioBytesSent += base64DecodedBytes(wire.audio);
    if (audioFramesSent % UPSTREAM_AUDIO_HEARTBEAT_FRAMES !== 0) {
      return;
    }
    const buffered = socket?.bufferedAmount;
    const bufferedReading = typeof buffered === 'number' && Number.isFinite(buffered) ? String(buffered) : 'n/a';
    options.log?.(`to-upstream audio frames=${audioFramesSent} bytes=${audioBytesSent} buffered=${bufferedReading}`);
  }

  /**
   * Tells every listener that a synthesized tool-resume `response.create` has
   * ACTUALLY reached the socket. Fired at the two points a create genuinely leaves —
   * the fall-through send above and the coalesced flush below — and never where one
   * is merely planned or held back, so a suppressed or deferred create grants no
   * credit. Consumers: the bridge's follow-up-credit counter, which this is what
   * makes "额度 > 0 ⇒ 有一次合成 create 在飞" true by construction.
   */
  function notifySynthesizedToolResume(): void {
    for (const handler of [...synthesizedResumeHandlers]) handler();
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
      // Already reported as SEND_FAILED; the socket is down, so no create left and
      // no credit is granted — the bridge must not expect a response that was never asked for.
      return;
    }
    // The coalesced N-held-creates become ONE real create, so they grant ONE credit.
    notifySynthesizedToolResume();
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
        sendClientFrames(toDashscopeFrames(message, sessionDefaults, switchedTurnDetection), true);
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
    markReceipt(item.call_id, 'acked');
  }

  /** Writes the ledger line a journal reads, so a rejection is visible without a browser error. */
  function logReceipt(callId: string, state: FunctionCallReceiptState, note = ''): void {
    options.log?.(`function_call_output receipt call_id=${callId} state=${state}${note === '' ? '' : ` ${note}`}`);
  }

  /**
   * Moves one call's receipt to `state`, keeping the turn it was delivered in, and returns it.
   *
   * A call with no receipt gets one created at the CURRENT turn counter. An inbound
   * `function_call` should have registered one, but nothing here depends on that having
   * happened, and inventing a receipt is safer than reading `undefined`.
   */
  function markReceipt(callId: string, state: FunctionCallReceiptState): FunctionCallReceipt {
    const receipt: FunctionCallReceipt = { state, turnSeq: callReceipts.get(callId)?.turnSeq ?? userTurnSeq };
    callReceipts.set(callId, receipt);
    evictReceipts();
    return receipt;
  }

  /**
   * Drops the oldest TERMINAL receipts once the ledger is over {@link MAX_CALL_RECEIPTS}.
   *
   * Terminal only: `pending` and `output-sent` are the two states a live decision still
   * reads, and evicting one would make the ledger forget a call it is about to answer.
   * Insertion order is the eviction order — a `Map` iterates in insertion order, and
   * re-`set`ting an existing key keeps its original position — so the oldest call is
   * genuinely the first terminal one this walk meets.
   */
  function evictReceipts(): void {
    if (callReceipts.size <= MAX_CALL_RECEIPTS) return;
    for (const [callId, receipt] of callReceipts) {
      if (callReceipts.size <= MAX_CALL_RECEIPTS) return;
      if (receipt.state === 'pending' || receipt.state === 'output-sent') continue;
      callReceipts.delete(callId);
    }
  }

  /**
   * Whether one inbound frame means the person has taken the turn back (see {@link userTurnSeq}).
   *
   * Both readings count: the endpoint's own detector starting an utterance, and the endpoint
   * reporting a USER message item. A `conversation.item.created` for anything else — an
   * assistant message, the echo of a tool result — is NOT a new turn and must not move the
   * counter, or the acknowledgement of a call would supersede the very call it acknowledges.
   */
  function startsNewUserTurn(event: RealtimeServerMessage): boolean {
    if (event.type === 'input_audio_buffer.speech_started') return true;
    if (event.type !== 'conversation.item.created') return false;
    const item = event.item as { type?: unknown; role?: unknown } | undefined;
    return item?.type === 'message' && item.role === 'user';
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
      chargeSpendGuard(wire);
      const event = toBridgeEvent(wire);
      if (event === null) return;

      // ---- the tool-result receipt ledger (see `FunctionCallReceipt`) ---------------------------
      // The endpoint naming a call it never held is the race this ledger exists to survive: the
      // result reached the endpoint after the turn it answered had ended, so the model never saw
      // the call. It is absorbed HERE, before anything else looks at the frame, and never
      // forwarded — the browser has no action for it and it is not a session failure — while the
      // journal keeps the reading below. The call is also dropped from the replay queue: a
      // reconnect must not re-send a result the endpoint has already refused, or the refusal
      // simply repeats on the new socket.
      const rejectedCallId = rejectedFunctionCallOutputCallId(event);
      if (rejectedCallId !== null) {
        const receipt = markReceipt(rejectedCallId, 'rejected');
        unackedOutputs.delete(rejectedCallId);
        logReceipt(rejectedCallId, 'rejected', `turn_seq=${receipt.turnSeq} now=${userTurnSeq}`);
        return;
      }
      // The endpoint's follow-up to that refusal: the `response.create` synthesized for the SAME
      // result, which it will not honour. One cause, one owner — absorbed with the frame above.
      // This frame carries no call id (`param: response`), so the line names the state, not a call.
      if (isRejectedFunctionCallOutputResume(event)) {
        options.log?.('function_call_output receipt state=rejected phase=resume');
        return;
      }
      // A turn that has BEGUN is what makes a still-`pending` result unsendable, so the counter
      // moves before any consumer reads it (see `userTurnSeq`, and `send`'s supersede check).
      if (startsNewUserTurn(event)) userTurnSeq += 1;

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
          // The call is now outstanding: a result for it may still be answered by NOT sending,
          // but only until a later turn begins (see `FunctionCallReceipt`). Written after the
          // de-duplication so the second delivery of the same call cannot re-stamp it with a
          // LATER turn counter, which would make an already-superseded result look sendable.
          markReceipt(callId, 'pending');
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
        throw new Error('a DashScope key is required to open the real DashScope realtime transport');
      }
      if (factory === undefined && isMaskedDashscopeApiKey(apiKey)) {
        state = 'closed';
        emitError({ code: 'MASKED_API_KEY' });
        throw new Error('the stored DashScope key is the masked placeholder, not a real credential');
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
        active.onclose = (event) => {
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
            // The close frame's own code/reason ride along with the notification (see
            // `readCloseDetail`): this is the only point they exist, and the bridge's forensics turn
            // them into a journal line. A deliberate close never reaches here.
            const detail = readCloseDetail(event);
            for (const handler of [...closeHandlers]) handler(detail);
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
      // ...nor anything to remember: a receipt is a reading of THIS session's turns, and a
      // session that is over has no turns. The counter goes back to zero with the ledger so the
      // two can never disagree (see `userTurnSeq`).
      callReceipts.clear();
      userTurnSeq = 0;
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
      // A tool result whose turn is already over is NOT put on the wire at all (see
      // `FunctionCallReceipt`). At this point it is still `pending` — the executor was simply
      // slower than the person — and the endpoint no longer holds the call, so sending it buys
      // only an `Unknown function call id` the browser cannot act on and a `response.create` it
      // will refuse. Dropped before the frames are composed and before it joins `unackedOutputs`,
      // so the reconnect path never replays a result that was deliberately not sent. The socket
      // check above stays first: a closed socket is a real fault and must still be reported, not
      // silently swallowed by a supersede.
      if (message.type === 'function_call_output') {
        const receipt = callReceipts.get(message.callId);
        if (receipt?.state === 'pending' && userTurnSeq > receipt.turnSeq) {
          markReceipt(message.callId, 'superseded');
          logReceipt(message.callId, 'superseded', `turn_seq=${receipt.turnSeq} now=${userTurnSeq}`);
          return;
        }
      }
      // THE SWITCH IS REMEMBERED BEFORE THE FRAME IS COMPOSED, and before it is known to have left
      // the socket. Recorded-then-sent is the safe order: a `session.turn_detection` whose write
      // fails is retried by the bridge (it does not remember a failed send either), and a retry that
      // finds the switch already recorded is idempotent, whereas the reverse order would let a later
      // full update be composed from defaults the switch had already superseded.
      if (message.type === 'session.turn_detection') {
        switchedTurnDetection = message.turnDetection;
      }
      let frames: unknown[];
      try {
        frames = toDashscopeFrames(message, sessionDefaults, switchedTurnDetection);
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
        markReceipt(message.callId, 'output-sent');
      }
      sendClientFrames(frames, message.type === 'function_call_output');
    },

    subscribe(handler: (message: RealtimeServerMessage) => void): () => void {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },

    onClose(handler: (detail?: RealtimeCloseDetail) => void): () => void {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },

    onSynthesizedToolResume(handler: () => void): () => void {
      synthesizedResumeHandlers.add(handler);
      return () => {
        synthesizedResumeHandlers.delete(handler);
      };
    },
  };
}

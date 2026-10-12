/**
 * The `/voice-realtime` WebSocket handler — the browser's half of a Realtime
 * voice connection (GOAL-031 / AC-312).
 *
 * WHY IT EXISTS. AC-310 wired the Realtime TOOL table to the real MCP services
 * (`voice-realtime-live-executor.ts`) and AC-311 made the bridge survive a
 * dropped connection, but both are server-side leaves: nothing let a BROWSER
 * open a Realtime session. This handler is that wire. It sits between the
 * browser socket and a real DashScope transport, so the credentials stay on the
 * server (the browser never dials the upstream itself) and the browser speaks
 * one small JSON protocol rather than DashScope's.
 *
 * WHY THERE IS NO INTENT CONFIRMATION (GOAL-033 / AC-316). Earlier builds
 * surfaced the model's proposed `session_send` as an editable draft and
 * awaited a browser `decision` frame before calling the real AC-310 handler.
 * AC-316 removed that step: Live Voice is a continuous-capture mode with no
 * per-utterance confirmation UI, so `session_send` now executes the moment the
 * model calls it. The bridge routes `function_call` frames straight into the
 * executor's routing table and exposes no `onFunctionCall` hook — deliberately,
 * so the bridge stays an offline-provable leaf — so this handler's executor
 * wrapper is now a thin single-flight guard rather than a confirmation gate.
 *
 * WHAT THE BROWSER MAY SAY (inbound, one JSON object per frame):
 *   - `{ type: 'hello', protocol }` — the segmented-relay offer, sent the moment the socket opens
 *     (P4 / AC-322). The server answers it, or does not, and that answer is the whole protocol
 *     switch: silence keeps the connection on the continuous frames below.
 *   - `{ type: 'segment_start' | 'audio' | 'segment_end' }` — one relay segment (SPEC §C1).
 *   - `{ type: 'context', text, chars, rows }` — the C2 context pack.
 *   - `{ type: 'audio', audio }`  — one base64 PCM frame from the capture
 *     pipeline (microphone or an injected test file), sent only while the
 *     browser is not muted.
 *   - `{ type: 'close' }` — the browser is done; the upstream is closed.
 *
 * WHAT THE SERVER SAYS (outbound):
 *   - `{ type: 'ready', protocol }` — the segmented-relay acceptance; absent means "stay continuous".
 *   - `{ type: 'state', state }`   — the bridge's connection state.
 *   - `{ type: 'sent', sessionId, result }` — the real `session_send` answer.
 *   - `{ type: 'error', code, message }` — a reported bridge/transport failure.
 *
 * The tool whitelist that pins every send onto the connection's one session is
 * NOT re-implemented here: the executor the caller injects is
 * `createVoiceRealtimeLiveExecutor`, whose `boundSessionId` already refuses a
 * call naming another session. This handler only decides WHEN a send happens,
 * never WHICH session it reaches.
 */
import { WebSocket } from 'ws';

import type { VoiceRealtimeAudioCapture } from './voice-realtime-audio-capture.js';
import {
  connect,
  type RealtimeBridge,
  type RealtimeBridgeError,
  type RealtimeBridgeHooks,
  type RealtimeBridgeOptions,
  type RealtimeBridgeState,
  type RealtimeSegmentCommitMode,
  type RealtimeSegmentEndReason,
  type RealtimeSegmentPhaseEvent,
  type RealtimeToolExecutor,
  type RealtimeTransport,
} from './voice-realtime-bridge.service.js';
import {
  composeVoiceRealtimeInstructions,
  loadVoiceRealtimeSettings,
} from './voice-realtime-settings.js';
import { VOICE_REALTIME_TOOLS } from './voice-realtime-tools.js';
import { createLocalSpeechGate, type LocalSpeechBoundary } from './voice-realtime-local-speech.js';
import { createUpstreamPool, type UpstreamPoolRotation } from './voice-realtime-upstream-pool.js';
import {
  SEGMENTED_RELAY_PROTOCOL,
  VOICE_REALTIME_MODE_ENV,
  describeVoiceRealtimeMode,
  resolveVoiceRealtimeMode,
} from './voice-realtime-mode.js';

/** The WebSocket path this handler answers. Mounted by the websocket gateway. */
export const VOICE_REALTIME_PATH = '/voice-realtime';

/**
 * The scopes a first-party voice connection carries.
 *
 * A voice connection presents no PAT and reaches no HTTP endpoint: it is opened
 * by an already-authenticated browser, so the browser's own authority is what it
 * acts with. The set is the full first-party vocabulary the gateway's tools
 * check against, listed in one place so a tool that later adds a scope names a
 * missing entry rather than silently narrowing what the user can say.
 */
export const VOICE_REALTIME_CALLER_SCOPES = [
  'cloudcli:approve',
  'cloudcli:navigate',
  'cloudcli:read',
  'cloudcli:session:control',
  'cloudcli:session:create',
  'cloudcli:session:send',
] as const;

/**
 * The session instructions the proxy installs once the Realtime connection is up.
 *
 * A RELAY, deliberately. The first version told the model to call `session_send` only for
 * "something to be done" and not "to answer questions you can answer yourself"; measured against
 * the real model that forwarded 7 of 12 test utterances, and the other 5 were answered in a TEXT
 * reply nothing displays — so the user spoke, saw their words transcribed, and then saw nothing
 * (`experiments/voice-realtime-prompt/`). Claude is the one who reasons; this model only carries
 * the words over.
 *
 * Kept here rather than in a UI string table because it is a PROMPT, not copy:
 * it names the function the model must call and the argument the server's
 * whitelist reads back, so it has to agree with `VOICE_REALTIME_TOOLS`' `session_send`
 * schema rather than with anything the browser renders.
 */
export const VOICE_REALTIME_INSTRUCTIONS = [
  'You are a voice relay for one Claude Code session.',
  'You never answer, comment or reason yourself, and you never reply in text.',
  'EVERYTHING the user says — instructions, questions, remarks, feedback, even a single',
  'word — must be passed on by calling the `session_send` function with `{ message }`,',
  'where message is what the user said, kept in their own words (fix obvious',
  'speech-recognition slips only). Always call the function; never produce a text reply.',
  'The ONE exception is a stop: if the user tells you to stop — "stop", "停", "停下",',
  '"别做了" — call the `session_interrupt` function instead of `session_send`, then reply',
  'with the single word OK and say nothing else.',
  'The session is fixed by the connection; never name one.',
].join(' ');

/**
 * How long a relayed instruction may wait for its committed segment's transcription.
 *
 * THE RACE THIS CLOSES. The endpoint reports a segment's transcript and the model relays it as two
 * independent upstream events, and nothing orders them: measured on the 2026-10-11 defect the
 * transcription preceded the `session_send` call by 273 ms, but the reverse is just as legal. A
 * guard that only looks at the transcript when the call arrives would therefore deliver an invented
 * message whenever the model answers first, so the delivery point HOLDS a call whose segment has no
 * transcription yet and releases it the moment one lands (or the segment settles).
 *
 * WHY A CEILING AT ALL. The hold must never become a deadlock: a caller that committed a segment
 * but whose endpoint never transcribes it (the offline protocol suites are exactly that case) would
 * otherwise wait forever for an event that is not coming. This is the point at which the guard
 * gives up and FAILS OPEN — an unknown transcript is not an empty one, and inventing a delay for a
 * delivery the user is waiting on is worse than relaying words nobody has proved absent. It sits
 * well under the retry/poll budgets the criteria use, so a held call still reads as delivered.
 */
export const SEGMENT_TRANSCRIPT_GRACE_MS = 600;

/**
 * Whether a relayed piece carries no words at all: empty, whitespace, or punctuation/symbols only.
 *
 * THE BOUND IS MECHANICAL, and that line is deliberate. The endpoint saying "zero words" is the one
 * fact this guard may act on; nothing here compares the relayed text with what the person said, and
 * nothing here decides whether a message is *worth* sending. A filter that started with stop words
 * would be a different mechanism with a different failure mode (`嗯`/`呃` are content: they are
 * relayed, and the negative control in the criteria holds this predicate to that).
 *
 * `\p{P}` covers `。`, `…`, `！` and the rest of the punctuation blocks; `\p{S}` covers the symbol
 * blocks, so a stray emoji-like mark is not mistaken for speech either.
 */
const EMPTY_RELAY_TEXT = /^[\s\p{P}\p{S}]*$/u;

/**
 * The form the continuous-mode duplicate guard compares two relayed messages in.
 *
 * WHY A NORMALIZATION AT ALL. The endpoint's transcript and the model's relay are independent
 * upstream events, and JSON quoting mangles one against the other: two relays of the SAME spoken
 * sentence differed only in where a quote landed — 「只有用"现在我在用live voice"」 against
 * 「只有"用现在我在用live voice"」 (journal 95a9d738). Comparing raw strings would call those
 * different and deliver the sentence twice. Collapsing whitespace, punctuation and symbols to
 * nothing — the same character classes {@link EMPTY_RELAY_TEXT} already treats as non-words — makes
 * the two forms equal while leaving the spoken words themselves untouched.
 */
export function normalizeRelayText(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** How often a spoken instruction re-tries a session that is mid-turn. */
const BUSY_RETRY_INTERVAL_MS = 2_000;
/** How long it keeps trying before giving up and saying so. A turn longer than this is not waited out. */
const BUSY_RETRY_MAX_MS = 120_000;

/**
 * The most UTF-8 bytes of the person's as-yet-undelivered text the relay will hold before refusing
 * the next `session_send`.
 *
 * WHY A BOUND AT ALL. Measured 2026-10-11 (01:54–01:57 CST, tag `d88c6722`): the operator spoke for
 * over two minutes into a session whose turn was in flight; four deliveries were accepted, three of
 * them silently piled up in the session's own queue, and the screen showed one message. Nothing told
 * the operator that three sentences were still waiting, and nothing bounded how much could. Every
 * accepted message is a promise the session will answer it; an unbounded queue is a promise the
 * session cannot keep, and one the operator cannot see.
 *
 * WHY IT CANNOT BE A CANCELLATION. The provider's `cancelQueuedInput` slot is `false` for the
 * Claude provider (see `provider-capabilities.service.ts`), so a message already handed over cannot
 * be taken back. The bound therefore has to be enforced BEFORE `base.session_send` is reached —
 * which is exactly where {@link handleVoiceRealtimeConnection}'s `sessionSend` judges it — rather
 * than by dropping an item the session is already holding.
 *
 * WHY BYTES, NOT MESSAGES. The bound this replaces counted MESSAGES (`VOICE_QUEUE_MAX_DELIVERIES`,
 * three). Measured 2026-10-11 (19:22–19:30 CST, session `9db75ad5`): a four-minute turn in flight,
 * and the operator's next EIGHT sentences — about 150 CJK characters, well UNDER 500 bytes together
 * — were every one refused (`VOICE_QUEUE_FULL depth=3 max=3`). The count was already spent on the
 * first three; the sentences after them were far inside any sane budget of TEXT and were still
 * thrown away. The thing a person runs out of is the patience to wait, and that is spent by how much
 * they have said, not by how many times they paused. So the admission axis is the UTF-8 byte length
 * of the text still waiting, and 1000 is a page or so of their words: enough that a real
 * mid-turn monologue is carried whole, small enough that the session is never handed a promise it
 * cannot keep.
 */
export const VOICE_QUEUE_MAX_BYTES = 1000;

/**
 * The UTF-8 byte length of a relayed message, which is the unit {@link VOICE_QUEUE_MAX_BYTES} is
 * written in. A non-string message (the model occasionally calls `session_send` without `message`)
 * counts as zero: there are no words to spend the budget on.
 */
export function voiceMessageBytes(message: unknown): number {
  return typeof message === 'string' ? Buffer.byteLength(message, 'utf8') : 0;
}

/** The reason code a refused `session_send` carries — stable, so the model can act on it, and so the log can be read. */
export const VOICE_QUEUE_FULL_REASON = 'VOICE_QUEUE_FULL';

/**
 * The most pack text one `context` frame may carry, in UTF-16 code units.
 *
 * The browser builds its pack to the SPEC's own budget (`VOICE_CONTEXT_BUDGET_CHARS` in
 * `src/modules/chat/utils/voiceContextPack.ts`) and this is that number again, on purpose: the
 * proxy does not trust the page with what reaches the upstream. A frame over the cap is refused
 * whole — not truncated — because a partial pack is a conversation with a hole in it, and a hole is
 * worse for the model than no context at all. Nothing legitimate ever sends one; the refusal exists
 * so a client that grew its own, larger budget is visible in the log instead of silently obeyed.
 */
export const VOICE_REALTIME_CONTEXT_MAX_CHARS = 2000;

// ---- S-A: the execution-status line (SPEC `voice-realtime-persistent-control-SPEC.md` §8.3) ----

/**
 * The most UTF-8 bytes ONE injected status line may take, marker included (SPEC §8.3's "注入行 ≤
 * 200 字节"). The line is built from bounded, sanitized fields, so this bound is the belt to
 * construction's braces: it holds even if a future field (a tool name, say) grows.
 */
export const VOICE_REALTIME_STATUS_MAX_BYTES = 200;

/**
 * How many status lines ONE run may put on the wire (SPEC §8.3's "总注入次数 ≤ 8 / run"). The eighth
 * is the last: it carries the `(+N more, ask session_status)` marker and then the run is silent until
 * a new run begins. §8.3 registers this as a SAFETY CAP, not an optimum — the per-injection cost was
 * never measured (G-5), so it may only be widened once that reading exists.
 */
export const VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN = 8;

/**
 * The S-A rate window (SPEC §8.3: "最多 1 次 / 2 s"). A change opens the window; everything that
 * changes inside it collapses to the latest reading and none is queued — so a burst of state changes
 * costs one `session.update`, not one each.
 */
export const VOICE_REALTIME_STATUS_RATE_MS = 2000;

/**
 * The three session phases SPEC §6.3/§7.2 names for the execution plane.
 *
 * `awaiting-permission` is deliberately ABSENT: the proxy has no event source for a pending
 * interaction (the voice tool surface is `session_send` + `session_interrupt`), so nothing could
 * honestly report it. {@link VoiceRealtimeExecStatusReading.pendingInteraction} is the field it would
 * arrive on, and it stays `null` until the tool that can observe one lands.
 */
export type VoiceRealtimeExecPhase = 'idle' | 'queued' | 'running';

/** The pending interaction a paused session is waiting on — SPEC §8.3 keys the dedup on its `requestId`. */
export type VoiceRealtimePendingInteraction = { requestId: string; toolName: string };

/**
 * One reading of the execution plane — the SINGLE source S-A renders its line from, and the same
 * reading a future S-B (`session_status`) and S-C (the browser event stream) would read (SPEC §8.2,
 * R-8.3). Kept as one object so no consumer can compute a second, disagreeing version of it.
 */
export type VoiceRealtimeExecStatusReading = {
  phase: VoiceRealtimeExecPhase;
  runId: string | null;
  elapsedMs: number;
  queuedItems: number;
  queuedBytes: number;
  /**
   * Whether {@link queuedItems}/{@link queuedBytes} include the bound session's OWN queue.
   *
   * The relay can only see the L3 terms it owns (the coalescing window and the busy wait); the
   * messages the session itself accepted are held by the CLI, which drains them at a turn boundary
   * nothing tells the relay about. So the CLI term is reconciled against the host's own reading
   * ({@link VoiceRealtimeProxySeams.hostQueueReading}) rather than counted here, and when that
   * reading is unavailable this is `false`: the numbers above are then the L3 terms ONLY, and the
   * line says so instead of presenting them as a complete depth (SPEC §18.5: 「读不到…显式记为未知」).
   *
   * Optional and defaulting to KNOWN so a reading literal written before the field existed stays
   * valid and reads as a complete depth — the same convention {@link VoiceRealtimeExecStatusPatch}
   * uses for its absent fields. A consumer that must distinguish them reads `=== false`.
   */
  queuedKnown?: boolean;
  pendingInteraction: VoiceRealtimePendingInteraction | null;
  /** Monotone within a run: bumped the moment the dedup key moves. The shared provenance reading. */
  statusSeq: number;
  /** Epoch ms of the last change — the line's `at`, which `ageMs` is measured from. */
  at: number;
};

/** One observation folded into the aggregator. An absent field is left as it was. */
export type VoiceRealtimeExecStatusPatch = {
  phase?: VoiceRealtimeExecPhase;
  /** Present (possibly `null`) means "this is the run now"; a DIFFERENT non-null id opens a new run. */
  runId?: string | null;
  queuedItems?: number;
  queuedBytes?: number;
  /** Whether the queued readings carry a reconciled CLI term. See {@link VoiceRealtimeExecStatusReading.queuedKnown}. */
  queuedKnown?: boolean;
  pendingInteraction?: VoiceRealtimePendingInteraction | null;
};

/** The aggregator: the reading, its dedup key, and the one line rendered from them. */
export type VoiceRealtimeExecStatus = {
  /** Whether there is anything worth telling the model yet — false leaves the prompt byte-identical. */
  hasState(): boolean;
  /** The current dedup key (SPEC §8.3's tuple), or `''` before there is any state. */
  key(): string;
  /** The current reading. */
  reading(): VoiceRealtimeExecStatusReading;
  /** Folds one observation in; `changed` says the dedup key moved, `newRun` that a new run opened. */
  update(patch: VoiceRealtimeExecStatusPatch): { changed: boolean; newRun: boolean };
  /**
   * Renders the one injectable line (and the reading it came from) for `nowMs`.
   *
   * The line carries `statusSeq` — the same number on the reading — even though §8.4's example
   * shape omits it. The field is ADDITIVE (the §8.4 budget is bytes, not a field list) and it is
   * what makes §8.3's "同源" requirement checkable from the wire alone: a reader can compare the
   * line's `statusSeq` against the reading's without recomputing anything.
   */
  render(
    nowMs: number,
    marker?: { more: number },
  ): { key: string; text: string; reading: VoiceRealtimeExecStatusReading };
};

/**
 * One field of the injected line, sanitized to the alphabet the shape allows and cut to `maxChars`.
 *
 * This is the WHOLE defence against the line carrying something it must not (SPEC §8.4: never a
 * session body, a file path or the user's own words): only `[\w.:-]` survives, so a `runId` that
 * somehow held a path or a sentence comes out as an opaque token — or as `-` when nothing is left.
 */
function voiceStatusField(value: string, maxChars: number): string {
  const kept = value.replace(/[^\w.:-]+/g, '');
  return kept === '' ? '-' : kept.slice(0, maxChars);
}

/**
 * The run id a `session_send` result names, or `null` when it names none.
 *
 * Read defensively: the result is the executor's own `unknown` (a `queued: true` delivery has no run
 * at all, and the MCP gateway's shape is not this module's to police), so anything that is not a
 * non-empty string is "no run" rather than a guess. `null` is also what a NEW run is detected from —
 * a result that names the same run as last time is the same run, not a restart.
 */
function runIdOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) {
    return null;
  }
  const runId = (result as { runId?: unknown }).runId;
  return typeof runId === 'string' && runId !== '' ? runId : null;
}

/**
 * Builds the per-connection execution-status aggregator (SPEC §8.2's L3 single source).
 *
 * NOT A POLLER. Every field is folded in from an event the proxy already handles, and nothing here
 * reads the clock except to stamp `at` and to measure `elapsedMs`/`ageMs` at render time — which is
 * what makes the reading a thing that CHANGES rather than a snapshot taken on a schedule.
 *
 * `now` is injectable so a criterion can drive a stale reading deterministically; production takes
 * `Date.now`.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (the connection handler) and
 * `tests/voice-realtime-status-injection.test.ts`.
 */
export function createVoiceRealtimeExecStatus(now: () => number = Date.now): VoiceRealtimeExecStatus {
  let phase: VoiceRealtimeExecPhase = 'idle';
  let runId: string | null = null;
  let runStartedAt: number | null = null;
  let queuedItems = 0;
  let queuedBytes = 0;
  let queuedKnown = true;
  let pendingInteraction: VoiceRealtimePendingInteraction | null = null;
  let statusSeq = 0;
  let at = 0;
  /** Whether a run has started or messages wait — before that there is no line at all. */
  let started = false;

  const keyOf = (): string =>
    [phase, runId ?? '-', queuedKnown ? 'k' : '?', queuedItems, queuedBytes, pendingInteraction?.requestId ?? '-'].join(
      '|',
    );
  let currentKey = keyOf();

  const reading = (): VoiceRealtimeExecStatusReading => ({
    phase,
    runId,
    elapsedMs: runStartedAt === null ? 0 : Math.max(0, now() - runStartedAt),
    queuedItems,
    queuedBytes,
    queuedKnown,
    pendingInteraction,
    statusSeq,
    at,
  });

  const update = (patch: VoiceRealtimeExecStatusPatch): { changed: boolean; newRun: boolean } => {
    const before = currentKey;
    let newRun = false;
    if ('runId' in patch) {
      const next = patch.runId ?? null;
      if (next !== null && next !== runId) {
        newRun = true;
        runStartedAt = now();
      }
      runId = next;
    }
    if (patch.phase !== undefined) phase = patch.phase;
    if (patch.queuedItems !== undefined) queuedItems = Math.max(0, Math.trunc(patch.queuedItems));
    if (patch.queuedBytes !== undefined) queuedBytes = Math.max(0, Math.trunc(patch.queuedBytes));
    if (patch.queuedKnown !== undefined) queuedKnown = patch.queuedKnown;
    if ('pendingInteraction' in patch) pendingInteraction = patch.pendingInteraction ?? null;
    if (phase !== 'idle' || runId !== null || queuedItems > 0) started = true;

    currentKey = keyOf();
    if (currentKey === before) {
      return { changed: false, newRun };
    }
    statusSeq += 1;
    at = now();
    return { changed: true, newRun };
  };

  const render = (nowMs: number, marker?: { more: number }) => {
    const current = reading();
    if (!started) {
      return { key: '', text: '', reading: current };
    }
    const pending =
      current.pendingInteraction === null
        ? '-'
        : `${voiceStatusField(current.pendingInteraction.requestId, 12)}/${voiceStatusField(
            current.pendingInteraction.toolName,
            16,
          )}`;
    // A depth with no readable CLI term is stated as unknown, not as the L3-only number it would
    // otherwise print: "queued=0/0B" while the session holds messages is the exact lie §18.5 names.
    const queueReading =
      current.queuedKnown === false
        ? 'queued=unknown'
        : `queued=${current.queuedItems}/${current.queuedBytes}B`;
    const body =
      `[exec] phase=${current.phase} run=${current.runId === null ? '-' : voiceStatusField(current.runId, 16)}` +
      ` statusSeq=${current.statusSeq} elapsed=${Math.round(current.elapsedMs / 1000)}s ${queueReading}` +
      ` pending=${pending} at=${current.at} ageMs=${Math.max(0, nowMs - current.at)}`;
    // The marker is appended AFTER the cap is applied to the body, not inside it: the cap notice is
    // the last thing a run says, so it is the one thing that must survive the byte bound. Measured in
    // bytes so the two halves together are still ≤ {@link VOICE_REALTIME_STATUS_MAX_BYTES}.
    const markerText = marker === undefined ? '' : ` (+${marker.more} more, ask session_status)`;
    const bodyCap = VOICE_REALTIME_STATUS_MAX_BYTES - Buffer.byteLength(markerText, 'utf8');
    let text = body;
    if (Buffer.byteLength(text, 'utf8') > bodyCap) {
      text = Buffer.from(text, 'utf8').subarray(0, Math.max(0, bodyCap)).toString('utf8');
    }
    text += markerText;
    return { key: currentKey, text, reading: current };
  };

  return { hasState: () => started, key: () => currentKey, reading, update, render };
}

/**
 * One inbound browser frame, as far as this handler distinguishes them.
 *
 * Three of these are the segmented relay's (SPEC §C1): a browser-side segmenter cuts
 * the capture at pauses and numbers each piece, and the number is what makes the whole
 * path idempotent — see {@link VoiceRealtimeOutboundFrame}'s `segment_ack`.
 *
 * The fourth is the ORIGINAL continuous frame and is deliberately still spelled exactly
 * as it was: `{ type: 'audio', audio }`, with no `seq`. A capture that does not segment
 * (an older page, a microphone in the default mode) keeps the behaviour it always had,
 * and `seq` — not a mode flag — is what tells the two apart.
 */
export type VoiceRealtimeInboundFrame =
  /**
   * The segmented-relay offer (P4 / AC-322): the browser names the protocol it can speak and waits to
   * be told the server speaks it too. `protocol` is read as given — the handler answers only the token
   * it actually implements (see {@link SEGMENTED_RELAY_PROTOCOL}).
   */
  | { type: 'hello'; protocol: string }
  /** A segment opens. `startedAtMs` is the browser's own clock reading, for the log only. */
  | { type: 'segment_start'; seq: number; startedAtMs?: number }
  /**
   * One base64 PCM frame. With `seq` it belongs to that segment; without, it is the continuous path.
   *
   * `sourceRate` is the rate the CLIENT says its capture ran at — optional, and absent from the
   * shipped page, which resamples every frame to 16 kHz and names no rate on the wire. It is read for
   * the audio capture's WAV header (a client that downsamples differently must have that recorded),
   * never for the relay: what crosses to the endpoint is the same bytes with or without it.
   */
  | { type: 'audio'; audio: string; seq?: number; sourceRate?: number }
  /** A segment closes: the pause, the max length, or the end of the stream. */
  | { type: 'segment_end'; seq: number; durationMs?: number; reason?: RealtimeSegmentEndReason }
  /**
   * The C2 ContextPack (`VoiceRealtimeContextFrame` in the browser's protocol module): the part of
   * the conversation the user could see said, already rendered as text. It arrives once, right
   * behind the offer, and is what the session's instructions are composed from — see
   * `voice-realtime-settings.ts`.
   *
   * `chars`/`rows` are the browser's own accounting and are used for the log only; the text is the
   * payload, and it is re-checked against {@link VOICE_REALTIME_CONTEXT_MAX_CHARS} here rather than
   * trusted, because the cap is what bounds what reaches the upstream.
   */
  | { type: 'context'; text: string; chars: number; rows: number }
  | { type: 'close' };

/** One outbound server frame. */
export type VoiceRealtimeOutboundFrame =
  /**
   * The segmented-relay acceptance (P4 / AC-322). `protocol` repeats the token the browser offered;
   * a server frame WITHOUT this — or with another token — leaves the page on the continuous wire.
   */
  | { type: 'ready'; protocol?: string }
  | { type: 'state'; state: RealtimeBridgeState }
  /**
   * One interim-or-final transcription of the user's own audio (AC-317). Display
   * only: the browser renders it as the user's message and MUST NOT route it back
   * as model input — the model hears the audio itself. See `RealtimeCaption`.
   */
  | { type: 'caption'; itemId: string; text: string; final: boolean }
  /**
   * A `session_send` was ACCEPTED and is waiting in the coalescing window (AC-327). The moment the
   * model decides to deliver — `pendingParts` goes from empty to non-empty — is the real start of
   * the wait that ends at {@link sent}, and this frame is that moment made visible: the page shows
   * the person's row as "being tidied up" instead of leaving it frozen for the whole window.
   *
   * Emitted once per window, only on the coalescing path (`coalesceMs > 0`), and NOT on the replay
   * branch — a segment being replayed has already been delivered and must not open a second window.
   *
   * `depth` is how many of the person's messages are waiting at this instant: the one this frame
   * announces, anything joined into an outstanding busy wait, and everything the session's own queue
   * has accepted and not drained. It is a COUNT reading, kept beside the byte reading below so the
   * page can say both "how many" and "how much".
   *
   * `bytes` is how many UTF-8 bytes of the person's text are waiting at this instant — the same
   * three places as `depth`, measured in the unit the bound is judged in
   * (see {@link VOICE_QUEUE_MAX_BYTES}). It is what the bar shows as "待投递 N 字", the reading
   * a person needs to tell "a sentence is waiting" from "a paragraph is waiting".
   */
  | { type: 'queued'; depth: number; bytes: number }
  /**
   * The bound was reached: the `session_send` this frame answers was NOT accepted and will never
   * reach the session (AC1/AC3 — the model's call is answered, the executor is not touched).
   *
   * The person's words are NOT silently dropped: nothing claims them, so their caption stays on
   * screen as an undelivered line rather than being absorbed into a delivered message. That is the
   * disposition this frame's `reason` names — `queue-full` means "kept as the caption you can still
   * read, not sent".
   *
   * `bytes` is the pending byte total this delivery would have pushed over the budget
   * (pending + this message); the page shows it so the refusal names the number it happened at.
   */
  | { type: 'refused'; reason: 'queue-full'; depth: number; bytes: number }
  /**
   * `message` is the text actually delivered to the session (after pieces were joined). The browser
   * uses it to recognise the real user message in the transcript and mark it as having come from
   * the voice transcript, instead of showing the person's words twice.
   *
   * `depth` is the waiting depth AFTER this delivery landed — the reading the page keeps between
   * `queued` frames. A send that started a run (`queued: false`) reports 0, because starting a run
   * means everything queued ahead of it had drained. `bytes` is the same reading in
   * {@link VOICE_QUEUE_MAX_BYTES}'s unit.
   */
  | { type: 'sent'; sessionId: string; result: unknown; message?: string; depth: number; bytes: number }
  /**
   * What became of one segment the browser sent (SPEC §C1). Display/diagnosis only: the
   * page uses it to show that a segment was taken rather than silently swallowing it.
   *
   * `committed` means the segment reached the upstream as an utterance — in manual mode
   * when its `input_audio_buffer.commit` went out, in fallback mode when the endpoint
   * transcribed it (which is what proves the VAD closed it). `dropped` means the proxy
   * refused it (a `segment_end` for a segment it never saw open), with `reason` saying so.
   */
  | { type: 'segment_ack'; seq: number; state: 'committed' | 'dropped'; reason?: string }
  /**
   * A failure. `recoverable` marks the ones that concern a single model turn (a bad
   * function call) rather than the connection: the browser reports the message but
   * keeps listening, because ending the user's session over one malformed call
   * would turn a model hiccup into a dead microphone. Absent means fatal.
   */
  | { type: 'error'; code: string; message: string; recoverable?: true }
  /**
   * One spoken turn the endpoint never answered (observed live as "我说完之后就没反应了").
   *
   * NOT an `error`. The endpoint heard the utterance, announced `speech_started` and then went
   * silent until the bridge's stall deadline passed — no fault on either side, and nothing left
   * to retry: in the continuous path the audio is already upstream and was never held, so there
   * is no replay to make. What the page was missing was not a worse message but a DESTINATION
   * for that utterance: it got its own frame, so the bar can say the turn ended unanswered
   * (instead of sitting on "Listening…", which is what the real report was about).
   *
   * `seconds` is the deadline that expired, not a measurement of the silence. The connection is
   * untouched: the next utterance is heard normally, and a later `sent` is an answer to it.
   */
  | { type: 'turn_unanswered'; seconds: number }
  /**
   * A spoken STOP was carried out: the run in flight was aborted and the person should be told,
   * honestly, what became of everything else.
   *
   * `aborted` is the control service's own verdict — `true` means a run was stopped, `false` means
   * there was nothing in flight to stop (the provider's `session_interrupt` reports both without
   * error; see `NO_RUN_TO_ABORT_MESSAGE`). `depth` is how many of the person's messages are STILL
   * waiting after the stop — the reading the bar turns into "已停止当前回合；已排队的 N 条仍会依次
   * 处理". A stop ends ONE run; it never cancels the messages already accepted, so `depth` is the
   * promise that survives the stop, not a count of what was thrown away.
   */
  | { type: 'stopped'; aborted: boolean; depth: number };

/**
 * How much of the person's text the bound session's OWN queue is still holding.
 *
 * The count and byte readings the relay reconciles its CLI term against (SPEC §18.1 F-3). The same
 * units {@link queuedDepth}/{@link queuedBytes} use, so the reading and the relay's own terms add
 * up: `items` is a message count and `bytes` is UTF-8 text length. Structurally identical to the
 * runtime gateway's `HostPendingQueuedInputs`, and declared here rather than imported so the
 * voice-realtime module keeps its lean half free of a providers-module dependency — the composition
 * root, not this leaf, is what knows both shapes and joins them.
 */
export type HostQueueReading = { items: number; bytes: number };

/**
 * What the handler needs from the composition root, all injected.
 *
 * Functions rather than values because both halves are per-connection: the
 * transport carries the upstream socket, and the executor carries the
 * `boundSessionId` whitelist. A closed gate or a missing upstream credential is
 * therefore reported per connection, where the browser can see it, rather than
 * aborting the whole server at boot.
 */
export type VoiceRealtimeProxySeams = {
  /**
   * Builds a fresh upstream transport for one browser connection.
   *
   * `reportError` is the transport's own error channel (a rejected function call,
   * a malformed upstream frame, …). A transport that is handed no `onError` drops
   * those silently, which is how a rejected `session_send` once read as "Listening…"
   * forever; pass it straight through as the transport's `onError`.
   */
  createTransport(reportError: (error: { code: string } & Record<string, unknown>) => void): RealtimeTransport;
  /** Builds the live executor whose `session_send` is whitelisted to `boundSessionId`. */
  createExecutor(input: { boundSessionId: string }): RealtimeToolExecutor;
  /** The session instructions sent upstream once connected, and the base of the defaults a settings file overrides. */
  instructions: string;
  /**
   * The settings file to read for this connection, overriding {@link VOICE_REALTIME_SETTINGS_ENV}.
   * A criterion points it at a file it owns; a deployment sets the environment variable instead.
   */
  settingsPath?: string;
  /**
   * How a spoken instruction waits for a session that is mid-turn. Optional: the defaults
   * ({@link BUSY_RETRY_INTERVAL_MS}, {@link BUSY_RETRY_MAX_MS}) are what ships; a criterion
   * shrinks them so the wait is observable in milliseconds.
   */
  busyRetry?: { intervalMs: number; maxMs: number };
  /**
   * How many UTF-8 bytes of the person's as-yet-undelivered text may be waiting before the relay
   * refuses the next message (see {@link VOICE_QUEUE_MAX_BYTES}). Optional: the constant is what
   * ships, and a criterion shrinks it to reach the bound in a couple of calls.
   */
  maxQueuedVoiceBytes?: number;
  /**
   * The S-A rate window (SPEC §8.3: at most one status line per 2 s, a window's changes collapsing to
   * the latest). Optional: {@link VOICE_REALTIME_STATUS_RATE_MS} is what ships, and a criterion shrinks
   * it so the collapse is observable in milliseconds rather than in seconds.
   */
  statusRateMs?: number;
  /**
   * Receives the aggregator reading behind each status line that goes upstream — the provenance
   * reading SPEC §8.2 wants shared between S-A and the future S-B/S-C. A criterion reads it to prove
   * the line and the reading are ONE source (`statusSeq` included), not two computations of the same
   * thing. Never the line's text: this is the reading, not the wire.
   */
  onExecStatus?: (reading: VoiceRealtimeExecStatusReading) => void;
  /**
   * Receives one plain line per event worth knowing about on the BROWSER side of the
   * connection — what was sent to the page, and how long a spoken instruction took to
   * deliver. `server/index.ts` writes it to the server log: the upstream log alone
   * cannot say whether the page was ever told.
   */
  log?: (line: string) => void;
  /** Overrides the bridge's stall threshold (ms). Production leaves it unset; a criterion shrinks it. */
  stallMs?: number;
  /**
   * How long speech must be quiet before what the model relayed is delivered as ONE message.
   * The server VAD cuts a sentence at every pause and the model relays each piece, so without this
   * one thought reached Claude as four or five fragments ("这个逻辑不要放在前。" / "端。" / "放到 server。"
   * / "那边去。" — measured on three clips: 13 messages). Unset or 0 delivers every call at once.
   */
  coalesceMs?: number;
  /**
   * How long one relayed instruction may wait for its committed segment's transcription to come back
   * before it stops being held and is delivered anyway. See {@link SEGMENT_TRANSCRIPT_GRACE_MS}.
   */
  transcriptGraceMs?: number;
  /**
   * How the segmented path closes a segment upstream: `manual` (the endpoint's own VAD
   * off, one `commit` + `response.create` per `segment_end`) or `server-vad` (the
   * fallback the SPEC names, where real silence between segments is what the endpoint's
   * detector reads). A criterion sets it directly; a deployment sets
   * {@link VOICE_REALTIME_SEGMENT_COMMIT_ENV} instead (see {@link resolveSegmentSelection}).
   * Left unset by both, the segmented path still runs — the browser's own frames are what
   * select it — with the adopted protocol (`manual`).
   */
  segmentCommit?: RealtimeSegmentCommitMode;
  /** Fallback mode only: the ceiling on the real silence that closes a segment. See the bridge. */
  commitGapMs?: number;
  /**
   * The C3 upstream session pool (SPEC §C3). When set, this connection runs over one active
   * session plus a pre-warmed standby and switches to the standby after `idleRotateMs` idle;
   * when omitted it is exactly one session, as before. The pool IS a `RealtimeBridge`, so the
   * connection below cannot tell the difference — which is the point: the rotation is a
   * property of the transport, not of the protocol the page speaks.
   *
   * `onRotate` is how the DIAGNOSIS report gets its `rotations[]`: the pool itself is built
   * here, so the readings are handed out as they happen rather than reconstructed afterwards.
   */
  upstreamPool?: { idleRotateMs: number; onRotate?: (rotation: UpstreamPoolRotation) => void };
  /**
   * Whether this connection answers a matching `hello` with `ready{protocol:'segmented-v1'}` — the
   * P4 rollout switch (AC-322).
   *
   * LEFT UNSET BY EVERY CALLER THAT HAS NO OPINION, and that is deliberate: unset means "resolve from
   * {@link VOICE_REALTIME_MODE_ENV} with the same pure resolver `server/index.ts` calls", so the
   * shipped default (segmented) is what a caller that passes nothing gets. `server/index.ts` passes
   * it EXPLICITLY, because it is the composition root and the resolution belongs at the assembly
   * point; a criterion passes nothing, so it reads the real default rather than re-declaring it.
   */
  segmentedRelay?: boolean;
  /**
   * THIS connection's uplink audio capture, or absent (see `voice-realtime-audio-capture.ts`).
   *
   * A SIDE CHANNEL, never a replacement: the proxy tells it what crossed the wire and it decides what
   * lands on disk. Every call below is `?.`-guarded and the recorder behind the seam is fail-open, so a
   * connection that was given no capture — and one whose capture cannot be written — forwards exactly
   * the frames it always did. That is what makes "capture off" byte-neutral (AC6), and why the capture
   * resolves its own directory rather than the proxy ever seeing one: the environment belongs to the
   * assembly point (`server/index.ts`), which passes this only when `VOICE_REALTIME_CAPTURE` turned it on.
   */
  audioCapture?: VoiceRealtimeAudioCapture;
  /**
   * A fresh, read-only sample of the BOUND session's own queue, or `null` when it cannot be taken.
   *
   * THE ONE READING THE RELAY CANNOT PRODUCE. Every other term in {@link queuedDepth} is an event
   * the proxy saw; the messages the session's own queue accepted are held by the CLI, which drains
   * them at a turn boundary the proxy is never told about — so the relay's own count could only
   * grow (SPEC §18.1 F-3: reported `queued=8→9→10` against a real peak of 7 that then fell ≤2).
   * When present, this seam is consulted at each report point (each delivery result, before each
   * status line, after a stop) and the CLI term is read from it instead of counted.
   *
   * `null` means the reading could not be taken — a per-run session, a host that is gone — and the
   * CLI term is then UNKNOWN, not zero: the line says so
   * ({@link VoiceRealtimeExecStatusReading.queuedKnown} `false`) rather than presenting the L3-only
   * remainder as a complete depth.
   *
   * LEFT UNSET BY A CALLER WITH NO HOST. `server/index.ts` — the composition root — always passes
   * it, so a deployed connection always reconciles; a criterion that stands up a bare proxy keeps
   * the relay's own optimistic count, exactly as before this seam existed.
   */
  hostQueueReading?: (sessionId: string) => HostQueueReading | null;
};

/**
 * The environment variable that asks a deployment for the segmented relay's commit protocol.
 *
 * `manual` or `server-vad`; anything else (including unset) asks for nothing. It exists so a
 * run of `scripts/voice-realtime-diagnose.mjs --segments` can exercise the path over HTTP,
 * where the seams are built by `server/index.ts` and the request body names no protocol —
 * the route's body is transport input, and a protocol switch is not transport input.
 */
export const VOICE_REALTIME_SEGMENT_COMMIT_ENV = 'VOICE_REALTIME_SEGMENT_COMMIT';

/**
 * Which segmented-path protocol this connection speaks, and whether the caller asked for it.
 *
 * Resolution order, highest first: the seam (what a criterion or the composition root
 * passes), then {@link VOICE_REALTIME_SEGMENT_COMMIT_ENV}, then the adopted protocol —
 * `manual`, the one P0a's S1 probe concluded the endpoint supports.
 *
 * `explicit` distinguishes "someone asked for the segmented path" from "this is just the
 * default". The distinction is the diagnosis service's, not the connection's: a `turns`
 * script arriving over HTTP is spoken as segments only when the operator asked for it, so
 * the existing continuous multi-turn diagnosis keeps its meaning (see
 * `runVoiceRealtimeDiagnosis`). Consumers: this service's connection handler and
 * `voice-realtime-diagnose.service.ts`.
 */
export function resolveSegmentSelection(seams: {
  segmentCommit?: RealtimeSegmentCommitMode;
}): { mode: RealtimeSegmentCommitMode; explicit: boolean } {
  if (seams.segmentCommit !== undefined) return { mode: seams.segmentCommit, explicit: true };
  const requested = process.env[VOICE_REALTIME_SEGMENT_COMMIT_ENV];
  if (requested === 'manual' || requested === 'server-vad') return { mode: requested, explicit: true };
  return { mode: 'manual', explicit: false };
}

/**
 * Renders one bridge failure as human-readable text for the browser.
 *
 * `RealtimeBridgeError` is a discriminated union of readings, not an `Error` —
 * its members carry the facts a caller branches on and no message — so this is
 * the one place the two worlds meet. The `code` is forwarded verbatim as the
 * frame's code; only the message is composed here.
 */
export function describeBridgeError(error: RealtimeBridgeError): string {
  switch (error.code) {
    case 'CONNECTION_FAILED':
      return `Could not reach the Realtime upstream (attempt ${error.attempt}/${error.maxAttempts}).`;
    case 'CONNECTION_LOST':
      return `The Realtime upstream dropped (attempt ${error.attempt}/${error.maxAttempts}).`;
    case 'UNKNOWN_EVENT':
      return `The upstream sent an event this build does not handle: ${error.eventType}.`;
    case 'UPSTREAM_ERROR':
      return `The Realtime upstream reported an error: ${error.message}`;
    case 'TRANSCRIPTION_FAILED':
      return `A spoken segment could not be transcribed: ${error.message}`;
    case 'MODEL_TEXT_REPLY':
      return `The voice model answered itself instead of passing your words to Claude: ${error.text.slice(0, 160)}`;
    case 'TOOL_LOOP_GUARD':
      return `The voice model kept calling the same tool (${error.calls} calls) without you saying anything; it was stopped.`;
    case 'UPSTREAM_STALLED':
      return `The voice service heard you but has not answered for ${error.seconds} s; it may be slow or stuck.`;
    case 'UNKNOWN_TOOL':
      return `The model called an undeclared tool: ${error.tool}.`;
    case 'MALFORMED_FUNCTION_CALL':
      return `A function call from the upstream was malformed: ${error.reason}.`;
    case 'TOOL_EXECUTION_FAILED':
      return `The tool "${error.tool}" failed: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`;
    case 'SEND_FAILED':
      return `A frame could not be sent upstream: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`;
    case 'DISPATCH_FAILED':
      return `A tool result could not be dispatched: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`;
  }
}

/**
 * Failure codes that spoil one model turn but leave the connection sound: the model
 * called a tool badly. Everything else (a lost upstream, a missing credential, an
 * event this build cannot read) ends the session.
 */
const RECOVERABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'TOOL_ARGUMENT_SCHEMA_VIOLATION',
  'UNDECLARED_TOOL',
  'UNKNOWN_TOOL',
  'MALFORMED_FUNCTION_CALL',
  'TOOL_EXECUTION_FAILED',
  'TRANSCRIPTION_FAILED',
  // `UPSTREAM_STALLED` is deliberately absent: it no longer reaches this channel at all (a stalled
  // turn is reported as `turn_unanswered`), and a code listed here that can never arrive would
  // describe a disposition the proxy does not have.
  'MODEL_TEXT_REPLY',
  'TOOL_LOOP_GUARD',
  // The endpoint's own `error` event usually refuses ONE request (an unknown call id, a
  // content-inspection verdict on one segment); a socket that is really gone is reported
  // separately as CONNECTION_LOST, so this need not end the session by itself.
  'UPSTREAM_ERROR',
]);

const errorFrame = (code: string, message: string, recoverable = RECOVERABLE_ERROR_CODES.has(code)): VoiceRealtimeOutboundFrame =>
  recoverable ? { type: 'error', code, message, recoverable: true } : { type: 'error', code, message };

/**
 * Renders one transport-level failure (the DashScope transport's own `onError`
 * channel) as text. The transport's members carry the facts and no message, so the
 * useful ones are named here; anything else falls back to its code plus whatever
 * `reason`/`message` it carried.
 */
export function describeTransportError(error: { code: string } & Record<string, unknown>): string {
  const detail = typeof error.reason === 'string' ? error.reason : typeof error.message === 'string' ? error.message : '';
  switch (error.code) {
    case 'MISSING_API_KEY':
      return 'The Realtime upstream credential is not configured on this server.';
    case 'SPEND_LIMIT':
      return `Voice spending guard: this connection used about ¥${Number(error.cny).toFixed(3)} ${
        error.scope === 'window' ? `in ${Math.round(Number(error.windowMs ?? 0) / 1000)} s` : 'in total'
      } (limit ¥${Number(error.limitCny).toFixed(3)}), so it was ended. Start Live Voice again to continue.`;
    case 'TOOL_ARGUMENT_SCHEMA_VIOLATION':
      return `The model called ${String(error.tool)} with arguments that do not match its schema (${detail}).`;
    case 'UNDECLARED_TOOL':
      return `The model called an undeclared tool: ${String(error.tool)}.`;
    default:
      return detail === '' ? `Realtime transport error: ${error.code}.` : `Realtime transport error ${error.code}: ${detail}`;
  }
}

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

  if (frame.type === 'close') {
    return { type: 'close' };
  }

  return null;
}

/**
 * Runs one browser voice connection to completion.
 *
 * Consumed by `server/index.ts`, which derives `boundSessionId` and the caller
 * from the authenticated upgrade request and hands the result to the websocket
 * gateway's `/voice-realtime` branch.
 *
 * The socket is closed by this function on every terminal path — an upstream
 * failure, the browser's own `close`, or the socket's `close` event — because a
 * browser that keeps its microphone open against a dead upstream is the one
 * state this must not leave behind.
 */
export function handleVoiceRealtimeConnection(
  socket: WebSocket,
  boundSessionId: string,
  seams: VoiceRealtimeProxySeams,
): void {
  const send = (frame: VoiceRealtimeOutboundFrame): void => {
    if (frame.type === 'caption' ? frame.final : true) {
      seams.log?.(
        `to-browser ${frame.type}${frame.type === 'state' ? ` ${frame.state}` : ''}${
          frame.type === 'error' ? ` ${frame.code}${frame.recoverable === true ? ' (recoverable)' : ''}: ${frame.message}` : ''
        }${frame.type === 'caption' ? ` ${JSON.stringify(frame.text)}` : ''}${
          frame.type === 'queued' || frame.type === 'refused' || frame.type === 'stopped' ? ` depth=${frame.depth}` : ''
        }`,
      );
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  };

  let sending = false;
  let closed = false;
  let audioFramesFromBrowser = 0;

  /**
   * Where the person's utterance began and ended, as heard on THIS side of the wire. One per
   * connection, because a boundary is a transition and the state must not outlive the audio it
   * describes — see `voice-realtime-local-speech.ts`.
   */
  const localSpeechGate = createLocalSpeechGate();
  /**
   * Hands a local boundary to the bridge, whose stall watchdog is otherwise armed only by the
   * endpoint's own `speech_started`. Deliberately silent on `null`: most frames close no boundary.
   */
  const reportLocalSpeechBoundary = (boundary: LocalSpeechBoundary | null): void => {
    if (boundary === 'started') {
      bridge.noteLocalUtteranceStart();
      return;
    }
    if (boundary === 'ended') {
      bridge.noteLocalUtteranceEnd();
    }
  };

  // ---- the segmented path: which seq a delivery belongs to, and what was already delivered ----
  //
  // The upstream can be made to repeat a committed segment: the socket drops after the
  // commit and before the response, and the bridge writes that segment once more onto the
  // new one. The MODEL may then call `session_send` a second time for words the session was
  // already given — which, left alone, puts one thought in the conversation twice. So every
  // delivery is attributed to the segment that was in flight, and a delivery that arrives
  // while a segment is being REPLAYED is dropped if that segment already produced one.
  // Dropping it here (and answering the model as though it landed) is what keeps the
  // session at exactly one message.
  // ---- the C2 context pack: what the session was told about the conversation ----
  //
  // Read ONCE, here, and this connection keeps this reading for its whole life: an edit to the
  // settings file reaches the NEXT connection and leaves live ones alone (the criterion reads this
  // as "a new connection gets the new template, an existing one is unaffected").
  const settings = loadVoiceRealtimeSettings({ baseInstructions: seams.instructions, settingsPath: seams.settingsPath });
  if (settings.problems.length > 0) {
    seams.log?.(`settings: using the built-in prompt — ${settings.problems.join('; ')}`);
  }
  /** The pack this connection was sent, or `''` before it arrives (and for a session with nothing said). */
  let contextText = '';
  let contextChars = 0;
  let contextRows = 0;
  /** The (context, status) pair already advertised, so a repeated compose is not a second `session.update`. */
  let advertisedKey: string | null = null;

  // ---- S-A: the execution-status line, folded into this connection's instructions (SPEC §8.3) ----
  //
  // ONE aggregator per connection, driven only by events this proxy already sees: a `session_send`
  // result, a coalescing window opening, a stop. Its reading is the single source the line is
  // rendered from, so the line and any other reader can never disagree (AC6).
  const execStatus = createVoiceRealtimeExecStatus();
  const statusRateMs = seams.statusRateMs ?? VOICE_REALTIME_STATUS_RATE_MS;
  /** Status lines this run has put on the wire. The cap is on THIS, not on how many changes there were. */
  let statusInjectionsThisRun = 0;
  /** Distinct dedup keys this run has observed — what the last line's `(+N more)` counts the gap from. */
  let statusChangesThisRun = 0;
  /** Set once the run's last line has gone out: no further status line until a new run begins. */
  let statusCapReached = false;
  /** The marker the NEXT line must carry. Set only for the cap notice, cleared as it is sent. */
  let statusMarker: { more: number } | null = null;
  /** The open rate window. A change inside it updates the reading but arms nothing second (coalesce). */
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Folds one observation in and, when the dedup key moved, opens the rate window.
   *
   * The dedup gate is SPEC §8.3's: a change that leaves the key `(phase, runId, queuedItems,
   * queuedBytes, pendingInteraction.requestId)` where it was is NOT a change, and nothing is sent.
   * A new run resets the per-run counters, which is what makes the cap a property of a run rather
   * than of the connection.
   */
  const noteStatus = (patch: VoiceRealtimeExecStatusPatch): void => {
    // `queuedKnown` is always written from the current term, so a reading that fell out of a host
    // source says so. The host is sampled by the CALLER before it computes the depth this patch
    // carries (a delivery result, a stop), so the numbers and this flag describe one sample.
    const { changed, newRun } = execStatus.update({ ...patch, queuedKnown: cliQueueTerm().known });
    if (newRun) {
      statusInjectionsThisRun = 0;
      statusChangesThisRun = 0;
      statusCapReached = false;
      statusMarker = null;
    }
    if (!changed) {
      return;
    }
    statusChangesThisRun += 1;
    if (statusTimer === null) {
      // No window is open, so this change opens one. A change that arrives while one IS open only
      // updates the reading the window will render — nothing is armed a second time, and nothing is
      // queued behind it, which is what makes a burst coalesce to its latest state (SPEC §8.3).
      statusTimer = setTimeout(flushStatus, statusRateMs);
      statusTimer.unref();
    }
  };

  /**
   * Pushes the composed instructions onto the upstream session.
   *
   * Guarded on `bridge.state`, not called-and-hoped: `sendSessionUpdate` throws on a transport that
   * is not open, and the pack can arrive either side of the upstream handshake — the browser sends
   * it the moment its socket opens, which is usually well before the upstream is up. When the
   * bridge is not open this is a no-op and the `whenConnected` path below applies it instead.
   *
   * Returns whether a frame actually went out — the status bookkeeping below counts on that and must
   * not spend a slot on a compose that the dedup (or a closed bridge) swallowed.
   */
  const advertiseInstructions = (): boolean => {
    if (bridge.state !== 'open') {
      return false;
    }
    const status = execStatus.render(Date.now(), statusMarker ?? undefined);
    const key = `${status.key}\u0000${contextText}`;
    if (advertisedKey === key) {
      return false;
    }
    advertisedKey = key;
    bridge.sendSessionUpdate(
      composeVoiceRealtimeInstructions(settings, contextText, status.text === '' ? undefined : status.text),
    );
    if (contextText !== '') {
      // What was injected, by size and provenance — never the body: this log goes to the server's
      // console, and the body is the user's conversation (SPEC §C2).
      seams.log?.(
        `context injected chars=${contextChars} rows=${contextRows} template=${settings.source}${
          settings.version === null ? '' : ` version=${settings.version}`
        }`,
      );
    }
    if (status.text !== '') {
      // Safe to log whole: §8.4 forbids the line from carrying a body, a path or the user's words,
      // and `voiceStatusField` is what enforces that. The reading is handed out here, beside the
      // send, so a criterion can prove the line and the reading are one source (AC6).
      seams.log?.(
        `status injected seq=${status.reading.statusSeq} phase=${status.reading.phase} queued=${status.reading.queuedItems}/${status.reading.queuedBytes}B ageMs=${Math.max(0, Date.now() - status.reading.at)}${
          statusMarker === null ? '' : ` more=${statusMarker.more}`
        }`,
      );
      seams.onExecStatus?.(status.reading);
    }
    statusMarker = null;
    return true;
  };

  /**
   * The end of one rate window: put the LATEST reading on the wire, once.
   *
   * The last line of a run carries the `(+N more, ask session_status)` marker and shuts the run down
   * — the cap is on INJECTIONS, so a burst that coalesced into one line has spent one slot, not five.
   */
  const flushStatus = (): void => {
    statusTimer = null;
    if (closed || bridge.state !== 'open' || statusCapReached || !execStatus.hasState()) {
      return;
    }
    // Reconcile at the INJECTION, not only when the change was folded in: the CLI can drain its own
    // queue between the event that armed this window and the moment the line goes out, and §18.5's
    // "回合边界深度误差 = 0" is judged on what the line says. This updates the aggregator's stored
    // queued fields from a fresh sample; it arms nothing (only `noteStatus` opens a window), so a
    // drain noticed here is simply the reading this one line carries.
    refreshHostQueue();
    execStatus.update({
      queuedItems: queuedDepth(),
      queuedBytes: queuedBytes(),
      queuedKnown: cliQueueTerm().known,
    });
    const last = statusInjectionsThisRun >= VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN - 1;
    if (last) {
      statusMarker = { more: Math.max(1, statusChangesThisRun - statusInjectionsThisRun) };
    }
    if (advertiseInstructions()) {
      statusInjectionsThisRun += 1;
      if (last) {
        statusCapReached = true;
      }
    }
    statusMarker = null;
  };

  const segmentCommitMode = resolveSegmentSelection(seams).mode;

  // ---- the P4 rollout switch: does this connection declare the segmented relay? ------------------
  //
  // Read ONCE per connection, like the settings above: a live connection keeps the answer it was
  // opened with, so flipping the environment variable affects the NEXT connection and leaves the one
  // already in progress alone. When the caller passed no seam, this resolves the shipped default —
  // the same {@link resolveVoiceRealtimeMode} `server/index.ts` calls at the assembly point — and
  // reports a misconfigured variable here, where there is a log sink to report it to.
  const modeResolution = resolveVoiceRealtimeMode(process.env);
  if (seams.segmentedRelay === undefined) {
    const modeNote = describeVoiceRealtimeMode(modeResolution);
    if (modeNote !== null) {
      seams.log?.(modeNote);
    }
  }
  const segmentedRelay = seams.segmentedRelay ?? (modeResolution.mode === 'segmented');
  /** The segment a delivery arriving now belongs to, or `null` outside any segment. */
  let activeSegmentSeq: number | null = null;
  /** Whether that segment is being replayed onto a NEW upstream socket. */
  let activeSegmentIsReplay = false;
  /** Segments that have already produced one delivered message. */
  const deliveredSegmentSeqs = new Set<number>();

  // ---- continuous mode's duplicate guard: one spoken sentence is one message ----
  //
  // THE DEFECT THIS CLOSES. The endpoint's server-side VAD commits an utterance when the user stops
  // speaking and the model relays it as `session_send`; but the model can then re-issue the SAME
  // call with no new audio behind it — nudged by the tool-resume `response.create`, or by the
  // upstream starting a response on its own. The call ids are fresh, the segmented replay gate above
  // never fires (continuous mode carries no `seq`), and the per-utterance cap is nowhere near, so
  // one sentence was delivered into the session three times (journal 57279cc1, 2026-10-11,
  // 15:40:00 / 15:40:16 / 15:40:33 — the last two with `audioTokens=259`, i.e. no new input audio).
  //
  // THE COUNTER is "user utterances the upstream has begun and not yet accounted for by an accepted
  // delivery". A NEW utterance is signalled two ways and BOTH count — the endpoint's
  // `input_audio_buffer.committed` (through {@link RealtimeBridgeHooks.onUserAudioCommitted}: the
  // proxy cannot see the event itself, the bridge tolerates it) and a FINAL transcription
  // (`onCaption` below — the very signal the bridge uses to end its own per-utterance tool-loop
  // count, `MAX_CALLS_PER_UTTERANCE`). Counting the commit ALONE is not enough: a producer that
  // announces an utterance by its transcript with no `committed` the proxy observed — the scripted
  // stand-in `voice-realtime-status-injection.test.ts` drives its turns exactly that way — would have
  // every genuine repeat swallowed as an echo. The guard only ever reads the count for "== 0", so
  // counting both is strictly safer than either and never masks a phantom (which carries neither).
  // RESET to 0 the moment a call passes every gate and is accepted, NOT at the `flushCoalesced`
  // moment: an utterance that lands INSIDE the 2.5 s window then belongs to the NEXT one instead of
  // being erased by the flush.
  let unforwardedUserUtterances = 0;
  /**
   * Normalized text of the most recent message this connection accepted for delivery (the window's
   * joined text while a window is open). The guard's other half: with the counter at 0, a call
   * whose normalized text equals this — or is contained in it — is words the session already has.
   */
  let lastAcceptedRelayText = '';
  /** Per-segment frame count, for the log line and the ack. */
  const segmentFrameCounts = new Map<number, number>();
  /** Fallback mode: segments committed whose transcription has not come back yet, oldest first. */
  const awaitingTranscriptionSeqs: number[] = [];
  /**
   * A committed segment's transcript, once the endpoint has reported one: `false` when it carried
   * words, `true` when it carried none. ABSENT means "not known yet", which is a third state and
   * not the same as empty — the guard holds on absent and drops on `true` (see
   * {@link SEGMENT_TRANSCRIPT_GRACE_MS}).
   */
  const segmentTranscriptEmpty = new Map<number, boolean>();
  /** Segments already answered with `dropped`/`empty-transcript`, so the ack goes out once. */
  const emptiedSegmentSeqs = new Set<number>();
  /** Segments whose `segment_end` has already been handled, so a repeat cannot close one twice. */
  const endedSegmentSeqs = new Set<number>();
  /** The one relayed instruction held back because its segment's transcript is not yet known. */
  let heldDelivery: { seq: number; isReplay: boolean; args: Record<string, unknown>; resolve: (value: unknown) => void } | null = null;
  let heldTimer: ReturnType<typeof setTimeout> | null = null;
  const transcriptGraceMs = seams.transcriptGraceMs ?? SEGMENT_TRANSCRIPT_GRACE_MS;

  const base = seams.createExecutor({ boundSessionId });

  /**
   * `session_send`, executed immediately — no browser confirmation (AC-316).
   *
   * DashScope's server-side VAD can start a second response (and so a second
   * `session_send` call) before the first real call has returned — AC-308's
   * real trace already proved that race happens. `sending` is a single-flight
   * guard, not a queue: a second call while one is outstanding is refused
   * outright rather than running concurrently against the same bound session
   * (AC-315's protocol-simulation suite regresses this).
   */
  /** True while an instruction is waiting out a busy session — the only state a newer call may join. */
  let waitingForBusySession = false;
  /** What was said while the first instruction was waiting; delivered with it, in order. */
  let waitingExtraMessages: string[] = [];
  /**
   * Deliveries the bound session's OWN queue accepted (`queued: true`) and has not drained yet.
   *
   * THE RELAY'S OWN GUESS, and it is only used when this connection has no host to ask (see
   * {@link hostQueueSource}). It can only ever grow: once `session_send` resolves with `queued: true`
   * the message is the session's, and nothing here is told when the turn ahead of it ends — the next
   * send's own result is the sole reset (a `queued: false` send could only start its run because
   * everything ahead had drained). Measured 2026-10-12 (SPEC §18.1 F-3): that guess reached 10 while
   * the CLI's real depth peaked at 7 and then fell to 2, so a connection that CAN ask the host does
   * not use this at all.
   */
  let cliQueuedDeliveries = 0;
  /**
   * The UTF-8 bytes those same `queued: true` deliveries carried, moving with
   * {@link cliQueuedDeliveries} — see that field for when this is read at all.
   */
  let cliQueuedBytes = 0;
  /** Whether this connection reconciles its CLI term against a host reading. Set once, at construction. */
  const hostQueueSource = seams.hostQueueReading;
  /**
   * The last host sample for the bound session, or `null` when the last read failed.
   *
   * Only meaningful when {@link hostQueueSource} is set: `null` there is UNKNOWN depth, which is a
   * reading of its own — never the relay's own count, and never zero.
   */
  let hostQueueSample: HostQueueReading | null = null;

  /**
   * Samples the host's own queue reading for this connection's bound session.
   *
   * Called at each point the proxy REPORTS a depth — each delivery result, before each status line,
   * after a stop — because those are the only moments a fresh number is shown, and the CLI can drain
   * its queue between any two of them. A missing seam is a no-op; a seam that throws, or answers
   * `null`, leaves {@link hostQueueSample} at `null` so the depth reads as UNKNOWN rather than stale
   * (the failure §18.5 forbids is reusing the last count as if it were current).
   */
  const refreshHostQueue = (): void => {
    if (hostQueueSource === undefined) {
      return;
    }
    try {
      hostQueueSample = hostQueueSource(boundSessionId) ?? null;
    } catch {
      hostQueueSample = null;
    }
  };

  /**
   * The CLI term of the depth and byte readings: the session's own queue, and whether it is known.
   *
   * Three-way on purpose. A connection with NO host source reports its own optimistic count (the
   * pre-seam behaviour, kept for a bare proxy); one with a source whose last read failed reports
   * UNKNOWN, contributing nothing to the numbers and setting `known: false`; one with a live reading
   * reports it verbatim.
   */
  const cliQueueTerm = (): { known: boolean; items: number; bytes: number } => {
    if (hostQueueSource === undefined) {
      return { known: true, items: cliQueuedDeliveries, bytes: cliQueuedBytes };
    }
    if (hostQueueSample === null) {
      return { known: false, items: 0, bytes: 0 };
    }
    return { known: true, items: hostQueueSample.items, bytes: hostQueueSample.bytes };
  };

  const deliverSessionSend = async (args: Record<string, unknown>): Promise<unknown> => {
    if (sending) {
      if (waitingForBusySession) {
        // Something more was said while the session is still busy. It joins the waiting message
        // (one delivery, in order) instead of being refused or replacing what was said before it.
        if (typeof args.message === 'string' && args.message.trim() !== '') {
          waitingExtraMessages.push(args.message);
        }
        seams.log?.(`session_send joined the instruction waiting for the session`);
        return {
          accepted: true,
          instruction: 'The message was accepted and joins the one already waiting. Do not call session_send again for it. Reply with the single word OK.',
        };
      }
      throw new Error('A previous voice instruction is still being sent.');
    }
    sending = true;
    try {
      const intervalMs = seams.busyRetry?.intervalMs ?? BUSY_RETRY_INTERVAL_MS;
      const maxMs = seams.busyRetry?.maxMs ?? BUSY_RETRY_MAX_MS;
      const startedAt = Date.now();
      let told = false;
      seams.log?.(`session_send start ${JSON.stringify(args).slice(0, 200)}`);
      for (;;) {
        try {
          const payload =
            waitingExtraMessages.length === 0
              ? args
              : { ...args, message: [String(args.message ?? ''), ...waitingExtraMessages].join(' ') };
          const result = await base.session_send(payload);
          seams.log?.(`session_send delivered in ${Date.now() - startedAt} ms`);
          // The readings the depth and the byte total are made of, updated BEFORE the frame that
          // reports them. A `queued: true` result is one more of the person's messages the session
          // is holding, and its text adds to the bytes it holds; a `queued: false` one started a
          // run, which could only happen with the queue ahead of it drained — so it is the one
          // moment both readings can be reset rather than incremented. The joined messages have just
          // been delivered inside `payload`, so they leave the buffer here rather than a whole turn
          // later in the `finally` below.
          const queuedResult =
            typeof result === 'object' && result !== null && (result as { queued?: unknown }).queued === true;
          // The relay's own guess is only kept when there is no host to ask (see `cliQueueTerm`); a
          // connection with a host samples it HERE, at the delivery result, which is the first moment
          // a drain the CLI performed during the send becomes visible.
          if (hostQueueSource === undefined) {
            cliQueuedDeliveries = queuedResult ? cliQueuedDeliveries + 1 : 0;
            cliQueuedBytes = queuedResult ? cliQueuedBytes + voiceMessageBytes(payload.message) : 0;
          } else {
            refreshHostQueue();
          }
          waitingExtraMessages = [];
          send({
            type: 'sent',
            sessionId: boundSessionId,
            result,
            depth: queuedDepth(),
            bytes: queuedBytes(),
            ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
          });
          // S-A: this result is the one reading that says which run the session is on and whether
          // this message started it or is waiting behind one. Folded in AFTER the frame that reports
          // the same depth/bytes, so the browser sees the delivery and the status line agrees with it.
          noteStatus({
            phase: queuedResult ? 'queued' : 'running',
            runId: runIdOf(result),
            queuedItems: queuedDepth(),
            queuedBytes: queuedBytes(),
          });
          return result;
        } catch (error) {
          // A session that is mid-turn refuses a new run. A person talking to Claude
          // while it works means "after this", not "never": wait for the turn to end
          // (bounded), say so once, and deliver. Without this the instruction was
          // dropped, the model heard nothing back, and the user saw nothing happen.
          const busy = (error as { code?: unknown } | null)?.code === 'SESSION_BUSY';
          if (!busy || closed || Date.now() - startedAt >= maxMs) {
            seams.log?.(`session_send failed after ${Date.now() - startedAt} ms: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
          if (!told) {
            told = true;
            send({
              type: 'error',
              code: 'SESSION_BUSY',
              message: 'Claude is still working in this session; your instruction will be sent as soon as it finishes.',
              recoverable: true,
            });
          }
          waitingForBusySession = true;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
    } finally {
      sending = false;
      waitingForBusySession = false;
      waitingExtraMessages = [];
    }
  };

  // ---- coalescing: one spoken thought is one message ----------------------------------------
  const coalesceMs = seams.coalesceMs ?? 0;
  let pendingParts: string[] = [];
  let pendingExtra: Record<string, unknown> = {};
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * How many of the person's messages are WAITING right now — the COUNT reading the page is shown.
   *
   * Three terms, one per place a message can be waiting, and no term for the delivery being handed
   * over: a delivery in flight is not waiting, it is being delivered.
   *
   *   · the coalescing window, as ONE. However many pieces of a paused sentence landed in
   *     `pendingParts`, they are joined into one message at the flush — counting the pieces would
   *     refuse the tail of a sentence that was always going to be one message.
   *   · the utterances joined into an outstanding busy wait, one each. These are NOT pieces of one
   *     sentence: the window is 2.5 s and a busy turn can run for two minutes, so a person who keeps
   *     talking into a working session has really said that many things, and each is waiting.
   *   · the session's own queue, read from the host when this connection can ask it
   *     ({@link cliQueueTerm}). When it can and the read fails, the term is UNKNOWN and contributes
   *     nothing — the count the page is shown is then the L3 terms alone, and
   *     {@link VoiceRealtimeExecStatusReading.queuedKnown} says so rather than letting the page read
   *     a partial number as complete.
   *
   * The bound is NOT judged against this any more (see {@link VOICE_QUEUE_MAX_BYTES}); it is kept
   * because the page shows "how many waiting" beside "how much", and the two answer different
   * questions — three short sentences and one long paragraph are both one waiting message to the
   * count.
   */
  const queuedDepth = (): number =>
    (pendingParts.length > 0 ? 1 : 0) + waitingExtraMessages.length + cliQueueTerm().items;

  const joinParts = (parts: readonly string[]): string => {
    let out = '';
    for (const part of parts) {
      const next = part.trim();
      if (next === '') continue;
      // No space between two CJK pieces; one between anything else.
      const cjkBoundary = /[\u3000-\u9fff\uff00-\uffef]$/.test(out) && /^[\u3000-\u9fff\uff00-\uffef]/.test(next);
      out = out === '' ? next : `${out}${cjkBoundary ? '' : ' '}${next}`;
    }
    return out;
  };

  /**
   * How many UTF-8 bytes of the person's text are WAITING right now — the reading the bound is
   * judged against, and the one the page shows as "待投递 N 字" (AC1/AC3).
   *
   * The same three terms as {@link queuedDepth}, each measured in bytes rather than counted, and each
   * measured the way it will be delivered: the coalescing window is joined into the one message it
   * will become (so a paused sentence is charged once, at its true length, not piece by piece), and
   * the busy-wait utterances are summed as separate messages (they arrive as separate sends, joined
   * into one payload — the space the join adds between them is not charged, which under-states the
   * pending total by at most a space per seam; that is the safe direction, because it can accept a
   * sliver too much and never refuse a sentence that fits).
   */
  const queuedBytes = (): number =>
    (pendingParts.length > 0 ? voiceMessageBytes(joinParts(pendingParts)) : 0) +
    waitingExtraMessages.reduce((sum, message) => sum + voiceMessageBytes(message), 0) +
    cliQueueTerm().bytes;

  const flushCoalesced = (): void => {
    if (coalesceTimer !== null) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    if (pendingParts.length === 0) return;
    const message = joinParts(pendingParts);
    const extra = pendingExtra;
    seams.log?.(`coalesced ${pendingParts.length} relayed piece(s) into one message`);
    pendingParts = [];
    pendingExtra = {};
    void deliverSessionSend({ ...extra, message }).catch((error: unknown) => {
      // The model has already been told the call was accepted; a late failure surfaces here.
      send(
        errorFrame(
          'TOOL_EXECUTION_FAILED',
          `The instruction could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
          true,
        ),
      );
    });
  };

  const armCoalesce = (): void => {
    if (pendingParts.length === 0) return;
    if (coalesceTimer !== null) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(flushCoalesced, coalesceMs);
    coalesceTimer.unref?.();
  };

  /**
   * The answer a relayed call gets when it will NOT become a message: the raw text carried nothing,
   * the segment it belonged to was transcribed as silence, or the connection is already gone.
   *
   * Said as "handled", never as "reached the session": the model must not re-call, and it must not
   * be told a falsehood it could act on. The wording is the same shape as the other replies so the
   * model's single behaviour — reply `OK` and stop — stays one instruction rather than three.
   */
  const handledWithoutDelivery = (): unknown => ({
    accepted: true,
    instruction: 'The message was accepted and has already been handled. Do not call session_send again for it. Reply with the single word OK.',
  });

  /**
   * Records that a relayed instruction did NOT reach the session, with why.
   *
   * The journal line is the point of this call: the 2026-10-11 defect ended with a segment's reply
   * arriving after the browser had gone and simply vanishing, leaving the operator unable to tell
   * "dropped on purpose" from "never happened". `voice-realtime-log.ts` recognises the line, so the
   * absence is a recorded outcome rather than a gap in the record.
   */
  const noteNotDelivered = (reason: string): void => {
    seams.log?.(`session_send not-delivered (${reason})`);
  };

  /** Answers one segment as refused because the endpoint reported no words for it (once per seq). */
  const markSegmentEmpty = (seq: number): void => {
    if (emptiedSegmentSeqs.has(seq)) {
      return;
    }
    emptiedSegmentSeqs.add(seq);
    seams.log?.(`segment ${seq} dropped: the endpoint reported no words for it`);
    send({ type: 'segment_ack', seq, state: 'dropped', reason: 'empty-transcript' });
  };

  /**
   * The delivery point for a relayed instruction this connection has decided MAY become a message.
   *
   * `segmentSeq`/`segmentIsReplay` are passed in rather than read from the live state because a call
   * released from the transcript hold concludes the segment it was HELD for, which by then may not
   * be the segment that is active.
   */
  const proceedRelay = async (
    args: Record<string, unknown>,
    segmentSeq: number | null,
    segmentIsReplay: boolean,
  ): Promise<unknown> => {
    // The idempotency gate. A segment being REPLAYED has been sent upstream before, and if
    // it already produced a message the session must not get a second one. The model is
    // answered exactly as a first delivery would answer it, so it does not retry — the
    // words are already where they were meant to go.
    if (segmentSeq !== null && segmentIsReplay && deliveredSegmentSeqs.has(segmentSeq)) {
      seams.log?.(`segment ${segmentSeq} replayed: the relay repeated an already-delivered call, dropped`);
      return {
        accepted: true,
        instruction: 'The message was accepted and has already reached the session. Do not call session_send again for it. Reply with the single word OK.',
      };
    }
    // The CONTINUOUS-MODE duplicate gate. A call the session already has — no user utterance has
    // been begun upstream since the last accepted delivery (the counter is 0), and the normalized
    // text equals (or is contained in) that last delivery's — is the model re-sending ONE utterance,
    // not relaying a new one. Answered exactly as a replayed segment above, so the model does not
    // retry, and nothing reaches the session. The counter alone would be fooled by a late forward
    // whose literal differs, and by the user genuinely repeating themselves (both keep the delivery
    // when a commit has landed); the text check is what tells those apart from a pure echo.
    //
    // SCOPED TO `segmentSeq === null`, i.e. the CONTINUOUS path. A delivery that belongs to a
    // segment (segmented relay) is the `seq` dedup gate's job — that gate keys on identity the text
    // comparison cannot see, and applying both here would let this guard mask the other's false
    // forms (the AC8 mutation suite reddens the missing `seq` gate by expecting the replay to land
    // twice). The defect this guard closes is precisely that continuous mode carries no `seq`.
    const normalizedRelay = normalizeRelayText(typeof args.message === 'string' ? args.message : '');
    if (
      segmentSeq === null &&
      unforwardedUserUtterances === 0 &&
      normalizedRelay !== '' &&
      lastAcceptedRelayText !== '' &&
      (normalizedRelay === lastAcceptedRelayText || lastAcceptedRelayText.includes(normalizedRelay))
    ) {
      // Parens are stripped from the preview: `voice-realtime-log.ts`'s `SEND_NOT_DELIVERED_LINE`
      // reads the reason up to the first `)`, so one in the message would truncate the journal line.
      const preview = String(args.message ?? '').replace(/[\r\n()]/g, ' ').slice(0, 80);
      noteNotDelivered(`duplicate: no new user audio since the last delivery — ${preview}`);
      return {
        accepted: true,
        instruction: 'The message was accepted and has already reached the session. Do not call session_send again for it. Reply with the single word OK.',
      };
    }
    // The BOUND (AC1/AC3), judged here — the model's call point, before any await — so a message
    // the relay refuses never reaches the executor at all: `base.session_send` is not called and the
    // session never sees it. Judged AFTER the replay gate, because a replayed segment is not a new
    // message and adds nothing to the queue; and BEFORE the segment bookkeeping, because a refused
    // delivery must not be recorded as one this segment produced.
    //
    // WHO IS REFUSED: a message whose text would push the person's waiting bytes past the budget —
    // `pendingBytes + thisMessageBytes > maxBytes`. A message that FITS is always accepted, however
    // many have come before it (AC1/AC3): the axis is text, not turns.
    //
    // A call that JOINS a window already open adds nothing new to the total — that window is already
    // counted as the one message it will become — so it is let through even at the budget. Without
    // this, the tail of a paused sentence would be refused for the sentence's own head.
    const maxBytes = seams.maxQueuedVoiceBytes ?? VOICE_QUEUE_MAX_BYTES;
    const joiningOpenWindow = coalesceMs > 0 && pendingParts.length > 0;
    const incomingBytes = voiceMessageBytes(args.message);
    if (!joiningOpenWindow && queuedBytes() + incomingBytes > maxBytes) {
      const bytes = queuedBytes() + incomingBytes;
      const depth = queuedDepth();
      seams.log?.(`session_send refused: ${VOICE_QUEUE_FULL_REASON} bytes=${bytes} max=${maxBytes} depth=${depth}`);
      send({ type: 'refused', reason: 'queue-full', depth, bytes });
      // The model reads this. The reason code is stable and the instruction names the number it
      // happened at and the disposition of the words — kept as the caption the person can still
      // see, NOT delivered — and forbids the retry that would otherwise turn one refusal into a
      // stream of them, while still asking the model to keep relaying what the person says next
      // rather than answering them itself (the model must not take over the conversation).
      return {
        accepted: false,
        reason: VOICE_QUEUE_FULL_REASON,
        depth,
        bytes,
        instruction:
          `Refused: the user's undelivered text already waiting for this session plus this message would come to ${bytes} bytes, ` +
          `over the budget of ${maxBytes} bytes (${depth} of their messages are waiting). ` +
          'This message was NOT delivered and will not be. It stays on the user\'s screen as an undelivered line, ' +
          'so the words are not lost. Do not call session_send again for them, and do not retry. ' +
          'Keep passing what the user says next through session_send — do not answer the user yourself: ' +
          'the next thing they say will be carried once the session has caught up.',
      };
    }
    // First delivery of this segment: remember it, so the replay of the same `seq` can be told apart.
    if (segmentSeq !== null) {
      deliveredSegmentSeqs.add(segmentSeq);
    }
    // Accepted: this call consumes whatever user utterance upstream has begun so far, and its text
    // becomes the baseline the NEXT no-audio repeat is judged against. Reset HERE, at acceptance —
    // not at the flush — so an utterance arriving inside the window is charged to the next delivery.
    unforwardedUserUtterances = 0;
    if (coalesceMs <= 0) {
      lastAcceptedRelayText = normalizedRelay;
      return deliverSessionSend(args);
    }
    // The window OPENS here, and only here: `pendingParts` was empty, so nothing was already
    // waiting and this delivery starts the wait that `flushCoalesced` ends. Tell the browser at
    // this instant (AC-327) — before the timer is armed, so the frame precedes `sent` for certain.
    // A later message that lands INSIDE an open window joins it without a second frame.
    const openingWindow = pendingParts.length === 0;
    if (typeof args.message === 'string' && args.message.trim() !== '') {
      pendingParts.push(args.message);
    }
    // The baseline a repeat is judged against is the WINDOW'S joined text, so a call that joins an
    // open window widens it: a no-audio repeat of any piece already in the window is recognised.
    lastAcceptedRelayText = normalizeRelayText(joinParts(pendingParts));
    const { message: _ignored, ...rest } = args;
    pendingExtra = { ...pendingExtra, ...rest };
    if (openingWindow && pendingParts.length > 0) {
      // The other end of this delivery's journal: `flushCoalesced` writes `coalesced …` when the
      // window closes, this is where it opened and the frame above announced it. An operator
      // reading the log sees the two lines bracketing the wait the browser showed as "tidying up".
      seams.log?.(`queued: opening a ${coalesceMs} ms coalescing window (the frame precedes the sent)`);
      const depth = queuedDepth();
      const bytes = queuedBytes();
      send({ type: 'queued', depth, bytes });
      // S-A: text is now waiting even though no run has been started for it — the one event that
      // moves the status line to `queued` with a non-zero backlog.
      noteStatus({ phase: 'queued', queuedItems: depth, queuedBytes: bytes });
    }
    armCoalesce();
    // The model reads this. Wording matters: "will be delivered when the user stops speaking" made it
    // retry the same call every 0.65 s. Say it is DONE from its side, and what to do next.
    return {
      accepted: true,
      instruction: 'The message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK.',
    };
  };

  /**
   * Releases a held instruction: with the transcript now known, deliver it — or, if the segment was
   * transcribed as silence, refuse it and say so.
   */
  const releaseHeldDelivery = (): void => {
    if (heldTimer !== null) {
      clearTimeout(heldTimer);
      heldTimer = null;
    }
    const held = heldDelivery;
    if (held === null) {
      return;
    }
    heldDelivery = null;
    if (closed) {
      noteNotDelivered('socket closed');
      held.resolve(handledWithoutDelivery());
      return;
    }
    if (segmentTranscriptEmpty.get(held.seq) === true) {
      noteNotDelivered('empty-transcript');
      held.resolve(handledWithoutDelivery());
      return;
    }
    void proceedRelay(held.args, held.seq, held.isReplay).then(held.resolve, (error: unknown) => {
      send(
        errorFrame(
          'TOOL_EXECUTION_FAILED',
          `The instruction could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
          true,
        ),
      );
      held.resolve(handledWithoutDelivery());
    });
  };

  /**
   * Holds one relayed instruction until its segment's transcription is known, or the grace elapses.
   *
   * The held call is answered only when it is released, which is what makes the ORDERING of the
   * transcription and the model's call irrelevant: both orders end in the same decision.
   */
  const holdUntilTranscriptKnown = (
    seq: number,
    isReplay: boolean,
    args: Record<string, unknown>,
  ): Promise<unknown> =>
    new Promise((resolve) => {
      if (heldDelivery !== null) {
        // A second piece while the first is held is the same utterance relayed in pieces — the shape
        // coalescing exists for. Join them, so the wait costs one message rather than two or none.
        heldDelivery.args = {
          ...heldDelivery.args,
          message: joinParts([String(heldDelivery.args.message ?? ''), String(args.message ?? '')]),
        };
        resolve(handledWithoutDelivery());
        return;
      }
      heldDelivery = { seq, isReplay, args, resolve };
      heldTimer = setTimeout(releaseHeldDelivery, transcriptGraceMs);
      heldTimer.unref?.();
    });

  /**
   * `session_send`, executed immediately (AC-316) — behind the empty-transcript guard.
   *
   * The guard sits HERE, at the delivery point, and not only where the transcription arrives: the
   * endpoint's transcript and the model's relay are independent upstream events and either may land
   * first. Deciding when the call arrives therefore covers both orders, and the hold above makes the
   * decision the same one whichever it was.
   */
  const sessionSend = async (args: Record<string, unknown>): Promise<unknown> => {
    // A connection the browser has already left has nowhere to deliver to. Without this the relay
    // of a segment that arrived after the socket closed was handed to the session anyway, and the
    // page was never told because there was no page — the "silent disappearance" of 2026-10-11.
    if (closed) {
      noteNotDelivered('socket closed');
      return handledWithoutDelivery();
    }
    // The model's own message, judged on its own: an empty or punctuation-only `message` is not a
    // thought to relay, whatever the segment's transcript said.
    if (EMPTY_RELAY_TEXT.test(typeof args.message === 'string' ? args.message : '')) {
      noteNotDelivered('empty-message');
      return handledWithoutDelivery();
    }
    if (activeSegmentSeq !== null) {
      const empty = segmentTranscriptEmpty.get(activeSegmentSeq);
      if (empty === true) {
        noteNotDelivered('empty-transcript');
        markSegmentEmpty(activeSegmentSeq);
        return handledWithoutDelivery();
      }
      if (empty === undefined) {
        return holdUntilTranscriptKnown(activeSegmentSeq, activeSegmentIsReplay, args);
      }
    }
    return proceedRelay(args, activeSegmentSeq, activeSegmentIsReplay);
  };

  /**
   * `session_interrupt`, the STOP path — the ONE handler that deliberately does not go through
   * {@link deliverSessionSend}.
   *
   * WHY IT BYPASSES THE SEND MACHINERY. A stop has to work precisely when a send is stuck: while a
   * `session_send` is parked in the busy-wait (the single-flight `sending` held) or while the queue
   * is full (`VOICE_QUEUE_FULL`), a stop that queued behind the send it is meant to cancel would
   * never run — the user says stop and the run keeps going. So it does NOT touch `sending`, it does
   * NOT open a coalescing window, and it is NOT judged by the delivery bound. It calls the bound
   * session's own interrupt and answers at once (AC2/AC3).
   *
   * WHAT A STOP IS NOT. It is not a teardown: the voice connection, the microphone and the messages
   * already accepted all survive it (AC4). It ends the ONE run in flight (the control service's
   * abort verb — the SAME one the browser's stop button and the MCP `session_interrupt` reach), and
   * the backlog's first message is released immediately rather than waiting for its coalescing
   * window, so the person's next words are carried without a pause. `depth` is read BEFORE that
   * release, so the number the bar shows still counts everything the stop did not throw away.
   */
  const sessionInterrupt = async (args: Record<string, unknown>): Promise<unknown> => {
    const result = await base.session_interrupt(args);
    const aborted =
      typeof result === 'object' && result !== null && (result as { aborted?: unknown }).aborted === true;
    // Sample the host right after the stop: ending the run in flight is the one event that can make
    // the CLI dequeue what was waiting behind it, so the depth reported here has to be re-read rather
    // than carried over from before the stop.
    refreshHostQueue();
    const depth = queuedDepth();
    seams.log?.(`session_interrupt: aborted=${aborted} backlog=${depth}`);
    send({ type: 'stopped', aborted, depth });
    // S-A: the run in flight just ended, so the status line goes back to `idle` with no run. The
    // backlog the stop did not throw away is still counted, which is why the phase and the counts are
    // one patch rather than two — a line reading `idle queued=0` while text waits would be a lie.
    noteStatus({ phase: 'idle', runId: null, queuedItems: depth, queuedBytes: queuedBytes() });
    // Release the backlog's first message NOW (its coalescing window would otherwise hold it for up
    // to `coalesceMs`). Only when nothing is mid-delivery: `deliverSessionSend` is single-flight and
    // would refuse a second concurrent call, turning the release into a spurious failure. While a
    // send is in flight the flush is a no-op and the queued message keeps its own timer — the stop
    // has already done its job by aborting the run.
    if (!sending) {
      flushCoalesced();
    }
    return result;
  };

  const executor: RealtimeToolExecutor = {
    ...base,
    session_send: sessionSend,
    session_interrupt: sessionInterrupt,
  };

  const reportTransportError = (error: { code: string } & Record<string, unknown>): void => {
    send(errorFrame(error.code, describeTransportError(error)));
    if (error.code === 'SPEND_LIMIT') {
      // Not recoverable: a connection spending at this rate is not left running. The pending
      // instruction (if any) is still delivered by the teardown flush; nothing more is asked of the model.
      seams.log?.(`teardown: spend guard tripped (${JSON.stringify({ ...error, code: undefined })})`);
      teardown();
    }
  };

  /**
   * One segment phase transition from the bridge: which `seq` a delivery belongs to now,
   * whether it is a replay, and — where the protocol says so — the ack the page is owed.
   *
   * The ack TIMING is the whole difference between the two implementations, and neither is
   * a placeholder. Manual mode knows the segment landed the moment its commit goes out.
   * Fallback mode does not: the segment is closed by real silence and the endpoint's own
   * detector, so nothing is proven until it transcribes the segment — hence the queue, and
   * `onCaption` draining it below.
   */
  const onSegmentPhase = (event: RealtimeSegmentPhaseEvent): void => {
    // A held instruction belongs to the segment it was relayed for, and any transition that ends
    // that segment's window releases it: the segment settled (its response is over, nothing more is
    // coming), or a DIFFERENT segment's audio is now the active one. The release re-reads the
    // transcript, so a segment that was never transcribed fails open rather than waiting forever.
    if (heldDelivery !== null && (event.phase === 'settled' || event.seq !== heldDelivery.seq)) {
      releaseHeldDelivery();
    }
    activeSegmentSeq = event.phase === 'settled' ? null : event.seq;
    activeSegmentIsReplay = event.phase === 'replayed';
    if (event.phase === 'settled') {
      return;
    }
    if (segmentCommitMode === 'manual') {
      send({ type: 'segment_ack', seq: event.seq, state: 'committed' });
      return;
    }
    if (event.phase === 'committed') {
      awaitingTranscriptionSeqs.push(event.seq);
    }
  };

  let bridge: RealtimeBridge;
  try {
    const bridgeOptions: RealtimeBridgeOptions = {
      ...(seams.stallMs === undefined ? {} : { stallMs: seams.stallMs }),
      segment: {
        commitMode: segmentCommitMode,
        ...(seams.commitGapMs === undefined ? {} : { commitGapMs: seams.commitGapMs }),
      },
    };
    const bridgeHooks: RealtimeBridgeHooks = {
      onSegmentPhase,
      // Continuous mode's duplicate guard's signal (see `unforwardedUserUtterances`): every user
      // utterance the endpoint COMMITS is one the model may yet relay. The bridge tolerates the
      // event itself, so this hook is the proxy's only view of it; the guard's other signal, a final
      // transcription (`onCaption`), is already on this side.
      onUserAudioCommitted: () => {
        unforwardedUserUtterances += 1;
      },
      onStateChange: (next) => send({ type: 'state', state: next }),
        // A dropped upstream the bridge is already redialling is a hiccup, not the end: the
        // `state: open` that follows the redial restores the page, and a fatal frame here
        // would flash "Voice control stopped" over a session that is about to recover.
        //
        // A STALL IS NOT AN ERROR AT ALL. It used to travel this channel like any other failure,
        // which put it in the same slot as a malformed call and left the page with a sentence and
        // no state: the turn the person had just spoken was neither answered nor ended. It gets its
        // own frame — the utterance's disposition — and the human reading still goes to the log, so
        // a reported incident stays diagnosable from the server side alone.
        onError: (error) => {
          if (error.code === 'UPSTREAM_STALLED') {
            seams.log?.(`to-browser turn_unanswered: ${describeBridgeError(error)}`);
            send({ type: 'turn_unanswered', seconds: error.seconds });
            return;
          }
          send(
            errorFrame(
              error.code,
              describeBridgeError(error),
              error.code === 'CONNECTION_LOST' ? error.willRetry : RECOVERABLE_ERROR_CODES.has(error.code),
            ),
          );
        },
        // Forwarded verbatim: the caption channel exists so the browser can SHOW
        // what the model heard, and it deliberately shares no path with the
        // `session_send` executor above.
        onCaption: (caption) => {
          send({ type: 'caption', ...caption });
          if (caption.final) {
            // A FINAL transcription is a user utterance begun upstream — the same reading the bridge
            // takes when it resets `callsSinceUtterance` on this event. Counting it here, beside
            // `onUserAudioCommitted`, is what keeps the duplicate guard from treating a legitimate
            // repeat as an echo when the utterance reached us by transcript rather than by a
            // `committed` the proxy saw. See `unforwardedUserUtterances`.
            unforwardedUserUtterances += 1;
            // The segment's transcript, finally known. `true` means the endpoint reported ZERO
            // words for it — the one mechanical fact the guard acts on — and the segment is
            // answered as refused here, where the fact arrives, whether or not the model relays it.
            const empty = EMPTY_RELAY_TEXT.test(caption.text);
            if (activeSegmentSeq !== null) {
              segmentTranscriptEmpty.set(activeSegmentSeq, empty);
              if (empty) {
                markSegmentEmpty(activeSegmentSeq);
              }
              if (heldDelivery !== null && heldDelivery.seq === activeSegmentSeq) {
                releaseHeldDelivery();
              }
            }
            // Fallback mode's ack: a FINAL caption is the endpoint having closed the oldest
            // segment still waiting on one, because the segment only closed at all once its
            // trailing silence was read as the end of speech. In order, one caption per ack.
            // An empty one was already answered `dropped` above, so it is not acked twice.
            if (segmentCommitMode === 'server-vad' && awaitingTranscriptionSeqs.length > 0) {
              const seq = awaitingTranscriptionSeqs.shift() as number;
              if (!emptiedSegmentSeqs.has(seq)) {
                send({ type: 'segment_ack', seq, state: 'committed' });
              }
            }
          }
          // The person is still talking: the quiet window starts over.
          armCoalesce();
        },
    };
    bridge =
      seams.upstreamPool === undefined
        ? connect(seams.createTransport(reportTransportError), VOICE_REALTIME_TOOLS, executor, { ...bridgeOptions, hooks: bridgeHooks })
        : // SPEC §C3. `createTransport` is called once per SESSION, so the standby is a
          // second upstream connection rather than a second view of the first; the pool
          // owns both, and closing the pool closes both.
          createUpstreamPool({
            createSession: (sessionHooks) =>
              connect(seams.createTransport(reportTransportError), VOICE_REALTIME_TOOLS, executor, {
                ...bridgeOptions,
                hooks: sessionHooks,
              }),
            idleRotateMs: seams.upstreamPool.idleRotateMs,
            hooks: { ...bridgeHooks, onRotate: seams.upstreamPool.onRotate },
            log: seams.log,
          });
  } catch (error) {
    // `createTransport()` is the only call above that can throw synchronously
    // (a missing upstream credential is refused at construction). The bridge
    // itself reports every later failure through `onError`/the state hook.
    send({ type: 'error', code: 'TRANSPORT', message: error instanceof Error ? error.message : String(error) });
    socket.close();
    return;
  }

  const teardown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (statusTimer !== null) {
      // A status window armed just before the end would fire into a connection that no longer
      // exists. `flushStatus` guards on `closed` too; this is the cheaper half of the same rule.
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    // An instruction still waiting on its segment's transcript will never get it now: releasing it
    // here records the non-delivery instead of leaving it held until the grace timer fires into a
    // connection that no longer exists.
    releaseHeldDelivery();
    // Ending the session right after speaking must not drop the last thing said — and
    // ending it mid-segment must not either. A segment that was started and never ended is
    // closed here with the frames that did arrive, upstream and all: the user stopped
    // talking by ending the session, not by pausing, and that is a segment end too.
    const flushedSeq = bridge.flushOpenSegment();
    if (flushedSeq !== null) {
      seams.log?.(`teardown: closed the open segment seq=${flushedSeq} with the frames received`);
    }
    flushCoalesced();
    // The capture's last words: the recorder patches the WAV's size fields and appends the final
    // frame/byte/duration reading. A no-op with no capture wired, and fail-open with one — a capture
    // that cannot be closed must not keep a dead connection's microphone open (why this is before the
    // socket close, with the rest of the teardown).
    seams.audioCapture?.finalize();
    void bridge.close().catch(() => undefined);
    if (socket.readyState === socket.OPEN) {
      socket.close();
    }
  };

  // `whenConnected()` never rejects — it resolves on `open` or once the bridge
  // has exhausted its attempts and closed — so the state is what decides whether
  // there is a session to advertise. Sending an update on a closed bridge would
  // be dropped silently and leave the browser listening to nothing.
  void bridge.whenConnected().then(() => {
    if (bridge.state !== 'open') {
      send({
        type: 'error',
        code: 'TRANSPORT',
        message: 'The Realtime upstream could not be reached.',
      });
      teardown();
      return;
    }
    // The session is opened with the instructions AS THEY STAND: the settings read at the top of
    // this connection, plus whatever pack the browser has sent by now. A pack that arrives after
    // this point is applied by its own branch in the message handler.
    advertiseInstructions();
  });

  socket.on('message', (raw: unknown) => {
    const frame = readVoiceRealtimeInboundFrame(
      Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : String(raw),
    );
    if (!frame) {
      return;
    }

    if (frame.type === 'hello') {
      // THE WHOLE PROTOCOL SWITCH, one branch (P4 / AC-322). The browser offered a token; answering
      // with the same token is what lets it start cutting speech into segments. Anything else —
      // the mode turned off, or an offer this proxy does not speak — is answered with silence, and
      // silence is a MEANINGFUL answer here: the page keeps sending the continuous frames it always
      // did, so a rollback needs no browser release. Only the exact token is echoed: a page offering
      // a protocol this proxy does not implement is told nothing rather than told the wrong thing.
      if (segmentedRelay && frame.protocol === SEGMENTED_RELAY_PROTOCOL) {
        send({ type: 'ready', protocol: SEGMENTED_RELAY_PROTOCOL });
        seams.log?.(`hello: declaring ${SEGMENTED_RELAY_PROTOCOL}`);
      } else {
        seams.log?.(
          `hello: not declaring (offered ${JSON.stringify(frame.protocol)}${
            segmentedRelay ? '' : `, relay off via ${VOICE_REALTIME_MODE_ENV}`
          })`,
        );
      }
      return;
    }

    if (frame.type === 'context') {
      // The browser built this from its own transcript's visibility rules; what the proxy owns is
      // the size it is willing to hand upstream. Refusing the WHOLE frame rather than trimming it is
      // deliberate: a pack cut anywhere but its own oldest-row boundary is a conversation with a
      // hole in it, and the injection would then be evidence of nothing. The builder already holds a
      // 2000-char budget, so this only fires on a client that ignored it — and it says so.
      if (frame.text.length > VOICE_REALTIME_CONTEXT_MAX_CHARS) {
        seams.log?.(
          `context refused: ${frame.text.length} chars exceeds the ${VOICE_REALTIME_CONTEXT_MAX_CHARS}-char cap (rows=${frame.rows})`,
        );
        return;
      }
      contextText = frame.text;
      contextChars = frame.chars;
      contextRows = frame.rows;
      seams.log?.(`context received chars=${contextChars} rows=${contextRows}`);
      advertiseInstructions();
      return;
    }

    if (frame.type === 'segment_start') {
      segmentFrameCounts.set(frame.seq, 0);
      bridge.startSegment(frame.seq);
      // The SEGMENTED path's own boundary, handed to the same watchdog the continuous path feeds.
      // It needs its own: this wire runs `turn_detection: null`, so the endpoint never sends the
      // `speech_started` the watchdog's timer is otherwise armed from — a committed segment nobody
      // answered was silently unanswered, which is exactly this path's stall to report.
      bridge.noteLocalUtteranceStart();
      return;
    }

    if (frame.type === 'audio') {
      audioFramesFromBrowser += 1;
      // A sparse heartbeat, so the log can say whether the page is sending audio at all
      // (and for how long) without a line per 20 ms frame.
      if (audioFramesFromBrowser === 1 || audioFramesFromBrowser % 250 === 0) {
        seams.log?.(`from-browser audio frames=${audioFramesFromBrowser}`);
      }
      if (frame.seq === undefined) {
        // THE UPLINK CAPTURE'S ONE FEED (see `voice-realtime-audio-capture.ts`). The continuous path is
        // the full microphone stream — silence included — which is the material an offline VAD study
        // needs; the segmented path below is deliberately NOT captured, because a segmenter has already
        // dropped its silence and a corpus of speech-only clips cannot answer a detector question.
        //
        // Sees the frame on ARRIVAL, before the forward, so the audio and the endpoint's judgement
        // timeline are read against one origin. A SIDE CHANNEL: the frame is forwarded unconditionally,
        // and with no capture wired (`?.`) this branch is the bytes it was before the seam existed.
        seams.audioCapture?.frame(frame.audio, frame.sourceRate, Date.now());
        // THE WATCHDOG'S READING FOR THE CONTINUOUS WIRE, where the endpoint's own `server_vad` is
        // what endpoints this audio — so if it goes silent, nothing else can tell the relay that an
        // utterance happened (measured 2026-10-12: 118.4 s of total upstream silence, and no report).
        // The segmented path needs no energy gate because it already HAS precise boundaries, the
        // browser's own segmenter's; it hands those to the same watchdog instead (see the
        // `segment_start`/`segment_end` branches). Running this gate there as well would be a
        // second, competing endpointing over audio the segmenter has already decided.
        reportLocalSpeechBoundary(localSpeechGate.observe(frame.audio));
        bridge.sendAudioFrame(frame.audio);
        return;
      }
      segmentFrameCounts.set(frame.seq, (segmentFrameCounts.get(frame.seq) ?? 0) + 1);
      bridge.sendSegmentAudio(frame.seq, frame.audio);
      return;
    }

    if (frame.type === 'segment_end') {
      // An end for a segment this connection never saw open is refused rather than
      // committed: there is no audio to close, and inventing an empty utterance would ask
      // the endpoint for a response to nothing.
      if (!segmentFrameCounts.has(frame.seq)) {
        seams.log?.(`segment seq=${frame.seq} dropped: no matching segment_start`);
        send({ type: 'segment_ack', seq: frame.seq, state: 'dropped', reason: 'unknown-segment' });
        return;
      }
      // A repeat of an end already handled is DROPPED rather than committed again: closing one
      // segment twice would put the same audio upstream a second time and ask the endpoint for a
      // second response to it — one utterance billed and relayed twice. Idempotent, and silent on
      // the ack channel because the page already has this segment's answer.
      if (endedSegmentSeqs.has(frame.seq)) {
        seams.log?.(`segment seq=${frame.seq} end repeated for an already-closed segment, dropped`);
        return;
      }
      endedSegmentSeqs.add(frame.seq);
      // SPEC §C4's one line per segment, with the wall clock the log is read against.
      seams.log?.(
        `segment seq=${frame.seq} dur=${frame.durationMs ?? 0}ms reason=${frame.reason ?? 'gap'} frames=${
          segmentFrameCounts.get(frame.seq) ?? 0
        } at=${new Date().toISOString()}`,
      );
      // The segment's own accounting joins the capture's judgement timeline — the endpoint's decision
      // (which utterance it closed, how long the browser said it ran, how many frames carried it) is
      // exactly what an offline detector's proposals are graded against. Recorded even though the
      // segmented path sends no continuous audio: the timeline is the point, not a rider on the WAV.
      seams.audioCapture?.timeline({
        kind: 'segment',
        atMs: Date.now(),
        seq: frame.seq,
        durationMs: frame.durationMs ?? 0,
        frames: segmentFrameCounts.get(frame.seq) ?? 0,
      });
      bridge.endSegment(frame.seq);
      // The segment is closed and its commit asks the endpoint for an answer. If the endpoint said
      // nothing during the segment, that answer is now owed and the clock starts — see
      // `noteLocalUtteranceEnd`. A DROPPED or repeated end returns above and deliberately does not
      // reach here: no commit left, so no answer is owed and nothing may be reported missing.
      bridge.noteLocalUtteranceEnd();
      return;
    }

    seams.log?.(`teardown: the browser sent a close frame (audio frames received=${audioFramesFromBrowser})`);
    teardown();
  });

  socket.on('close', () => {
    seams.log?.(`teardown: the browser socket closed (audio frames received=${audioFramesFromBrowser})`);
    teardown();
  });
}

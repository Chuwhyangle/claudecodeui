/**
 * The P0 probe library: three questions about the LIVE endpoint, asked through the SHIPPING transport.
 *
 * `docs/proposals/voice-realtime-segmented-relay-SPEC.md` ("分期 / P0") needs three facts before the
 * segmentation design can be fixed, and all three are facts about the live service rather than about
 * this repository:
 *
 *   S1  does `session.update{turn_detection: null}` + an AUDIO commit + `response.create` work, or
 *       does the manual path exist only for text turns?
 *   S2  how long does a fresh upstream session take to become usable, and can a warm standby take
 *       over the segment right after the active session's `response.done`?
 *   S3  with a ~2,000-character context pack prepended to `instructions`, does the relay still
 *       forward every utterance — and what does each response then read in?
 *
 * WHY THE SHIPPING TRANSPORT AND NOT A HAND-ROLLED SOCKET. `createDashscopeTransport` is what
 * production dials; a probe that spoke its own dialect would answer questions about the probe. Its
 * `observer` seam sees every frame in BOTH directions exactly as the transport framed it, and its
 * `socketFactory` seam is what the guard's unit case swaps for a fake upstream. The one thing the
 * transport cannot express is the frames S1 is about (`input_audio_buffer.commit`, a bare
 * `response.create`) — its message set is the bridge's, deliberately — so those go out through
 * {@link P0Session.sendRaw}, which records them through the same observer and therefore leaves ONE
 * uniform trace rather than two shapes of evidence.
 *
 * WHY A BUDGET GUARD RATHER THAN A PROMISE TO BE CAREFUL. A realtime session bills per response,
 * and a runaway tool loop spent ~¥0.49 in one minute on 2026-10-09 (SPEC F8). The guard is what
 * makes "≤ ¥0.04" enforceable instead of aspirational: every `response.done` usage is priced with
 * the shipping `estimateRealtimeCostCny` on the tick it arrives, the running total is compared with
 * the stage budget, and the first crossing closes EVERY open socket and records `guardTriggered:
 * true`. `guard-case.mts` drives it against a fake upstream and is asserted from
 * `scripts/voice-realtime-p0-record-check.test.mjs`.
 *
 * CREDENTIAL HYGIENE. The key travels in the `Authorization` header only — never a URL, never a
 * frame. Every trace is scrubbed before it is written: the live key's value and any `sk-…`-shaped
 * string become `<redacted>`, and {@link writeTrace} REFUSES to write a trace that still carries
 * one. The assertion is on the serialized bytes, which is the thing that actually reaches disk.
 *
 * Run (from the repo root, on a machine with egress and a live key):
 *
 *     set -a; . ./.env.test; set +a
 *     npx tsx experiments/voice-realtime-segmented/p0/s1-manual-commit.mts
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';
import { z } from 'zod';

import {
  connect,
  createDashscopeTransport,
  estimateRealtimeCostCny,
  type DashscopeSocket,
  type DashscopeSocketFactory,
  type DashscopeTransport,
  type RealtimeBridge,
  type RealtimeToolDescriptor,
  type RealtimeToolExecutor,
} from '../../../server/modules/voice-realtime/index.js';

export const P0_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(P0_DIR, '../../..');
export const TRACES_DIR = path.join(P0_DIR, 'traces');
export const FIXTURES_DIR = path.join(P0_DIR, 'fixtures');

/** A `sk-`-shaped token, or the live key's own value. Both are what a trace may never carry. */
const SECRET_SHAPE = /sk-[A-Za-z0-9_-]{16,}/g;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Monotonic milliseconds, so two frames never share a timestamp and a real RTT is never 0. */
export const hrMs = (): number => Number(process.hrtime.bigint() / 1000n) / 1000;

/** Polls `predicate` until it holds or the deadline passes; returns whether it held. */
export async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

/** The live credential, or a refusal. Never logged; only ever handed to the transport. */
export function readApiKey(): string {
  const key = process.env.DASHSCOPE_API_KEY ?? '';
  if (key === '') {
    throw new Error('DASHSCOPE_API_KEY is not set — run `set -a; . ./.env.test; set +a` first.');
  }
  return key;
}

/** Replaces the live key and every `sk-…`-shaped token with `<redacted>`. */
export function scrubSecrets(text: string, apiKey: string): { text: string; scrubbed: number } {
  let out = text;
  let scrubbed = 0;
  if (apiKey !== '') {
    scrubbed += out.split(apiKey).length - 1;
    out = out.split(apiKey).join('<redacted>');
  }
  out = out.replace(SECRET_SHAPE, () => {
    scrubbed += 1;
    return '<redacted>';
  });
  return { text: out, scrubbed };
}

/**
 * Writes one trace under `traces/`, scrubbed, and refuses to write one that still carries a
 * credential-shaped string. The refusal is on the BYTES that would reach disk, so a future field
 * that starts echoing a token reds here instead of leaking.
 */
export function writeTrace(
  name: string,
  payload: Record<string, unknown>,
  apiKey: string,
): { file: string; scrubbed: number; bytes: number } {
  const { text, scrubbed } = scrubSecrets(JSON.stringify(payload, null, 2), apiKey);
  if (SECRET_SHAPE.test(text)) {
    SECRET_SHAPE.lastIndex = 0;
    throw new Error(`refusing to write ${name}: a sk-…-shaped string survived scrubbing`);
  }
  SECRET_SHAPE.lastIndex = 0;
  if (/Authorization/i.test(text)) {
    throw new Error(`refusing to write ${name}: the trace carries an Authorization header`);
  }
  mkdirSync(TRACES_DIR, { recursive: true });
  const file = path.join(TRACES_DIR, name);
  const body = `${text}\n`;
  writeFileSync(file, body, 'utf8');
  return { file, scrubbed, bytes: Buffer.byteLength(body, 'utf8') };
}

// ── the session body ─────────────────────────────────────────────────────────────────────────────

/**
 * The wire session body the probes send, mirroring `DEFAULT_SESSION_DEFAULTS` in the shipping
 * transport (text-only output, PCM16 in / PCM24 out, `server_vad`) because the transport REPLACES
 * rather than merges a caller's `sessionDefaults`. `turn_detection` is the one field S1 varies.
 */
export function sessionBody(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    modalities: ['text'],
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm24',
    turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 },
    ...overrides,
  };
}

/**
 * The one tool the relay advertises.
 *
 * WHY NOT `REALTIME_TOOLS_BY_NAME.session_send`. That descriptor declares `session` as REQUIRED,
 * while the shipping relay instructions ("The session is fixed by the connection; never name one")
 * tell the model to send `{ message }` alone — and the transport validates arguments against the
 * declared shape before routing, so the shipping pair would reject the very call it asks for. S1–S3
 * are questions about forwarding, not about that mismatch, so the probe advertises the shape the
 * relay's own instructions describe. The name is unchanged: the traces are read by tool NAME.
 */
export const SESSION_SEND_TOOL: RealtimeToolDescriptor = {
  name: 'session_send',
  description: 'Send a message to the Claude Code session.',
  inputSchema: { message: z.string() },
};

// ── the budget guard ─────────────────────────────────────────────────────────────────────────────

/** What one `response.done` costs, priced by the shipping estimator unless a case injects its own. */
export type CostEstimator = (usage: unknown) => number;

export type BudgetGuardOptions = {
  /** The most this run may spend, in CNY. The first crossing trips the guard. */
  budgetCny: number;
  /** Called exactly once, on the crossing. The run wires it to "close every open socket". */
  onOverBudget?: (info: { spendCny: number; limitCny: number }) => void;
  /** Defaults to the shipping {@link estimateRealtimeCostCny}. */
  estimateCny?: CostEstimator;
  now?: () => number;
};

export type BudgetGuard = {
  /** Prices one `response.done` usage and accumulates it. Returns true exactly once: on the crossing. */
  observeUsage(usage: unknown): boolean;
  readonly spendCny: number;
  readonly budgetCny: number;
  readonly guardTriggered: boolean;
  /** When the guard tripped, as a wall-clock ISO timestamp — `null` while it has not. */
  readonly trippedAt: string | null;
};

/**
 * The guard the AC names. Deliberately tiny and synchronous: `observeUsage` runs from the frame
 * observer on the same tick the `response.done` arrived, so a runaway loop cannot outrun it.
 */
export function createBudgetGuard(options: BudgetGuardOptions): BudgetGuard {
  const estimateCny = options.estimateCny ?? estimateRealtimeCostCny;
  const now = options.now ?? Date.now;
  let spendCny = 0;
  let trippedAt: string | null = null;
  return {
    observeUsage(usage: unknown): boolean {
      const cost = estimateCny(usage);
      if (Number.isFinite(cost) && cost > 0) spendCny += cost;
      if (trippedAt === null && spendCny > options.budgetCny) {
        trippedAt = new Date(now()).toISOString();
        options.onOverBudget?.({ spendCny, limitCny: options.budgetCny });
        return true;
      }
      return false;
    },
    get spendCny() {
      return spendCny;
    },
    get budgetCny() {
      return options.budgetCny;
    },
    get guardTriggered() {
      return trippedAt !== null;
    },
    get trippedAt() {
      return trippedAt;
    },
  };
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────

/** One frame as the observer saw it. `sinceOpenMs` is relative to THIS session's own open. */
export type ProbeEvent = {
  direction: 'sent' | 'received';
  atMs: number;
  sinceOpenMs: number;
  wire: Record<string, unknown>;
};

export type P0RunOptions = {
  /** The stage's budget, in CNY. Shared by every session the run opens. */
  budgetCny: number;
  apiKey: string;
  onEvent?: (sessionLabel: string, event: ProbeEvent) => void;
};

/** One probe run: the shared budget, the shared spend, and every session opened under them. */
export type P0Run = {
  readonly guard: BudgetGuard;
  /** The live credential, kept here so a session does not have to be handed it again. Never traced. */
  readonly apiKey: string;
  readonly spendCny: number;
  readonly guardTriggered: boolean;
  /** How many sessions the guard itself closed, so the trace can say so. */
  readonly guardClosedSessions: number;
  /** Registers a session's closer. Only {@link openSession} calls this. */
  register(closer: () => void): void;
  unregister(closer: () => void): void;
  onEvent?: (sessionLabel: string, event: ProbeEvent) => void;
};

export function createRun(options: P0RunOptions): P0Run {
  const closers = new Set<() => void>();
  let guardClosedSessions = 0;
  const guard = createBudgetGuard({
    budgetCny: options.budgetCny,
    onOverBudget: () => {
      // The whole point of the guard: the sockets go down on the tick the budget was crossed.
      for (const close of [...closers]) {
        guardClosedSessions += 1;
        close();
      }
    },
  });
  return {
    guard,
    apiKey: options.apiKey,
    get spendCny() {
      return guard.spendCny;
    },
    get guardTriggered() {
      return guard.guardTriggered;
    },
    get guardClosedSessions() {
      return guardClosedSessions;
    },
    register(closer) {
      closers.add(closer);
    },
    unregister(closer) {
      closers.delete(closer);
    },
    onEvent: options.onEvent,
  };
}

// ── one session ──────────────────────────────────────────────────────────────────────────────────

export type P0SessionOptions = {
  run: P0Run;
  /** A label that tells a rotated session from its predecessor in the trace. */
  label: string;
  instructions: string;
  /** The descriptors `session.update` advertises. Defaults to {@link SESSION_SEND_TOOL} alone. */
  tools?: readonly RealtimeToolDescriptor[];
  /** The wire session body. Defaults to {@link sessionBody}(). S1 passes `turn_detection: null`. */
  sessionDefaults?: Readonly<Record<string, unknown>>;
  executor?: RealtimeToolExecutor;
  model?: string;
  voice?: string;
  /** Replaces the real socket opener. The guard's unit case injects a fake upstream here. */
  socketFactory?: DashscopeSocketFactory;
  /** Mirrors the transport's own switch; the relay leaves it off so a tool result never re-reads. */
  respondToToolOutputs?: boolean;
  /** Per-session frame tap, in addition to the run's. */
  onEvent?: (event: ProbeEvent) => void;
  /** Cap on how long {@link P0Session.close} waits for the socket to finish closing. */
  closeTimeoutMs?: number;
};

export type P0Session = {
  readonly label: string;
  readonly events: ProbeEvent[];
  /** The `session.id` the endpoint assigned, or `null` while it has not said. */
  readonly sessionId: string | null;
  readonly model: string;
  readonly voice: string;
  readonly instructions: string;
  /** ms from socket open to `session.created` / `session.updated`, or `null`. */
  readonly createdMs: number | null;
  readonly updatedMs: number | null;
  readonly socketOpenMs: number | null;
  readonly closed: boolean;
  /** Frames closed by the budget guard rather than by the probe — the AC's "guard closed the socket". */
  readonly closedByGuard: boolean;
  readonly errors: Array<{ atMs: number; sinceOpenMs: number | null; wire: Record<string, unknown> }>;
  readonly responses: Array<{
    id: string | null;
    atMs: number;
    sinceOpenMs: number | null;
    usage: unknown;
    status: string | null;
    spendCny: number;
  }>;
  readonly functionCalls: Array<{ name: string; arguments: string; atMs: number }>;
  /** Every `response.done`'s usage on THIS connection, priced with the shipping estimator. */
  readonly spendCny: number;
  /** Frames the bridge cannot express (S1's commit / response.create), recorded like any other. */
  sendRaw(wire: Record<string, unknown>): void;
  sendAudioBase64(base64: string): void;
  /** Re-sends `session.update` with new instructions on THIS connection. */
  setInstructions(next: string): void;
  waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
};

/**
 * Opens ONE real upstream session through the shipping transport and returns the handle the probes
 * drive. Every frame the transport sends or receives is appended to `events` — the socket is
 * observed, not simulated — and every `response.done` is priced into the run's budget guard.
 */
export async function openSession(options: P0SessionOptions): Promise<P0Session> {
  const { run } = options;
  const model = options.model ?? 'qwen3.8-omni-flash-realtime';
  const voice = options.voice ?? 'Tina';
  const events: ProbeEvent[] = [];
  const responses: P0Session['responses'] = [];
  const errors: P0Session['errors'] = [];
  const functionCalls: P0Session['functionCalls'] = [];
  let sessionId: string | null = null;
  let socketOpenAt: number | null = null;
  let createdMs: number | null = null;
  let updatedMs: number | null = null;
  let closed = false;
  let closedByGuard = false;
  let spendCny = 0;
  let openedSocket: DashscopeSocket | null = null;

  const sinceOpen = (atMs: number): number | null =>
    socketOpenAt === null ? null : Number((atMs - socketOpenAt).toFixed(3));

  const record = (event: ProbeEvent): void => {
    events.push(event);
    options.onEvent?.(event);
    run.onEvent?.(options.label, event);
  };

  /** The frame observer: one funnel for sent, received, and raw frames alike. */
  const observer = (observation: { direction: 'sent' | 'received'; atMs: number; wire: unknown }): void => {
    const wire = (observation.wire ?? {}) as Record<string, unknown>;
    const anchored = sinceOpen(observation.atMs) ?? 0;
    const event: ProbeEvent = {
      direction: observation.direction,
      atMs: observation.atMs,
      sinceOpenMs: anchored,
      wire,
    };
    record(event);
    if (observation.direction !== 'received') return;
    if (wire.type === 'session.created' || wire.type === 'session.updated') {
      const session = wire.session as Record<string, unknown> | undefined;
      if (typeof session?.id === 'string') sessionId = session.id;
      if (wire.type === 'session.created' && createdMs === null && sinceOpen(observation.atMs) !== null) {
        createdMs = sinceOpen(observation.atMs);
      }
      if (wire.type === 'session.updated' && updatedMs === null && sinceOpen(observation.atMs) !== null) {
        updatedMs = sinceOpen(observation.atMs);
      }
    }
    if (wire.type === 'error') {
      errors.push({ atMs: observation.atMs, sinceOpenMs: sinceOpen(observation.atMs), wire });
    }
    if (wire.type === 'response.done') {
      const response = (wire.response ?? {}) as Record<string, unknown>;
      const usage = response.usage ?? null;
      const raw = estimateRealtimeCostCny(usage);
      const cost = Number.isFinite(raw) ? raw : 0;
      spendCny += cost;
      responses.push({
        id: typeof response.id === 'string' ? response.id : null,
        atMs: observation.atMs,
        sinceOpenMs: sinceOpen(observation.atMs),
        usage,
        status: typeof response.status === 'string' ? response.status : null,
        spendCny: Number(cost.toFixed(6)),
      });
      // The guard runs on the frame's own tick, before anything else can be sent.
      run.guard.observeUsage(usage);
    }
  };

  const realFactory: DashscopeSocketFactory = (url, headers) => {
    const ws = new WebSocket(url, { headers });
    const socket: DashscopeSocket = {
      send(data: string) {
        ws.send(data);
      },
      close(code?: number, reason?: string) {
        ws.close(code, reason);
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    ws.on('open', () => {
      socketOpenAt = Date.now();
      socket.onopen?.({});
    });
    ws.on('message', (data) => socket.onmessage?.({ data: data.toString() }));
    ws.on('error', (error) => socket.onerror?.(error));
    ws.on('close', (code, reason) => socket.onclose?.({ code, reason: String(reason) }));
    return socket;
  };

  const transport: DashscopeTransport = createDashscopeTransport({
    apiKey: run.apiKey,
    model,
    voice,
    sessionDefaults: options.sessionDefaults ?? sessionBody(),
    respondToToolOutputs: options.respondToToolOutputs,
    // EVERY factory is wrapped, not just the real one: `sendRaw` has to be able to deliver the
    // frames the bridge cannot express, and the guard case's fake upstream is dialled through this
    // same seam. Capturing the socket here is what keeps the two paths one path.
    socketFactory: (url, headers) => {
      const created = (options.socketFactory ?? realFactory)(url, headers);
      openedSocket = created;
      return created;
    },
    observer,
    onError: (error) => {
      errors.push({ atMs: Date.now(), sinceOpenMs: sinceOpen(Date.now()), wire: { type: 'transport.error', ...error } });
    },
  });

  /** Wraps the caller's executor so a routed call is recorded on the session it arrived on. */
  const recordingExecutor: RealtimeToolExecutor = Object.fromEntries(
    Object.entries(options.executor ?? {}).map(([name, handler]) => [
      name,
      (args: Record<string, unknown>) => {
        functionCalls.push({ name, arguments: JSON.stringify(args ?? {}), atMs: Date.now() });
        return handler(args);
      },
    ]),
  );

  const bridge: RealtimeBridge = connect(transport, options.tools ?? [SESSION_SEND_TOOL], recordingExecutor, {
    maxConnectAttempts: 1,
  });

  /** Closes the socket WITHOUT the bridge's `close()` — what the guard does when the budget trips. */
  const closer = (): void => {
    if (closed) return;
    closed = true;
    closedByGuard = run.guardTriggered;
    try {
      openedSocket?.close();
    } catch {
      // A socket that is already gone is exactly the state this closer wants.
    }
  };
  run.register(closer);

  await bridge.whenConnected();
  // The session body travels with the FIRST `session.update`. Without it the endpoint holds its
  // own defaults (`server_vad`, its own voice) and S1 would be measuring the wrong session.
  bridge.sendSessionUpdate(options.instructions);

  return {
    label: options.label,
    events,
    get sessionId() {
      return sessionId;
    },
    model,
    voice,
    instructions: options.instructions,
    get createdMs() {
      return createdMs;
    },
    get updatedMs() {
      return updatedMs;
    },
    get socketOpenMs() {
      return socketOpenAt;
    },
    get closed() {
      return closed;
    },
    get closedByGuard() {
      return closedByGuard;
    },
    errors,
    responses,
    functionCalls,
    get spendCny() {
      return Number(spendCny.toFixed(6));
    },
    sendRaw(wire: Record<string, unknown>): void {
      // Recorded through the same observer the transport's own frames go through, and delivered on
      // the same socket — the transport simply never sees it, so nothing is recorded twice.
      observer({ direction: 'sent', atMs: Date.now(), wire });
      openedSocket?.send(JSON.stringify(wire));
    },
    sendAudioBase64(base64: string): void {
      bridge.sendAudioFrame(base64);
    },
    setInstructions(next: string): void {
      bridge.sendSessionUpdate(next);
    },
    waitFor: (predicate, timeoutMs) => waitUntil(predicate, timeoutMs),
    async close(): Promise<void> {
      await bridge.close();
      closer();
      // The endpoint's own close is the trace's last entry; give it a moment to arrive.
      await sleep(options.closeTimeoutMs ?? 200);
      run.unregister(closer);
    },
  };
}

// ── trace shaping ────────────────────────────────────────────────────────────────────────────────

/**
 * The base64 audio payload is ~320 kB for twelve seconds and would dwarf the trace. Its exact
 * bytes are reproducible from the fixture WAV, so the frame keeps its type and its decoded byte
 * count and drops only the payload — the same elision the AC-308 live capture uses.
 */
export function elideAudio(events: ProbeEvent[]): ProbeEvent[] {
  return events.map((event) => {
    const audio = event.wire.audio;
    if (event.wire.type !== 'input_audio_buffer.append' || typeof audio !== 'string') return event;
    return {
      ...event,
      wire: {
        ...event.wire,
        audioBytes: Math.floor(audio.length * 0.75),
        audio: '<elided: the decoded PCM bytes are audioBytes; the source WAV is the fixture>',
      },
    };
  });
}

/** The reading half of every trace: what the frames themselves say, with no hand-written verdict. */
export function summarizeExchange(events: ProbeEvent[]): {
  sent: Record<string, number>;
  received: Record<string, number>;
} {
  const sent: Record<string, number> = {};
  const received: Record<string, number> = {};
  for (const event of events) {
    const type = String(event.wire.type ?? '<none>');
    const bucket = event.direction === 'sent' ? sent : received;
    bucket[type] = (bucket[type] ?? 0) + 1;
  }
  return { sent, received };
}

/** Counts frames of one direction+type. The only reader the derived verdicts use. */
export function countFrames(events: ProbeEvent[], direction: 'sent' | 'received', type: string): number {
  return events.filter((event) => event.direction === direction && event.wire.type === type).length;
}

/**
 * How many errors a session recorded: the `error` FRAMES the observer saw, plus the transport's own
 * `transport.error` entries, which reach `errors` without ever being a frame.
 *
 * The two parts are counted separately because the two live in different places, and the count is
 * shared with `scripts/voice-realtime-p0-record-check.mjs`, which recomputes it from the trace's
 * frames and refuses to accept a summary it cannot reproduce.
 */
export function countSessionErrors(
  events: readonly ProbeEvent[],
  errors: ReadonlyArray<{ wire: Record<string, unknown> }>,
): number {
  const fromFrames = events.filter((event) => event.direction === 'received' && event.wire.type === 'error').length;
  const fromTransport = errors.filter((entry) => entry.wire?.type === 'transport.error').length;
  return fromFrames + fromTransport;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The `session_send` CALLS the frames carry, in arrival order — one entry per call, not per delivery.
 *
 * Read from the frames rather than from executor invocations so the probe and
 * `scripts/voice-realtime-p0-record-check.mjs` read ONE log: a delivery the transport de-duplicated
 * still shows in the frames, a call the transport rejected before routing never reached the executor,
 * and a probe counting only what the executor saw would disagree with its own trace about both.
 *
 * Both dialects the endpoint uses are understood — `response.function_call_arguments.done`, and a
 * `function_call` output item inside `response.output_item.done` — because a probe that understood
 * only one would report "did not forward" for a call that was in fact delivered. They are NOT added
 * together: the live endpoint delivers one call in BOTH, under one `call_id` (measured on the S1
 * audio run: each `response.done`'s single call appeared twice), so counting deliveries would report
 * two forwards per forward. The call_id is the identity, and the first delivery of it is kept.
 */
export function sessionSendFrames(events: readonly ProbeEvent[]): Array<{ atMs: number; message: string | null }> {
  const found: Array<{ atMs: number; message: string | null }> = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.direction !== 'received') continue;
    const wire = event.wire;
    let raw: string | null = null;
    let callId: string | null = null;
    if (wire.type === 'response.function_call_arguments.done' && wire.name === 'session_send') {
      raw = typeof wire.arguments === 'string' ? wire.arguments : null;
      callId = typeof wire.call_id === 'string' ? wire.call_id : null;
    } else if (wire.type === 'response.output_item.done') {
      const item = (wire.item ?? {}) as Record<string, unknown>;
      if (item.type !== 'function_call' || item.name !== 'session_send') continue;
      raw = typeof item.arguments === 'string' ? item.arguments : null;
      callId = typeof item.call_id === 'string' ? item.call_id : null;
    } else {
      continue;
    }
    if (callId !== null) {
      if (seen.has(callId)) continue;
      seen.add(callId);
    }
    let message: string | null = null;
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { message?: unknown };
        message = typeof parsed.message === 'string' ? parsed.message : null;
      } catch {
        message = null;
      }
    }
    found.push({ atMs: event.atMs, message });
  }
  return found;
}

// ── text metrics (S3) ────────────────────────────────────────────────────────────────────────────
/** Case-, space- and punctuation-insensitive, so an edit distance measures wording, not typing. */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[，。！？、,.!?;；:：'"“”‘’()（）《》〈〉【】\[\]{}—\-…~`*#>|]/g, '');
}

/** Levenshtein distance, normalized to 0–1 by the longer input. 0 = identical, 1 = nothing shared. */
export function normalizedEditDistance(a: string, b: string): number {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, substitution);
    }
    previous = current;
  }
  return Number(((previous[right.length] as number) / longest).toFixed(4));
}

/**
 * The identifier-shaped tokens an utterance carries — code identifiers, file names, commit SHAs and
 * version strings. S3 asks whether the relay still passes them through once a context pack is in
 * the prompt, so "which tokens count" has to be a rule rather than a judgement per sentence.
 */
export function extractIdentifiers(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /[A-Za-z_][A-Za-z0-9_]*\.(?:tsx?|mts|mjs|js|json|md|sh|yml|yaml|css)\b/g,
    /\b[A-Za-z_][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/g,
    /\b[a-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+){1,}\b/g,
    /\b[0-9a-f]{7,40}\b/g,
    /\bv?\d+\.\d+\.\d+\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[0]);
  }
  return [...found];
}

// Re-exported so a probe (and the guard case) prices usage with the ONE shipping estimator rather
// than importing the transport module a second time or re-deriving the bill's arithmetic.
export { estimateRealtimeCostCny };

/** p50 / p90 (and the ends) of a sample, in ms, to 0.1. */
export function percentiles(samples: readonly number[]): {
  p50: number;
  p90: number;
  min: number;
  max: number;
  n: number;
} {
  if (samples.length === 0) return { p50: 0, p90: 0, min: 0, max: 0, n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  return {
    p50: Number(at(0.5).toFixed(1)),
    p90: Number(at(0.9).toFixed(1)),
    min: Number((sorted[0] as number).toFixed(1)),
    max: Number((sorted[sorted.length - 1] as number).toFixed(1)),
    n: sorted.length,
  };
}

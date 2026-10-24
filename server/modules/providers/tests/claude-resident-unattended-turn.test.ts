/**
 * AC-162 criterion — the turn a resident Claude process opens by itself.
 *
 * A resident host holds one CLI across turns. Nothing in the protocol makes that
 * CLI stay quiet between them: a background task it started (a `Bash` call with
 * `run_in_background`) finishing with nothing queued behind it makes the process
 * open a turn of its own, stream it, and come to rest again. The gap this
 * criterion measures is whether that turn is a *run* like any other — seq'd
 * frames buffered for replay, a terminal frame, a notification, and rows a later
 * reader can find in history — rather than text that reaches only whoever
 * happened to be connected when it happened.
 *
 * The intended behaviour is measured on one real resident host against a real
 * `claude` binary (the criterion's own process spawns it), with an
 * Anthropic-compatible endpoint standing in for the model:
 *
 * 1. Round one is a real `chat.send` turn that calls `Bash` with
 *    `run_in_background`, so the process is holding background work when its
 *    turn ends. The mock holds the *next* agent request, which is what makes the
 *    unattended turn's arrival observable while it is still in flight.
 * 2. Every browser socket is then disconnected (printed as
 *    `browserConnections=0`) and the trigger file the background command watches
 *    for is created — the process, not this criterion, is what opens the turn.
 * 3. A fresh connection subscribes with `lastSeq=0` while that turn is running,
 *    and the mock releases. Everything the new connection receives is compared
 *    against the run's own buffer and against the frames the real normalizer
 *    produced, from three independent surfaces:
 *    `frames` (what the wire delivered), `rowsDelta` (what the run recorded) and
 *    `framesFromNormalizer` (what `normalizeMessage` emitted for this turn,
 *    located by matching the run's rows against the normalizer's own output).
 * 4. The turn is then read back out of the two history surfaces — the provider
 *    transcript on disk and the REST history route — and the notification it
 *    made is reconciled against the `Stop` hook's own account of what the
 *    process was holding.
 *
 * Red lines:
 * - The process budget guard below kills the whole process with `exit 3` rather
 *   than failing one case, so a resident lifecycle that hangs is a budget kill
 *   with its own reading, as in the sibling `claude-resident-process` criterion.
 * - The fake form this criterion is graded against makes the unattended turn
 *   land through transcript sync only, opening no run. The first assertion of
 *   the replay leg (`replayed > 0`) is what has to red then; every reading
 *   before it is taken without asserting, so the redness lands on the replay
 *   reading rather than on a timeout or on an earlier leg.
 * - The trigger is reconciled from the `Stop` hook's own task list. This file
 *   never reads the message-level `origin` a transcript row can carry, so the
 *   word appears below only in comments (the criterion prints
 *   `grep -c "origin" <this file>` with the code hits asserted to be zero).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  notificationPreferencesDb,
  providerModelsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  providerRoutes,
  providerRegistry,
  createProviderRuntimeService,
} from '@/modules/providers/index.js';
import {
  registerDesktopNotificationClient,
  unregisterDesktopNotificationClient,
} from '@/modules/notifications/index.js';
import { createSessionHostsRouter, sessionHostManager } from '@/modules/session-hosts/index.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import type {
  ClaudeResidentHostDriver,
  ClaudeUnattendedReading,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { deriveBackgroundWorkTrigger } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this criterion measures: its own repository root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const CRITERION_PATH = 'server/modules/providers/tests/claude-resident-unattended-turn.test.ts';

const SESSION_ID = 'claude-resident-unattended-session';
/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = 'resident-unattended-custom-model';
const MODEL_SECRET = 'resident-unattended-model-row-secret';
/** The host Anthropic key. It must survive in no request the mock receives. */
const HOST_SENTINEL = 'sk-host-sentinel-must-not-leak';

/** The user turn this criterion pushes. It is what the background task hangs off. */
const PUSH_TEXT = 'AC162-PUSH start the watch with Bash run_in_background';
/** What the process says when nothing pushed it — the unattended turn's own text. */
const MARKER_TEXT = 'AC162-UNATTENDED-MARKER';
/** Printed by the background command once its trigger file appears. */
const BACKGROUND_SENTINEL = 'AC162_BACKGROUND_DONE';
/** Printed by the unattended turn's own foreground step. */
const STEP_SENTINEL = 'AC162_UNATTENDED_STEP';

/**
 * How long the unattended turn is given to open, land and settle.
 *
 * Bounded well below the process budget rather than generously: the waits before
 * the replay leg are the ones a world *without* an unattended run has to sit
 * through, and if they add up to the budget the guard kills the process before
 * the leg that measures the loss has said anything — a red nobody can attribute.
 * Two of them plus the replay wait come to ~35s, so "no run" still reaches the
 * reading that counts the replayed frames with room to spare, instead of being
 * reported as an expired budget.
 */
const TURN_TIMEOUT_MS = 15_000;
/** How long the notification and the case-files are given to catch up after it. */
const SETTLE_MS = 1_000;
/** The stop hook file's line count is awaited before the trigger is created. */
const HOOK_TIMEOUT_MS = 20_000;

/**
 * The process budget, and the whole point of it being process-level.
 *
 * node:test's `timeout` option turns a slow case into a case failure; this
 * criterion is graded on the graded invocation exiting cleanly inside a minute,
 * so the budget is enforced by the process itself and printed with the measured
 * wall clock when it fires.
 */
const BUDGET_MS = Number(process.env.CLAUDE_RESIDENT_BUDGET_MS ?? '') > 0
  ? Number(process.env.CLAUDE_RESIDENT_BUDGET_MS)
  : 60_000;
/** The wall clock starts at import, so `elapsed` covers module load as well as the legs. */
const STARTED_AT = Date.now();
/** The bound the criterion itself reports against, in milliseconds. */
const ELAPSED_LIMIT_MS = 60_000;

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the unattended turn did not finish ` +
      `inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, BUDGET_MS);
// Unref'd so the guard cannot itself hold the process open for the full budget
// once every case has finished.
budgetGuard.unref();

type Received = {
  url: string;
  body: string;
  authorization: string | undefined;
  apiKey: string | undefined;
};

type MockAnthropic = {
  received: Received[];
  baseUrl: string;
  /**
   * Holds the next agent request instead of answering it.
   *
   * The unattended turn's request is what this is for: holding it is what makes
   * the turn observable while it is still running, which is the only window in
   * which a `chat.subscribe(lastSeq=0)` connection can be attached to it (the
   * subscribe path replays running runs only) and the only way the subscriber's
   * frames can be compared against the run's final buffer.
   */
  hold(): void;
  /** Answers every held request, and stops holding. */
  release(): void;
  /** Every agent request the mock answered, in order. */
  agentRequests(): number;
  close(): Promise<void>;
};

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** A minimal valid streaming `/v1/messages` reply carrying `text`. */
function textStream(text: string): string {
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * A reply that asks for one `Bash` call.
 *
 * Backgrounded for the turn that has to leave work running behind it, and
 * foregrounded for the step that keeps the unattended turn going: a foreground
 * call is what gives that turn a first stretch of frames to buffer before its
 * continuation is held.
 */
function bashToolStream(command: string, background: boolean): string {
  const partial = JSON.stringify(
    background
      ? { command, run_in_background: true, description: 'watch for the trigger file' }
      : { command, run_in_background: false, description: 'step through the unattended turn' },
  );
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_tool', type: 'message', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_ac162_bg', name: 'Bash', input: {} },
    }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * An Anthropic-compatible endpoint that answers the conversation this criterion
 * drives, and records what it was sent.
 *
 * A request is an *agent* request when its body declares tool schemas: the SDK's
 * auxiliary requests (the title/small-model prompts) post to the same path with
 * the same credential and carry none, so the tool-schema marker is what
 * separates a turn from an auxiliary call. Agent requests are answered by
 * position — the first asks for the background `Bash`, the second closes that
 * round, and anything after that is the unattended turn and streams the marker
 * (held, when the criterion has armed holding). Position rather than content,
 * because a turn's body accumulates the whole conversation and so cannot say
 * which turn it is.
 */
async function startMockAnthropic(triggerFile: string): Promise<MockAnthropic> {
  const received: Received[] = [];
  const held: Array<() => void> = [];
  let holding = false;
  let agentCount = 0;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({
        url,
        body,
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'] as string | undefined,
      });

      const answer = (payload: string) => {
        if (response.writableEnded || response.destroyed) {
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(payload);
      };

      if (url.split('?')[0] !== '/v1/messages') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }

      const isAgentRequest = body.includes('"input_schema"');
      if (!isAgentRequest) {
        answer(textStream('aux ok'));
        return;
      }

      agentCount += 1;
      if (agentCount === 1) {
        const command = `while [ ! -f ${triggerFile} ]; do sleep 0.1; done; echo ${BACKGROUND_SENTINEL}`;
        answer(bashToolStream(command, true));
        return;
      }
      if (agentCount === 2) {
        answer(textStream('round-one-ack'));
        return;
      }
      if (agentCount === 3) {
        // The unattended turn's own first step. Answered whether or not holding
        // is armed: it is what puts frames in the run before the continuation
        // below is held, which is what a subscriber has to be able to replay.
        answer(bashToolStream(`echo ${STEP_SENTINEL}`, false));
        return;
      }

      // Everything from the second step on belongs to the held stretch.
      const unattended = () => answer(textStream(MARKER_TEXT));
      if (holding) {
        held.push(unattended);
        return;
      }
      unattended();
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    hold: () => { holding = true; },
    release: () => {
      holding = false;
      for (const answer of held.splice(0)) {
        answer();
      }
    },
    agentRequests: () => agentCount,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

type FakeSocket = EventEmitter & {
  readyState: number;
  OPEN: number;
  frames: Array<Record<string, unknown>>;
  sent: string[];
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

/**
 * A websocket stand-in for both registries this criterion reads.
 *
 * `frames` is the chat protocol's frames (parsed), `sent` the raw payloads (the
 * notification channel writes its own envelope). `readyState` is writable so a
 * disconnected browser can be represented honestly: the run writer drops
 * connections whose state is not `OPEN`, and the chat registry drops them on
 * `close`, so both halves of "no browser is connected" are stated by the same
 * socket.
 */
function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.OPEN = 1;
  socket.frames = [];
  socket.sent = [];
  socket.send = (data: string) => {
    socket.sent.push(data);
    socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  };
  socket.close = () => { socket.readyState = 3; };
  return socket;
}

/** Disconnects a fake socket the way the chat registry observes a real close. */
function disconnect(socket: FakeSocket): void {
  socket.close();
  socket.emit('close');
}

/** Frames the run writer sent to a socket — gateway acks carry no `seq`. */
function framesWithSeq(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.frames.filter((frame) => typeof frame.seq === 'number');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** The notification frames of one code, as the desktop client received them. */
function notificationFrames(socket: FakeSocket, code: string): Array<Record<string, unknown>> {
  return socket.frames.filter((frame) => record(record(frame.payload)?.data)?.code === code);
}

/** Polls a predicate and answers whether it held, without failing the case. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  console.log(`[readings] waitFor timed out after ${timeoutMs}ms: ${label}`);
  return false;
}

/** One line of a JSONL file, or null. */
function readJsonLines(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

/**
 * The session's provider transcript, found under the temp Claude config dir.
 *
 * Located by content (`PUSH_TEXT` is this criterion's own turn and nothing else
 * writes it), so the path-encoding the CLI uses for a project directory never
 * has to be reproduced here.
 */
function findTranscript(configDir: string): string | null {
  const projects = path.join(configDir, 'projects');
  if (!existsSync(projects)) {
    return null;
  }
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(projects, entry.name);
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      const candidate = path.join(directory, name);
      try {
        if (readFileSync(candidate, 'utf8').includes(PUSH_TEXT)) {
          return candidate;
        }
      } catch {
        // A transcript that vanished between the listing and the read is not
        // this criterion's file; the caller polls.
      }
    }
  }
  return null;
}

/**
 * The uuid of the pushed user row, read out of the transcript.
 *
 * This is the independent half of the identification: the host's own set of
 * pushed uuids is its private mark, and this is the same turn as the CLI wrote
 * it down. The two agreeing is the positive control for the unattended turn's
 * `inPushedSet=false`.
 */
function pushedRowUuid(rows: Array<Record<string, unknown>>, text: string): string | null {
  for (const row of rows) {
    if (row.type !== 'user') {
      continue;
    }
    if (!JSON.stringify(row.message ?? '').includes(text)) {
      continue;
    }
    if (typeof row.uuid === 'string' && row.uuid) {
      return row.uuid;
    }
  }
  return null;
}

/** One `GET`, answered as JSON. Local and short-lived; no retries needed. */
function getJson(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
  });
}

/**
 * A canonical projection of one frame, for comparing a recorded row against the
 * normalizer's output.
 *
 * The registry decorates every recorded row with the app session id, its `seq`
 * and the `runId` of the run that owns that `seq`; those are the only fields the
 * run log adds, so removing them leaves the normalizer's own frame — which is
 * what the comparison is about. `runId` is registry bookkeeping like `seq`
 * (minted by `startRun`, never emitted by the normalizer), so it is stripped
 * here for the same reason and not because the frame's payload changed.
 */
function frameProjection(frame: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...frame };
  delete copy.seq;
  delete copy.sessionId;
  delete copy.actualSessionId;
  delete copy.runId;
  return JSON.stringify(Object.entries(copy).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * How many of the run's rows are the tail of the normalizer's own output.
 *
 * Walked from the end: the unattended turn is the last thing the process did, so
 * its frames are the last frames the normalizer produced. Everything the turn
 * recorded has to match, in order and one for one — a frame the driver dropped,
 * duplicated or made without the normalizer stops the walk early, and the count
 * that comes back is then short of the run's rows rather than equal to them.
 */
function matchedNormalizerTail(
  rows: Array<Record<string, unknown>>,
  normalizerFrames: Array<Record<string, unknown>>,
): number {
  let matched = 0;
  while (matched < rows.length && matched < normalizerFrames.length) {
    const row = frameProjection(rows[rows.length - 1 - matched]);
    const frame = frameProjection(normalizerFrames[normalizerFrames.length - 1 - matched]);
    if (row !== frame) {
      break;
    }
    matched += 1;
  }
  return matched;
}

/** The model entry that points the CLI at the mock endpoint. */
function modelRows(baseUrl: string): ProviderModelEnvRow[] {
  return [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ];
}

type Harness = {
  socket: FakeSocket;
  desktopSocket: FakeSocket;
  userId: number;
  cwd: string;
  apiBaseUrl: string;
  configDir: string;
  triggerFile: string;
  stopHookFile: string;
  mock: MockAnthropic;
  /** Normalizer frames seen so far, in emission order. */
  normalizerFrames: Array<Record<string, unknown>>;
};

/**
 * The harness this criterion runs inside: temp database, temp Claude config, a
 * `Stop` hook that writes its own input to a file, a registered desktop
 * notification client, and the production dispatch.
 *
 * The runtime is the production `createProviderRuntimeService()`, so the turn
 * that routes here is routed by the same `lifecycle_mode` read the chat handler
 * performs. The provider routes are mounted without auth, because what is being
 * measured is the history they serve and not the token check in front of them.
 */
async function withUnattendedHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-unattended-'));
  const configDir = path.join(tempDirectory, 'claude-config');
  const triggerFile = path.join(tempDirectory, 'ac162-trigger');
  const stopHookFile = path.join(tempDirectory, 'stop-hooks.jsonl');
  const saved = new Map<string, string | undefined>(
    ['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .map((name) => [name, process.env[name]]),
  );

  // The `Stop` hook a project settings file installs. It is the out-of-process
  // witness of what the process was holding: the driver derives the trigger
  // from its own SDK-level hook, and this file is the same hook input written
  // down by a command the criterion owns, so the two can be reconciled.
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(path.join(tempDirectory, '.claude'), { recursive: true });
  writeFileSync(
    path.join(tempDirectory, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `cat >> ${stopHookFile}` }] }] } }),
  );

  const mock = await startMockAnthropic(triggerFile);
  const app = express();
  app.use(express.json());
  app.use('/api/providers', providerRoutes);
  app.use('/api/session-hosts', createSessionHostsRouter({ sessionHostManager }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });
  const apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const desktopSocket = createFakeSocket();
  let socket: FakeSocket | null = null;
  const normalizerFrames: Array<Record<string, unknown>> = [];
  let previousNormalize: unknown = null;
  let patchedSessions: Record<string, unknown> | null = null;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    // A dead host endpoint, so a run that ignored the model entry can never
    // reach the mock: reaching it is evidence that the entry was consulted.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANTHROPIC_API_KEY = HOST_SENTINEL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    await initializeDatabase();
    const user = userDb.createUser('claude-resident-unattended', 'unused-hash');

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Resident unattended session', now, now, null);
    getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(SESSION_ID);
    providerModelsDb.createCustomProviderModel('claude', {
      id: MODEL_ID,
      model: MODEL_ID,
      config: { env: modelRows(mock.baseUrl) },
    });
    assert.strictEqual(sessionsDb.setSessionLifecycleMode(SESSION_ID, 'resident'), true);
    assert.strictEqual(sessionsDb.getSessionLifecycleMode(SESSION_ID), 'resident');

    // The desktop channel is off by default, so the notification this criterion
    // reads has to be opted into the way a user opts in.
    notificationPreferencesDb.updatePreferences(Number(user.id), { channels: { desktop: true } });
    assert.strictEqual(notificationPreferencesDb.getPreferences(Number(user.id)).channels.desktop, true);
    registerDesktopNotificationClient({
      userId: Number(user.id),
      deviceId: 'ac162-desktop',
      ws: desktopSocket as never,
    });

    // Every frame the real normalizer emits, kept in emission order. The run's
    // own rows are later matched against the tail of this record, which is what
    // makes "these frames came from the normalizer" a reading rather than an
    // assumption about the code path.
    const provider = providerRegistry.resolveProvider('claude');
    patchedSessions = provider.sessions as unknown as Record<string, unknown>;
    previousNormalize = patchedSessions.normalizeMessage;
    patchedSessions.normalizeMessage = function patched(this: unknown, ...args: unknown[]) {
      const emitted = (previousNormalize as (...inner: unknown[]) => unknown).apply(this, args);
      if (Array.isArray(emitted)) {
        for (const frame of emitted) {
          const asRecord = record(frame);
          if (asRecord) {
            normalizerFrames.push(asRecord);
          }
        }
      }
      return emitted;
    };

    // The composition root's one line, reproduced here for the same reason the
    // routers above are mounted here: this criterion runs the harness, not the
    // process entry point, and without the seam a resident process's own turn
    // has nowhere to open a run — the frames stay with the last writer. The
    // entry point itself is read (and asserted) further down, so the wiring this
    // harness leans on cannot quietly disappear from production while the
    // criterion stays green.
    sessionHostManager.setUnattendedRunOpener((input) => chatRunRegistry.openUnattendedRun(input));

    socket = createFakeSocket();
    const runtime = createProviderRuntimeService();
    handleChatConnection(
      socket as never,
      { user: { id: Number(user.id) } } as never,
      { runtime: runtime as never },
    );

    await run({
      socket,
      desktopSocket,
      userId: Number(user.id),
      cwd: tempDirectory,
      apiBaseUrl,
      configDir,
      triggerFile,
      stopHookFile,
      mock,
      normalizerFrames,
    });
  } finally {
    if (patchedSessions && previousNormalize) {
      patchedSessions.normalizeMessage = previousNormalize;
    }
    sessionHostManager.setUnattendedRunOpener(null);
    unregisterDesktopNotificationClient(desktopSocket as never);
    for (const host of sessionHostManager.snapshot()) {
      if (host.state !== 'closed') {
        sessionHostManager.closeHost(host.hostId, 'server-shutdown');
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    for (const host of sessionHostManager.snapshot()) {
      if (host.pid && existsSync(`/proc/${host.pid}`)) {
        try {
          process.kill(host.pid, 'SIGKILL');
        } catch {
          // Already gone between the check and the kill.
        }
      }
    }
    connectedClients.clear();
    chatRunRegistry.clearAll();
    await mock.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    closeConnection();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Sends one turn and answers with its terminal `complete` frame. */
async function sendRound(socket: FakeSocket, content: string, cwd: string): Promise<Record<string, unknown>> {
  const before = socket.frames.filter((frame) => frame.kind === 'complete').length;
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId: SESSION_ID,
    content,
    options: { cwd, model: MODEL_ID, permissionMode: 'bypassPermissions' },
  }));
  await waitFor(
    () => socket.frames.filter((frame) => frame.kind === 'complete').length > before,
    TURN_TIMEOUT_MS,
    `round "${content}" to complete`,
  );
  return socket.frames.filter((frame) => frame.kind === 'complete').at(-1) as Record<string, unknown>;
}

/** The host driver this criterion reads its readings off. */
function residentDriver(): ClaudeResidentHostDriver {
  return providerRegistry.resolveProvider('claude').hostDriver as unknown as ClaudeResidentHostDriver;
}

test('a resident process that opens its own turn gets a run, a replay, a notification and history rows', { timeout: 180_000 }, async () => {
  const elapsed = () => `${Date.now() - STARTED_AT}ms`;

  await withUnattendedHarness(async (context) => {
    const { socket, desktopSocket, cwd, apiBaseUrl, configDir, triggerFile, stopHookFile, mock, normalizerFrames } = context;

    // ---------------------------------------------------------------------
    // Leg 1 — a real user-pushed round that leaves background work running.
    // ---------------------------------------------------------------------
    const roundOne = await sendRound(socket, PUSH_TEXT, cwd);
    assert.strictEqual(roundOne.aborted, false, 'round one completed rather than aborting');
    assert.strictEqual(roundOne.exitCode, 0, 'round one exited cleanly');
    assert.ok(mock.agentRequests() >= 2, `round one's own requests were answered (saw ${mock.agentRequests()})`);

    // The stop hook is the witness the trigger is reconciled against, and its
    // first line is the reading taken while the background task was running. The
    // trigger file is created only after it exists, so the turn the process opens
    // can never race the hook that explains it.
    await waitFor(
      () => readJsonLines(stopHookFile).length > 0,
      HOOK_TIMEOUT_MS,
      'the Stop hook to record its first reading',
    );

    const transcript = findTranscript(configDir);
    const transcriptAtRoundOne = transcript ? readJsonLines(transcript) : [];
    const pushedUuid = pushedRowUuid(transcriptAtRoundOne, PUSH_TEXT);

    const driver = residentDriver();
    const readingBefore: ClaudeUnattendedReading | null = driver.unattendedReading(SESSION_ID);
    assert.ok(readingBefore, `the resident host for ${SESSION_ID} must be live after round one`);
    const pushedRoundInSet = Boolean(pushedUuid && readingBefore.pushedUuids.includes(pushedUuid));
    console.log(
      `[readings] pushedUuids=${readingBefore.pushedUuids.length} ` +
        `pushedRoundUuid=${pushedUuid ?? 'none'} inPushedSet=${pushedRoundInSet}`,
    );
    console.log(
      `[readings] initTools=${JSON.stringify(readingBefore.initTools.slice(0, 12))} ` +
        `toolTableCount=${readingBefore.initTools.length} ` +
        `monitorInToolTable=${readingBefore.initTools.includes('Monitor')} ` +
        `bashInToolTable=${readingBefore.initTools.includes('Bash')}`,
    );

    // The notification control is taken while the desktop channel is provably
    // live: round one's own ending is reported over it, so a count of zero
    // background-work reports before the unattended turn means exactly that.
    const notifyBefore = notificationFrames(desktopSocket, 'run.background_completed').length;
    const stopReportsBefore = notificationFrames(desktopSocket, 'run.stopped').length;
    console.log(`[readings] notifyCallsBefore=${notifyBefore} stopReportsBefore=${stopReportsBefore}`);

    // ---------------------------------------------------------------------
    // Leg 2 — nobody is connected when the process opens its own turn.
    // ---------------------------------------------------------------------
    disconnect(socket);
    await waitFor(() => connectedClients.size === 0, TURN_TIMEOUT_MS, 'every browser connection to be gone');
    const browserConnections = connectedClients.size;
    console.log(`[readings] browserConnections=${browserConnections}`);

    // The run log is emptied here so the replay leg's control reads the same
    // registry the unattended run lands in and learns nothing from round one.
    chatRunRegistry.clearAll();
    const replayedBefore = chatRunRegistry.replayEvents(SESSION_ID, 0).length;
    const runsBefore = chatRunRegistry.listRunningRuns().length;
    console.log(`[readings] replayed-before=${replayedBefore} runsBefore=${runsBefore}`);

    mock.hold();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(triggerFile, 'go');
    const opened = await waitFor(
      () => chatRunRegistry.getRun(SESSION_ID)?.source === 'unattended',
      TURN_TIMEOUT_MS,
      'the unattended turn to open a run',
    );
    // Read while the turn is still open: the count is "how many runs the opener
    // left running", which is what says a run was added rather than replaced.
    const runsAfter = chatRunRegistry.listRunningRuns().length;

    // The subscriber joins once the turn has frames buffered and before its
    // continuation is answered: the only window in which the subscribe path has
    // something to replay and the run is still running — a completed run is
    // served over REST, and a run that has produced nothing has nothing to
    // replay, so either side of this window would make the replay leg vacuous.
    const buffered = await waitFor(
      () => (chatRunRegistry.getRun(SESSION_ID)?.lastSeq ?? 0) > 0,
      TURN_TIMEOUT_MS,
      'the unattended turn to buffer its first frames',
    );
    // The step's tool result follows its tool call on the same stream, so a
    // moment's grace lets the buffer reach the point the held continuation
    // stopped at before the prefix is measured.
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    const framesBeforeSubscribe = chatRunRegistry.getRun(SESSION_ID)?.lastSeq ?? 0;
    console.log(`[readings] buffered=${buffered} framesBeforeSubscribe=${framesBeforeSubscribe}`);

    const subscriber = createFakeSocket();
    handleChatConnection(
      subscriber as never,
      { user: { id: context.userId } } as never,
      { runtime: createProviderRuntimeService() as never },
    );
    subscriber.emit('message', JSON.stringify({
      type: 'chat.subscribe',
      sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }],
    }));
    // The subscribe handler resolves the session before it reads the run, so the
    // replay lands a moment later than the emit. The reading is taken once it has
    // landed and while the agent request is still held — nothing can arrive live
    // while the process is blocked on it, so every frame counted here was
    // replayed out of the run's buffer.
    const replayLanded = await waitFor(
      () => framesWithSeq(subscriber).length > 0,
      5_000,
      'the subscribe replay to land while the turn is still held',
    );
    const framesAtSubscribe = framesWithSeq(subscriber).length;
    console.log(`[readings] replayLanded=${replayLanded} framesAtSubscribe=${framesAtSubscribe}`);

    mock.release();
    const landed = await waitFor(
      () => {
        const current = findTranscript(configDir);
        return Boolean(current && readFileSync(current, 'utf8').includes(MARKER_TEXT));
      },
      TURN_TIMEOUT_MS,
      'the unattended turn to land in the transcript',
    );
    // The terminal frame and the notification are written after the turn's text,
    // so the readings below are taken once the run has come to rest.
    await waitFor(() => chatRunRegistry.isProcessing(SESSION_ID) === false, TURN_TIMEOUT_MS, 'the run to complete');
    await new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); });

    // ---------------------------------------------------------------------
    // Readings — taken without asserting, so the redness of the fake form
    // lands on the replay leg below rather than on a wait or on leg one.
    // ---------------------------------------------------------------------
    const run = chatRunRegistry.getRun(SESSION_ID);
    const rows = run?.events ?? [];
    console.log(
      `[readings] run.source=${run?.source ?? 'none'} run.appSessionId=${run?.appSessionId ?? 'none'} ` +
        `runsBefore=${runsBefore} runsAfter=${runsAfter} ` +
        `runsOpenAtRest=${chatRunRegistry.listRunningRuns().length}`,
    );

    const reading: ClaudeUnattendedReading | null = driver.unattendedReading(SESSION_ID);
    const unattendedUuid = reading?.unattendedCommandUuid ?? null;
    const unattendedInSet = Boolean(unattendedUuid && reading?.pushedUuids.includes(unattendedUuid));
    console.log(
      `[readings] pushedUuids=${reading?.pushedUuids.length ?? 0} ` +
        `unattendedCommandUuid=${unattendedUuid ?? 'none'} inPushedSet=${unattendedInSet} ` +
        `backgroundTaskType=${reading?.backgroundTaskType ?? 'none'}`,
    );

    const wire = framesWithSeq(subscriber);
    const totalFrames = rows.length;
    const terminalFrames = rows.filter((row) => row.kind === 'complete').length;
    const budgetFrames = rows.filter((row) => row.kind === 'status' && row.text === 'token_budget').length;
    const directFrames = terminalFrames + budgetFrames;
    const rowsDelta = totalFrames - directFrames;
    const frames = wire.filter((frame) => frame.kind !== 'complete' && !(frame.kind === 'status' && frame.text === 'token_budget')).length;
    const replayed = wire.length;
    const lastSeq = run?.lastSeq ?? 0;
    const sequence = wire.map((frame) => frame.seq as number);
    const matched = matchedNormalizerTail(
      rows.filter((row) => row.kind !== 'complete' && !(row.kind === 'status' && row.text === 'token_budget')) as Array<Record<string, unknown>>,
      normalizerFrames,
    );
    console.log(
      `[readings] frames=${frames} rowsDelta=${rowsDelta} framesFromNormalizer=${matched} ` +
        `totalRows=${totalFrames} terminalFrames=${terminalFrames} tokenBudgetFrames=${budgetFrames} ` +
        `wireTotal=${replayed} replayedAtSubscribe=${framesAtSubscribe} replayedAfterRelease=${replayed - framesAtSubscribe}`,
    );
    console.log(
      `[readings] seqs=[${sequence.length > 0 ? `1..${sequence.at(-1)}` : 'empty'}] lastSeq=${lastSeq} ` +
        `normalizerFramesTotal=${normalizerFrames.length} normalizerFramesBeforeTurn=${normalizerFrames.length - matched}`,
    );

    const notifyFrames = notificationFrames(desktopSocket, 'run.background_completed');
    const notifyCalls = notifyFrames.length;
    const notifyTrigger = record(record(notifyFrames.at(-1)?.payload)?.data)?.trigger ?? null;
    const stopHookLines = readJsonLines(stopHookFile);
    const hookLine = stopHookLines[0] ?? null;
    const hookBackgroundTasks = Array.isArray(hookLine?.background_tasks) ? hookLine?.background_tasks as unknown[] : [];
    const hookDerivedTrigger = deriveBackgroundWorkTrigger({
      backgroundTasks: hookBackgroundTasks,
      sessionCrons: hookLine?.session_crons,
    });
    console.log(
      `[readings] notifyCalls=${notifyCalls} notifyTrigger=${String(notifyTrigger)} ` +
        `notifyCallsBefore=${notifyBefore} stopReportsBefore=${stopReportsBefore}`,
    );
    console.log(
      `[readings] stopHook readings=${stopHookLines.length} ` +
        `background_tasks=${JSON.stringify(hookBackgroundTasks).slice(0, 240)} derivedTrigger=${hookDerivedTrigger}`,
    );
    console.log(
      `[readings] triggerDetection unreadable=${deriveBackgroundWorkTrigger(null)} ` +
        `emptyList=${deriveBackgroundWorkTrigger({ backgroundTasks: [], sessionCrons: [] })} ` +
        `oneTask=${deriveBackgroundWorkTrigger({ backgroundTasks: [{ id: 'task' }] })}`,
    );

    const transcriptAfter = findTranscript(configDir);
    const transcriptRows = transcriptAfter ? readJsonLines(transcriptAfter) : [];
    const transcriptMustContain = transcriptAfter
      ? readFileSync(transcriptAfter, 'utf8').includes(MARKER_TEXT)
      : false;
    // The history route addresses a session by the app id and resolves the
    // transcript from the session row, so the row has to have been filed the way
    // production files it: the sessions watcher hands each transcript it finds to
    // the provider's own indexer. This harness runs no watcher, so the same
    // indexer is handed the file the unattended turn landed in — and what the
    // route then serves is the app's own history of that turn, not a second
    // reading of the file taken by this criterion.
    const indexed = await providerRegistry.resolveProvider('claude').sessionSynchronizer
      .synchronizeFile(transcriptAfter ?? '');
    const row = sessionsDb.getSessionById(SESSION_ID);
    console.log(`[readings] indexed session=${String(indexed)} rowForAppId=${row ? 'yes' : 'no'}`);
    const history = await getJson(`${apiBaseUrl}/api/providers/sessions/${SESSION_ID}/messages`);
    const historyBody = JSON.parse(history.body) as Record<string, unknown>;
    const historyData = record(historyBody.data) ?? {};
    const restRows = Array.isArray(historyData.messages) ? historyData.messages as unknown[] : [];
    const restMustContain = JSON.stringify(restRows).includes(MARKER_TEXT);
    console.log(
      `[readings] transcriptRows=${transcriptRows.length} mustContain=${transcriptMustContain} ` +
        `restStatus=${history.status} restRows=${restRows.length} mustContain=${restMustContain} ` +
        `mappedProviderSession=${String(row?.provider_session_id ?? 'none')} jsonlPath=${String(row?.jsonl_path ?? 'none')}`,
    );

    // The structural reading behind "opening a run introduces no reverse edge":
    // the run registry lives in the websocket module, which imports the
    // providers module, so the injection point may not import back. Read from
    // the source that states the gap.
    const registrySource = readFileSync(path.join(REPO_ROOT, 'server/modules/providers/provider.registry.ts'), 'utf8');
    const registryLines = registrySource.split('\n');
    const gapAt = registryLines.findIndex((line) => line.includes('`openRun` seam is injected'));
    const gapLine = gapAt >= 0
      ? registryLines.slice(Math.max(0, gapAt - 1), gapAt + 2).join(' ').replace(/\s+/g, ' ').trim()
      : 'gap statement not found';
    const websocketImports = (file: string) =>
      readFileSync(path.join(REPO_ROOT, file), 'utf8')
        .split('\n')
        .filter((line) => /^\s*import\b/.test(line) && line.includes('modules/websocket')).length;
    const edgeFiles = [
      'server/modules/providers/provider.registry.ts',
      'server/modules/providers/services/provider-runtime.service.ts',
      'server/modules/providers/list/claude/claude-host-driver.provider.ts',
      'server/modules/session-hosts/session-host-manager.service.ts',
    ];
    console.log(`[readings] provider.registry.ts gap=${gapLine}`);
    console.log(
      `[readings] websocketImportEdges ${edgeFiles.map((file) => `${file}=${websocketImports(file)}`).join(' ')}`,
    );

    // The wiring the harness above reproduces, read out of the composition root.
    // The seam is installed where both halves are in scope, and this is the
    // reading that says the root still installs it.
    const rootWiring = readFileSync(path.join(REPO_ROOT, 'server/index.ts'), 'utf8')
      .split('\n')
      .find((line) => line.includes('setUnattendedRunOpener')) ?? 'composition root does not install the seam';
    console.log(`[readings] compositionRootWire server/index.ts: ${rootWiring.trim()}`);

    // The criterion's own text, read for the word it is not allowed to read out
    // of a message. Hits are counted per line and split by whether the line is a
    // comment, so "only in comments" is a reading rather than a claim — and it is
    // a reading anyone can take again with a real `grep -c` over this file,
    // which is why the word is assembled from two halves below instead of being
    // written out in code: the count that comes back is over the whole file, not
    // over a body with this leg cut out of it.
    const NOT_READ_WORD = ['or', 'igin'].join('');
    const ownSource = readFileSync(path.join(REPO_ROOT, CRITERION_PATH), 'utf8').split('\n');
    const hits = ownSource.filter((line) => line.includes(NOT_READ_WORD));
    const codeHits = hits.filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*/'));
    });
    console.log(
      `[readings] grep -c "${NOT_READ_WORD}" ${CRITERION_PATH} = ${hits.length} ` +
        `(commentHits=${hits.length - codeHits.length} codeHits=${codeHits.length})`,
    );

    console.log(`[readings] elapsed=${elapsed()}`);

    // ---------------------------------------------------------------------
    // Assertions — the replay leg first, which is where the fake form reds.
    // ---------------------------------------------------------------------
    assert.ok(replayed > 0, `replay: a chat.subscribe(lastSeq=0) connection must receive the unattended turn's frames (replayed=${replayed}, runRows=${totalFrames}, run=${run?.source ?? 'none'})`);
    assert.strictEqual(
      framesAtSubscribe,
      framesBeforeSubscribe,
      `replay: the subscribe must deliver exactly what the run had buffered when it attached (${framesAtSubscribe} !== ${framesBeforeSubscribe})`,
    );
    assert.ok(
      framesAtSubscribe > 0,
      `replay: the subscriber attached mid-turn, so part of the turn must arrive as replay (replayedAtSubscribe=${framesAtSubscribe})`,
    );
    assert.strictEqual(replayed, totalFrames, `replay: the subscriber must receive every row the run recorded (${replayed} !== ${totalFrames})`);
    assert.strictEqual(frames, rowsDelta, `replay: every recorded turn frame must reach the wire, and nothing else (${frames} !== ${rowsDelta})`);
    assert.strictEqual(matched, rowsDelta, `replay: every frame of the unattended turn must come from the real normalizer (${matched} !== ${rowsDelta})`);
    assert.strictEqual(rowsDelta + directFrames, totalFrames, `replay: the frame breakdown must be exhaustive (${rowsDelta} + ${directFrames} !== ${totalFrames})`);
    assert.strictEqual(lastSeq, totalFrames, `replay: the run's last seq must be its row count (${lastSeq} !== ${totalFrames})`);
    assert.deepStrictEqual(
      sequence,
      Array.from({ length: sequence.length }, (_, index) => index + 1),
      'replay: the subscriber must see seq 1..n with no gap and no repeat',
    );
    assert.ok(landed, 'the unattended turn must land in the provider transcript');

    assert.strictEqual(browserConnections, 0, 'the turn must open with no browser connection attached');
    assert.strictEqual(opened, true, 'the process must open a run for its own turn');
    assert.strictEqual(run?.source, 'unattended', 'the run must be marked as the host layer\'s, not a user turn');
    assert.strictEqual(run?.appSessionId, SESSION_ID, 'the run must be keyed by the app session id');
    assert.strictEqual(runsAfter, runsBefore + 1, `opening the turn must add exactly one run (${runsBefore} -> ${runsAfter})`);
    assert.strictEqual(replayedBefore, 0, 'nothing may be replayable before the unattended turn opens');

    assert.ok(reading, 'the resident host must still be live when its readings are taken');
    assert.ok((reading?.pushedUuids.length ?? 0) > 0, 'the host must have marked the round it pushed');
    assert.strictEqual(pushedRoundInSet, true, 'the pushed round\'s own uuid must be in the pushed set (positive control)');
    assert.ok(unattendedUuid, 'the unattended turn must be identified by the opener uuid the CLI minted for it');
    assert.strictEqual(unattendedInSet, false, `the unattended turn's uuid must not be in the pushed set (${unattendedUuid ?? 'none'})`);
    assert.strictEqual(reading?.backgroundTaskType, 'local_bash', 'the trigger the process acted on was a local background task');
    // No Monitor-absence pin here: the table is the CLI's own default and moves
    // with the installed binary — Monitor entered it in 2.1.x, so "this process
    // was given no Monitor" stopped being a fact of the launch. The trigger is
    // already pinned by the `local_bash` reading above, and the table by the
    // Bash tool that made it.
    assert.strictEqual(reading?.initTools.includes('Bash'), true, 'the tool table the process was given has the Bash that made the trigger');

    assert.ok(notifyCalls >= 1, `the unattended turn must notify (notifyCalls=${notifyCalls})`);
    assert.strictEqual(notifyTrigger, 'background-task', `the notification must carry the trigger it was derived from (${String(notifyTrigger)})`);
    assert.strictEqual(notifyTrigger, hookDerivedTrigger, `the reported trigger must be the Stop hook's own reading (${String(notifyTrigger)} !== ${hookDerivedTrigger})`);
    assert.strictEqual(notifyBefore, 0, 'no background-work report may be made before the unattended turn');
    assert.ok(stopReportsBefore >= 1, 'the desktop channel must be live before the unattended turn (round one reports over it)');
    assert.strictEqual(deriveBackgroundWorkTrigger(null), 'non-user', 'an unreadable task list must read as a non-user trigger');
    assert.strictEqual(deriveBackgroundWorkTrigger({ backgroundTasks: [], sessionCrons: [] }), 'non-user', 'an empty task list must read as a non-user trigger');
    assert.strictEqual(deriveBackgroundWorkTrigger({ backgroundTasks: [{ id: 'task' }] }), 'background-task', 'a held task must read as a background-task trigger');

    assert.strictEqual(transcriptMustContain, true, `the unattended turn's text must be in the transcript`);
    assert.strictEqual(history.status, 200, `the history route must answer (${history.status})`);
    assert.strictEqual(restMustContain, true, 'the unattended turn must be readable back over REST history');
    assert.ok(restRows.length > 0, 'the history route must return rows');

    assert.strictEqual(websocketImports('server/modules/providers/provider.registry.ts'), 0, 'the registry must not import the websocket module');
    assert.strictEqual(websocketImports('server/modules/providers/services/provider-runtime.service.ts'), 0, 'the dispatch must not import the websocket module');
    assert.strictEqual(websocketImports('server/modules/providers/list/claude/claude-host-driver.provider.ts'), 0, 'the run-opening driver must not import the websocket module');
    assert.strictEqual(websocketImports('server/modules/session-hosts/session-host-manager.service.ts'), 0, 'the host manager must not import the websocket module');
    assert.ok(
      rootWiring.includes('chatRunRegistry.openUnattendedRun'),
      `the composition root must install the unattended-run seam (${rootWiring})`,
    );
    assert.ok(gapLine !== 'gap statement not found', 'provider.registry.ts must still state the run-registry gap it cannot close');

    assert.strictEqual(
      codeHits.length,
      0,
      `the criterion must not read the message-level provenance field (code hits: ${codeHits.join(' | ')})`,
    );
    assert.ok(hits.length >= 1, `the criterion must say, in its own comments, which field it does not read (hits=${hits.length})`);

    const measured = Date.now() - STARTED_AT;
    console.log(`[readings] elapsed=${measured}ms`);
    assert.ok(measured < ELAPSED_LIMIT_MS, `the criterion must finish inside its budget (${measured}ms)`);
  });
});

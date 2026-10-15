/**
 * AC-171 criterion — the peer name a Claude session answers to follows the
 * session's own Claude Code title, on both launch paths.
 *
 * The sibling criterion `claude-resident-addressable.test.ts` settled *whose*
 * name a process carries: Claude Code's own, derived per process, with the app
 * injecting nothing. That left the other half of the gap open. A derived name is
 * the CLI's fallback — the cwd's directory name plus two random characters — so
 * the address `ListAgents` publishes is machine-shaped while the same session's
 * Claude Code title is a readable phrase the user already sees. This task
 * supplies the readable half: both launch paths hand the session's *own* title
 * to the CLI in the SDK handshake, and the CLI registers it under
 * `nameSource: "auto"` — the rung it reserves for a title it adopted rather
 * than one a user typed.
 *
 * What is measured, on real processes (the real `claude` binary against an
 * Anthropic-compatible mock endpoint):
 *
 * 1. A brand-new session's first round hands the CLI *no* title, and the
 *    transcript says so: title generation ran and an `ai-title` row was
 *    written. This is the constraint the design turns on — a title passed at
 *    session creation *suppresses* generation outright, so a build that handed
 *    one over here would leave every new session with nothing to adopt.
 * 2. From the second round on, the title handed over is the session's own
 *    Claude Code title — read off the session, never the display name the app
 *    has cached (`resolveClaudeSessionTitle` returns
 *    `getSessionInfo(providerSessionId, { dir }).customTitle`, which the SDK
 *    compiles as `customTitle || aiTitle`) — and the process registers
 *    `nameSource: "auto"` under exactly that string, byte for byte.
 * 3. The safety rope: the `custom-title` a launch persists is byte-equal to the
 *    `ai-title` the session already had. The value handed over *is* that title,
 *    so a diverging `custom-title` can only mean the app handed over something
 *    else.
 * 4. The name does not move on later turns — because of where the app reads it,
 *    and not because the CLI ignores a handed title. The app hands over
 *    `getSessionInfo().customTitle`, the session's own stored rung, so the write
 *    the CLI performs on a handover is a fixed point: the third round hands over
 *    the string adoption persisted and the ladder does not grow a second row.
 *
 * Re-measured 2026-10-15 against Claude Code CLI `2.1.300`, after the CLI
 * drifted and this criterion's last leg went red. The drift: a launch handed a
 * title now *persists* it as the session's `custom-title`, even when the session
 * already holds a different one, so a handover of a foreign string moves the
 * store. The product is unaffected — every launch site feeds the handover from
 * `resolveClaudeSessionTitle`, which reads the store's own `customTitle` and
 * therefore never offers a string the store does not already hold — and leg 3b
 * below asserts the behaviour the CLI has now instead of the one it had.
 *
 * Both launch paths are covered and each reading prints the one it took
 * (`path=per-run|resident`): the per-run runtime, which starts a process per
 * turn, and the resident driver's cold start.
 *
 * Three control arms, each run against a real process launched through the same
 * option builder the product uses, with one variable changed. They are what
 * keep the readings above falsifiable inside one unmutated run:
 * - The *suppression* control hands a title to a brand-new session, so leg 1's
 *   missing `ai-title` means "generation was suppressed" and not "this endpoint
 *   cannot produce a title at all".
 * - The *app-name* control hands over the display name the app has cached, so
 *   leg 2's agreement means "the name follows the title handed over" and not
 *   "the registry always says `auto`" — and it is leg 3's rope failing on the
 *   arm it is supposed to fail on.
 * - The *freeze* control hands an adopted session a string it has never had, to
 *   locate where the stability comes from: leg 3b reads what the store does with
 *   it, which is the reading that moved when the CLI did.
 *
 * Red lines:
 * - The process budget guard below kills the whole process with `exit 3` rather
 *   than failing one case, so a lifecycle that hangs is a budget kill with its
 *   own reading, as in the sibling criteria.
 * - Every reading is printed before anything is asserted.
 * - The registry readings are taken while the process is still holding its turn
 *   open. A per-run process lingers for `BG_WAIT_CEILING_MS` after its `result`,
 *   and that hold is the only thing that makes a per-run process readable at
 *   all: nothing else in the app reports a per-run pid.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getSessionInfo, query } from '@anthropic-ai/claude-agent-sdk';
import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  providerModelsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  buildPromptMessages,
  createHeldPromptStream,
  mapCliOptionsToSDK,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { createProviderRuntimeService, providerRoutes } from '@/modules/providers/index.js';
import { createSessionHostsRouter, sessionHostManager } from '@/modules/session-hosts/index.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

/**
 * This run's own tag.
 *
 * The registry this criterion reads is machine-global and pid-keyed, so its rows
 * are looked up by the provider session id this run minted — but the session ids
 * and the transcript markers have to belong to this run alone: the project
 * directory a transcript lives in is shared with every other run on the host.
 */
const RUN_TAG = randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 8);
const SESSION_NEW = `${RUN_TAG}-new`;
const SESSION_RESIDENT = `${RUN_TAG}-resident`;

/** What the mock answers the CLI's title-generation request with. */
const MOCK_AI_TITLE = `AC171 Title ${RUN_TAG}`;
/** What the app has cached as its own display name — deliberately a different string. */
const APP_CACHED_NAME = `AC171 App Cached ${RUN_TAG}`;
/** The arbitrary title the suppression control hands to a brand-new session. */
const SUPPRESSION_TITLE = `AC171 Suppressed ${RUN_TAG}`;
/**
 * A title handed to a session that has *already* adopted one.
 *
 * The design accepts that adoption freezes, and leg 3b locates where it freezes:
 * the first handover is persisted as a `custom-title`, which outranks the
 * `ai-title` below it *and* is what the app reads back, so every later round
 * offers the same string. A resume offered a string the session has never had is
 * therefore the control that shows what the freeze does and does not cover — a
 * handover of a foreign string moves the store, a handover of the store's own
 * value is a fixed point. This is that string.
 */
const LATER_TITLE = `AC171 Later ${RUN_TAG}`;

const MARKER_NEW = `AC171-N-${RUN_TAG}`;
const MARKER_RESIDENT = `AC171-R-${RUN_TAG}`;
const MARKER_SUPPRESSION = `AC171-S-${RUN_TAG}`;
const MARKER_APPNAME = `AC171-A-${RUN_TAG}`;
const MARKER_FREEZE = `AC171-F-${RUN_TAG}`;

/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = `peer-name-custom-model-${RUN_TAG}`;
const MODEL_SECRET = `peer-name-model-row-secret-${RUN_TAG}`;

/** How long a turn is given to open, land and settle. */
const TURN_TIMEOUT_MS = 30_000;
/** How long a transcript or registry reading is given to appear. */
const READ_TIMEOUT_MS = 15_000;

/**
 * The process budget, enforced by the process rather than by node:test's own
 * per-case timeout, so a lifecycle that hangs is its own reading.
 */
const BUDGET_MS = Number(process.env.CLAUDE_PEER_NAME_BUDGET_MS ?? '') > 0
  ? Number(process.env.CLAUDE_PEER_NAME_BUDGET_MS)
  : 180_000;
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  console.error(
    `[budget] budget=${BUDGET_MS}ms elapsed=${Date.now() - STARTED_AT}ms exit=3 — the peer-name run did not ` +
      `finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, BUDGET_MS);
budgetGuard.unref();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------------------------------------------------------------------------
// The registry, as the CLI writes it. Read here, independently.
// ---------------------------------------------------------------------------

type CliRegistration = {
  pid: number;
  sessionId: string | null;
  name: string | null;
  nameSource: string | null;
};

/**
 * Every live registration for one provider session, oldest pid first.
 *
 * Read straight off `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` rather than
 * through the driver's own reader, for the reason the addressable criterion
 * reads it itself: a criterion that compared the app's answer to the app's
 * reader would only be saying that the reader equals itself.
 *
 * Sorted by pid rather than by mtime because a per-run session leaves its
 * earlier processes' registrations behind while they linger, and a fresh pid is
 * the only thing that distinguishes the process a round started from the one
 * before it.
 */
function readAllRegistrations(configDir: string): CliRegistration[] {
  const dir = path.join(configDir, 'sessions');
  if (!existsSync(dir)) {
    return [];
  }
  const rows: CliRegistration[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const pid = Number(file.slice(0, -'.json'.length));
    if (!Number.isFinite(pid)) {
      continue;
    }
    try {
      const row = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
      rows.push({
        pid,
        sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
        name: typeof row.name === 'string' && row.name ? row.name : null,
        nameSource: typeof row.nameSource === 'string' ? row.nameSource : null,
      });
    } catch {
      // No registration yet, or a torn one. A caller polls.
    }
  }
  return rows.sort((left, right) => left.pid - right.pid);
}

/**
 * Collects the registrations a round's process writes, *while it is alive*.
 *
 * A per-run process is gone by the time its turn completes — it registers, runs,
 * answers, and exits — so a registry read taken after the `complete` frame finds
 * nothing at all, which is exactly what "no title was handed over" would also
 * look like. The registration therefore has to be watched for concurrently with
 * the round, and `seenPids` is what keeps the reading about *this* round's
 * process rather than one that has not exited yet.
 *
 * The last state seen for a pid is the one kept, because the CLI writes this
 * file more than once: it registers under its own derived name as it starts and
 * rewrites the name when it adopts a title. Keeping the first sighting would
 * read every process as `derived`, which is precisely the reading under test.
 */
function watchRegistrations(configDir: string, seenPids: number[]): {
  captured: CliRegistration[];
  first: CliRegistration[];
  sweep: () => void;
  stop: () => Promise<void>;
} {
  const captured: CliRegistration[] = [];
  /**
   * The *first* state each pid was seen in, which is not the one `captured` keeps.
   *
   * The two readings answer different questions. `captured` answers "where did
   * this process's name end up", which is what a launch that adopts a title
   * needs; `first` answers "what did it register as it started", which is what a
   * launch that hands nothing over needs. They stopped being the same string the
   * moment a resident process could be renamed *during its first turn* by the
   * live title mirror (`gap-claude-resident-name-live-mirror`): the process is
   * still launched under the CLI's derived name, and the registry file is
   * rewritten a moment later in the same turn. Reading only the last state would
   * report that later rewrite as what the launch registered.
   */
  const first: CliRegistration[] = [];
  let watching = true;

  /** One pass over the registry: `first` once per pid, `captured` last-state-wins. */
  const sweep = (): void => {
    for (const row of readAllRegistrations(configDir)) {
      if (seenPids.includes(row.pid) || !row.name) {
        continue;
      }
      const index = captured.findIndex((existing) => existing.pid === row.pid);
      if (index === -1) {
        captured.push(row);
        first.push(row);
      } else {
        captured[index] = row;
      }
    }
  };

  const loop = (async () => {
    while (watching) {
      sweep();
      await sleep(50);
    }
  })();
  return {
    captured,
    first,
    sweep,
    stop: async () => {
      watching = false;
      await loop;
    },
  };
}

/** Every pid the CLI holds a registration for right now, across all sessions. */
function registrationPids(configDir: string): number[] {
  const dir = path.join(configDir, 'sessions');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => Number(file.slice(0, -'.json'.length)))
    .filter((pid) => Number.isFinite(pid));
}

/**
 * The registration this round's process wrote, picked out of what the watcher
 * collected.
 *
 * Matched by provider session id first, because that is the reading the
 * assertions are about; a round whose transcript says one thing and whose
 * registration says another is a real disagreement and not something to paper
 * over with a fallback. The fallback exists only for the arm that reaches its
 * assertion with no registration at all, where `null` is the reading.
 */
function registrationFor(
  captured: CliRegistration[],
  providerSessionId: string | null,
  label: string,
): CliRegistration | null {
  const match = captured.find((row) => row.sessionId === providerSessionId);
  if (!match) {
    console.log(
      `[readings] no registration collected for ${label}: providerSessionId=${String(providerSessionId)} ` +
        `captured=${JSON.stringify(captured)}`,
    );
  }
  return match ?? null;
}

// ---------------------------------------------------------------------------
// The mock endpoint
// ---------------------------------------------------------------------------

type Received = { url: string; body: string; isAgent: boolean; tag: string };

type MockAnthropic = {
  received: Received[];
  baseUrl: string;
  /** Opens a fresh recording bucket for one round and returns it. */
  openRound(tag: string): Received[];
  close(): Promise<void>;
};

const sse = (events: Array<[string, unknown]>): string =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');

const textStream = (text: string): string =>
  sse([
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);

/**
 * An Anthropic-compatible endpoint that answers a turn and a title generation.
 *
 * A request is an *agent* request when its body declares tool schemas. The
 * CLI's title generation posts to the same path with the same credential and
 * declares none, which is what separates the two — and the whole of reading 1
 * is whether that second request is made at all.
 *
 * Its answer has to be the JSON the title prompt asks for (`{"title": ...}`);
 * the CLI discards anything else. That matters to the reading: with a
 * plain-text answer, "no `ai-title` row appeared" would hold even for a build
 * that did nothing wrong.
 */
async function startMockAnthropic(): Promise<MockAnthropic> {
  const received: Received[] = [];
  let recording = received;
  let tag = 'setup';

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      const body = Buffer.concat(chunks).toString('utf8');

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

      const isAgent = body.includes('"input_schema"');
      recording.push({ url, body, isAgent, tag });
      answer(isAgent ? textStream(`AC171 ack ${tag}`) : textStream(JSON.stringify({ title: MOCK_AI_TITLE })));
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    openRound: (nextTag: string) => {
      tag = nextTag;
      recording = [];
      return recording;
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// ---------------------------------------------------------------------------
// Transport stand-in and file readings
// ---------------------------------------------------------------------------

type FakeSocket = EventEmitter & {
  readyState: number;
  OPEN: number;
  frames: Array<Record<string, unknown>>;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.OPEN = 1;
  socket.frames = [];
  socket.send = (data: string) => {
    socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  };
  socket.close = () => { socket.readyState = 3; };
  return socket;
}

/** Polls a predicate and answers whether it held, without failing the case. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(50);
  }
  console.log(`[readings] waitFor timed out after ${timeoutMs}ms: ${label}`);
  return false;
}

/** One line of a JSONL file, or an empty record for a torn one. */
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
 * The session's transcript, located by the conversation it holds.
 *
 * The provider session id is not known when the first round starts — the app has
 * none yet either, which is exactly why the first round hands over no title — so
 * the file is identified by the marker only that session's prompt carries. Once
 * a file is found its basename *is* the provider session id, and every later
 * reading uses that. The newest match wins, because a session whose process died
 * on the way up and was booted again leaves an earlier file behind.
 */
function findTranscriptByMarker(configDir: string, marker: string): string | null {
  const projects = path.join(configDir, 'projects');
  if (!existsSync(projects)) {
    return null;
  }
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const file of readdirSync(path.join(projects, entry.name))) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }
      const candidate = path.join(projects, entry.name, file);
      if (!readFileSync(candidate, 'utf8').includes(marker)) {
        continue;
      }
      const mtimeMs = statSync(candidate).mtimeMs;
      if (!newest || mtimeMs > newest.mtimeMs) {
        newest = { file: candidate, mtimeMs };
      }
    }
  }
  return newest?.file ?? null;
}

/** The title rows a process wrote into its own transcript, in row order. */
function titleRows(rows: Array<Record<string, unknown>>): {
  aiTitles: string[];
  customTitles: string[];
  agentNames: string[];
} {
  const aiTitles: string[] = [];
  const customTitles: string[] = [];
  const agentNames: string[] = [];
  for (const row of rows) {
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle) {
      aiTitles.push(row.aiTitle);
    }
    if (row.type === 'custom-title' && typeof row.customTitle === 'string' && row.customTitle) {
      customTitles.push(row.customTitle);
    }
    if (row.type === 'agent-name' && typeof row.agentName === 'string' && row.agentName) {
      agentNames.push(row.agentName);
    }
  }
  return { aiTitles, customTitles, agentNames };
}

/**
 * The safety rope, as one predicate: every title a launch persisted is one of
 * the titles the session already had.
 *
 * A launch that hands over the session's *own* title can only persist a
 * `custom-title` the session's `ai-title` already agrees with; a launch that
 * hands over anything else persists a string that appears nowhere in the
 * session's own history. Stated over the sets rather than as an equality,
 * because the CLI writes its title rows more than once per session.
 */
function ropeHolds(customTitles: string[], aiTitles: string[]): boolean {
  return customTitles.length > 0 && customTitles.every((title) => aiTitles.includes(title));
}

/**
 * One rung of the session's own title, as Claude Code reads it.
 *
 * `summary` is the SDK's compiled ladder — "custom title, auto-generated
 * summary, or first prompt" — and is what the legs that compare *titles* read.
 * `customTitle` is the rung the app hands over, and reading it is how leg 3b
 * says what the next round would offer the CLI: `resolveClaudeSessionTitle`
 * returns `getSessionInfo().customTitle`, so this call is the app's input read
 * the way the app reads it — not a second opinion on it.
 *
 * `getSessionInfo` resolves the Claude home from *this* process's environment,
 * not from the environment handed to the CLI subprocess, so the reading points
 * `CLAUDE_CONFIG_DIR` at the temp home for the length of the call. That
 * asymmetry is real rather than an artefact of the harness: the product's own
 * reader runs in the server process and resolves the same way. `dir` is the
 * session's project directory — the one the CLI was launched in — because that
 * is what names the project key the transcript is filed under.
 */
async function readSessionTitle(
  providerSessionId: string,
  dir: string,
  configDir: string,
  rung: 'summary' | 'customTitle' = 'summary',
): Promise<string | null> {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const info = await getSessionInfo(providerSessionId, { dir });
    const value = info?.[rung];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  } finally {
    if (saved === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = saved;
    }
  }
}

/** The model entry that points the CLI at the mock endpoint. */
function modelRows(baseUrl: string): ProviderModelEnvRow[] {
  return [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ];
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

type Harness = {
  socket: FakeSocket;
  userId: number;
  cwd: string;
  configDir: string;
  mock: MockAnthropic;
};

async function withPeerNameHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-peer-name-'));
  const configDir = path.join(tempDirectory, 'claude-config');
  const saved = new Map<string, string | undefined>(
    ['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .map((name) => [name, process.env[name]]),
  );

  const mock = await startMockAnthropic();
  const app = express();
  app.use(express.json());
  app.use('/api/providers', providerRoutes);
  app.use('/api/session-hosts', createSessionHostsRouter({ sessionHostManager }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    // A dead host endpoint, so a run that ignored the model entry can never
    // reach the mock: reaching it is evidence that the entry was consulted.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANTHROPIC_API_KEY = 'sk-host-sentinel-must-not-leak';
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    await initializeDatabase();
    const user = userDb.createUser(`claude-peer-name-${RUN_TAG}`, 'unused-hash');

    const now = new Date().toISOString();
    for (const sessionId of [SESSION_NEW, SESSION_RESIDENT]) {
      sessionsDb.createSession(sessionId, 'claude', tempDirectory, APP_CACHED_NAME, now, now, null);
      // A session the app has never resumed has no provider session id yet, and
      // that absence is what keeps the first round from handing over a title.
      getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(sessionId);
    }
    assert.strictEqual(sessionsDb.setSessionLifecycleMode(SESSION_RESIDENT, 'resident'), true);

    providerModelsDb.createCustomProviderModel('claude', {
      id: MODEL_ID,
      model: MODEL_ID,
      config: { env: modelRows(mock.baseUrl) },
    });

    sessionHostManager.setUnattendedRunOpener((input) => chatRunRegistry.openUnattendedRun(input));

    const socket = createFakeSocket();
    handleChatConnection(
      socket as never,
      { user: { id: Number(user.id) } } as never,
      { runtime: createProviderRuntimeService() as never },
    );

    await run({ socket, userId: Number(user.id), cwd: tempDirectory, configDir, mock });
  } finally {
    sessionHostManager.setUnattendedRunOpener(null);
    for (const host of sessionHostManager.snapshot()) {
      if (host.state !== 'closed') {
        sessionHostManager.closeHost(host.hostId, 'server-shutdown');
      }
    }
    await sleep(250);
    for (const host of sessionHostManager.snapshot()) {
      if (host.pid && existsSync(`/proc/${host.pid}`)) {
        try {
          process.kill(host.pid, 'SIGKILL');
        } catch {
          // Already gone between the check and the kill.
        }
      }
    }
    // A per-run process is not in the host snapshots — those carry `pid: null`
    // for it — so the registrations it left behind are what has to be swept, or
    // a leaked CLI outlives the case.
    for (const pid of registrationPids(configDir)) {
      if (existsSync(`/proc/${pid}`)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
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

/** Sends one user turn and answers with its terminal `complete` frame. */
async function sendRound(
  socket: FakeSocket,
  sessionId: string,
  content: string,
  cwd: string,
): Promise<Record<string, unknown>> {
  const completes = (): Array<Record<string, unknown>> =>
    socket.frames.filter((frame) => frame.kind === 'complete' && frame.sessionId === sessionId);
  const before = completes().length;
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId,
    content,
    options: { cwd, model: MODEL_ID, permissionMode: 'bypassPermissions' },
  }));
  await waitFor(() => completes().length > before, TURN_TIMEOUT_MS, `round "${content.slice(0, 40)}" to complete`);
  return completes().at(-1) as Record<string, unknown>;
}

type RoundReading = {
  frame: Record<string, unknown>;
  providerSessionId: string | null;
  registration: CliRegistration | null;
  /**
   * The registration as the process *started* — the state a launch handed nothing
   * to registers in. See `watchRegistrations`.
   */
  launchRegistration: CliRegistration | null;
  aiTitles: string[];
  customTitles: string[];
  agentNames: string[];
  titleGenRequests: number;
};

/**
 * One round through the app, with the readings that only exist while its process
 * is alive.
 *
 * The registration is read first, because it is the reading with a deadline: a
 * per-run process lingers after its `result` but not forever, and the round
 * after it supersedes it. The transcript is read afterwards, twice if it has to
 * be, because a process flushes its title rows late — an `ai-title` that is
 * absent at the first read is routinely present at the second.
 */
async function runMeasuredRound(
  context: Harness,
  sessionId: string,
  marker: string,
  label: string,
): Promise<RoundReading> {
  const bucket = context.mock.openRound(label);
  const watch = watchRegistrations(context.configDir, registrationPids(context.configDir));
  const frame = await sendRound(context.socket, sessionId, `${marker} round for ${label}`, context.cwd);
  // A last look after the frame, for a process that answered before a poll came
  // round: it is gone a moment later, so this is the end of the window.
  await sleep(400);
  await watch.stop();

  await waitFor(() => Boolean(findTranscriptByMarker(context.configDir, marker)), READ_TIMEOUT_MS, `${label} transcript`);
  const transcriptFile = findTranscriptByMarker(context.configDir, marker);
  const providerSessionId = transcriptFile ? path.basename(transcriptFile, '.jsonl') : null;
  const registration = registrationFor(watch.captured, providerSessionId, label);

  const launchRegistration = registrationFor(watch.first, providerSessionId, label);

  let titles = titleRows(transcriptFile ? readJsonLines(transcriptFile) : []);
  if (titles.aiTitles.length === 0 && titles.customTitles.length === 0) {
    await sleep(1_500);
    titles = titleRows(transcriptFile ? readJsonLines(transcriptFile) : []);
  }

  const reading: RoundReading = {
    frame,
    providerSessionId,
    registration,
    launchRegistration,
    aiTitles: titles.aiTitles,
    customTitles: titles.customTitles,
    agentNames: titles.agentNames,
    titleGenRequests: bucket.filter((request) => !request.isAgent && request.url.startsWith('/v1/messages')).length,
  };
  console.log(
    `[readings] round=${label} path=${sessionId === SESSION_RESIDENT ? 'resident' : 'per-run'} ` +
      `exit=${String(frame.exitCode ?? 'none')} providerSessionId=${String(providerSessionId)} ` +
      `titleGenRequests=${reading.titleGenRequests} aiTitles=${JSON.stringify(reading.aiTitles)} ` +
      `customTitles=${JSON.stringify(reading.customTitles)} agentNames=${JSON.stringify(reading.agentNames)} ` +
      `registration=${JSON.stringify(registration)}`,
  );
  return reading;
}

/**
 * One real process launched the way the product launches one, with exactly one
 * variable changed: the title handed over.
 *
 * This is the control arm's launch. It cannot go through the app's dispatch,
 * because the app's dispatch has no seam for handing over a title the app did
 * not resolve — which is the point of the change being graded — so the control
 * builds its options the way both launch paths do (`mapCliOptionsToSDK`), adds
 * the one key, and reads the same registry and the same transcript.
 *
 * The launch is held open across the reading — the same hold the product keeps
 * for the same reason (`createHeldPromptStream`), driven here until the process
 * is actually read rather than until a fixed delay expires. The registry file is
 * the CLI's, written as the process starts and deleted as it exits, so a launch
 * that let go of its input at the `result` would race the reader against a file
 * that only exists for the length of the turn.
 */
async function launchWithTitle(
  context: Harness,
  marker: string,
  label: string,
  title: string,
  resumeProviderSessionId: string | null = null,
): Promise<RoundReading & { providerSessionId: string | null }> {
  const bucket = context.mock.openRound(label);
  const watch = watchRegistrations(context.configDir, registrationPids(context.configDir));
  const env = { ...process.env };
  env.CLAUDE_CONFIG_DIR = context.configDir;
  env.ANTHROPIC_BASE_URL = context.mock.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = MODEL_SECRET;
  delete env.ANTHROPIC_API_KEY;

  const options = mapCliOptionsToSDK({
    cwd: context.cwd,
    model: MODEL_ID,
    permissionMode: 'bypassPermissions',
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true },
    // A resume is expressed the way the product expresses it: handing the
    // provider session id is what `mapCliOptionsToSDK` turns into `resume`.
    providerSessionId: resumeProviderSessionId,
  }) as unknown as Record<string, unknown>;
  options.env = env;
  options.title = title;
  delete options.spawnClaudeCodeProcess;

  const held = createHeldPromptStream(await buildPromptMessages(`${marker} control round for ${label}`, [], [], context.cwd));
  let exited = false;
  let launchFailure: string | null = null;
  const pump = (async () => {
    // Consumed to the end of the stream rather than broken at the `result`: the
    // input iterable stays pending until `release()` below, which is what keeps
    // the CLI — and the registration file it deletes on its way out — alive
    // until this launch has been read.
    for await (const message of query({ prompt: held.stream, options } as never)) {
      if ((message as { type?: string }).type === 'result') {
        exited = true;
      }
    }
  })().catch((error: unknown) => {
    // Recorded, never swallowed: a launch that failed to reach its `result` has
    // to say so in the reading, or it reaches the assertions as a `null` that
    // reads exactly like a build that handed over nothing.
    launchFailure = error instanceof Error ? error.message : String(error);
  });

  // The turn is driven to its end with stdin still open — no `release()` yet.
  //
  // This is what makes the registry reading a causal one instead of a race. The
  // CLI writes `sessions/<pid>.json` as it starts and deletes it as it exits,
  // and a direct launch is short enough that the file can come and go inside one
  // poll of the watcher above on a loaded host. Waiting for the `result` first
  // and only then sweeping is sound in the other direction too: every write a
  // process makes about its own name happens before its first turn ends, so the
  // state read here is the settled one and not an intermediate.
  await waitFor(() => exited || launchFailure !== null, TURN_TIMEOUT_MS, `${label} to reach its result`);
  // Swept on a loop rather than read once, because the CLI rewrites this file
  // more than once and a single read can land on a torn one. The process is
  // still held, so the wait is bounded by the file being written at all and not
  // by how long the process happens to live.
  await waitFor(() => {
    watch.sweep();
    return watch.captured.length > 0;
  }, READ_TIMEOUT_MS, `${label} registration`);

  held.release();
  await Promise.race([pump, sleep(5_000)]);
  await watch.stop();

  await waitFor(() => Boolean(findTranscriptByMarker(context.configDir, marker)), READ_TIMEOUT_MS, `${label} transcript`);
  const transcriptFile = findTranscriptByMarker(context.configDir, marker);
  const providerSessionId = transcriptFile ? path.basename(transcriptFile, '.jsonl') : null;
  const registration = registrationFor(watch.captured, providerSessionId, label);

  await sleep(1_500);

  const titles = titleRows(transcriptFile ? readJsonLines(transcriptFile) : []);
  const reading = {
    frame: { exitCode: exited ? 0 : null },
    providerSessionId,
    registration,
    launchRegistration: registrationFor(watch.first, providerSessionId, label),
    aiTitles: titles.aiTitles,
    customTitles: titles.customTitles,
    agentNames: titles.agentNames,
    titleGenRequests: bucket.filter((request) => !request.isAgent && request.url.startsWith('/v1/messages')).length,
  };
  console.log(
    `[readings] control=${label} path=direct-launch handedOver=${JSON.stringify(title)} ` +
      `providerSessionId=${String(providerSessionId)} titleGenRequests=${reading.titleGenRequests} ` +
      `aiTitles=${JSON.stringify(reading.aiTitles)} customTitles=${JSON.stringify(reading.customTitles)} ` +
      `launchFailure=${JSON.stringify(launchFailure)} registration=${JSON.stringify(registration)}`,
  );
  return reading;
}

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

test('a session hands its own Claude Code title to the CLI, and answers to it', { timeout: 300_000 }, async () => {
  await withPeerNameHarness(async (context) => {
    const { configDir, cwd } = context;

    // ---------------------------------------------------------------------
    // Leg 1 — a brand-new session's first round hands over nothing, and the
    // CLI's own title generation runs.
    //
    // This is the constraint the design turns on: the SDK skips automatic title
    // generation outright when a title is passed, so a build that handed one
    // over here would leave every new session with nothing to adopt later.
    // ---------------------------------------------------------------------
    const first = await runMeasuredRound(context, SESSION_NEW, MARKER_NEW, 'new-round-1');
    assert.notStrictEqual(first.providerSessionId, null, 'the first round must produce a provider session id');
    assert.strictEqual(
      first.aiTitles.includes(MOCK_AI_TITLE),
      true,
      `the first round of a new session must let the CLI generate its title ` +
        `(aiTitles=${JSON.stringify(first.aiTitles)})`,
    );
    assert.strictEqual(
      first.titleGenRequests > 0,
      true,
      `the title-generation request must reach the endpoint on a first round (saw ${first.titleGenRequests})`,
    );
    assert.strictEqual(
      first.registration?.nameSource,
      'derived',
      `a first round hands over no title, so the process keeps the CLI's own derived name ` +
        `(${JSON.stringify(first.registration)})`,
    );

    // ---------------------------------------------------------------------
    // Leg 1c — the suppression control.
    //
    // The same reading, on a session of the same shape, with one variable
    // changed: a title handed over at creation. Every reading above has to flip
    // — no title-generation request, no `ai-title` row, and a process registered
    // `auto` under the handed string. Without this arm, leg 1's missing
    // `ai-title` would be equally consistent with an endpoint the CLI cannot get
    // a title out of at all.
    // ---------------------------------------------------------------------
    const suppressed = await launchWithTitle(context, MARKER_SUPPRESSION, 'suppression-control', SUPPRESSION_TITLE);
    assert.strictEqual(
      suppressed.titleGenRequests,
      0,
      `handing a title over must suppress title generation entirely (saw ${suppressed.titleGenRequests} requests)`,
    );
    assert.deepEqual(
      suppressed.aiTitles,
      [],
      `a session handed a title at creation must have no generated title (${JSON.stringify(suppressed.aiTitles)})`,
    );
    assert.strictEqual(
      suppressed.registration?.nameSource,
      'auto',
      `a handed-over title registers as adopted (${JSON.stringify(suppressed.registration)})`,
    );
    assert.strictEqual(
      suppressed.registration?.name,
      SUPPRESSION_TITLE,
      `the registry must carry the handed-over title (${JSON.stringify(suppressed.registration)})`,
    );

    // ---------------------------------------------------------------------
    // Leg 2 — from the second round on, the app hands over the session's own
    // title, and the process answers to it.
    //
    // The app maps the provider session id after the first round, as it does in
    // production, and the second round resumes. The expected registered name is
    // read here with the same call the product uses, so it is a reading of the
    // session and not a constant this criterion chose.
    // ---------------------------------------------------------------------
    const providerSessionId = first.providerSessionId as string;
    sessionsDb.assignProviderSessionId(SESSION_NEW, providerSessionId);
    const summaryBeforeAdoption = await readSessionTitle(providerSessionId, cwd, configDir);
    assert.strictEqual(
      summaryBeforeAdoption,
      MOCK_AI_TITLE,
      `before adoption the session's own title is the generated one (${JSON.stringify(summaryBeforeAdoption)})`,
    );

    const adopted = await runMeasuredRound(context, SESSION_NEW, MARKER_NEW, 'new-round-2');
    console.log(
      `[readings] round=new-round-2 handedOver=${JSON.stringify(summaryBeforeAdoption)} ` +
        `registered=${JSON.stringify(adopted.registration?.name)} ` +
        `nameSource=${JSON.stringify(adopted.registration?.nameSource)}`,
    );
    assert.strictEqual(
      adopted.registration?.nameSource,
      'auto',
      `the resumed process must register the handed-over title (${JSON.stringify(adopted.registration)})`,
    );
    assert.strictEqual(
      adopted.registration?.name,
      summaryBeforeAdoption,
      `the registered name must be the session's own title byte for byte ` +
        `(registered=${JSON.stringify(adopted.registration?.name)} title=${JSON.stringify(summaryBeforeAdoption)})`,
    );
    // The safety rope: the value handed over *is* the `ai-title` above, so every
    // `custom-title` this launch persists has to be that same string.
    assert.strictEqual(
      ropeHolds(adopted.customTitles, adopted.aiTitles),
      true,
      `the persisted custom-title must be byte-identical to the session's ai-title ` +
        `(custom=${JSON.stringify(adopted.customTitles)} ai=${JSON.stringify(adopted.aiTitles)})`,
    );

    // ---------------------------------------------------------------------
    // Leg 2c — the app-name control.
    //
    // The retired failure mode is handing over the display name the *app* has
    // cached rather than the session's own title. Same launch, one variable
    // changed: the process registers that string instead, and the `custom-title`
    // it persists is no longer the `ai-title` — which is what leg 3's rope is
    // for, failing here on the arm it is supposed to fail on.
    // ---------------------------------------------------------------------
    const appNamed = await launchWithTitle(context, MARKER_APPNAME, 'appname-control', APP_CACHED_NAME);
    assert.strictEqual(
      appNamed.registration?.name,
      APP_CACHED_NAME,
      `the control must register the string it was handed (${JSON.stringify(appNamed.registration)})`,
    );
    assert.strictEqual(
      appNamed.titleGenRequests,
      0,
      `the app-name control hands a title over too, so it suppresses generation as well (saw ${appNamed.titleGenRequests})`,
    );
    assert.strictEqual(
      ropeHolds(appNamed.customTitles, appNamed.aiTitles),
      false,
      `the rope must be able to fail: an app name handed over is a title the session never had ` +
        `(custom=${JSON.stringify(appNamed.customTitles)} ai=${JSON.stringify(appNamed.aiTitles)})`,
    );

    // ---------------------------------------------------------------------
    // Leg 3 — the name does not move on later turns.
    //
    // What makes it stable is where the app reads it: the adopted title is now
    // persisted as a `custom-title`, which outranks the `ai-title` below it, so
    // `getSessionInfo().summary` returns the adopted value and every later round
    // hands over the same string. That is the freeze the design accepts — the
    // *input* freezes, while a process handed a different string moves the store
    // as well as the process (the freeze control in leg 3b is the proof of that).
    // ---------------------------------------------------------------------
    const summaryAfterAdoption = await readSessionTitle(providerSessionId, cwd, configDir);
    assert.strictEqual(
      summaryAfterAdoption,
      summaryBeforeAdoption,
      `the session's own title must not move after adoption ` +
        `(${JSON.stringify(summaryBeforeAdoption)} -> ${JSON.stringify(summaryAfterAdoption)})`,
    );
    const third = await runMeasuredRound(context, SESSION_NEW, MARKER_NEW, 'new-round-3');
    assert.strictEqual(
      third.registration?.name,
      summaryBeforeAdoption,
      `a later round must leave the registered name where adoption put it ` +
        `(${JSON.stringify(third.registration?.name)} !== ${JSON.stringify(summaryBeforeAdoption)})`,
    );
    assert.notStrictEqual(
      third.registration?.pid,
      adopted.registration?.pid,
      `the later round must be a new process for the reading to be about a launch ` +
        `(${String(adopted.registration?.pid)} -> ${String(third.registration?.pid)})`,
    );
    // That round handed over the string adoption persisted, and a launch handed a
    // title writes it down (leg 3b). So this is where the one production
    // consequence of that — a ladder with a row per round — is measured rather
    // than assumed: an identical handover is a no-op, and the ladder still holds
    // exactly what adoption put there.
    assert.deepEqual(
      third.customTitles,
      adopted.customTitles,
      `a round re-offering the adopted title must not add a row to the ladder ` +
        `(afterAdoption=${JSON.stringify(adopted.customTitles)} afterThirdRound=${JSON.stringify(third.customTitles)})`,
    );

    // ---------------------------------------------------------------------
    // Leg 3b — the freeze, located where it actually is.
    //
    // The task this criterion belongs to says the name "freezes at the first
    // adoption", and the reading below is what that turns out to mean. The same
    // conversation is resumed with a title it has never had. Two things could
    // have happened, and Claude Code CLI 2.1.300 — the version this was
    // re-measured on, after the reading below moved — does both:
    //
    //   - The *ladder* takes the new string. A launch handed a title persists it
    //     as the session's `custom-title`, so the transcript comes out holding
    //     the adopted title and then the offered one, and the store names the
    //     session by the string it was offered.
    //   - The *registry* registers the string it was handed, as it always did.
    //
    // So Claude Code offers no freeze here: it writes down whatever title a
    // launch hands it. What holds an adopted name in place is the app's *input* —
    // every launch site hands over `getSessionInfo().customTitle`, the store's
    // own value (`resolveClaudeSessionTitle`), so the string offered each round
    // is the string the store already holds, the write is a fixed point, and the
    // name stands still. That is leg 3's reading restated, and this control is
    // what shows the guarantee belongs to the input rather than to the CLI.
    //
    // The design accepts this rather than engineering a refresh, because
    // refreshing would mean the app calling `renameSession` on its own
    // initiative — naming a process on no human's instruction.
    // ---------------------------------------------------------------------
    const frozen = await launchWithTitle(context, MARKER_FREEZE, 'freeze-leg', LATER_TITLE, providerSessionId);
    console.log(
      `[readings] control=freeze-leg path=direct-launch resumed=${String(providerSessionId)} ` +
        `handedOver=${JSON.stringify(LATER_TITLE)} registered=${JSON.stringify(frozen.registration?.name)} ` +
        `nameSource=${JSON.stringify(frozen.registration?.nameSource)} ` +
        `customTitles=${JSON.stringify(frozen.customTitles)}`,
    );
    assert.strictEqual(
      frozen.registration?.name,
      LATER_TITLE,
      `a process handed a title registers it — the registry is not what freezes ` +
        `(registered=${JSON.stringify(frozen.registration?.name)} handedOver=${JSON.stringify(LATER_TITLE)})`,
    );
    assert.strictEqual(
      frozen.customTitles.includes(LATER_TITLE),
      true,
      `a title offered after adoption reaches the ladder — a launch hands the CLI a ` +
        `title and the CLI writes it down (customTitles=${JSON.stringify(frozen.customTitles)})`,
    );
    assert.deepEqual(
      frozen.customTitles,
      [...adopted.customTitles, LATER_TITLE],
      `the ladder must come out holding the adopted title and then the offered one ` +
        `(afterAdoption=${JSON.stringify(adopted.customTitles)} afterLaterTitle=${JSON.stringify(frozen.customTitles)})`,
    );
    const customTitleAfterLaterTitle = await readSessionTitle(providerSessionId, cwd, configDir, 'customTitle');
    const summaryAfterLaterTitle = await readSessionTitle(providerSessionId, cwd, configDir);
    console.log(
      `[readings] control=freeze-leg customTitleAfterLaterTitle=${JSON.stringify(customTitleAfterLaterTitle)} ` +
        `summaryAfterLaterTitle=${JSON.stringify(summaryAfterLaterTitle)} ` +
        `adopted=${JSON.stringify(summaryBeforeAdoption)}`,
    );
    assert.strictEqual(
      customTitleAfterLaterTitle,
      LATER_TITLE,
      `the store must have moved to the offered title — this is the app's input, the rung ` +
        `the next round would hand back (customTitle=${JSON.stringify(customTitleAfterLaterTitle)} ` +
        `offered=${JSON.stringify(LATER_TITLE)})`,
    );
    assert.strictEqual(
      summaryAfterLaterTitle,
      LATER_TITLE,
      `the compiled title follows the store, so a foreign handover overwrites the adopted ` +
        `string (${JSON.stringify(summaryBeforeAdoption)} -> ${JSON.stringify(summaryAfterLaterTitle)})`,
    );

    // ---------------------------------------------------------------------
    // Leg 4 — the resident path.
    //
    // A resident session holds one process across turns, so it is handed a title
    // once, on the cold start that resumes it. Its own first launch is a
    // brand-new session like any other — no title, a derived name — and the
    // reading that matters is the launch after the provider session id is known.
    // ---------------------------------------------------------------------
    const residentFirst = await runMeasuredRound(context, SESSION_RESIDENT, MARKER_RESIDENT, 'resident-boot');
    assert.notStrictEqual(residentFirst.providerSessionId, null, 'the resident boot must reach a session');
    // The claim is about the *launch*: it is handed no title, so the process
    // starts under the CLI's derived name. Read off `launchRegistration`, not
    // `registration`: since `gap-claude-resident-name-live-mirror` a resident
    // process's registry name can be rewritten *during its first turn* — that is
    // precisely what that task adds — so the last state of the same turn is no
    // longer the state the launch registered. The regression this guards is a
    // build that hands a title over at creation (leg 1c's suppression shape); the
    // process would then start under `auto`, which `launchRegistration` still
    // reads.
    console.log(
      `[readings] round=resident-boot launchNameSource=${JSON.stringify(residentFirst.launchRegistration?.nameSource)} ` +
        `launchName=${JSON.stringify(residentFirst.launchRegistration?.name)} ` +
        `postTurnNameSource=${JSON.stringify(residentFirst.registration?.nameSource)} ` +
        `postTurnName=${JSON.stringify(residentFirst.registration?.name)}`,
    );
    assert.strictEqual(
      residentFirst.launchRegistration?.nameSource,
      'derived',
      `a resident session's own first launch hands over no title either ` +
        `(${JSON.stringify(residentFirst.launchRegistration)})`,
    );
    sessionsDb.assignProviderSessionId(SESSION_RESIDENT, residentFirst.providerSessionId as string);
    const residentSummary = await readSessionTitle(residentFirst.providerSessionId as string, cwd, configDir);
    assert.strictEqual(
      residentSummary,
      MOCK_AI_TITLE,
      `the resident session's own title is the generated one (${JSON.stringify(residentSummary)})`,
    );

    // The host serving the resident session, found by the pid of the process the
    // round just registered — the one handle this criterion already holds. Read
    // off the manager rather than off the REST projection because the projection
    // only carries an address for a host whose read-back ran at a *brand-new*
    // session, and this leg's restart resumes one.
    const firstResidentPid = residentFirst.registration?.pid ?? null;
    assert.notStrictEqual(firstResidentPid, null, 'the resident boot must register a process to be restarted');
    const hostOfResident = sessionHostManager
      .snapshot()
      .find((host) => host.pid === firstResidentPid);
    assert.ok(hostOfResident, 'the resident session must still be served by an open host before the restart');
    sessionHostManager.closeHost(hostOfResident.hostId, 'user');
    await waitFor(
      () => firstResidentPid === null || !existsSync(`/proc/${firstResidentPid}`),
      15_000,
      "the resident session's first process to be gone before the restart",
    );

    const residentRestart = await runMeasuredRound(context, SESSION_RESIDENT, MARKER_RESIDENT, 'resident-restart');
    console.log(
      `[readings] round=resident-restart handedOver=${JSON.stringify(residentSummary)} ` +
        `registered=${JSON.stringify(residentRestart.registration?.name)} ` +
        `nameSource=${JSON.stringify(residentRestart.registration?.nameSource)}`,
    );
    assert.strictEqual(
      residentRestart.registration?.nameSource,
      'auto',
      `the restarted resident process must register the session's own title ` +
        `(${JSON.stringify(residentRestart.registration)})`,
    );
    assert.strictEqual(
      residentRestart.registration?.name,
      residentSummary,
      `the resident path's registered name must be the session's own title byte for byte ` +
        `(registered=${JSON.stringify(residentRestart.registration?.name)} summary=${JSON.stringify(residentSummary)})`,
    );
    assert.notStrictEqual(
      residentRestart.registration?.pid,
      firstResidentPid,
      `the resident reading must be about a second process ` +
        `(${String(firstResidentPid)} -> ${String(residentRestart.registration?.pid)})`,
    );

    const measured = Date.now() - STARTED_AT;
    console.log(`[readings] elapsed=${measured}ms`);
    assert.ok(measured < BUDGET_MS, `the criterion must finish inside its budget (${measured}ms)`);
  });
});

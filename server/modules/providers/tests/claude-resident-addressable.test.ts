/**
 * AC-164 criterion — the address a resident Claude process answers to, and
 * whether a copy of that address is enough to reach the process.
 *
 * A resident host holds one CLI across turns, and every CLI process registers a
 * name for itself when it starts: other sessions on the machine can address it
 * by that name. Claude Code picks that name; **CloudCLI does not**. It used to
 * (`--name <slug>-<id6>`, proposal §12), and that is the design this criterion
 * was rewritten for: an app-invented name outranked the session's own `ai-title`
 * and grew a new suffix on every restart. The app now launches the process with
 * no name at all and *reads* the name Claude Code derived, out of the process's
 * own registration (`~/.claude/sessions/<pid>.json`).
 *
 * Three things are measured here, on real processes (this criterion spawns the
 * real `claude` binary against an Anthropic-compatible mock endpoint):
 *
 * 1. The address is *the process's own*. The host snapshot's `peerName` has to
 *    be the `name` in that process's registration file, read here by this
 *    criterion directly off disk, and the registration's `nameSource` has to be
 *    `derived` — the CLI's own derivation — rather than `user`, which is what a
 *    name handed to the process through `--name` reads as.
 * 2. The app *injects nothing*. The process's transcript must hold no
 *    `agent-name` and no `custom-title` entry: those are the two entries a
 *    `--name` writes (as a pair, with the same value), and a transcript that
 *    carries one is the app having named the session after all.
 * 3. The address *survives a rename*. Renaming the session moves the name a user
 *    sees, and the address must not move with it: a process that answered to
 *    `archguard-85` before a rename has to answer to it after, or every copy of
 *    the address a peer is holding has been invalidated by an app-side edit.
 *    Read as `pid` and registration `name` before and after.
 *
 * The restatement rule is gone with the rule. What replaces it is the witness:
 * the expected address is the registration file's own `name`, read by this file
 * rather than through the driver's reader, so "the driver published what the
 * registry says" is a claim about two independent reads and not about a function
 * agreeing with itself.
 *
 * Three living hosts carry the readings:
 * - A and B are two resident sessions in one database. A is the sender, B the
 *   addressee.
 * - C is the control arm and is launched with *no* `sessionSummary`. Under the
 *   old rule its address was uncomputable and read as `null`; under this one a
 *   session's address does not depend on any title the app holds, so C must
 *   publish the name its own process registered while having been told nothing.
 *   That is what makes the pair falsifiable inside one unmutated run: a driver
 *   that went back to computing an address from the title would publish nothing
 *   for C, and a driver that published a name it made up would disagree with C's
 *   registration file.
 *
 * The delivery itself is real: the mock scripts A's turn into a `SendMessage`
 * tool call whose `to` is the address this criterion read from
 * `GET /api/session-hosts` — the same REST projection a client would read — and
 * B, being a real Claude process registered under that name, opens a turn of its
 * own for the arriving message. That turn is the measured outcome: a run with
 * `source=unattended`, a notification whose trigger names the cross-session
 * arrival rather than an unexplained turn, and frames a later subscriber can
 * replay. This is the reading the task record calls load-bearing: it is the one
 * thing a *derived* address had never been shown to do, and the whole reason
 * dropping the app's own name is not a loss of addressability.
 *
 * Red lines:
 * - The process budget guard below kills the whole process with `exit 3` rather
 *   than failing one case, so a lifecycle that hangs is a budget kill with its
 *   own reading, as in the sibling `claude-resident-unattended-turn` criterion.
 * - Every reading is printed before anything is asserted, and the assertions
 *   start with the registration-versus-snapshot agreement for A and B. The
 *   graded false form (the driver computes an address of its own and hands it to
 *   the process) reds on *this* reading, because the name published and the name
 *   the process registered are then two different strings — and it reds on the
 *   transcript reading too, since a name handed over is a name written down.
 * - The trigger is read off the arrival as the CLI states it on the turn's own
 *   `result`. The `Stop` hook's task list is the reading for every other reason a
 *   resident process opens a turn, and it cannot see a peer message at all: a
 *   turn opened that way holds nothing, which is why it is the `result` that has
 *   to carry the fact.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
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
  createProviderRuntimeService,
  providerRegistry,
  providerRoutes,
  sessionsService,
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
import type { ProviderModelEnvRow } from '@/shared/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this criterion measures: its own repository root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/**
 * This run's own tag, and the reason it is random.
 *
 * The addresses this criterion reads are machine-global — every Claude process
 * on the host shares `~/.claude/sessions/` — and pid-keyed, so two runs of this
 * file cannot land on each other's processes however they name their sessions.
 * (The old reason for the tag was the opposite: the machinery this task removes
 * built the address out of the app session id's first six characters, so two
 * runs without distinct ids could compute the same address and address each
 * other's processes. Path (a) deletes that entire class of collision.) What the
 * tag still buys is that this run's session ids, and the markers its transcripts
 * are located by, belong to this run alone.
 */
const RUN_TAG = randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 8);
const SESSION_A = `${RUN_TAG}-a`;
const SESSION_B = `${RUN_TAG}-b`;
const SESSION_C = `${RUN_TAG}-c`;

const TITLE_A = 'AC164 Addressable Alpha';
const TITLE_B = 'AC164 Addressable Beta';
/** After this the title the app holds is a different string; the address must not move. */
const TITLE_A_RENAMED = 'AC164 Addressable Alpha Renamed';

/**
 * The mock discriminates a turn by the session whose conversation it carries.
 *
 * A turn's request body accumulates that session's whole conversation, so a
 * marker written once in the session's first prompt is present in every request
 * that session ever makes — and absent from every other session's, which is what
 * makes three processes answerable by one endpoint. The cross-session message
 * deliberately carries no session marker: it is a *new* turn on B, and the only
 * thing that classifies it is that it is B's conversation it arrives in.
 */
const MARKER_A = 'AC164-A-';
const MARKER_B = 'AC164-B-';
const MARKER_C = 'AC164-C-';
const A_SEND_TEXT = `${MARKER_A}SEND the cross message to the address in the tool table`;
/** Assembled so no session's marker is a substring of the message. */
const CROSS_TEXT = 'AC164-XCROSS hello from the alpha session';
const CROSS_SUMMARY = 'AC164 cross-session probe';
/** The tool call the mock mints for A's send turn, and the tool result it reads back. */
const SEND_TOOL_ID = 'toolu_ac164_send';
/** Printed by B's own step, which is what gives a subscriber frames to replay. */
const PEER_STEP_SENTINEL = 'AC164_PEER_STEP';
/** B's answer to the cross-session message. */
const PEER_ACK = 'AC164 peer turn ack';

/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = 'resident-addressable-custom-model';
const MODEL_SECRET = 'resident-addressable-model-row-secret';
/** The host Anthropic key. It must survive in no request the mock receives. */
const HOST_SENTINEL = 'sk-host-sentinel-must-not-leak';

/** How long a turn is given to open, land and settle. */
const TURN_TIMEOUT_MS = 15_000;
/**
 * How many times a session's first turn is sent before the criterion gives up on
 * that process coming up. See `bootResidentSession` for why the retry is here.
 */
const BOOT_ATTEMPTS = 3;
/** How long the identity read-back is given to publish after a turn has ended. */
const IDENTITY_TIMEOUT_MS = 8_000;
/** How long the notification and the run registry are given to catch up. */
const SETTLE_MS = 1_000;

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
    `[budget] budget=${BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the addressable-session run did not ` +
      `finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, BUDGET_MS);
// Unref'd so the guard cannot itself hold the process open for the full budget
// once every case has finished.
budgetGuard.unref();

// ---------------------------------------------------------------------------
// The address, as the CLI registers it. Read here, independently.
// ---------------------------------------------------------------------------

/**
 * One live Claude process, as the CLI's own registry records it.
 *
 * `<configDir>/sessions/<pid>.json` is the file the CLI writes for each process
 * on the host. This criterion parses it here rather than through the driver's
 * `readCliSessionRegistration` on purpose: the reading is that the address the
 * app publishes is the address the process registered, and a reading that
 * compared the driver's answer to the driver's own reader would only be saying
 * that the reader equals itself. Two independent reads of the same file can
 * disagree, and that disagreement is the whole point.
 *
 * `nameSource` is the discriminator that makes path (a) measurable at all:
 * `derived` is the CLI's own per-process name, `user` is a name handed to the
 * process — which is exactly what the retired `--name` argument produced.
 */
type CliRegistration = {
  pid: number;
  sessionId: string | null;
  name: string | null;
  nameSource: string | null;
  messagingSocketPath: string | null;
};

function readCliRegistration(configDir: string, pid: number | null): CliRegistration | null {
  if (pid === null) {
    return null;
  }
  try {
    const row = JSON.parse(readFileSync(path.join(configDir, 'sessions', `${pid}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    return {
      pid,
      sessionId: typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : null,
      name: typeof row.name === 'string' && row.name ? row.name : null,
      nameSource: typeof row.nameSource === 'string' ? row.nameSource : null,
      messagingSocketPath:
        typeof row.messagingSocketPath === 'string' && row.messagingSocketPath ? row.messagingSocketPath : null,
    };
  } catch {
    // No registration yet, or one this process cannot read. A caller polls.
    return null;
  }
}

// ---------------------------------------------------------------------------
// The mock endpoint
// ---------------------------------------------------------------------------

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
   * The address the send turn's `SendMessage` call is aimed at.
   *
   * Set from `GET /api/session-hosts` by the criterion immediately before the
   * send turn, never derived here: the point of the leg is that the address a
   * client reads out of the app is the address that answers.
   */
  sendTo(name: string | null): void;
  /**
   * Holds the next request of B's cross-session turn instead of answering it.
   *
   * That hold is what makes the delivery observable *while it is running*: a
   * `chat.subscribe(lastSeq=0)` connection replays running runs only, so the
   * subscriber has to attach between the turn's first frames and its last, and
   * everything it then holds has to have come out of the run's own buffer.
   */
  hold(): void;
  /** Answers every held request, and stops holding. */
  release(): void;
  close(): Promise<void>;
};

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function textStream(text: string): string {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function toolStream(id: string, name: string, input: Record<string, unknown>): string {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * An Anthropic-compatible endpoint that answers the three conversations this
 * criterion drives, and records what it was sent.
 *
 * A request is an *agent* request when its body declares tool schemas: the SDK's
 * auxiliary requests (the title/small-model prompts) post to the same path with
 * the same credential and carry none, so the tool-schema marker separates a turn
 * from an auxiliary call. Which conversation a request belongs to is read from
 * the request body (see the marker note above); *which request of that
 * conversation* it is, is read from its content rather than from a counter,
 * because a turn's body accumulates the conversation and cannot say how many
 * requests preceded it. The send turn is therefore recognised by "this body
 * carries the send instruction and does not yet carry the tool call minted for
 * it", which stays true however many times the turn's request is posted.
 */
async function startMockAnthropic(): Promise<MockAnthropic> {
  const received: Received[] = [];
  const held: Array<() => void> = [];
  let holding = false;
  let sendTarget: string | null = null;

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

      if (!body.includes('"input_schema"')) {
        answer(textStream('aux ok'));
        return;
      }

      if (body.includes(MARKER_A)) {
        if (body.includes(A_SEND_TEXT) && !body.includes(SEND_TOOL_ID)) {
          answer(toolStream(SEND_TOOL_ID, 'SendMessage', {
            to: sendTarget,
            summary: CROSS_SUMMARY,
            message: CROSS_TEXT,
          }));
          return;
        }
        answer(textStream('AC164 alpha ack'));
        return;
      }

      if (body.includes(MARKER_B)) {
        if (body.includes(CROSS_TEXT)) {
          // The cross-session turn. Its first request gets a step of its own, so
          // the run holds frames a subscriber can be handed; its continuation is
          // the stretch the criterion holds and releases.
          if (!body.includes(SEND_TOOL_ID) && !body.includes('toolu_ac164_step')) {
            answer(toolStream('toolu_ac164_step', 'Bash', {
              command: `echo ${PEER_STEP_SENTINEL}`,
            }));
            return;
          }
          const finish = () => answer(textStream(PEER_ACK));
          if (holding) {
            held.push(finish);
            return;
          }
          finish();
          return;
        }
        answer(textStream('AC164 beta ack'));
        return;
      }

      if (body.includes(MARKER_C)) {
        answer(textStream('AC164 control ack'));
        return;
      }

      answer(textStream('AC164 unclassified'));
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    sendTo: (name: string | null) => { sendTarget = name; },
    hold: () => { holding = true; },
    release: () => {
      holding = false;
      for (const answer of held.splice(0)) {
        answer();
      }
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// ---------------------------------------------------------------------------
// Transport stand-ins and readings
// ---------------------------------------------------------------------------

type FakeSocket = EventEmitter & {
  readyState: number;
  OPEN: number;
  frames: Array<Record<string, unknown>>;
  sent: string[];
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

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

/** The frames of a run, in seq order — what a subscriber was actually handed. */
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
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
 * The session's own transcript, located by the conversation it holds.
 *
 * The provider session id the file is named after is not reachable from here:
 * the manager's binding never learns it — nothing reports it to the receiving
 * side — so the projection a client reads carries `null` where a lookup would
 * want an id. The conversation's own marker identifies the file instead: each
 * session's prompt carries its own marker, which is in that session's transcript
 * for as long as the transcript exists and in no other session's, because no
 * other session was ever sent it. What the caller reads out of the file
 * afterwards is the CLI's own statement, so identifying the file by content does
 * not weaken the reading it feeds.
 *
 * The newest match is the one returned, not the first one read. A session whose
 * process died on the way up and was then booted again can leave an earlier file
 * carrying the same marker behind — same session, same prompt, a different
 * process — and the file being appended to now is the one whose rows state what
 * the *current* process registered.
 */
function findTranscriptByMarker(configDir: string, marker: string): { path: string | null; scanned: number } {
  const projects = path.join(configDir, 'projects');
  let scanned = 0;
  if (!existsSync(projects)) {
    return { path: null, scanned };
  }
  const candidates: string[] = [];
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const file of readdirSync(path.join(projects, entry.name))) {
      if (file.endsWith('.jsonl')) {
        candidates.push(path.join(projects, entry.name, file));
      }
    }
  }
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const candidate of candidates) {
    scanned += 1;
    if (!readFileSync(candidate, 'utf8').includes(marker)) {
      continue;
    }
    const mtimeMs = statSync(candidate).mtimeMs;
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { path: candidate, mtimeMs };
    }
  }
  return { path: newest?.path ?? null, scanned };
}

/**
 * Every name the *app* wrote into the process's own transcript, in row order.
 *
 * The two rows a `--name <value>` launch produces are a pair: the CLI records
 * the handed-over name as the session's `agent-name` *and* as its
 * `custom-title`. Reading both is the point — a criterion that only looked at
 * `agent-name` would certify a build that still wrote the `custom-title` half.
 *
 * Under path (a) this list must be empty: the app hands the process no name at
 * all, so the process has none of its own to write down. This is the reading the
 * "restore `--name`" false form reds on, and it is independent of the registry
 * read above — one is what the process says about itself, the other what the
 * app publishes.
 */
function selfWrittenNames(rows: Array<Record<string, unknown>>): string[] {
  const names: string[] = [];
  for (const row of rows) {
    if (row.type === 'agent-name' && typeof row.agentName === 'string' && row.agentName) {
      names.push(row.agentName);
    }
    if (row.type === 'custom-title' && typeof row.customTitle === 'string' && row.customTitle) {
      names.push(row.customTitle);
    }
  }
  return names;
}

/** The input of one `SendMessage` tool call, as the process wrote it down. */
function toolUseInput(rows: Array<Record<string, unknown>>, toolUseId: string): Record<string, unknown> | null {
  for (const row of rows) {
    const message = record(row.message);
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      const asRecord = record(block);
      if (asRecord?.type === 'tool_use' && asRecord.id === toolUseId) {
        return record(asRecord.input);
      }
    }
  }
  return null;
}

/** The payload of the tool result the CLI wrote for one tool call. */
function toolResultPayload(rows: Array<Record<string, unknown>>, toolUseId: string): Record<string, unknown> | null {
  for (const row of rows) {
    const message = record(row.message);
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      const asRecord = record(block);
      if (asRecord?.type !== 'tool_result' || asRecord.tool_use_id !== toolUseId) {
        continue;
      }
      const inner = Array.isArray(asRecord.content) ? asRecord.content : [];
      const text = inner
        .map((part) => (typeof record(part)?.text === 'string' ? String(record(part)?.text) : ''))
        .join('');
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return record(JSON.parse(text.slice(start, end + 1)));
        } catch {
          return null;
        }
      }
      return null;
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

/** The model entry that points the CLI at the mock endpoint. */
function modelRows(baseUrl: string): ProviderModelEnvRow[] {
  return [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ];
}

// ---------------------------------------------------------------------------
// The REST projection this criterion reads addresses out of
// ---------------------------------------------------------------------------

type BindingRow = {
  appSessionId: string;
  providerSessionId: string | null;
  state: string;
  peerName: string | null;
};

type HostRow = {
  hostId: string;
  state: string;
  pid: number | null;
  bindings: BindingRow[];
};

async function readHosts(apiBaseUrl: string): Promise<HostRow[]> {
  const response = await getJson(`${apiBaseUrl}/api/session-hosts`);
  assert.strictEqual(response.status, 200, `GET /api/session-hosts must answer (${response.status})`);
  const body = record(JSON.parse(response.body)) ?? {};
  const data = record(body.data) ?? {};
  return (Array.isArray(data.hosts) ? data.hosts : []) as HostRow[];
}

async function readBinding(
  apiBaseUrl: string,
  appSessionId: string,
): Promise<{ host: HostRow; binding: BindingRow } | null> {
  for (const host of await readHosts(apiBaseUrl)) {
    const binding = (host.bindings ?? []).find((candidate) => candidate.appSessionId === appSessionId);
    if (binding && host.state !== 'closed') {
      return { host, binding };
    }
  }
  return null;
}

/**
 * The address the app publishes for one session, polled until it lands.
 *
 * Polled rather than read once because the driver reports the address only after
 * it has read it back out of the process, and a bounded wait that gives up is a
 * reading (`null`, printed) and not a failure: the arms that are supposed to have
 * no address must still reach their assertion.
 */
async function awaitPeerName(
  apiBaseUrl: string,
  appSessionId: string,
  timeoutMs: number,
  label: string,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  for (;;) {
    const found = await readBinding(apiBaseUrl, appSessionId);
    last = found?.binding.peerName ?? null;
    if (last || Date.now() >= deadline) {
      break;
    }
    await sleep(100);
  }
  if (!last) {
    console.log(`[readings] awaitPeerName read no address (${label}, waited ${timeoutMs}ms)`);
  }
  return last;
}

/** One session's identity, as the app's projection and the process's own file state it. */
type IdentityReading = {
  sessionId: string;
  label: string;
  /** The title the app holds for this session, or `''` for the control arm that holds none. */
  title: string;
  hostPid: number | null;
  hostState: string;
  /** The projection's own `providerSessionId`, printed to show it cannot be the lookup key. */
  providerSessionId: string | null;
  /** What the app publishes as this session's address (`GET /api/session-hosts`). */
  snapshotPeerName: string | null;
  /** The CLI's registration for this session's process, read here off disk. */
  registration: CliRegistration | null;
  /** Convenience copies of the registration's own fields, for printing. */
  registryName: string | null;
  registryNameSource: string | null;
  transcriptPath: string | null;
  transcriptFile: string | null;
  transcriptsScanned: number;
  /** Every name the app wrote into the process's transcript; empty under path (a). */
  selfWrittenNames: string[];
  /**
   * The address the app publishes is the address the process registered.
   *
   * The registration has to *carry* a name for this to hold: two absences are
   * not an agreement, and reading them as one would make the graded false form
   * (`--name` restored, app publishes nothing) pass.
   */
  equalToSnapshot: boolean;
};

async function readIdentity(
  apiBaseUrl: string,
  configDir: string,
  label: string,
  appSessionId: string,
  title: string | null,
  marker: string,
  waitMs: number,
): Promise<IdentityReading> {
  const found = await readBinding(apiBaseUrl, appSessionId);
  const hostPid = found?.host.pid ?? null;
  const snapshotPeerName = await awaitPeerName(apiBaseUrl, appSessionId, waitMs, `${label} identity`);
  const located = findTranscriptByMarker(configDir, marker);
  const transcript = located.path;
  const registration = readCliRegistration(configDir, hostPid);
  return {
    sessionId: appSessionId,
    label,
    title: title ?? '',
    hostPid,
    hostState: found?.host.state ?? 'missing',
    providerSessionId: found?.binding.providerSessionId ?? null,
    snapshotPeerName,
    registration,
    registryName: registration?.name ?? null,
    registryNameSource: registration?.nameSource ?? null,
    transcriptPath: transcript,
    transcriptFile: transcript ? path.basename(transcript) : null,
    transcriptsScanned: located.scanned,
    selfWrittenNames: transcript ? selfWrittenNames(readJsonLines(transcript)) : [],
    equalToSnapshot: Boolean(registration?.name) && snapshotPeerName === registration?.name,
  };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

type Harness = {
  socket: FakeSocket;
  desktopSocket: FakeSocket;
  userId: number;
  cwd: string;
  apiBaseUrl: string;
  configDir: string;
  mock: MockAnthropic;
};

/**
 * The harness this criterion runs inside: temp database, temp Claude config, a
 * registered desktop notification client, and the production dispatch.
 *
 * The runtime is the production `createProviderRuntimeService()`, so the turns
 * that route here are routed by the same `lifecycle_mode` read the chat handler
 * performs. The provider routes are mounted without auth, because what is being
 * measured is the host layer's own state and not the token check in front of it.
 */
async function withAddressableHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-addressable-'));
  const configDir = path.join(tempDirectory, 'claude-config');
  const saved = new Map<string, string | undefined>(
    ['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .map((name) => [name, process.env[name]]),
  );

  mkdirSync(path.join(tempDirectory, '.claude'), { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const mock = await startMockAnthropic();
  const app = express();
  app.use(express.json());
  app.use('/api/providers', providerRoutes);
  app.use('/api/session-hosts', createSessionHostsRouter({ sessionHostManager }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });
  const apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const desktopSocket = createFakeSocket();

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
    const user = userDb.createUser('claude-resident-addressable', 'unused-hash');

    const now = new Date().toISOString();
    for (const [sessionId, title] of [
      [SESSION_A, TITLE_A],
      [SESSION_B, TITLE_B],
      [SESSION_C, 'AC164 Addressable Control'],
    ] as Array<[string, string]>) {
      sessionsDb.createSession(sessionId, 'claude', tempDirectory, title, now, now, null);
      // A session the app has never resumed has no provider session id yet, and
      // the driver mints one at launch rather than reading this column.
      getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(sessionId);
      assert.strictEqual(sessionsDb.setSessionLifecycleMode(sessionId, 'resident'), true);
      assert.strictEqual(sessionsDb.getSessionLifecycleMode(sessionId), 'resident');
    }

    providerModelsDb.createCustomProviderModel('claude', {
      id: MODEL_ID,
      model: MODEL_ID,
      config: { env: modelRows(mock.baseUrl) },
    });

    // The desktop channel is off by default, so the notification this criterion
    // reads has to be opted into the way a user opts in.
    notificationPreferencesDb.updatePreferences(Number(user.id), { channels: { desktop: true } });
    registerDesktopNotificationClient({
      userId: Number(user.id),
      deviceId: 'ac164-desktop',
      ws: desktopSocket as never,
    });

    // The composition root's one line, reproduced here for the same reason the
    // routers above are mounted here: this criterion runs the harness, not the
    // process entry point, and without the seam a resident process's own turn has
    // nowhere to open a run — the frames stay with the last writer, and the
    // cross-session arrival would be the one case the app could not report.
    sessionHostManager.setUnattendedRunOpener((input) => chatRunRegistry.openUnattendedRun(input));

    const socket = createFakeSocket();
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
      mock,
    });
  } finally {
    sessionHostManager.setUnattendedRunOpener(null);
    unregisterDesktopNotificationClient(desktopSocket as never);
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

/**
 * Sends one user turn and answers with its terminal `complete` frame.
 *
 * `sessionSummary` is passed the way the app passes it — it is the title the
 * driver is handed along with a turn. `extraOptions` are merged in last and
 * exist for one caller: the handed-over-name arm, which launches a process the
 * way the retired plumbing did (a raw CLI flag carried in the option bag).
 */
async function sendRound(
  socket: FakeSocket,
  sessionId: string,
  content: string,
  sessionSummary: string | null,
  cwd: string,
  extraOptions: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const completes = (): Array<Record<string, unknown>> =>
    socket.frames.filter((frame) => frame.kind === 'complete' && frame.sessionId === sessionId);
  const before = completes().length;
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId,
    content,
    options: {
      cwd,
      model: MODEL_ID,
      permissionMode: 'bypassPermissions',
      ...(sessionSummary ? { sessionSummary } : {}),
      ...extraOptions,
    },
  }));
  await waitFor(() => completes().length > before, TURN_TIMEOUT_MS, `round "${content.slice(0, 40)}" to complete`);
  return completes().at(-1) as Record<string, unknown>;
}

/**
 * Boots one resident session, retrying a process that died on the way up.
 *
 * The retry is here rather than in the readings because the failure it absorbs
 * is environmental: the provider CLI exits non-zero before it reaches the mock
 * at all, which is a fact about the machine the criterion runs on and not about
 * the address rule. Left unretried it would not red the address arms — a process
 * that never started simply reads as a session with no address — it would
 * hollow out the control arm, whose whole claim is that a *live* host launched
 * without a title publishes none. So the boot is made to land here, and its
 * landing is asserted after it, which is what makes the control's `null` mean
 * "no address" and not "no process".
 *
 * Every attempt is recorded, so a retry is visible in the log and a session that
 * only ever came up on the second try cannot pass as one that came up first.
 */
async function bootResidentSession(
  socket: FakeSocket,
  sessionId: string,
  marker: string,
  title: string | null,
  cwd: string,
  label: string,
): Promise<{ frame: Record<string, unknown>; exits: number[]; attempts: number }> {
  const exits: number[] = [];
  for (;;) {
    const frame = await sendRound(socket, sessionId, `${marker}BOOT first turn`, title, cwd);
    const exitCode = typeof frame.exitCode === 'number' ? frame.exitCode : 0;
    exits.push(exitCode);
    const landed = exitCode === 0 && frame.aborted === false;
    if (landed || exits.length >= BOOT_ATTEMPTS) {
      return { frame, exits, attempts: exits.length };
    }
    console.log(
      `[readings] boot retry session=${label} attempt=${exits.length} exit=${exitCode} ` +
        `(the process did not come up; sending the first turn again)`,
    );
    await sleep(250);
  }
}

/** One more connection to the chat protocol, for the subscribe legs. */
function openConnection(userId: number): FakeSocket {
  const socket = createFakeSocket();
  handleChatConnection(
    socket as never,
    { user: { id: userId } } as never,
    { runtime: createProviderRuntimeService() as never },
  );
  return socket;
}

function subscribe(socket: FakeSocket, sessionId: string): void {
  socket.emit('message', JSON.stringify({
    type: 'chat.subscribe',
    sessions: [{ sessionId, lastSeq: 0 }],
  }));
}

/** The host driver this criterion reads its readings off. */
function residentDriver(): ClaudeResidentHostDriver {
  return providerRegistry.resolveProvider('claude').hostDriver as unknown as ClaudeResidentHostDriver;
}

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

test('a resident session publishes the address it answers to, and a peer reaches it there', { timeout: 180_000 }, async () => {
  const elapsed = () => `${Date.now() - STARTED_AT}ms`;

  await withAddressableHarness(async (context) => {
    const { socket, desktopSocket, cwd, apiBaseUrl, configDir, mock } = context;

    // ---------------------------------------------------------------------
    // Leg 1 — three resident processes: two named, one the no-title control.
    //
    // Started one at a time, and not because the readings need it: the driver
    // hands a first turn's process to the manager through a single per-driver
    // slot (`startResidentHost` fills it, `startHost` consumes it), so two
    // sessions' *first* turns in flight at once would collide and the second
    // would be opened without a process. That is a property of the launch path
    // this criterion stands on rather than anything it measures, so the starts
    // are ordered and everything read afterwards is not.
    // ---------------------------------------------------------------------
    const legOne = Date.now();
    const bootA = await bootResidentSession(socket, SESSION_A, MARKER_A, TITLE_A, cwd, 'A');
    const bootB = await bootResidentSession(socket, SESSION_B, MARKER_B, TITLE_B, cwd, 'B');
    const bootC = await bootResidentSession(socket, SESSION_C, MARKER_C, null, cwd, 'C');
    const boots = [bootA, bootB, bootC];
    const booted = boots.every(
      (boot) => boot.frame.exitCode === 0 && boot.frame.aborted === false,
    );
    console.log(
      `[readings] booted=${booted} ` +
        `bootExits=${boots.flatMap((boot) => boot.exits).join(',')} ` +
        `bootAttempts=${boots.map((boot) => String(boot.attempts)).join(',')} ` +
        `agentRequests=${mock.received.filter((entry) => entry.body.includes('"input_schema"')).length} ` +
        `leg1=${Date.now() - legOne}ms`,
    );
    // Asserted, not just printed: every reading below — including the control's
    // absent address — is a statement about a process, so a process that never
    // came up has to stop the case here instead of quietly making the control
    // arm vacuous.
    assert.strictEqual(
      booted,
      true,
      `all three resident processes must come up before the address readings mean anything ` +
        `(exits=${boots.flatMap((boot) => boot.exits).join(',')} attempts=${boots.map((boot) => String(boot.attempts)).join(',')})`,
    );

    // ---------------------------------------------------------------------
    // Leg 2 — the identity readings, all three at once.
    //
    // Read together rather than in a row because each one has a deadline of its
    // own inside the driver: a binding that never learns an address says so only
    // when that deadline expires, and three of those in series would spend the
    // criterion's whole budget before the false form reached the reading it is
    // graded on.
    // ---------------------------------------------------------------------
    const legTwo = Date.now();
    const [alpha, beta, control] = await Promise.all([
      readIdentity(apiBaseUrl, configDir, 'A', SESSION_A, TITLE_A, MARKER_A, IDENTITY_TIMEOUT_MS),
      readIdentity(apiBaseUrl, configDir, 'B', SESSION_B, TITLE_B, MARKER_B, IDENTITY_TIMEOUT_MS),
      readIdentity(apiBaseUrl, configDir, 'C', SESSION_C, null, MARKER_C, IDENTITY_TIMEOUT_MS),
    ]);
    const legTwoMs = Date.now() - legTwo;

    for (const reading of [alpha, beta, control]) {
      console.log(
        `[readings] session=${reading.label} hostPid=${String(reading.hostPid)} hostState=${reading.hostState} ` +
          `registryName=${String(reading.registryName)} registryNameSource=${String(reading.registryNameSource)} ` +
          `registrySessionId=${String(reading.registration?.sessionId ?? null)} ` +
          `registrySocket=${reading.registration?.messagingSocketPath ? 'present' : 'absent'} ` +
          `snapshotPeerName=${String(reading.snapshotPeerName)} equalToSnapshot=${reading.equalToSnapshot} ` +
          `selfWrittenNames=${JSON.stringify(reading.selfWrittenNames)} titleHeldByApp=${JSON.stringify(reading.title)}`,
      );
    }
    console.log(
      `[readings] transcriptFile=${String(alpha.transcriptFile)} transcriptsScanned=${alpha.transcriptsScanned} ` +
        `bindingProviderSessionId=${String(alpha.providerSessionId)} leg2=${legTwoMs}ms`,
    );

    // The tool table is a fact of the process, read off its own `system/init`:
    // a process that can be addressed must have been handed the tool that
    // addresses, and this is the reading that says so without going through the
    // mock or through any claim of this criterion's own.
    const readingB: ClaudeUnattendedReading | null = residentDriver().unattendedReading(SESSION_B);
    const toolTable = readingB?.initTools ?? [];
    const sendMessageInToolTable = toolTable.includes('SendMessage');
    // The negative control: a tool the process lacks must read absent, which is
    // what says this table is a report rather than a list that answers yes to
    // everything. Monitor was the original control, but the CLI now includes it
    // in its default table (2.1.x), so a real name would pin the installed
    // binary's tool set instead of this reader — hence a name no build ships.
    const absentToolName = 'NoSuchToolInTheProcess';
    const absentToolInToolTable = toolTable.includes(absentToolName);
    console.log(
      `[readings] sendMessageInToolTable=${sendMessageInToolTable} absentToolInToolTable=${absentToolInToolTable} ` +
        `tools=${toolTable.length} leg2=${legTwoMs}ms`,
    );

    // ---------------------------------------------------------------------
    // The address assertions, taken here rather than at the end.
    //
    // Two reasons, and the second is the load-bearing one. The address is what
    // every later leg stands on — a session with no address cannot be sent to —
    // and the false form this criterion is graded against (the driver goes back
    // to computing `<slug>-<id6>` and handing it over) has to red on *this*
    // reading and not on a wait downstream of it. Asserting here is what puts
    // the red on the reading the criterion names, while every wait after this
    // point is inside the budget.
    //
    // The reading is deliberately a comparison of two independent reads: the
    // app's own REST projection (`snapshotPeerName`) against the CLI's registry
    // file, parsed in this file by `readCliRegistration`. Nothing here calls the
    // driver's reader, so "the app publishes what the process registered" cannot
    // be satisfied by a reader agreeing with itself.
    // ---------------------------------------------------------------------
    assert.strictEqual(
      alpha.equalToSnapshot,
      true,
      `the app must publish the address the process registered, and the process must have registered one ` +
        `(snapshot=${String(alpha.snapshotPeerName)} registry=${String(alpha.registryName)} ` +
        `registryNameSource=${String(alpha.registryNameSource)} providerSessionId=${String(alpha.providerSessionId)})`,
    );
    assert.strictEqual(
      beta.equalToSnapshot,
      true,
      `the second resident session must publish the address it registered too ` +
        `(snapshot=${String(beta.snapshotPeerName)} registry=${String(beta.registryName)} ` +
        `registryNameSource=${String(beta.registryNameSource)} providerSessionId=${String(beta.providerSessionId)})`,
    );
    // AC2: the name the process carries is the CLI's own (`derived`), not one
    // handed to it — a `--name` launch reads `user` here, even when the value is
    // byte-identical to what a derivation would have produced. This is the
    // assertion that separates "the app happens to publish the right string"
    // from "the app did not name the process at all".
    assert.strictEqual(
      alpha.registryNameSource,
      'derived',
      `the process must be registered under a name the CLI derived for it, not one it was handed ` +
        `(registryNameSource=${String(alpha.registryNameSource)} registryName=${String(alpha.registryName)})`,
    );
    assert.strictEqual(beta.registryNameSource, 'derived', `the second process must read \`derived\` as well (${String(beta.registryNameSource)})`);
    // AC2, the other half: the app writes nothing into the process's own file.
    // The two rows a handed-over name produces are `agent-name` and
    // `custom-title`, and an empty list is the statement that neither is there.
    assert.deepEqual(
      alpha.selfWrittenNames,
      [],
      `the app must not write a name into the process's transcript (found ${JSON.stringify(alpha.selfWrittenNames)})`,
    );
    // AC5: the record the address was read from is *this* conversation's record.
    // The registry is keyed by pid, and pids are recycled on a busy host, so "the
    // names matched" would mean nothing if the file were some other process's.
    // The check is against a third read of this criterion's own: the transcript
    // it located by A's private marker, whose file name *is* the conversation id
    // the CLI assigned. The registry entry has to name that same conversation.
    const transcriptConversationId = alpha.transcriptFile?.replace(/\.jsonl$/, '') ?? null;
    assert.notStrictEqual(
      alpha.registration?.sessionId,
      null,
      'the registry entry the address was read from must carry the conversation id',
    );
    assert.strictEqual(
      alpha.registration?.sessionId,
      transcriptConversationId,
      `the registry entry must name the conversation whose transcript this criterion found ` +
        `(registry=${String(alpha.registration?.sessionId)} transcript=${String(transcriptConversationId)})`,
    );
    assert.notStrictEqual(
      alpha.registration?.messagingSocketPath,
      null,
      'the registry entry must carry the socket the address resolves to, or the address is not reachable',
    );
    // The pollution shape itself, read on the published address: CloudCLI's
    // suffix was the app session id's first six characters appended to a slug.
    // A derived name is the CLI's and has no such tail.
    assert.strictEqual(
      String(alpha.snapshotPeerName).endsWith(`-${SESSION_A.slice(0, 6)}`),
      false,
      `the published address must not carry the app-side suffix shape (${String(alpha.snapshotPeerName)})`,
    );
    // The other half of the same rule, and the one the three rows above are
    // graded on: whatever the app displays for a session — the placeholder it
    // made up while waiting for a title, or the title itself — the address is
    // never it. An address is something a *peer* types, and a display name is a
    // value this app is free to revise; the moment the two are the same string,
    // the app has gone back to naming a process it does not own. Read against
    // the row rather than against the title handed in, because the control
    // session's stored name is the one the app would show.
    for (const reading of [alpha, beta, control]) {
      const displayedName = sessionsDb.getSessionById(reading.sessionId)?.custom_name ?? null;
      assert.notStrictEqual(
        reading.snapshotPeerName,
        displayedName,
        `the published address must never be the app-side name for the session ` +
          `(${reading.label}: address=${String(reading.snapshotPeerName)} displayed=${String(displayedName)})`,
      );
    }
    // The control arm, re-expressed for path (a). It is no longer "a host with
    // no title has no address" — under (a) a session's address does not depend
    // on any title the app holds, and this host was launched with none. So the
    // control now reads the *opposite* way: a titleless session still publishes
    // the address its own process registered, which is what makes the pair
    // falsifiable — a driver that went back to deriving the address from a title
    // would publish nothing here, and one that invented a name would disagree
    // with this process's registry file.
    assert.notStrictEqual(
      control.hostPid,
      null,
      'the control session must be served by a live process, or its address says nothing',
    );
    assert.notStrictEqual(
      control.hostState,
      'closed',
      `the control host must still be open when its address is read (state=${control.hostState})`,
    );
    assert.strictEqual(
      control.equalToSnapshot,
      true,
      `a titleless resident session must still publish the address its process registered ` +
        `(snapshot=${String(control.snapshotPeerName)} registry=${String(control.registryName)} ` +
        `registryNameSource=${String(control.registryNameSource)})`,
    );
    assert.strictEqual(
      control.registryNameSource,
      'derived',
      `the control's process must be registered under a derived name too (${String(control.registryNameSource)})`,
    );

    // ---------------------------------------------------------------------
    // Leg 2b — the control that makes every reading above falsifiable.
    //
    // Three readings have now come out one way: no name in the transcript,
    // `derived` in the registry, an address the app read rather than made up. A
    // reading that can only ever come out that way measures nothing, so this leg
    // runs the *same* three readings on the *same* session with one variable
    // changed: the process is launched with a name handed to it, through the
    // very option the retired plumbing used (`extraArgs.name` → the CLI's
    // `--name`). Everything else — the session row, the transcript, the config
    // dir, the driver, the projection — is what it was for C a moment ago.
    //
    // All three have to flip. If they do not, the assertions above are reading
    // the harness rather than the behaviour: a `--name` that left `derived` in
    // the registry would mean the registry is not where the name came from, and
    // a `--name` that wrote nothing into the transcript would mean the
    // transcript is not where a handed-over name is recorded.
    // ---------------------------------------------------------------------
    const HANDED_OVER_NAME = `${RUN_TAG}-handed-over`;
    const hostOfC = (await readHosts(apiBaseUrl)).find(
      (host) => host.state !== 'closed' && (host.bindings ?? []).some((b) => b.appSessionId === SESSION_C),
    );
    assert.ok(hostOfC, 'the control session must still be served by an open host before the handed-over-name arm');
    const controlFirstPid = hostOfC.pid;
    sessionHostManager.closeHost(hostOfC.hostId, 'user');
    await waitFor(
      () => controlFirstPid === null || !existsSync(`/proc/${controlFirstPid}`),
      10_000,
      'the control session\'s first process to be gone before the handed-over-name launch',
    );
    const namedBoot = await sendRound(socket, SESSION_C, `${MARKER_C}BOOT first turn`, null, cwd, {
      extraArgs: { name: HANDED_OVER_NAME },
    });
    const handedOver = await readIdentity(apiBaseUrl, configDir, 'C-named', SESSION_C, null, MARKER_C, IDENTITY_TIMEOUT_MS);
    console.log(
      `[readings] handed-over session=${handedOver.label} requested=${HANDED_OVER_NAME} ` +
        `exit=${String(namedBoot.exitCode)} registryName=${String(handedOver.registryName)} ` +
        `registryNameSource=${String(handedOver.registryNameSource)} ` +
        `snapshotPeerName=${String(handedOver.snapshotPeerName)} ` +
        `selfWrittenNames=${JSON.stringify(handedOver.selfWrittenNames)}`,
    );
    assert.strictEqual(
      handedOver.registryNameSource,
      'user',
      `a name handed to the process must register as the user's, not as the CLI's own derivation ` +
        `(registryNameSource=${String(handedOver.registryNameSource)})`,
    );
    assert.strictEqual(
      handedOver.registryName,
      HANDED_OVER_NAME,
      `the registry must carry the name that was handed over (${String(handedOver.registryName)})`,
    );
    assert.strictEqual(
      handedOver.selfWrittenNames.length > 0 && handedOver.selfWrittenNames.every((name) => name === HANDED_OVER_NAME),
      true,
      `a handed-over name must show up in the process's own transcript — both rows of it ` +
        `(found ${JSON.stringify(handedOver.selfWrittenNames)})`,
    );
    // And the address the app publishes follows the handed-over name here,
    // because it is reading the registry: one more statement that the projection
    // has no name of its own to fall back on.
    assert.strictEqual(
      handedOver.snapshotPeerName,
      HANDED_OVER_NAME,
      `the projection must publish whatever the process registered, including a handed-over name ` +
        `(${String(handedOver.snapshotPeerName)})`,
    );
    assert.strictEqual(sendMessageInToolTable, true, 'a process that can be addressed must have been handed the tool that addresses');
    assert.strictEqual(absentToolInToolTable, false, `the tool table is the process's own, so a tool it lacks must read absent (${absentToolName})`);

    // ---------------------------------------------------------------------
    // Leg 3 — the rename, through the app's own rename path, before the turn
    // that delivers.
    //
    // The turn below carries the renamed title as its summary, which is exactly
    // what a driver that recomputed the address per turn would derive a new name
    // from — so one turn proves both halves: that the address did not move, and
    // that the delivery still went to the address computed from the *original*
    // title.
    // ---------------------------------------------------------------------
    const pidBefore = alpha.hostPid;
    const nameBefore = alpha.snapshotPeerName;
    const renamed = await sessionsService.renameSessionById(SESSION_A, TITLE_A_RENAMED);
    assert.strictEqual(renamed.summary, TITLE_A_RENAMED, 'the rename must have been recorded');
    // The desktop channel's own liveness, read while it is provably live: the
    // boot rounds report their endings over it, so a count of zero
    // background-work reports later means exactly that rather than a channel
    // that was never up.
    const stopReportsBefore = notificationFrames(desktopSocket, 'run.stopped').length;
    assert.ok(
      stopReportsBefore > 0,
      `the desktop channel must be live before the delivery leg (saw ${stopReportsBefore} stop reports)`,
    );

    // ---------------------------------------------------------------------
    // Leg 4 — the delivery, addressed from the REST projection.
    // ---------------------------------------------------------------------
    const addressFromRest = await awaitPeerName(apiBaseUrl, SESSION_B, IDENTITY_TIMEOUT_MS, 'B address for the send');
    console.log(`[readings] addressSource=GET /api/session-hosts peerName=${String(addressFromRest)}`);
    assert.strictEqual(addressFromRest, beta.registryName, `the projected address must be B's own registered name (${String(addressFromRest)} !== ${String(beta.registryName)})`);
    // The address a client would copy is the address the send is aimed at: the
    // mock is handed this value and nothing else, so the `to` in the tool call
    // below can only have come from here.
    mock.sendTo(addressFromRest);

    // The run log is emptied here so the replay leg's control reads the same
    // registry the arriving turn lands in and learns nothing from the boots.
    chatRunRegistry.clearAll();
    const replayEventsBefore = chatRunRegistry.replayEvents(SESSION_B, 0).length;
    // What a client is handed before the delivery, read the way a client gets
    // it — a fresh connection subscribing with `lastSeq=0`. This is the control
    // for the replay reading below and is measured the same way, so the pair
    // compares: 0 before, every frame after.
    const beforeSocket = openConnection(context.userId);
    subscribe(beforeSocket, SESSION_B);
    await sleep(500);
    const replayedBefore = framesWithSeq(beforeSocket).length;
    const runsBefore = chatRunRegistry.getRun(SESSION_B)?.status === 'running' ? 1 : 0;

    mock.hold();
    const sendRoundA = await sendRound(socket, SESSION_A, A_SEND_TEXT, TITLE_A_RENAMED, cwd);
    const userTurnRun = chatRunRegistry.getRun(SESSION_A);
    const notifyBeforeDelivery = notificationFrames(desktopSocket, 'run.background_completed').length;
    // The user turn's own account of itself: a run the app was asked for, and no
    // background-work report at all — which is what the arriving turn below is
    // contrasted against. Read before the release, since the arriving turn's
    // report is what will follow it.
    console.log(
      `[readings] userTurn run.source=${String(userTurnRun?.source ?? 'none')} ` +
        `run.trigger=${notifyBeforeDelivery === 0 ? 'none' : String(record(record(notificationFrames(desktopSocket, 'run.background_completed').at(-1)?.payload)?.data)?.trigger ?? 'none')} ` +
        `reportsBefore=${notifyBeforeDelivery} roundExit=${String(sendRoundA.exitCode)}`,
    );

    const opened = await waitFor(
      () => chatRunRegistry.isProcessing(SESSION_B) && chatRunRegistry.getRun(SESSION_B)?.source === 'unattended',
      TURN_TIMEOUT_MS,
      'B to open a run for the arriving message',
    );
    // Read while the turn is still open: the count is "how many runs this session
    // has running", which is what says a run was added rather than replaced.
    const runsAfter = chatRunRegistry.getRun(SESSION_B)?.status === 'running' ? 1 : 0;

    // The subscriber joins once the turn has frames buffered and before its
    // continuation is answered: the only window in which the subscribe path has
    // something to replay and the run is still running. Either side would make
    // the leg vacuous — a completed run is served over REST, and a run that has
    // produced nothing has nothing to replay.
    const buffered = await waitFor(
      () => (chatRunRegistry.getRun(SESSION_B)?.lastSeq ?? 0) > 0,
      TURN_TIMEOUT_MS,
      'B\'s arriving turn to buffer its first frames',
    );
    await sleep(250);
    const framesBeforeSubscribe = chatRunRegistry.getRun(SESSION_B)?.lastSeq ?? 0;

    const replaySocket = openConnection(context.userId);
    subscribe(replaySocket, SESSION_B);
    const replayLanded = await waitFor(
      () => framesWithSeq(replaySocket).length > 0,
      5_000,
      'the subscribe replay to land while the turn is still held',
    );
    const replayedAtSubscribe = framesWithSeq(replaySocket).length;

    // The sender's own account of the delivery, read out of the transcript the
    // process wrote: the address it aimed at, and whether the CLI answered that
    // the message was taken.
    const afterRename = await readIdentity(apiBaseUrl, configDir, 'A', SESSION_A, TITLE_A_RENAMED, MARKER_A, IDENTITY_TIMEOUT_MS);
    const pidAfter = afterRename.hostPid;
    const nameAfter = afterRename.snapshotPeerName;
    const alphaRows = alpha.transcriptPath ? readJsonLines(alpha.transcriptPath) : [];
    const sentTo = toolUseInput(alphaRows, SEND_TOOL_ID)?.to ?? null;
    const payload = toolResultPayload(alphaRows, SEND_TOOL_ID);
    const delivered = payload?.success === true;
    console.log(
      `[readings] pidBefore=${String(pidBefore)} pidAfter=${String(pidAfter)} ` +
        `peerNameBefore=${String(nameBefore)} peerNameAfter=${String(nameAfter)} ` +
        `pidUnchanged=${pidBefore !== null && pidBefore === pidAfter} ` +
        `nameUnchanged=${nameBefore !== null && nameBefore === nameAfter}`,
    );
    console.log(
      `[readings] sentFrom=${String(nameAfter ?? nameBefore)} sentTo=${String(sentTo)} delivered=${delivered} ` +
        `sendExit=${String(sendRoundA.exitCode)} deliveryMessage=${String(payload?.message ?? 'none').slice(0, 160)}`,
    );

    mock.release();
    await waitFor(() => chatRunRegistry.isProcessing(SESSION_B) === false, TURN_TIMEOUT_MS, 'B\'s turn to complete');
    await sleep(SETTLE_MS);

    const runB = chatRunRegistry.getRun(SESSION_B);
    const replayed = framesWithSeq(replaySocket).length;
    const produced = runB?.events.length ?? 0;
    const notifyFrames = notificationFrames(desktopSocket, 'run.background_completed');
    const notifyTrigger = record(record(notifyFrames.at(-1)?.payload)?.data)?.trigger ?? null;
    console.log(
      `[readings] run.source=${String(runB?.source ?? 'none')} run.trigger=${String(notifyTrigger)} ` +
        `runsBefore=${runsBefore} runsAfter=${runsAfter}`,
    );
    console.log(
      `[readings] replayed=${replayed} produced=${produced} replayed-before=${replayedBefore} ` +
        `replayEventsBefore=${replayEventsBefore} replayedAtSubscribe=${replayedAtSubscribe} ` +
        `framesBeforeSubscribe=${framesBeforeSubscribe} appSessionId=${String(runB?.appSessionId ?? 'none')}`,
    );
    console.log(`[readings] buffered=${buffered} replayLanded=${replayLanded} opened=${opened}`);

    // ---------------------------------------------------------------------
    // Assertions — the delivery and its replay.
    // ---------------------------------------------------------------------
    assert.strictEqual(pidBefore !== null && pidBefore === pidAfter, true, `the rename must not move the process (${String(pidBefore)} -> ${String(pidAfter)})`);
    assert.strictEqual(nameBefore !== null && nameBefore === nameAfter, true, `the rename must not move the address (${String(nameBefore)} -> ${String(nameAfter)})`);
    assert.strictEqual(afterRename.snapshotPeerName, alpha.registryName, 'the address after the rename must still be the one the CLI registered for the process');
    assert.strictEqual(userTurnRun?.source, 'user', 'a turn the app was asked for must be a user run, not the host layer\'s');
    assert.strictEqual(
      notifyBeforeDelivery,
      0,
      `no background-work report may exist before the delivery (saw ${notifyBeforeDelivery})`,
    );

    assert.strictEqual(sentTo, addressFromRest, `the send must be aimed at the address the REST projection published (${String(sentTo)})`);
    assert.strictEqual(delivered, true, `the CLI must report the message as taken (${JSON.stringify(payload)})`);
    assert.strictEqual(opened, true, 'the arriving message must open a run on the addressed session');
    assert.strictEqual(runB?.source, 'unattended', 'the run the message opened must be the host layer\'s own, not a user turn');
    assert.strictEqual(runsAfter, runsBefore + 1, `the delivery must add exactly one run (${runsBefore} -> ${runsAfter})`);
    assert.strictEqual(
      notifyTrigger,
      'cross-session-message',
      `the report must name the arrival rather than an unexplained turn (${String(notifyTrigger)})`,
    );
    assert.strictEqual(runB?.appSessionId, SESSION_B, 'the run must be keyed by the addressed session');
    assert.strictEqual(replayedBefore, 0, `a subscriber attaching before the delivery must be handed nothing (${replayedBefore})`);
    assert.ok(replayed > 0, `a subscriber attaching mid-turn must be handed the turn's frames (replayed=${replayed})`);
    assert.strictEqual(replayed, produced, `the subscriber must end up with every frame the turn produced (${replayed} !== ${produced})`);
    assert.strictEqual(framesBeforeSubscribe, replayedAtSubscribe, `the subscribe must hand over exactly what was buffered when it attached (${replayedAtSubscribe} !== ${framesBeforeSubscribe})`);

    // ---------------------------------------------------------------------
    // Leg 5 — a restart does not grow the name.
    //
    // This is the shape the task record measured on 2026-09-30 and filed the gap
    // for: a resident session came back from a restart as
    // `<slug>-<id6>-<id6>`, because the name the app had stored was fed back in
    // as the *seed* for the next name. Path (a) removes the mechanism at its
    // root — the app hands the process nothing on either launch — so the two
    // readings here have to move together: the name the app holds for the
    // session is not rewritten by a launch, and the name the second process
    // registers is not longer than the first one's.
    //
    // The two registered names are *allowed* to differ. A fresh process gets a
    // fresh name from the CLI's own derivation, and that is the CLI's business;
    // what must not happen is one launch inheriting the previous launch's name
    // and appending to it. So the assertion is about length and shape, never
    // about equality — asserting equality would be asserting the CLI's
    // derivation, which this criterion has no business constraining.
    // ---------------------------------------------------------------------
    const storedNameBefore = sessionsDb.getSessionById(SESSION_A)?.custom_name ?? null;
    const hostOfA = (await readHosts(apiBaseUrl)).find(
      (host) => host.state !== 'closed' && (host.bindings ?? []).some((b) => b.appSessionId === SESSION_A),
    );
    assert.ok(hostOfA, 'A must still be served by an open host before the restart leg');
    const firstPid = hostOfA.pid;
    sessionHostManager.closeHost(hostOfA.hostId, 'user');
    await waitFor(
      () => firstPid === null || !existsSync(`/proc/${firstPid}`),
      10_000,
      'A\'s first process to be gone before the restart',
    );
    // The same user action the DoD walks: the process ended, a message is sent,
    // and the session comes back on a new process.
    const secondBoot = await bootResidentSession(socket, SESSION_A, MARKER_A, TITLE_A_RENAMED, cwd, 'A-restart');
    const second = await readIdentity(apiBaseUrl, configDir, 'A2', SESSION_A, TITLE_A_RENAMED, MARKER_A, IDENTITY_TIMEOUT_MS);
    const storedNameAfter = sessionsDb.getSessionById(SESSION_A)?.custom_name ?? null;
    const restartMs = Date.now() - STARTED_AT;
    console.log(
      `[readings] restart firstPid=${String(firstPid)} secondPid=${String(second.hostPid)} ` +
        `exit=${String(secondBoot.frame.exitCode)} attempts=${secondBoot.attempts} ` +
        `firstName=${String(alpha.snapshotPeerName)} secondName=${String(second.registryName)} ` +
        `secondNameSource=${String(second.registryNameSource)} secondSelfWritten=${JSON.stringify(second.selfWrittenNames)} ` +
        `firstNameLen=${String(alpha.snapshotPeerName).length} secondNameLen=${String(second.registryName).length} ` +
        `storedNameBefore=${JSON.stringify(storedNameBefore)} storedNameAfter=${JSON.stringify(storedNameAfter)} ` +
        `elapsed=${restartMs}ms`,
    );
    assert.strictEqual(
      second.hostPid !== null && second.hostPid !== firstPid,
      true,
      `the restart leg must read a *second* process (${String(firstPid)} -> ${String(second.hostPid)})`,
    );
    // The reading the gap was filed for: the name the app holds for the session
    // is the same string before and after a launch. Nothing the driver does on
    // the way up may touch it — under the false form the injected name becomes
    // the stored name, and a restart makes it longer than the launch before it.
    assert.strictEqual(
      storedNameAfter,
      storedNameBefore,
      `a resident launch must not rewrite the name the app holds (${JSON.stringify(storedNameBefore)} -> ${JSON.stringify(storedNameAfter)})`,
    );
    assert.strictEqual(
      storedNameAfter?.includes(`-${SESSION_A.slice(0, 6)}`),
      false,
      `the stored name must not carry the app-side suffix shape (${JSON.stringify(storedNameAfter)})`,
    );
    assert.strictEqual(
      second.equalToSnapshot,
      true,
      `the restarted session must publish the address its new process registered ` +
        `(snapshot=${String(second.snapshotPeerName)} registry=${String(second.registryName)})`,
    );
    // The rung the restarted process registers under.
    //
    // This arm originally read `derived`, on the policy that a launch handed the
    // CLI *no* name at all. `gap-claude-peer-name-follows-ai-title`
    // (2026-09-30) amended it to `auto` on the belief that this fixture's
    // session already had a Claude Code title by the time it restarted, so the
    // launch handed it back and the process adopted it. **That belief does not
    // hold for this fixture, and the correct reading is the original one.**
    // `gap-claude-peer-name-title-guard` (2026-10-01) measured why:
    //
    // - The mock endpoint answers every non-agent request with prose
    //   (`textStream('aux ok')` below), so the CLI never parses a title out of
    //   it and this run's transcripts hold no `ai-title` at all.
    // - The leg-3 rename above did not put one there either: it went through the
    //   app's own path, which refused it and said so —
    //   `[sessions] rename of session "894efd93-a" had nothing to write to the
    //   "claude" store (no-transcript)`, because this harness never populated
    //   the row's `jsonl_path`. So no `custom-title` was written either, and the
    //   `AC164 Addressable Alpha Renamed` that leg reads back is the *requested*
    //   string the service stores when the provider has nothing to report —
    //   not a title the CLI ever saw.
    //
    // With no `ai-title` and no `custom-title`, the only value the pre-guard
    // code could hand over was `getSessionInfo().summary`'s last rung: this
    // session's first prompt verbatim. That is the defect
    // `gap-claude-peer-name-title-guard` removes — a launch that hands a
    // fallback over makes the CLI write it as a `custom-title`, which the app
    // reads as `manual` and which therefore outranks the `ai-title` the session
    // may later earn. `auto` here was that handover, so this arm asserted it.
    //
    // Under the guard a session with no title is handed nothing and the CLI
    // derives its own name — leg 1 above reads `derived` for the same reason on
    // every session's first boot, and this arm now reds on the fallback
    // handover instead of requiring it. A session that genuinely has a title
    // still registers `auto`; that is measured where a title really exists, in
    // `claude-peer-name-follows-ai-title.test.ts` (resident cold start) and in
    // `claude-peer-name-title-guard.test.ts` (the positive control).
    //
    // See `docs/proposals/claude-resident-sessions.md` §12 and `goals/AC-164-*`.
    assert.strictEqual(
      second.registryNameSource,
      'derived',
      `a session with no title of its own must be restarted under the CLI's derived label, not under a ` +
        `ladder fallback the app handed over (${String(second.registryNameSource)})`,
    );
    assert.deepEqual(
      second.selfWrittenNames,
      [],
      `the restarted process's transcript must hold no name the app wrote (found ${JSON.stringify(second.selfWrittenNames)})`,
    );
    // What replaces the retired `secondNameLen <= firstNameLen` comparison.
    //
    // That comparison was a proxy for "the app is not re-minting this session's
    // name on every launch, one suffix longer each time" — the `-9959ff-9959ff`
    // shape the gap was filed for. Under the amended policy it is the wrong
    // proxy, and not merely because a session's own title is routinely longer
    // than the `<dirname>-<2 chars>` label it replaces: it was never the *name*
    // that had to stay put, it was the app's right to mint one. So the invariant
    // is stated directly, on the restarted reading, as the rule the loop above
    // applies to the first-boot rows — the address a peer is given is never the
    // name this app holds for the session. The restarted process answers to the
    // name the CLI registered for it, whichever rung that is; a launch that
    // handed the app's cached name instead would come back byte-equal to it, and
    // this arm is what reds.
    assert.notStrictEqual(
      second.registryName,
      second.title,
      `the restarted process must not answer to the name the app holds for the session ` +
        `(registry=${String(second.registryName)} appName=${String(second.title)})`,
    );
    assert.strictEqual(
      String(second.snapshotPeerName).endsWith(`-${SESSION_A.slice(0, 6)}`),
      false,
      `the restarted address must not carry the accumulated suffix shape (${String(second.snapshotPeerName)})`,
    );

    const measured = Date.now() - STARTED_AT;
    console.log(`[readings] elapsed=${measured}ms`);
    console.log(`[readings] verified at ${elapsed()}`);
    assert.ok(measured < ELAPSED_LIMIT_MS, `the criterion must finish inside its budget (${measured}ms)`);
  });
});

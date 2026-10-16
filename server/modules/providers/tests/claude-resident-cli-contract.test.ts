/**
 * Criterion for the CLI's own turn / interrupt frame contract on the production
 * SDK path — SPEC `resident-delivery-turn-ledger-SPEC.md` §2 (AC-379).
 *
 * §2 is a set of CLI facts the whole ledger design (C-1 … C-6) carries weight
 * on, and every one of them was measured rather than assumed:
 *
 * - a command has exactly one terminal frame (`completed` or `cancelled`);
 * - a `started` that arrives while a turn is open folds into that turn, while
 *   one that arrives between turns belongs to the following `init`;
 * - a command's terminal frame may arrive before OR after the turn's `RESULT`,
 *   so "every command completed" can never be read as "the turn ended";
 * - two `later` commands drained at a turn boundary share ONE turn — one `init`
 *   and one `RESULT` for both;
 * - an interrupt ends only the command in flight; the turn closes on an
 *   `is_error` `RESULT` and a queued command still runs afterwards.
 *
 * None of those are this repository's behaviour. They are the `claude` binary's,
 * and §14 names "CLI contract drift" as the design's first risk: an upgrade can
 * change any of them without a line of this tree changing. This criterion is the
 * one thing that notices, so it is written as a sentinel rather than as a
 * regression test —
 *
 * 1. it drives a REAL `claude` binary (`which claude`) through the PRODUCTION
 *    resident driver — the same object `providerRoutes` and
 *    `providerRegistry.resolveProvider('claude').hostDriver` hand a browser send
 *    — with the frames observed on the driver's own `observe` entry, in arrival
 *    order;
 * 2. the model is a loopback Anthropic-compatible endpoint, so nothing leaves
 *    the host and no model is billed; the mock answers BY POSITION (see
 *    `startMockAnthropic`), and the host's `ANTHROPIC_BASE_URL` points at a dead
 *    port, so a turn that reached the mock is proof the model entry was read;
 * 3. the order checker is a PURE FUNCTION of a normalized trace
 *    (`checkContract(scenario, trace)`), which is what makes the checker's own
 *    falsification possible: for every scenario it is also fed a synthetic trace
 *    built by swapping two of the real frames, and it must report `violated` on
 *    it. A checker that read live state instead of a frame sequence could not be
 *    falsified this way, and would be a sentinel nobody had ever seen fire.
 *
 * Red lines:
 * - The process budget guard kills the whole process with `exit 3` (a budget
 *   kill with its own reading, not a `node:test` case failure), as in the
 *   sibling resident criteria.
 * - Every reading is taken and printed BEFORE anything is asserted, so a red
 *   lands on the reading that is wrong rather than on a timeout or a later leg.
 * - The real traces and the synthetic (tampered) traces are printed under
 *   different prefixes so the falsification reading can never be mistaken for
 *   the measurement.
 * - The file only adds this criterion: production code is untouched (the
 *   observation is installed on `ClaudeResidentHostDriver.prototype` from the
 *   test side), and the harness is the one the merged-queued-turn criterion's
 *   real-binary arm already established.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
  createProviderRuntimeService,
  providerRegistry,
  providerRoutes,
} from '@/modules/providers/index.js';
import { ClaudeResidentHostDriver } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { createSessionHostsRouter, sessionHostManager } from '@/modules/session-hosts/index.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import type { AnyRecord, ProviderModelEnvRow } from '@/shared/types.js';

/** The host Anthropic key. It must survive in no request the mock receives. */
const HOST_SENTINEL = 'sk-host-sentinel-must-not-leak';
/**
 * A model entry, not a built-in name: only a custom entry's env reaches the
 * spawn, which is what points the CLI at the mock instead of the real endpoint.
 */
const MODEL_ID = 'resident-cli-contract-custom-model';
const MODEL_SECRET = 'resident-cli-contract-model-row-secret';

/** The bound this criterion reports its whole run against. */
const ELAPSED_LIMIT_MS = 50_000;
/** How long one scenario's terminal frame sequence may take to arrive. */
const SCENARIO_TIMEOUT_MS = 25_000;
/** How long the process's first agent request (the cold turn going in flight) may take. */
const COLD_TURN_TIMEOUT_MS = 15_000;
/** How long one busy write's `queued` lifecycle may take to come back. */
const QUEUED_TIMEOUT_MS = 5_000;

const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=3 — the cli-contract criterion did not ` +
      `finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, ELAPSED_LIMIT_MS - 1_000);
budgetGuard.unref();

// ---------------------------------------------------------------------------
// Scenarios and their arms
// ---------------------------------------------------------------------------

type Scenario = 'idle' | 'later-drain' | 'next-fold' | 'interrupt';
const SCENARIOS: readonly Scenario[] = ['idle', 'later-drain', 'next-fold', 'interrupt'];

/**
 * One scenario per scenario, and one app session per scenario.
 *
 * The session is per-scenario rather than shared because each scenario has to be
 * measured on a driver whose round FIFO describes only that scenario: the
 * `next-fold` shape leaves a round the CLI never gives a `result` of its own
 * (§2 C-3), and a later scenario driven through the same host would be read
 * against that leftover. A fresh session gives each scenario a cold driver —
 * the state a browser send produces — which is what makes a red attributable to
 * the CLI's frames rather than to the scenario before it.
 */
const SESSION_IDS: Record<Scenario, string> = {
  idle: 'claude-resident-cli-contract-idle',
  'later-drain': 'claude-resident-cli-contract-later-drain',
  'next-fold': 'claude-resident-cli-contract-next-fold',
  interrupt: 'claude-resident-cli-contract-interrupt',
};

type HostInputTier = 'later' | 'next' | 'now';

type ScenarioArm = {
  /**
   * Distinctive text planted in this scenario's cold turn. The mock keys its
   * answer on it, so a scenario's first agent request is answered the same way
   * whatever order the scenarios ran in.
   */
  marker: string;
  /** Whether the model's first answer asks for the long in-flight `Bash` call. */
  holdsTurn: boolean;
  /** How many commands are pushed while the cold turn is in flight. */
  busyCount: number;
  /** The tier those pushes name, or `null` for the CLI's own default (`later`). */
  priority: HostInputTier | null;
  /** Whether the scenario aborts the turn in flight. */
  abort: boolean;
};

const ARMS: Record<Scenario, ScenarioArm> = {
  idle: { marker: 'CLI_CONTRACT_IDLE', holdsTurn: false, busyCount: 0, priority: null, abort: false },
  'later-drain': { marker: 'CLI_CONTRACT_LATER', holdsTurn: true, busyCount: 2, priority: null, abort: false },
  'next-fold': { marker: 'CLI_CONTRACT_NEXT', holdsTurn: true, busyCount: 1, priority: 'next', abort: false },
  interrupt: { marker: 'CLI_CONTRACT_INTERRUPT', holdsTurn: true, busyCount: 1, priority: null, abort: true },
};

// ---------------------------------------------------------------------------
// The trace: raw observation, normalization, and the pure order checker
// ---------------------------------------------------------------------------

/** One frame as it arrived on `observe`, before any interpretation. */
type ObservedFrame = {
  /** The app session the frame was folded into, so scenarios cannot bleed. */
  sessionId: string;
  type: string;
  subtype: string;
  /** `command_lifecycle`'s own state, or `null` for any other frame. */
  lifecycleState: string | null;
  /** `command_lifecycle`'s `command_uuid`, or `null` for any other frame. */
  commandUuid: string | null;
  isError: boolean;
};

/**
 * One frame of a normalized trace — only the four facts §2's contract is about.
 *
 * `command` is the label the HOST stamped on the frame (`A`, `B`, `C`), read
 * from the driver's own pushed-uuid set rather than guessed from arrival order,
 * and `foreign` for a lifecycle the host never pushed. Dropping everything else
 * (assistant text, tool calls, `system/status`) keeps the checker about the
 * contract and makes "no second `init` in this turn" a statement about the turn
 * rather than about a filtered view of it.
 */
type TraceFrame =
  | { kind: 'lifecycle'; state: string; command: string }
  | { kind: 'init' }
  | { kind: 'result'; isError: boolean };

type Verdict = 'ok' | 'violated';

const observations: ObservedFrame[] = [];

/** Records one frame; tolerant of shapes the driver's own reader also tolerates. */
function recordFrame(state: unknown, message: AnyRecord): void {
  const owner = state as { appSessionId?: unknown } | null;
  const type = typeof message?.type === 'string' ? message.type : '';
  const subtype = typeof message?.subtype === 'string' ? message.subtype : '';
  const isLifecycleEnvelope =
    type === 'command_lifecycle' || (type === 'system' && subtype === 'command_lifecycle');
  observations.push({
    sessionId: typeof owner?.appSessionId === 'string' ? owner.appSessionId : '',
    type,
    subtype,
    lifecycleState: isLifecycleEnvelope && typeof message?.state === 'string' ? message.state : null,
    commandUuid: isLifecycleEnvelope && typeof message?.command_uuid === 'string' ? message.command_uuid : null,
    isError: message?.is_error === true,
  });
}

/**
 * Installs a read-only observation on the driver's `observe` entry, and returns
 * the function that takes it back off.
 *
 * `observe` is where every SDK message is folded into the host's state — the
 * driver's one stream entry — so wrapping it records the frames in the order the
 * CLI sent them, on the production path, without a second consumer of the
 * process's stream and without touching production code. The receiver is
 * forwarded faithfully (`observe` reads per-instance fields, not just prototype
 * methods), and the original is restored in the criterion's `finally` so a
 * later test in the same process cannot be measuring through it.
 */
function installObserver(): () => void {
  const slot = ClaudeResidentHostDriver.prototype as unknown as {
    observe(this: ClaudeResidentHostDriver, state: unknown, message: AnyRecord): void;
  };
  const original = slot.observe;
  slot.observe = function observeWithRecording(
    this: ClaudeResidentHostDriver,
    state: unknown,
    message: AnyRecord,
  ): void {
    recordFrame(state, message);
    original.call(this, state, message);
  };
  return () => {
    slot.observe = original;
  };
}

/** Every frame this run saw for one session, in arrival order. */
function framesOf(sessionId: string): ObservedFrame[] {
  return observations.filter((frame) => frame.sessionId === sessionId);
}

/** How many lifecycle frames for one state this session has seen. */
function countLifecycle(frames: ObservedFrame[], state: string): number {
  return frames.filter((frame) => frame.lifecycleState === state).length;
}

/** The host's own label for each uuid it pushed, in push order: `A`, `B`, `C`. */
function labelsFor(sessionId: string): Map<string, string> {
  const pushed = residentDriver().unattendedReading(sessionId)?.pushedUuids ?? [];
  const labels = new Map<string, string>();
  const names = ['A', 'B', 'C'];
  for (const [index, name] of names.entries()) {
    const uuid = pushed[index];
    if (uuid) {
      labels.set(uuid, name);
    }
  }
  return labels;
}

/** Normalizes raw frames into the contract's own vocabulary. */
function toTrace(frames: ObservedFrame[], labels: Map<string, string>): TraceFrame[] {
  const trace: TraceFrame[] = [];
  for (const frame of frames) {
    if (frame.lifecycleState !== null) {
      trace.push({
        kind: 'lifecycle',
        state: frame.lifecycleState,
        command: frame.commandUuid ? labels.get(frame.commandUuid) ?? 'foreign' : 'foreign',
      });
      continue;
    }
    if (frame.type === 'system' && frame.subtype === 'init') {
      trace.push({ kind: 'init' });
      continue;
    }
    if (frame.type === 'result') {
      trace.push({ kind: 'result', isError: frame.isError });
    }
  }
  return trace;
}

/** One flat reading of a trace, so a real and a synthetic trace cannot blur. */
function renderTrace(trace: TraceFrame[]): string {
  return trace
    .map((frame) => {
      if (frame.kind === 'init') {
        return 'init';
      }
      if (frame.kind === 'result') {
        return frame.isError ? 'RESULT(error)' : 'RESULT(ok)';
      }
      return `${frame.command}:${frame.state}`;
    })
    .join(' ');
}

function isLifecycle(frame: TraceFrame, state: string, command?: string): boolean {
  return frame.kind === 'lifecycle' && frame.state === state && (command === undefined || frame.command === command);
}

/**
 * The contract, as a pure function of a normalized trace.
 *
 * Each arm is exactly §2's row for that scenario. The checks are written with
 * `findIndex` on the trace — never on live state — because the falsification
 * leg below has to be able to hand the same function a trace whose frames did
 * not really happen.
 */
function checkContract(scenario: Scenario, trace: TraceFrame[]): Verdict {
  const firstIndex = (predicate: (frame: TraceFrame, index: number) => boolean): number =>
    trace.findIndex(predicate);
  const allLabeled = (allowed: readonly string[]): boolean =>
    trace.every((frame) => frame.kind !== 'lifecycle' || allowed.includes(frame.command));

  if (scenario === 'idle') {
    // queued < started < init < RESULT < completed, with `started` before `init`.
    if (!allLabeled(['A'])) {
      return 'violated';
    }
    const queued = firstIndex((frame) => isLifecycle(frame, 'queued', 'A'));
    const started = firstIndex((frame) => isLifecycle(frame, 'started', 'A'));
    const init = firstIndex((frame) => frame.kind === 'init');
    const result = firstIndex((frame) => frame.kind === 'result');
    const completed = firstIndex((frame) => isLifecycle(frame, 'completed', 'A'));
    if (queued < 0 || started < 0 || init < 0 || result < 0 || completed < 0) {
      return 'violated';
    }
    return queued < started && started < init && init < result && result < completed ? 'ok' : 'violated';
  }

  if (scenario === 'later-drain') {
    // A's own turn is an idle-shaped turn; after its RESULT come completed(A),
    // started(B) and started(C) (in that order), then ONE init, then one RESULT,
    // and only after it completed(B) and completed(C).
    if (!allLabeled(['A', 'B', 'C'])) {
      return 'violated';
    }
    const resultA = firstIndex((frame) => frame.kind === 'result');
    const completedA = firstIndex((frame) => isLifecycle(frame, 'completed', 'A'));
    const startedB = firstIndex((frame) => isLifecycle(frame, 'started', 'B'));
    const startedC = firstIndex((frame) => isLifecycle(frame, 'started', 'C'));
    if (resultA < 0 || completedA < 0 || startedB < 0 || startedC < 0) {
      return 'violated';
    }
    // B and C are symmetric in the contract, so only their joint position is read.
    const firstStart = Math.min(startedB, startedC);
    const lastStart = Math.max(startedB, startedC);
    if (!(resultA < completedA && completedA < firstStart)) {
      return 'violated';
    }
    // Both `started`s precede the SAME init: the next init is after the later of
    // them, and no init falls between them.
    const mergedInit = trace.findIndex((frame, index) => frame.kind === 'init' && index > lastStart);
    if (mergedInit < 0) {
      return 'violated';
    }
    const initBetween = trace.some(
      (frame, index) => frame.kind === 'init' && index > firstStart && index <= lastStart,
    );
    if (initBetween) {
      return 'violated';
    }
    const mergedResult = firstIndex((frame, index) => frame.kind === 'result' && index > mergedInit);
    if (mergedResult < 0) {
      return 'violated';
    }
    const completedB = firstIndex((frame) => isLifecycle(frame, 'completed', 'B'));
    const completedC = firstIndex((frame) => isLifecycle(frame, 'completed', 'C'));
    if (completedB < 0 || completedC < 0) {
      return 'violated';
    }
    return completedB > mergedResult && completedC > mergedResult ? 'ok' : 'violated';
  }

  if (scenario === 'next-fold') {
    // B `started` inside A's open turn (after A's init, before A's RESULT), no
    // second init in that turn, completed(B) before the RESULT and completed(A)
    // after it.
    if (!allLabeled(['A', 'B'])) {
      return 'violated';
    }
    const initA = firstIndex((frame) => frame.kind === 'init');
    const result = firstIndex((frame) => frame.kind === 'result');
    const startedB = firstIndex((frame) => isLifecycle(frame, 'started', 'B'));
    if (initA < 0 || result < 0 || startedB < 0) {
      return 'violated';
    }
    if (!(initA < startedB && startedB < result)) {
      return 'violated';
    }
    const secondInit = trace.some(
      (frame, index) => frame.kind === 'init' && index > initA && index < result,
    );
    if (secondInit) {
      return 'violated';
    }
    const completedB = firstIndex((frame) => isLifecycle(frame, 'completed', 'B'));
    const completedA = firstIndex((frame) => isLifecycle(frame, 'completed', 'A'));
    if (completedB < 0 || completedA < 0) {
      return 'violated';
    }
    return completedB < result && completedA > result ? 'ok' : 'violated';
  }

  // interrupt: an `is_error` RESULT, then cancelled(A), then started(B), then a
  // NEW init, and finally completed(B).
  if (!allLabeled(['A', 'B'])) {
    return 'violated';
  }
  const errorResult = firstIndex((frame) => frame.kind === 'result' && frame.isError);
  const cancelledA = firstIndex((frame) => isLifecycle(frame, 'cancelled', 'A'));
  const startedB = firstIndex((frame) => isLifecycle(frame, 'started', 'B'));
  const completedB = firstIndex((frame) => isLifecycle(frame, 'completed', 'B'));
  if (errorResult < 0 || cancelledA < 0 || startedB < 0 || completedB < 0) {
    return 'violated';
  }
  if (!(errorResult < cancelledA && cancelledA < startedB)) {
    return 'violated';
  }
  const nextInit = trace.findIndex((frame, index) => frame.kind === 'init' && index > startedB);
  if (nextInit < 0) {
    return 'violated';
  }
  return completedB > nextInit ? 'ok' : 'violated';
}

/**
 * A synthetic trace with two of the scenario's own frames swapped — the
 * checker's falsification leg.
 *
 * The swap is the one frame pair that scenario's arm turns on: move either of
 * them and the ordering claim the arm makes is no longer true. Built from the
 * real trace rather than hand-written so the synthetic reading has real shape;
 * when the real trace is already missing a frame the swap cannot be placed and
 * the trace is returned unswapped, which leaves the falsification leg red for
 * the same reason the real one is.
 */
function tamperedTrace(scenario: Scenario, trace: TraceFrame[]): TraceFrame[] {
  const copy = trace.slice();
  let left = -1;
  let right = -1;
  if (scenario === 'idle') {
    left = copy.findIndex((frame) => frame.kind === 'init');
    right = copy.findIndex((frame) => frame.kind === 'result');
  } else if (scenario === 'later-drain') {
    left = copy.findIndex((frame) => isLifecycle(frame, 'completed', 'A'));
    right = copy.findIndex((frame) => isLifecycle(frame, 'started', 'B'));
  } else if (scenario === 'next-fold') {
    left = copy.findIndex((frame) => isLifecycle(frame, 'completed', 'B'));
    right = copy.findIndex((frame) => frame.kind === 'result');
  } else {
    left = copy.findIndex((frame) => isLifecycle(frame, 'cancelled', 'A'));
    right = copy.findIndex((frame) => isLifecycle(frame, 'started', 'B'));
  }

  if (left < 0 || right < 0 || left === right) {
    return copy;
  }
  const held = copy[left];
  copy[left] = copy[right];
  copy[right] = held;
  return copy;
}

/** Whether the scenario's terminal frames have all been read. */
function terminalShapeReached(scenario: Scenario, frames: ObservedFrame[]): boolean {
  if (scenario === 'idle') {
    const result = frames.findIndex((frame) => frame.type === 'result');
    return result >= 0 && frames.some((frame, index) => index > result && frame.lifecycleState === 'completed');
  }
  if (scenario === 'later-drain') {
    const results = frames.flatMap((frame, index) => (frame.type === 'result' ? [index] : []));
    if (results.length < 2) {
      return false;
    }
    const second = results[1];
    return frames.some((frame, index) => index > second && frame.lifecycleState === 'completed');
  }
  if (scenario === 'next-fold') {
    const result = frames.findIndex((frame) => frame.type === 'result');
    return (
      result >= 0 &&
      frames.some((frame, index) => index < result && frame.lifecycleState === 'completed') &&
      frames.some((frame, index) => index > result && frame.lifecycleState === 'completed')
    );
  }
  const results = frames.filter((frame) => frame.type === 'result').length;
  return results >= 2 && frames.some((frame) => frame.lifecycleState === 'cancelled');
}

// ---------------------------------------------------------------------------
// The mock Anthropic endpoint
// ---------------------------------------------------------------------------

type Received = { url: string; body: string; authorization: string | undefined; apiKey: string | undefined };

type MockAnthropic = {
  received: Received[];
  address: string;
  baseUrl: string;
  agentRequests(): number;
  armScenario(marker: string, holdsTurn: boolean): void;
  disarm(): void;
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

/** A reply that asks for one foreground `Bash` call, holding the turn open. */
function bashToolStream(command: string): string {
  const partial = JSON.stringify({ command, run_in_background: false, description: 'hold the turn open' });
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_tool', type: 'message', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_contract_1', name: 'Bash', input: {} },
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
 * How long the in-flight `Bash` turn stays busy — the window the busy pushes and
 * the abort land in. Two seconds: long enough for two socket writes and an
 * abort, short enough that four scenarios fit the criterion's budget.
 */
const IN_FLIGHT_BASH = 'sleep 2; echo CLI_CONTRACT_IN_FLIGHT_DONE';

/**
 * An Anthropic-compatible endpoint that answers this criterion's conversation.
 *
 * A request is an *agent* request when its body declares tool schemas — the
 * SDK's auxiliary title/small-model prompts carry none on the same path with the
 * same credential, so they are answered with a short text and never counted.
 *
 * An agent request is answered from the armed scenario rather than by position
 * in a global count: the armed marker says which conversation is being driven
 * now, and the request is the scenario's cold turn — the one that asks for the
 * long in-flight `Bash` — exactly when that turn holds the turn open AND the
 * conversation does not yet carry a `tool_result` for it. Everything after that
 * (the close-out of the turn, the merged turn's own turn, the post-interrupt
 * turn) streams a short text, which is what lets a turn end.
 */
async function startMockAnthropic(): Promise<MockAnthropic> {
  const received: Received[] = [];
  let agentCount = 0;
  let armed: { marker: string; holdsTurn: boolean } | null = null;

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

      agentCount += 1;
      const holdsThisTurn = Boolean(
        armed?.holdsTurn && armed.marker && body.includes(armed.marker) && !body.includes('"tool_result"'),
      );
      answer(holdsThisTurn ? bashToolStream(IN_FLIGHT_BASH) : textStream('turn closed'));
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as AddressInfo;
  return {
    received,
    address: address.address,
    baseUrl: `http://127.0.0.1:${address.port}`,
    agentRequests: () => agentCount,
    armScenario: (marker, holdsTurn) => { armed = { marker, holdsTurn }; },
    disarm: () => { armed = null; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

// ---------------------------------------------------------------------------
// Driving the production path
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

/** The host driver the production path resolves for `claude`. */
function residentDriver(): ClaudeResidentHostDriver {
  return providerRegistry.resolveProvider('claude').hostDriver as unknown as ClaudeResidentHostDriver;
}

/** Polls a predicate and answers whether it held, without failing the case. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  console.log(`[readings] waitFor timed out after ${timeoutMs}ms: ${label}`);
  return false;
}

/** The model entry that points the CLI at the mock endpoint. */
function modelRows(baseUrl: string): ProviderModelEnvRow[] {
  return [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ];
}

/** Resolves the real `claude` binary, or null — the arm must not skip or run empty. */
function claudeBinaryPath(): string | null {
  const found = spawnSync('which', ['claude'], { encoding: 'utf8' });
  const resolved = found.status === 0 ? found.stdout.trim() : '';
  return resolved.length > 0 ? resolved : null;
}

/** The real binary's own version line, so a drift report names the build. */
function claudeVersion(binary: string): string {
  const found = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : '';
}

/** Sends one `chat.send` without waiting for it — the busy pushes are what this criterion times. */
function sendChat(
  socket: FakeSocket,
  sessionId: string,
  content: string,
  cwd: string,
  priority: HostInputTier | null,
): void {
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId,
    content,
    options: {
      cwd,
      model: MODEL_ID,
      permissionMode: 'bypassPermissions',
      ...(priority ? { priority } : {}),
    },
  }));
}

/** Sends one `chat.abort` for the scenario's session. */
function abortChat(socket: FakeSocket, sessionId: string): void {
  socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId }));
}

type ScenarioReading = {
  scenario: Scenario;
  realTrace: TraceFrame[];
  realVerdict: Verdict;
  tamperedTrace: TraceFrame[];
  tamperedVerdict: Verdict;
  terminalReached: boolean;
};

/**
 * Drives one scenario and reads its trace.
 *
 * The steps are the scenario's own arm: a cold send; for the holding scenarios,
 * a wait until the model's first answer has been handed over (which is when the
 * `Bash` starts, and therefore when the process is busy); then the busy pushes,
 * each waiting for its own `queued` lifecycle so the next write lands behind a
 * frame the CLI has really taken; then, for `interrupt`, the abort.
 */
async function driveScenario(
  scenario: Scenario,
  socket: FakeSocket,
  mock: MockAnthropic,
  configRoot: string,
): Promise<ScenarioReading> {
  const arm = ARMS[scenario];
  const sessionId = SESSION_IDS[scenario];
  const agentBefore = mock.agentRequests();
  mock.armScenario(arm.marker, arm.holdsTurn);
  process.env.CLAUDE_CONFIG_DIR = path.join(configRoot, `claude-config-${scenario}`);

  sendChat(socket, sessionId, `${arm.marker} cold turn`, configRoot, null);

  if (arm.busyCount > 0) {
    await waitFor(
      () => mock.agentRequests() >= agentBefore + 1,
      COLD_TURN_TIMEOUT_MS,
      `${scenario}: the cold turn's first model answer`,
    );
    for (let index = 0; index < arm.busyCount; index += 1) {
      const before = countLifecycle(framesOf(sessionId), 'queued');
      sendChat(socket, sessionId, `${arm.marker} queued ${index}`, configRoot, arm.priority);
      await waitFor(
        () => countLifecycle(framesOf(sessionId), 'queued') > before,
        QUEUED_TIMEOUT_MS,
        `${scenario}: queued command ${index}`,
      );
    }
  }

  if (arm.abort) {
    abortChat(socket, sessionId);
  }

  const terminalReached = await waitFor(
    () => terminalShapeReached(scenario, framesOf(sessionId)),
    SCENARIO_TIMEOUT_MS,
    `${scenario}: terminal frame sequence`,
  );
  mock.disarm();

  const frames = framesOf(sessionId);
  const labels = labelsFor(sessionId);
  const realTrace = toTrace(frames, labels);
  const synthetic = tamperedTrace(scenario, realTrace);
  return {
    scenario,
    realTrace,
    realVerdict: checkContract(scenario, realTrace),
    tamperedTrace: synthetic,
    tamperedVerdict: checkContract(scenario, synthetic),
    terminalReached,
  };
}

// ---------------------------------------------------------------------------

test('AC379 the real CLI keeps §2\'s frame order across the four turn scenarios', { timeout: 120_000 }, async () => {
  const binary = claudeBinaryPath();
  const version = binary ? claudeVersion(binary) : '';
  console.log(`claudeBinary=${binary ?? ''} claudeVersion=${version}`);
  assert.ok(binary, 'the real `claude` binary must be resolvable — the criterion may not skip or run empty');

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-cli-contract-'));
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

  const restoreObserver = installObserver();
  const readings: ScenarioReading[] = [];
  const retiredHosts: Array<() => void> = [];

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDirectory, 'claude-config');
    // A dead host endpoint, so a run that ignored the model entry can never
    // reach the mock: reaching it is evidence that the entry was consulted.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANTHROPIC_API_KEY = HOST_SENTINEL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    await initializeDatabase();
    const user = userDb.createUser('claude-resident-cli-contract', 'unused-hash');

    const now = new Date().toISOString();
    for (const scenario of SCENARIOS) {
      const sessionId = SESSION_IDS[scenario];
      sessionsDb.createSession(sessionId, 'claude', tempDirectory, `CLI contract ${scenario}`, now, now, null);
      // An app-created row carries its own id as the provider id until a real
      // provider session exists. Nulled so the host launches a fresh CLI rather
      // than resuming a session that never was (`--resume` rejects a non-UUID).
      getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(sessionId);
      assert.strictEqual(
        sessionsDb.setSessionLifecycleMode(sessionId, 'resident'),
        true,
        `${scenario} must be switched to the resident lifecycle mode`,
      );
      assert.strictEqual(sessionsDb.getSessionLifecycleMode(sessionId), 'resident');
    }
    providerModelsDb.createCustomProviderModel('claude', {
      id: MODEL_ID,
      model: MODEL_ID,
      config: { env: modelRows(mock.baseUrl) },
    });

    chatRunRegistry.clearAll();
    const socket = createFakeSocket();
    const runtime = createProviderRuntimeService();
    handleChatConnection(
      socket as never,
      { user: { id: Number(user.id) } } as never,
      { runtime: runtime as never },
    );
    retiredHosts.push(() => { socket.close(); });

    for (const scenario of SCENARIOS) {
      readings.push(await driveScenario(scenario, socket, mock, tempDirectory));
    }

    // ---- readings, printed before any assertion -------------------------
    console.log('--- real traces (raw CLI frame arrival order, normalized) ---');
    for (const reading of readings) {
      console.log(`trace.real.${reading.scenario}=${renderTrace(reading.realTrace)}`);
    }
    console.log('--- verdicts ---');
    for (const reading of readings) {
      console.log(`contract.${reading.scenario}=${reading.realVerdict}`);
    }
    console.log('--- tamper self-check: the SAME checker on synthetic traces, two frames swapped ---');
    console.log('--- every line below MUST read violated, or the sentinel cannot fire ---');
    for (const reading of readings) {
      console.log(`trace.tampered.${reading.scenario}=${renderTrace(reading.tamperedTrace)}`);
      console.log(`contract.${reading.scenario}=${reading.tamperedVerdict}`);
    }
    console.log(
      `mockAddress=${mock.address} mockRequests=${mock.received.length} agentRequests=${mock.agentRequests()} ` +
        `cliContractSessions=${SCENARIOS.length}`,
    );

    // ---- assertions ------------------------------------------------------
    for (const reading of readings) {
      assert.ok(
        reading.terminalReached,
        `${reading.scenario}: the CLI must reach its terminal frame sequence (trace=${renderTrace(reading.realTrace)})`,
      );
      assert.strictEqual(
        reading.realVerdict,
        'ok',
        `${reading.scenario}: the CLI's frame order must match §2 (trace=${renderTrace(reading.realTrace)})`,
      );
      assert.strictEqual(
        reading.tamperedVerdict,
        'violated',
        `${reading.scenario}: the checker must reject a trace with two frames swapped ` +
          `(synthetic=${renderTrace(reading.tamperedTrace)})`,
      );
    }

    // §2 (d): the harness never leaves the loopback, and the host credential
    // never reaches the mock — the CLI answered out of the model entry, not out
    // of the host's environment.
    assert.strictEqual(mock.address, '127.0.0.1', 'the mock endpoint must listen on the loopback only');
    assert.ok(mock.received.length > 0, 'the mock endpoint must have been reached — the model entry was read');
    const leaks = mock.received.filter(
      (request) =>
        (request.authorization ?? '').includes(HOST_SENTINEL) ||
        (request.apiKey ?? '').includes(HOST_SENTINEL) ||
        request.body.includes(HOST_SENTINEL),
    );
    assert.strictEqual(
      leaks.length,
      0,
      `no request to the mock may carry the host credential (leaked in ${leaks.length} of ${mock.received.length})`,
    );
    const offLoopback = mock.received.filter((request) => !request.url.startsWith('/'));
    assert.strictEqual(offLoopback.length, 0, 'every mock request must be a path on this endpoint');

    connectedClients.clear();
  } finally {
    restoreObserver();
    for (const host of sessionHostManager.snapshot()) {
      if (host.state !== 'closed') {
        sessionHostManager.closeHost(host.hostId, 'server-shutdown');
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    for (const host of sessionHostManager.snapshot()) {
      if (host.pid) {
        try {
          process.kill(host.pid, 'SIGKILL');
        } catch {
          // Already gone between the check and the kill.
        }
      }
    }
    for (const retire of retiredHosts) {
      retire();
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
});

test('the criterion finished inside its wall-clock budget', () => {
  const elapsed = Date.now() - STARTED_AT;
  console.log(`[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=0`);
  assert.ok(elapsed < ELAPSED_LIMIT_MS, `the criterion finished in ${elapsed}ms, under its ${ELAPSED_LIMIT_MS}ms budget`);
});

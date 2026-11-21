import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
  createChatEditPreparationService,
  type ChatEditPlan,
  type ChatEditPreparationDeps,
} from '@/modules/websocket/services/dispatch/chat-edit-preparation.service.js';
import { handleChatConnection } from '@/modules/websocket/services/dispatch/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/dispatch/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'edit-preparation-session';

/** Two turns and an edit of the second, in Claude's transcript format. */
const CLAUDE_ROWS = [
  {
    type: 'user', uuid: 'e-u1', parentUuid: null, sessionId: SESSION_ID,
    timestamp: '2026-08-23T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
  },
  {
    type: 'assistant', uuid: 'e-a1', parentUuid: 'e-u1', sessionId: SESSION_ID,
    timestamp: '2026-08-23T10:00:01.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'reply' }] },
  },
  {
    type: 'user', uuid: 'e-u2', parentUuid: 'e-a1', sessionId: SESSION_ID,
    timestamp: '2026-08-23T10:00:02.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
  },
];

/** The same two turns as a Codex rollout; an anchor is a whole turn there. */
const CODEX_ROWS = [
  { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'second' } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-b' } },
];

// ---------------------------------------------------------------------------
// The preparation service, driven directly
// ---------------------------------------------------------------------------

type UnitOverrides = {
  anchor?: { found: boolean; resumeThroughId: string | null } | null;
  rewinds?: boolean;
  resident?: boolean;
  hostFound?: boolean;
  closeFails?: Error;
  rewindFails?: Error;
};

const ANCHOR_MIDDLE = { found: true, resumeThroughId: 'row-before' };
const ANCHOR_FIRST = { found: true, resumeThroughId: null };

function unitHarness(overrides: UnitOverrides = {}) {
  const calls: string[] = [];
  const settings = {
    anchor: ANCHOR_MIDDLE,
    rewinds: false,
    resident: false,
    hostFound: true,
    ...overrides,
  };
  const deps: ChatEditPreparationDeps = {
    resolveEditAnchor: async () => {
      calls.push('resolve-anchor');
      return settings.anchor;
    },
    providerRewindsForEdit: () => {
      calls.push('provider-rewinds');
      return settings.rewinds;
    },
    isResidentSession: () => {
      calls.push('is-resident');
      return settings.resident;
    },
    rewindSessionForEdit: async (_sessionId, keepThroughId) => {
      calls.push(`rewind:${keepThroughId}`);
      if (settings.rewindFails) {
        throw settings.rewindFails;
      }
    },
    closeHostForEditAndWait: async () => {
      calls.push('close');
      if (settings.closeFails) {
        throw settings.closeFails;
      }
      return { found: settings.hostFound };
    },
  };
  return {
    service: createChatEditPreparationService(deps),
    deps,
    calls,
    settings,
  };
}

async function planFrom(harness: ReturnType<typeof unitHarness>, anchorId = 'anchor'): Promise<ChatEditPlan> {
  const outcome = await harness.service.prepare({ sessionId: SESSION_ID, provider: 'claude', anchorId });
  assert.equal(outcome.kind, 'ready');
  return (outcome as Extract<typeof outcome, { kind: 'ready' }>).plan;
}

test('planning composes lifecycle and provider recovery without side effects', async () => {
  // The old gateway derived "resident rebuild" as `!providerRewinds && resident`,
  // so a provider that branches (Codex) could never be both. These two plans are
  // the fix stated as data: independent facts that can hold together.
  const both = unitHarness({ rewinds: true, resident: true });
  const plan = await planFrom(both);
  assert.equal(plan.closesResidentHost, true);
  assert.equal(plan.recovery.kind, 'binding-replaced');
  assert.equal(plan.mutatesBeforeRun, true);
  assert.deepEqual(both.calls, ['resolve-anchor', 'provider-rewinds', 'is-resident']);

  const neither = await planFrom(unitHarness({ rewinds: false, resident: false }));
  assert.equal(neither.closesResidentHost, false);
  assert.equal(neither.recovery.kind, 'resume-at-anchor');
});

test('a resident provider that branches closes the host, then replaces the binding', async () => {
  const harness = unitHarness({ rewinds: true, resident: true });
  const plan = await planFrom(harness);
  harness.calls.length = 0;

  const applied = await harness.service.apply(plan, { onTruncate: () => harness.calls.push('truncate') });

  assert.deepEqual(applied, { kind: 'applied', hostClosed: true });
  // Announced first, then the old host is gone before the provider prepares its
  // replacement — the order the mutual-exclusion bug skipped entirely.
  assert.deepEqual(harness.calls, ['truncate', 'close', 'rewind:row-before']);
});

test('a resident provider that resumes closes the host but never rewinds it', async () => {
  const harness = unitHarness({ rewinds: false, resident: true });
  const plan = await planFrom(harness);
  harness.calls.length = 0;

  await harness.service.apply(plan, { onTruncate: () => harness.calls.push('truncate') });

  assert.deepEqual(harness.calls, ['truncate', 'close']);
});

test('a per-run provider that branches rewinds without closing a host', async () => {
  const harness = unitHarness({ rewinds: true, resident: false });
  const plan = await planFrom(harness);
  harness.calls.length = 0;

  await harness.service.apply(plan, { onTruncate: () => harness.calls.push('truncate') });

  assert.deepEqual(harness.calls, ['truncate', 'rewind:row-before']);
});

test('a per-run provider that resumes does nothing but announce the truncation', async () => {
  const harness = unitHarness({ rewinds: false, resident: false });
  const plan = await planFrom(harness);
  harness.calls.length = 0;

  await harness.service.apply(plan, { onTruncate: () => harness.calls.push('truncate') });

  assert.deepEqual(harness.calls, ['truncate']);
});

test('resume-at-anchor carries the null first-turn meaning; binding-replaced carries it to the rewind', async () => {
  const resuming = unitHarness({ anchor: ANCHOR_FIRST, rewinds: false });
  const resumePlan = await planFrom(resuming);
  assert.deepEqual(resuming.service.runtimeOptions(resumePlan), { resumeFromScratch: true });

  const branching = unitHarness({ anchor: ANCHOR_FIRST, rewinds: true });
  const branchPlan = await planFrom(branching);
  assert.deepEqual(branching.service.runtimeOptions(branchPlan), {});
  branching.calls.length = 0;
  await branching.service.apply(branchPlan, { onTruncate: () => {} });
  assert.ok(branching.calls.includes('rewind:null'), 'the cut point is the first turn, stated as null');
});

test('a resident host that is already gone is not a failure', async () => {
  const harness = unitHarness({ resident: true, hostFound: false });
  const plan = await planFrom(harness);
  harness.calls.length = 0;

  const applied = await harness.service.apply(plan, { onTruncate: () => {} });

  assert.deepEqual(applied, { kind: 'applied', hostClosed: false });
  assert.deepEqual(harness.calls, ['close']);
});

test('a close refusal stops the chain before the provider prepares', async () => {
  const harness = unitHarness({
    rewinds: true,
    resident: true,
    closeFails: new Error('the host refused to close'),
  });
  const plan = await planFrom(harness);
  harness.calls.length = 0;

  const applied = await harness.service.apply(plan, { onTruncate: () => harness.calls.push('truncate') });

  assert.equal(applied.kind, 'failed');
  assert.equal(applied.kind === 'failed' ? applied.stage : null, 'close');
  assert.ok(applied.kind === 'failed' && applied.message.includes('refused to close'));
  assert.deepEqual(harness.calls, ['truncate', 'close']);
});

test('a rewind failure is reported after the close it followed', async () => {
  const harness = unitHarness({
    rewinds: true,
    resident: true,
    rewindFails: new Error('the fork failed'),
  });
  const plan = await planFrom(harness);
  harness.calls.length = 0;

  const applied = await harness.service.apply(plan, { onTruncate: () => harness.calls.push('truncate') });

  assert.equal(applied.kind, 'failed');
  assert.equal(applied.kind === 'failed' ? applied.stage : null, 'rewind');
  assert.deepEqual(harness.calls, ['truncate', 'close', 'rewind:row-before']);
});

test('an unsupported provider, a missing anchor, and a failed lookup all change nothing', async () => {
  const unsupported = unitHarness({ anchor: null });
  assert.deepEqual(await unsupported.service.prepare({ sessionId: SESSION_ID, provider: 'cursor', anchorId: 'x' }), {
    kind: 'unsupported-provider',
  });
  assert.deepEqual(unsupported.calls, ['resolve-anchor']);

  const missing = unitHarness({ anchor: { found: false, resumeThroughId: null } });
  assert.deepEqual(await missing.service.prepare({ sessionId: SESSION_ID, provider: 'claude', anchorId: 'x' }), {
    kind: 'anchor-not-found',
  });
  assert.deepEqual(missing.calls, ['resolve-anchor']);

  const failing: ChatEditPreparationDeps = {
    ...unitHarness().deps,
    resolveEditAnchor: async () => {
      throw new Error('transcript unreadable');
    },
  };
  const service = createChatEditPreparationService(failing);
  const outcome = await service.prepare({ sessionId: SESSION_ID, provider: 'claude', anchorId: 'x' });
  assert.equal(outcome.kind, 'lookup-failed');
  assert.ok(outcome.kind === 'lookup-failed' && outcome.message.includes('transcript unreadable'));
});

test('reverse control: the pre-fix mutual exclusion would leave a Codex resident host open', async () => {
  // The plan the shipped service produces for the combination the old gateway
  // could not express: Codex (rewinds) + resident.
  const shipped = await planFrom(unitHarness({ rewinds: true, resident: true }));
  assert.equal(shipped.closesResidentHost, true);

  // The pre-fix rule, re-enacted as behaviour: `resident && !rewinds`.
  const legacyPlan: ChatEditPlan = { ...shipped, closesResidentHost: false };
  const legacy = unitHarness({ rewinds: true, resident: true });
  legacy.calls.length = 0;
  await legacy.service.apply(legacyPlan, { onTruncate: () => legacy.calls.push('truncate') });

  // The legacy plan writes the replacement binding without ever retiring the
  // process that still holds the old conversation. The shipped plan's own
  // assertion (above) is what reds when this rule is restored.
  assert.ok(!legacy.calls.includes('close'));
  assert.deepEqual(legacy.calls, ['truncate', 'rewind:row-before']);
});

test('reverse control: swallowing a close refusal would let the rewind continue', async () => {
  const harness = unitHarness({
    rewinds: true,
    resident: true,
    closeFails: new Error('the host refused to close'),
  });
  const plan = await planFrom(harness);
  harness.calls.length = 0;

  const shipped = await harness.service.apply(plan, { onTruncate: () => harness.calls.push('truncate') });
  assert.equal(shipped.kind, 'failed');
  assert.ok(!harness.calls.includes('rewind:row-before'), 'the shipped chain stops at the failed close');

  // The old `closeHostAndWait` swallowed the driver rejection, so this is the
  // continuation it allowed — and why the assertion above discriminates.
  const legacyCalls = ['truncate'];
  try {
    await harness.deps.closeHostForEditAndWait(SESSION_ID);
  } catch {
    // swallowed, as `closeHost` did
  }
  await harness.deps.rewindSessionForEdit(SESSION_ID, 'row-before');
  legacyCalls.push('rewind:row-before');
  assert.deepEqual(legacyCalls, ['truncate', 'rewind:row-before']);
});

// ---------------------------------------------------------------------------
// The gateway end to end
// ---------------------------------------------------------------------------

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

type GatewayOptions = {
  provider: string;
  resident?: boolean;
  rows?: unknown[];
  anchorId?: string;
  hostFound?: boolean;
  closeError?: Error;
  rewindError?: Error;
  failRun?: Error;
  holdNextRun?: boolean;
};

type HostHarness = {
  closes: string[];
  calls: string[];
  truncatedBeforeClose: boolean;
  closeHostForEditAndWait: (sessionId: string) => Promise<{ found: boolean }>;
  attachViewer: () => void;
};

function createFakeHostManager(
  socket: ReturnType<typeof createFakeSocket>,
  events: string[],
  options: GatewayOptions,
): HostHarness {
  const harness: HostHarness = {
    closes: [],
    calls: [],
    truncatedBeforeClose: false,
    async closeHostForEditAndWait(sessionId: string) {
      harness.calls.push('close');
      events.push('close-start');
      harness.truncatedBeforeClose = socket.frames.some((frame) => frame.kind === 'history_truncated');
      await Promise.resolve();
      if (options.closeError) {
        throw options.closeError;
      }
      if (options.hostFound ?? true) {
        harness.closes.push(sessionId);
      }
      events.push('close-done');
      return { found: options.hostFound ?? true };
    },
    attachViewer() {
      // Nothing in this file subscribes.
    },
  };
  return harness;
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withGateway(
  options: GatewayOptions,
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    runs: RunCall[];
    hosts: HostHarness;
    events: string[];
    rewinds: Array<{ sessionId: string; keepThroughId: string | null }>;
    sendFrame: (frame: Record<string, unknown>) => Promise<void>;
    releaseRun: () => void;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-edit-preparation-'));
  const transcriptPath = path.join(tempDirectory, `${SESSION_ID}.jsonl`);
  const rows = options.rows ?? CLAUDE_ROWS;
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: RunCall[] = [];
  const events: string[] = [];
  const rewinds: Array<{ sessionId: string; keepThroughId: string | null }> = [];
  const socket = createFakeSocket();
  const hosts = createFakeHostManager(socket, events, options);

  let releaseRun: () => void = () => {};
  let heldRun: Promise<void> | null = null;

  const realRewind = sessionsService.rewindSessionForEdit;
  sessionsService.rewindSessionForEdit = async (sessionId: string, keepThroughId: string | null) => {
    rewinds.push({ sessionId, keepThroughId });
    events.push('rewind');
    if (options.rewindError) {
      throw options.rewindError;
    }
  };

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, options.provider, tempDirectory, 'Edit session', now, now, transcriptPath);
    if (options.resident) {
      sessionsDb.setSessionLifecycleMode(SESSION_ID, 'resident');
    }

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: async (provider: string, command: string, runtimeOptions: Record<string, unknown>) => {
            events.push('run');
            runs.push({ provider, command, options: runtimeOptions });
            if (options.failRun) {
              throw options.failRun;
            }
            if (options.holdNextRun && heldRun) {
              await heldRun;
            }
          },
        } as never,
        sessionHostManager: hosts as never,
      },
    );

    const handleMessage = socket.listeners('message')[0] as (raw: unknown) => Promise<void>;
    const sendFrame = async (frame: Record<string, unknown>): Promise<void> => {
      await handleMessage(JSON.stringify(frame));
    };

    if (options.holdNextRun) {
      heldRun = new Promise<void>((resolve) => {
        releaseRun = () => resolve();
      });
    }

    await runTest({ socket, runs, hosts, events, rewinds, sendFrame, releaseRun });
  } finally {
    releaseRun();
    heldRun = null;
    sessionsService.rewindSessionForEdit = realRewind;
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function editFrame(anchorId: string, content = 'replacement'): Record<string, unknown> {
  return { type: 'chat.edit-send', sessionId: SESSION_ID, anchorId, content };
}

// Claude/Codex × per-run/resident × middle/first. The matrix is the AC's
// coverage statement; each row asserts the same four facts (which context was
// retired, which recovery ran, what the run was told, and that identity held),
// so a change to any one cell has to face its own row.
const MATRIX: Array<{
  name: string;
  provider: 'claude' | 'codex';
  resident: boolean;
  anchorId: string;
  expectClose: boolean;
  expectRewind: string | null | undefined;
  expectedOptions: Record<string, unknown>;
}> = [
  {
    name: 'Claude per-run, middle',
    provider: 'claude', resident: false, anchorId: 'e-u2',
    expectClose: false, expectRewind: undefined,
    expectedOptions: { resumeAnchorId: 'e-a1', resumeFromScratch: false },
  },
  {
    name: 'Claude per-run, first',
    provider: 'claude', resident: false, anchorId: 'e-u1',
    expectClose: false, expectRewind: undefined,
    expectedOptions: { resumeAnchorId: undefined, resumeFromScratch: true },
  },
  {
    name: 'Claude resident, middle',
    provider: 'claude', resident: true, anchorId: 'e-u2',
    expectClose: true, expectRewind: undefined,
    expectedOptions: { resumeAnchorId: 'e-a1', resumeFromScratch: false },
  },
  {
    name: 'Claude resident, first',
    provider: 'claude', resident: true, anchorId: 'e-u1',
    expectClose: true, expectRewind: undefined,
    expectedOptions: { resumeAnchorId: undefined, resumeFromScratch: true },
  },
  {
    name: 'Codex per-run, middle',
    provider: 'codex', resident: false, anchorId: 'turn-b',
    expectClose: false, expectRewind: 'turn-a',
    expectedOptions: {},
  },
  {
    name: 'Codex per-run, first',
    provider: 'codex', resident: false, anchorId: 'turn-a',
    expectClose: false, expectRewind: null,
    expectedOptions: {},
  },
  {
    name: 'Codex resident, middle',
    provider: 'codex', resident: true, anchorId: 'turn-b',
    expectClose: true, expectRewind: 'turn-a',
    expectedOptions: {},
  },
  {
    name: 'Codex resident, first',
    provider: 'codex', resident: true, anchorId: 'turn-a',
    expectClose: true, expectRewind: null,
    expectedOptions: {},
  },
];

for (const entry of MATRIX) {
  test(`${entry.name}: contexts retire in order and the run gets only its own recovery`, async () => {
    await withGateway(
      {
        provider: entry.provider,
        resident: entry.resident,
        rows: entry.provider === 'codex' ? CODEX_ROWS : CLAUDE_ROWS,
        anchorId: entry.anchorId,
        hostFound: true,
      },
      async ({ socket, runs, hosts, events, rewinds, sendFrame }) => {
        const before = sessionsDb.getSessionById(SESSION_ID);
        const rowsBefore = sessionsDb.getAllSessions().length;

        await sendFrame(editFrame(entry.anchorId, 'a better prompt'));

        assert.equal(runs.length, 1);
        assert.equal(runs[0].command, 'a better prompt');
        assert.equal(runs[0].provider, entry.provider);

        // The recovery the provider was actually given: Claude resumes at the
        // anchor (or restarts for the first prompt); Codex is handed neither
        // Claude option because its binding, not its run options, moved.
        if (entry.provider === 'claude') {
          assert.equal(runs[0].options.resumeAnchorId, entry.expectedOptions.resumeAnchorId);
          assert.equal(runs[0].options.resumeFromScratch, entry.expectedOptions.resumeFromScratch);
        } else {
          assert.equal('resumeAnchorId' in runs[0].options, false);
          assert.equal('resumeFromScratch' in runs[0].options, false);
        }

        // Which context was retired, and in what order. A resident session's
        // close must land before the provider's rewind and before the run; a
        // per-run session never closes one.
        assert.deepEqual(hosts.closes, entry.expectClose ? [SESSION_ID] : []);
        assert.deepEqual(
          rewinds,
          entry.expectRewind === undefined
            ? []
            : [{ sessionId: SESSION_ID, keepThroughId: entry.expectRewind }],
        );
        const expectedEvents = entry.expectClose
          ? entry.expectRewind === undefined
            ? ['close-start', 'close-done', 'run']
            : ['close-start', 'close-done', 'rewind', 'run']
          : entry.expectRewind === undefined
            ? ['run']
            : ['rewind', 'run'];
        assert.deepEqual(events, expectedEvents);

        // Clients hear about the cut before any slow close begins.
        const truncation = socket.frames.find((frame) => frame.kind === 'history_truncated');
        assert.ok(truncation, 'a history_truncated frame is emitted');
        assert.equal(truncation?.anchorId, entry.anchorId);
        assert.equal(truncation?.sessionId, SESSION_ID);
        assert.equal(typeof truncation?.seq, 'number');
        if (entry.expectClose) {
          assert.equal(hosts.truncatedBeforeClose, true);
        }

        // The app session identity and lifecycle mode survived the edit.
        const after = sessionsDb.getSessionById(SESSION_ID);
        assert.equal(after?.session_id, SESSION_ID);
        assert.equal(after?.lifecycle_mode, entry.resident ? 'resident' : 'per-run');
        assert.equal(after?.provider_session_id, before?.provider_session_id);
        assert.equal(sessionsDb.getAllSessions().length, rowsBefore);
      },
    );
  });
}

test('a resident edit whose host is already gone still runs the replacement', async () => {
  await withGateway(
    { provider: 'claude', resident: true, hostFound: false },
    async ({ runs, hosts, events, sendFrame }) => {
      await sendFrame(editFrame('e-u2'));

      assert.equal(runs.length, 1);
      assert.deepEqual(events, ['close-start', 'close-done', 'run']);
      // The close was asked for; there was simply nothing to retire.
      assert.deepEqual(hosts.calls, ['close']);
      assert.deepEqual(hosts.closes, []);
      assert.equal(runs[0].options.resumeAnchorId, 'e-a1');
    },
  );
});

test('an edit refused for a busy session closes nothing, rewinds nothing, and starts nothing', async () => {
  await withGateway(
    { provider: 'codex', resident: true, rows: CODEX_ROWS, holdNextRun: true },
    async ({ socket, runs, hosts, events, rewinds, sendFrame, releaseRun }) => {
      socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'in flight' }));
      await waitFor(() => runs.length === 1, 'the in-flight run to be registered');

      await sendFrame(editFrame('turn-b', 'an edit that arrives too late'));

      // Not admitted: no host closed, no binding replaced, no second run.
      assert.deepEqual(hosts.calls, []);
      assert.deepEqual(rewinds, []);
      assert.equal(runs.length, 1);
      assert.deepEqual(events, ['run']);
      assert.equal(socket.frames.at(-1)?.code, 'RUN_IN_PROGRESS');

      releaseRun();
      // Let the in-flight turn settle before teardown, so it cannot outlive the
      // database it reads.
      await waitFor(() => socket.frames.some((frame) => frame.kind === 'complete'), 'the in-flight run to settle');
    },
  );
});

test('a host that refuses to close ends the run and reports once, before any rewind', async () => {
  await withGateway(
    {
      provider: 'claude',
      resident: true,
      closeError: new Error('the host refused to close'),
    },
    async ({ socket, runs, hosts, rewinds, sendFrame }) => {
      const before = sessionsDb.getSessionById(SESSION_ID);

      await sendFrame(editFrame('e-u2'));

      assert.deepEqual(hosts.calls, ['close']);
      assert.deepEqual(rewinds, []);
      assert.equal(runs.length, 0, 'the provider was never asked to continue the old conversation');

      const completions = socket.frames.filter((frame) => frame.kind === 'complete');
      assert.equal(completions.length, 1);
      assert.equal(completions[0].exitCode, 1);

      const failures = socket.frames.filter((frame) => frame.code === 'EDIT_REWIND_FAILED');
      assert.equal(failures.length, 1);
      assert.equal(failures[0].sessionId, SESSION_ID);

      assert.deepEqual(sessionsDb.getSessionById(SESSION_ID), before);
    },
  );
});

test('a failed binding replacement ends the run and reports once, after the host closed', async () => {
  await withGateway(
    {
      provider: 'codex',
      resident: true,
      rows: CODEX_ROWS,
      rewindError: new Error('the fork failed'),
    },
    async ({ socket, runs, hosts, sendFrame }) => {
      const before = sessionsDb.getSessionById(SESSION_ID);

      await sendFrame(editFrame('turn-b'));

      assert.deepEqual(hosts.closes, [SESSION_ID]);
      assert.equal(runs.length, 0);

      const completions = socket.frames.filter((frame) => frame.kind === 'complete');
      assert.equal(completions.length, 1);
      assert.equal(completions[0].exitCode, 1);

      const failures = socket.frames.filter((frame) => frame.code === 'EDIT_REWIND_FAILED');
      assert.equal(failures.length, 1);

      assert.deepEqual(sessionsDb.getSessionById(SESSION_ID), before);
    },
  );
});

test('a replacement process that will not start ends the run and reports once', async () => {
  await withGateway(
    {
      provider: 'codex',
      resident: true,
      rows: CODEX_ROWS,
      failRun: new Error('the CLI would not come back up'),
    },
    async ({ socket, runs, hosts, rewinds, sendFrame }) => {
      const before = sessionsDb.getSessionById(SESSION_ID);

      await sendFrame(editFrame('turn-b'));

      assert.deepEqual(hosts.closes, [SESSION_ID]);
      assert.deepEqual(rewinds, [{ sessionId: SESSION_ID, keepThroughId: 'turn-a' }]);
      assert.equal(runs.length, 1, 'the replacement was attempted');

      const completions = socket.frames.filter((frame) => frame.kind === 'complete');
      assert.equal(completions.length, 1);
      assert.equal(completions[0].exitCode, 1);

      const failures = socket.frames.filter((frame) => frame.code === 'EDIT_REWIND_FAILED');
      assert.equal(failures.length, 1);

      assert.deepEqual(sessionsDb.getSessionById(SESSION_ID), before);
    },
  );
});

test('a normal send on a resident session never closes the host', async () => {
  await withGateway(
    { provider: 'claude', resident: true },
    async ({ socket, runs, hosts, events }) => {
      socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'ordinary turn' }));
      await waitFor(() => runs.length === 1, 'the ordinary run to be registered');

      assert.deepEqual(hosts.calls, []);
      assert.deepEqual(events, ['run']);
      assert.equal(socket.frames.some((frame) => frame.kind === 'history_truncated'), false);
    },
  );
});

/**
 * AC-168 criterion — the resident permission surface.
 *
 * A resident Claude process is one CLI held across turns under
 * `bypassPermissions`. Bypass is the right launch mode (nobody is there to
 * approve a tool), but it is not the same as "nothing ever asks a person": the
 * CLI still refers the *human-facing* requests — `AskUserQuestion`,
 * `ExitPlanMode`, an MCP elicitation, a `request_user_dialog` — to the host. A
 * host that installed no callback for those leaves the request parked on a
 * person who is not connected, which is a turn that never ends. This criterion
 * measures the three entries that close that hole, on the production driver with
 * a scripted process stream:
 *
 *   (1) the SDK options one resident launch is built with: `permissionMode`
 *       `'bypassPermissions'` *and* `allowDangerouslySkipPermissions` `true`
 *       (the SDK requires both together), with all three entries installed.
 *   (2) switching the mode mid-life goes through `query.setPermissionMode` on
 *       the *running* process: same host id, same pid, one spawn.
 *   (3) with nobody connected and no user round in flight, all three entries
 *       answer by themselves — `canUseTool` denies, `onElicitation` cancels,
 *       `onUserDialog` cancels — each inside a short budget, each leaving a
 *       notification behind, and none of them entering the client wait.
 *   (4) with a browser connected, the same three take the *existing*
 *       request-frame path: a `permission_request` frame on the run's writer, an
 *       entry in the runtime's own pending list, and the client's answer the
 *       entry returns once `resolveToolApproval` hands it over.
 *
 * What is measured, and what is taken from where:
 *
 * - The launch options are read off the object the SDK is handed: the process
 *   factory below composes the *production* `createSdkResidentProcess` and
 *   replaces only its query (`createQuery`), so the bag the criterion reads is
 *   the bag `buildResidentSdkOptions` built for that launch — not a second copy
 *   of it.
 * - The three entries are the ones that launch installed, read off that same
 *   bag. Driving them is what an SDK would do when the CLI refers a request;
 *   what the *CLI* does with a live process is E8's and E9's measurement (the
 *   readings are cited from the experiment record below rather than re-taken,
 *   because a scripted stream has no CLI to ask).
 * - The `(2)` request is E9 §9.6's own frame, transcribed verbatim below. The
 *   `(3)` request is *forged from `sdk.d.ts`* and says so in as many words: E9
 *   never reached that entry, so there is no wire sample to transcribe.
 * - `side_question` is deliberately absent: it travels host→CLI, its answer is
 *   not a refusal, and AC-168 puts it out of scope. The file's own text is read
 *   back at the end and the absence is asserted rather than claimed.
 *
 * Red lines:
 * - Every entry call is wrapped in a short budget, and a call that outlives it
 *   fails *this case* with the entry's own name. The process budget guard the
 *   sibling criteria carry is deliberately not reproduced here: AC-168 asks for
 *   an attributable red inside the budget, not a process-level kill.
 * - A host is never left behind: the last leg advances the manager's own clock
 *   past the idle ceiling and reads the close out of `snapshot()`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RESIDENT_IDLE_TIMEOUT,
  createSessionHostManager,
} from '@/modules/session-hosts/index.js';
import type {
  HostScheduler,
  ProcessHost,
  SessionBinding,
  SessionHostManager,
} from '@/modules/session-hosts/index.js';
import {
  ClaudeResidentHostDriver,
  createSdkResidentProcess,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
  ClaudeResidentQueryFactory,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import {
  getPendingApprovalsForSession,
  readSessionTurn,
  resolveToolApproval,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
// The AC9 leg drives the control plane's OWN `answerApproval` verb (the one
// `approval_answer` is a transport over), built from the same runtime service
// production wires; both go through their module barrels.
import { providerRuntimeService } from '@/modules/providers/index.js';
import { createChatControlService } from '@/modules/websocket/index.js';
import type {
  AnyRecord,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const FILE_STARTED_AT = Date.now();
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this criterion measures: its own repository root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const CRITERION_PATH = 'server/modules/providers/tests/claude-resident-permissions.test.ts';
const EXPERIMENTS_PATH = 'docs/proposals/claude-resident-sessions-experiments.md';

const SESSION = 'ac168-resident-permissions';
/** The session id E9's frames carry, so a pushed frame is shaped like the recorded ones. */
const E9_SESSION_ID = 'b827aab6-2114-4fe2-b1af-991a6c2285e1';
/**
 * The pid every leg's process reports.
 *
 * A value rather than a spawned child's: what the mode-switch leg has to read is
 * the *host record's* stability across the switch, and the real pid is captured
 * in a spawn hook no scripted stream ever runs.
 */
const PROCESS_PID = 4242;
/** The refusal wording the three entries must carry. Pinned as a literal, not imported. */
const UNATTENDED_WORD = '无人值守';

/**
 * The budget one entry call is given to answer inside.
 *
 * A real timer, and deliberately so. What AC-168 asks for is that the turn ends
 * *inside a bounded time*; this criterion's clock seam (`now`) is the driver's
 * own and the answer's latency does not travel on it, so the only honest way to
 * read "it returned" is to race the call against a real deadline. The budget is
 * short because the honest answer is immediate: anything still outstanding after
 * a second is a call parked on a person who is not there, which is the failure
 * this file exists to catch.
 */
const PERMISSION_BUDGET_MS = 1_000;

/** One line of this criterion's readings, prefixed so a reader can find them. */
function say(line: string): void {
  console.log(`perm ${line}`);
}

// ---------------------------
//----------------- THE TWO REQUESTS THE ENTRIES ARE DRIVEN WITH ------------
/**
 * E9 §9.6's elicitation frame, transcribed verbatim from the experiment record.
 *
 * This is the one entry with a real wire reading behind it, so it is the one
 * request below that is a transcription rather than a forgery. The record also
 * carries the line `elicitation 请求条数：1`; the leg asserts that line is still
 * in the document, so a transcription that drifted from the record reds.
 */
const E9_ELICITATION_FRAME: AnyRecord = {
  type: 'control_request',
  request_id: '97bacb9a-7e8f-4515-87f7-8126bfc05422',
  request: {
    subtype: 'elicitation',
    mcp_server_name: 'e9eliciting',
    message: 'E9 请人回答',
    mode: 'form',
    requested_schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    },
  },
};

/**
 * The entry's own argument, taken off that frame and nothing else.
 *
 * The SDK hands `onElicitation` the wire request under its camelCase type —
 * `ElicitationRequest` in `sdk.d.ts` is `serverName` / `message` / `mode` /
 * `requestedSchema` against the wire's snake_case — so this is the SDK's own
 * renaming applied to the frame's own `request` object. No field is added,
 * dropped or invented, and the leg below re-reads the projection against the
 * frame so "nothing else" is a reading rather than a promise.
 */
function elicitationRequestOf(frame: AnyRecord): AnyRecord {
  const wire = frame.request as AnyRecord;
  return {
    serverName: wire.mcp_server_name,
    message: wire.message,
    mode: wire.mode,
    requestedSchema: wire.requested_schema,
  };
}

/**
 * One `request_user_dialog` request — forged, and it says so in the task's own
 * words: **形态来自 sdk.d.ts 的类型定义，不是实物读数**.
 *
 * E9 did not reach this entry: §9.6 triggered the elicitation and read
 * `side_question`'s silence, but nothing fired a dialog, so there is no wire
 * sample to transcribe and no reading to quote. The shape below therefore comes
 * from `sdk.d.ts` alone — `SDKControlRequestUserDialogRequest` declares
 * `{ subtype: 'request_user_dialog', dialog_kind, payload, tool_use_id? }` on the
 * wire, and the callback's own `UserDialogRequest` is the same three fields in
 * camelCase (`dialogKind`, `payload`, `toolUseID?`). The wire form is written
 * out here and projected the way the elicitation request above is, so this
 * criterion's claim about it is exactly: *a dialog-shaped request, as the types
 * describe it, is answered rather than parked.*
 */
const FORGED_DIALOG_FRAME: AnyRecord = {
  type: 'control_request',
  request_id: 'ac168-forged-dialog-0000-0000-000000000000',
  request: {
    subtype: 'request_user_dialog',
    dialog_kind: 'ac168.forged.dialog',
    payload: { prompt: 'AC168 伪造的对话框' },
    tool_use_id: 'toolu_ac168_forged',
  },
};

/** The callback's own argument for the forged frame — the same projection, one type over. */
function dialogRequestOf(frame: AnyRecord): AnyRecord {
  const wire = frame.request as AnyRecord;
  return {
    dialogKind: wire.dialog_kind,
    payload: wire.payload,
    toolUseID: wire.tool_use_id,
  };
}

/** The two interactive tools E8 read reaching `canUseTool` under bypass. */
const ASK_INPUT: AnyRecord = {
  questions: [
    {
      question: 'AC168 选一个',
      header: 'AC168',
      options: [{ label: 'A', description: '第一个' }, { label: 'B', description: '第二个' }],
      multiSelect: false,
    },
  ],
};
const PLAN_INPUT: AnyRecord = { plan: 'AC168 的计划正文' };

// ---------------------------
//----------------- FIXTURE SCAFFOLDING ------------
/**
 * A scheduler whose deadlines are queue entries and whose clock is a number.
 *
 * The same seam the resident lifecycle criteria inject, for the same reason: the
 * manager's quiet ceiling is a policy number (24 hours) that no criterion can
 * wait out, and the driver dates its own decisions on the same clock.
 */
type FakeClock = HostScheduler & {
  now(): number;
  advance(ms: number): void;
  /** Deadlines still armed — a "held, not closed" reading that is not a state. */
  pending(): number;
};

type ClockEntry = { at: number; run: () => void; spent: boolean };

function createFakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  const entries: ClockEntry[] = [];

  return {
    now: () => current,
    schedule(at, run) {
      const entry: ClockEntry = { at, run, spent: false };
      entries.push(entry);
      return () => {
        entry.spent = true;
      };
    },
    advance(ms) {
      current += ms;
      for (;;) {
        const due = entries
          .filter((entry) => !entry.spent && entry.at <= current)
          .sort((left, right) => left.at - right.at)[0];
        if (!due) {
          return;
        }
        due.spent = true;
        due.run();
      }
    },
    pending: () => entries.filter((entry) => !entry.spent).length,
  };
}

/** One launch as the production factory was handed it, plus the bag it built. */
type Launch = {
  prompt: AsyncIterable<AnyRecord>;
  /** The SDK options — the object `query()` would be called with. */
  options: AnyRecord;
};

/**
 * A resident process the criterion owns: a stream it pushes into, plus the
 * production launch behind it.
 *
 * The query never ends on its own, which is load-bearing rather than
 * convenient: an iterable that finished would make the driver's read loop call
 * `reportExit`, the manager would close the host as `exited`, and every reading
 * below would be of a dead process.
 *
 * The factory composes {@link createSdkResidentProcess} — the real one — and
 * replaces only its query, so every option the launch carries is the production
 * builder's. The wrapper around it restores the two things a scripted stream has
 * no way to produce: a pid (the real one is captured in a spawn hook that never
 * runs) and, therefore, a stable host record for leg (2) to read across the mode
 * switch.
 */
type FakeProcess = {
  /** What the driver is constructed with. */
  factory: ClaudeResidentProcessFactory;
  /** Push one frame into the stream the driver is reading. */
  emit(frame: AnyRecord): void;
  /** Every launch the driver has built, in spawn order. */
  readonly launches: Launch[];
  /** Every `setPermissionMode` argument the live query has received, in order. */
  readonly setPermissionModes: string[];
  /** How many processes the driver has started. */
  readonly spawns: number;
};

function createFakeProcess(): FakeProcess {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];
  const launches: Launch[] = [];
  const setPermissionModes: string[] = [];
  let spawns = 0;

  const iterator: AsyncIterator<AnyRecord> = {
    next(): Promise<IteratorResult<AnyRecord>> {
      const frame = pending.shift();
      if (frame) {
        return Promise.resolve({ value: frame, done: false });
      }
      return new Promise<IteratorResult<AnyRecord>>((resolve) => {
        waiters.push((queued) => resolve({ value: queued, done: false }));
      });
    },
    // Never resolves with `done`: see the type's doc comment.
    return(): Promise<IteratorResult<AnyRecord>> {
      return new Promise<IteratorResult<AnyRecord>>(() => undefined);
    },
  };

  const query: ClaudeResidentQuery = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
    setModel: async () => undefined,
    setPermissionMode: async (mode: string) => {
      setPermissionModes.push(mode);
    },
  };

  return {
    factory: (input) => {
      spawns += 1;
      const built = createSdkResidentProcess(input, {
        createQuery: ((launch: Launch) => {
          launches.push(launch);
          return query;
        }) as ClaudeResidentQueryFactory,
      });
      return { query: built.query, pid: PROCESS_PID, writeRaw: built.writeRaw } satisfies ClaudeResidentProcess;
    },
    emit: (frame) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
        return;
      }
      pending.push(frame);
    },
    get launches() {
      return launches;
    },
    get setPermissionModes() {
      return setPermissionModes;
    },
    get spawns() {
      return spawns;
    },
  };
}

/** The runtime's own turn inputs, stubbed to the facts the driver asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  // No frames are asserted through this path: the criterion is about the
  // permission entries, and the frame pipeline has its own criteria beside this
  // one.
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

function createWriter(): ProviderRuntimeWriter & { frames: AnyRecord[] } {
  const frames: AnyRecord[] = [];
  return {
    frames,
    send: (data: unknown) => {
      frames.push(data as AnyRecord);
    },
    setSessionId: () => undefined,
    userId: 1,
  };
}

/** One host's worth of fixture: a clock, a manager, a driver, and one process. */
type Leg = {
  clock: FakeClock;
  manager: SessionHostManager;
  driver: ClaudeResidentHostDriver;
  process: FakeProcess;
  sessionId: string;
  /** Every notification the driver delivered through its injected seam. */
  notifications: Array<{ userId: string | number | null; event: AnyRecord }>;
  /** The rounds `run` is holding, in the order they were armed. */
  rounds: Array<{ done: Promise<void>; writer: ProviderRuntimeWriter & { frames: AnyRecord[] } }>;
};

/**
 * One leg: a manager on the injected clock, the real driver, a scripted process.
 *
 * `connected` is the driver's browser-count port, and it is a *value supplier*
 * rather than a value so a leg can move the connection count mid-flight — which
 * is how leg (3) proves its refusals were about the count rather than about an
 * entry that cannot answer at all. Omitted, the port's own default applies
 * (`() => 0`, nobody), which is the unattended arm.
 */
function createLeg(sessionId: string, options: { connected?: () => number } = {}): Leg {
  const clock = createFakeClock();
  const manager = createSessionHostManager({ now: () => clock.now(), scheduler: clock });
  const process = createFakeProcess();
  const notifications: Array<{ userId: string | number | null; event: AnyRecord }> = [];
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: process.factory,
    now: () => clock.now(),
    ...(options.connected ? { connectedClientCount: options.connected } : {}),
    // The notification seam, injected: what AC-168 asks a reader to see is
    // *that* a refusal notified, and the default delivery (a desktop channel
    // addressed to a user id) is not observable from here.
    notifyUser: (delivery) => {
      notifications.push(delivery);
    },
  });
  return { clock, manager, driver, process, sessionId, notifications, rounds: [] };
}

/** Yields the microtask queue enough times for the read loop to drain what was pushed. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 50; hop += 1) {
    await Promise.resolve();
  }
}

/** The manager's own copy of the binding this leg's session is on, or null. */
function findBinding(leg: Leg): SessionBinding | null {
  const host = leg.manager
    .snapshot()
    .find((candidate) => candidate.bindings.has(leg.sessionId));
  return host?.bindings.get(leg.sessionId) ?? null;
}

/** The host itself, as the manager publishes it. */
function findHost(leg: Leg): ProcessHost {
  const host = leg.manager
    .snapshot()
    .find((candidate) => candidate.bindings.has(leg.sessionId));
  if (!host) {
    throw new Error(`no host serves ${leg.sessionId}`);
  }
  return host;
}

function leaseKinds(leg: Leg): string[] {
  return findBinding(leg)?.leases.map((lease) => lease.kind) ?? [];
}

/**
 * Arms one real round through the driver's `run` entry and waits for its lease.
 *
 * The wait is on the `turn` lease rather than on the host record because the
 * lease is the later of the two facts: by the time it is there, `openHost` has
 * answered, `startHost` has adopted the process *and* installed the launch, the
 * queue has been seeded, and `run` is parked at the round's settlement. Every
 * leg below can then push frames and read the launch and know both are real.
 */
async function beginRound(leg: Leg, label: string): Promise<ProviderRuntimeWriter & { frames: AnyRecord[] }> {
  const writer = createWriter();
  const done = leg.driver.run(leg.sessionId, { command: label, options: {} }, writer, CONTEXT);
  leg.rounds.push({ done, writer });
  for (let hop = 0; hop < 400; hop += 1) {
    if (leaseKinds(leg).includes('turn')) {
      return writer;
    }
    await Promise.resolve();
  }
  throw new Error('the resident host never armed a turn lease');
}

/** Ends the round in flight with a `result`, and waits for the dispatch to settle. */
async function endRound(leg: Leg): Promise<void> {
  const round = leg.rounds.pop();
  leg.process.emit(resultFrame());
  // A round a mutation failed rejects; the settlement is not what this criterion
  // reads, so the rejection is swallowed here rather than crashing the file on an
  // unhandled rejection before the leg's own readings are printed.
  await round?.done.catch(() => undefined);
}

function resultFrame(): AnyRecord {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: E9_SESSION_ID,
    uuid: randomUUID(),
  };
}

/**
 * Runs one entry call under the short budget, failing the case by name if the
 * call is still outstanding when it expires.
 */
async function withinBudget<T>(what: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} did not answer inside ${PERMISSION_BUDGET_MS}ms — it is parked on a person, not refused`,
          ),
        ),
      PERMISSION_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([run(), expired]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** The three entries one launch installed, read off the bag the SDK was handed. */
function entriesOf(launch: Launch): {
  canUseTool: (toolName: string, input: AnyRecord, options: AnyRecord) => Promise<AnyRecord>;
  onElicitation: (request: AnyRecord, options: AnyRecord) => Promise<AnyRecord>;
  onUserDialog: (request: AnyRecord, options: AnyRecord) => Promise<AnyRecord>;
} {
  const options = launch.options as AnyRecord;
  return {
    canUseTool: options.canUseTool as never,
    onElicitation: options.onElicitation as never,
    onUserDialog: options.onUserDialog as never,
  };
}

/** A signal nobody aborts: these entries answer on their own or on the client's. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------
//----------------- THE CRITERION ------------
test('resident permissions: default bypass, live mode switch, and the three entries', async () => {
  // ---- (1) The launch bag, read through the production factory. ----
  {
    const leg = createLeg(`${SESSION}-1-launch`);
    await beginRound(leg, 'AC168-LAUNCH 说一句话');

    const launch = leg.process.launches[0];
    assert.ok(launch, 'the launch must have happened');
    const options = launch.options;
    const entries = entriesOf(launch);
    say(
      `(1) launch permissionMode=${String(options.permissionMode)} ` +
        `allowDangerouslySkipPermissions=${String(options.allowDangerouslySkipPermissions)} ` +
        `canUseTool=${typeof options.canUseTool} onElicitation=${typeof options.onElicitation} ` +
        `onUserDialog=${typeof options.onUserDialog}`,
    );
    assert.equal(
      options.permissionMode,
      'bypassPermissions',
      'a resident process is launched under the mode its unattended turns assume',
    );
    // Both together, because the SDK's own type requires the pair: the second is
    // what makes the first legal (`sdk.d.ts` states the requirement).
    assert.equal(
      options.allowDangerouslySkipPermissions,
      true,
      'bypassPermissions without allowDangerouslySkipPermissions is not the pair the SDK accepts',
    );
    assert.equal(typeof entries.canUseTool, 'function', 'the launch must install the tool-callback entry');
    assert.equal(typeof entries.onElicitation, 'function', 'the launch must install the elicitation entry');
    assert.equal(typeof entries.onUserDialog, 'function', 'the launch must install the dialog entry');

    // The E8 reading, cited rather than re-taken: whether the CLI refers an
    // `AskUserQuestion` to this callback under bypass is E8's measurement with a
    // real CLI, and a scripted stream has no CLI to ask. What this criterion
    // proves is the half the driver owns — that the callback is installed on a
    // bypass launch and answers (leg 3) — so the experiment's conclusion is read
    // out of the record it is stated in, and asserted to still say so.
    const experiments = readFileSync(path.join(REPO_ROOT, EXPERIMENTS_PATH), 'utf8');
    const e8Conclusion =
      experiments
        .split('\n')
        .find((line) => line.startsWith('结论：bypassPermissions 下 AskUserQuestion')) ??
      'E8 conclusion not found';
    say(`(1) E8 conclusion: ${e8Conclusion}`);
    assert.ok(
      e8Conclusion.includes('走 canUseTool'),
      `E8 must still record that the callback is reached under bypass (${e8Conclusion})`,
    );
    const e9Count = experiments.split('elicitation 请求条数：1').length - 1;
    assert.equal(e9Count, 1, 'E9 §9.6 must still record exactly one elicitation request');
    assert.ok(
      experiments.includes('"mcp_server_name":"e9eliciting"'),
      'the frame transcribed above must still match the one E9 recorded',
    );

    await endRound(leg);
  }

  // ---- (2) A mode switch moves the running process, not the host. ----
  {
    // A browser is connected here, so the switch is not read on a host that is
    // also refusing everything: the two behaviours are separate readings.
    const leg = createLeg(`${SESSION}-2-mode`, { connected: () => 1 });
    await beginRound(leg, 'AC168-MODE-SWITCH 说一句话');

    const before = findHost(leg);
    const result = await leg.driver.reconfigure(before, leg.sessionId, { permissionMode: 'default' });
    const after = findHost(leg);
    const reading = leg.driver.permissionReading(leg.sessionId);
    // A second switch, of the other non-bypass kind the AC names: a reading that
    // moved once could be a launch-time flag written after the fact, and the
    // prompt below shows the same call reaching the *same* live query again.
    const result2 = await leg.driver.reconfigure(after, leg.sessionId, { permissionMode: 'acceptEdits' });
    const after2 = findHost(leg);
    const reading2 = leg.driver.permissionReading(leg.sessionId);
    say(
      `(2) switch=${String(result)} setPermissionMode=${JSON.stringify(leg.process.setPermissionModes)} ` +
        `spawns=${leg.process.spawns} hostId=${before.hostId}->${after2.hostId} ` +
        `pid=${String(before.pid)}->${String(after2.pid)} hostState=${after2.state} ` +
        `reading.permissionMode=${String(reading?.permissionMode)}->${String(reading2?.permissionMode)} ` +
        `secondSwitch=${String(result2)}`,
    );
    assert.deepEqual(
      leg.process.setPermissionModes,
      ['default', 'acceptEdits'],
      'each switch must reach the live query as `setPermissionMode(<mode>)`, in order',
    );
    assert.equal(result, 'live', 'a switch the process accepted is reported applied');
    assert.equal(result2, 'live', 'and the next one too');
    assert.equal(leg.process.spawns, 1, 'a mode switch must not reopen the process');
    assert.equal(after2.hostId, before.hostId, 'the host is the same host');
    assert.equal(after2.pid, before.pid, 'the pid is the same pid');
    assert.notEqual(after2.state, 'closed', 'the host is still open after the switch');
    assert.equal(
      reading?.permissionMode,
      'default',
      "the host's own account of the mode must move with the call",
    );
    assert.equal(
      reading2?.permissionMode,
      'acceptEdits',
      'and with the next call, so the reading is live rather than set once',
    );
    assert.equal(leg.process.launches.length, 1, 'no switch built a second launch');

    // Positive control for the reading above: the *launch* bag is unchanged —
    // it still says bypass — so `permissionReading` is a live value rather than a
    // restatement of what the launch was built with.
    assert.equal(
      leg.process.launches[0].options.permissionMode,
      'bypassPermissions',
      'the launch options are not rewritten by a live switch',
    );

    await endRound(leg);
  }

  // ---- (3) Unattended: all three entries refuse, notify, and return. ----
  {
    const leg = createLeg(`${SESSION}-3-unattended`);
    const writer = await beginRound(leg, 'AC168-UNATTENDED 说一句话');
    await endRound(leg);

    const launch = leg.process.launches[0];
    const entries = entriesOf(launch);
    // Both entries exist before either is driven, so a launch that installed
    // only `canUseTool` reds here by name rather than as a TypeError three
    // assertions later (the fake form AC-168 asks to be caught).
    assert.equal(typeof entries.canUseTool, 'function', '(3) the tool-callback entry must be installed');
    assert.equal(typeof entries.onElicitation, 'function', '(3) the elicitation entry must be installed');
    assert.equal(typeof entries.onUserDialog, 'function', '(3) the dialog entry must be installed');

    // No round is in flight and the port reports nobody — the unattended
    // situation, taken as a reading rather than assumed: the same leg flips the
    // count below and the same entries start asking the client instead.
    // `idle` is the host's own word for "the last round settled and nothing is
    // running" — the state the refusals are supposed to be about.
    assert.equal(findHost(leg).state, 'idle');
    assert.equal(
      leg.driver.permissionReading(leg.sessionId)?.decisions.length,
      0,
      'nothing has been asked of this host yet, so the log below is entirely the four calls',
    );

    const askRefusal = await withinBudget('canUseTool(AskUserQuestion)', () =>
      entries.canUseTool('AskUserQuestion', ASK_INPUT, { signal: liveSignal() }),
    );
    const planRefusal = await withinBudget('canUseTool(ExitPlanMode)', () =>
      entries.canUseTool('ExitPlanMode', PLAN_INPUT, { signal: liveSignal() }),
    );
    const elicitRefusal = await withinBudget('onElicitation(E9 §9.6)', () =>
      entries.onElicitation(elicitationRequestOf(E9_ELICITATION_FRAME), { signal: liveSignal() }),
    );
    const dialogRefusal = await withinBudget('onUserDialog(forged)', () =>
      entries.onUserDialog(dialogRequestOf(FORGED_DIALOG_FRAME), { signal: liveSignal() }),
    );
    // Said in the output as well as in the comments above, because this is the
    // one request below with no experiment behind it: 形态来自 sdk.d.ts 的类型定义，不是实物读数.
    say('(3) request_user_dialog 帧：形态来自 sdk.d.ts 的类型定义，不是实物读数');
    const reading = leg.driver.permissionReading(leg.sessionId);
    const pending = getPendingApprovalsForSession(leg.sessionId);
    say(`(3) canUseTool(AskUserQuestion) => ${JSON.stringify(askRefusal)}`);
    say(`(3) canUseTool(ExitPlanMode) => ${JSON.stringify(planRefusal)}`);
    say(`(3) onElicitation => ${JSON.stringify(elicitRefusal)}`);
    say(`(3) onUserDialog => ${JSON.stringify(dialogRefusal)}`);
    say(
      `(3) decisions=${reading?.decisions.length} refused=${reading?.decisions.filter((d) => d.refused).length} ` +
        `viaClient=${reading?.decisions.filter((d) => d.viaClient).length} ` +
        `lastConnectedCount=${String(reading?.lastConnectedCount)} pendingApprovals=${pending.length} ` +
        `notifications=${leg.notifications.length}`,
    );

    // The refusal wording, on the entry's own answer rather than on a log.
    assert.equal(
      askRefusal.behavior,
      'deny',
      'an unattended AskUserQuestion is answered with the SDK\'s denial shape',
    );
    assert.ok(
      String(askRefusal.message).includes(UNATTENDED_WORD),
      `the tool refusal must say why (${String(askRefusal.message)})`,
    );
    assert.equal(planRefusal.behavior, 'deny', 'ExitPlanMode is answered the same way');
    assert.ok(
      String(planRefusal.message).includes(UNATTENDED_WORD),
      `the ExitPlanMode refusal must say why (${String(planRefusal.message)})`,
    );
    assert.equal(
      elicitRefusal.action,
      'cancel',
      'an unattended elicitation is cancelled — the SDK\'s own word for "no answer is coming"',
    );
    assert.equal(
      dialogRefusal.behavior,
      'cancelled',
      'an unattended dialog is cancelled, which is what the CLI applies its default for',
    );

    // The forge is read back against its own frame: the entry was driven with
    // the dialog the types describe, not with something this criterion made up
    // on the way in.
    assert.equal(dialogRequestOf(FORGED_DIALOG_FRAME).dialogKind, 'ac168.forged.dialog');
    assert.equal(elicitationRequestOf(E9_ELICITATION_FRAME).message, 'E9 请人回答');

    // One decision per request, each logged as a refusal that never travelled.
    const decisions = reading?.decisions ?? [];
    assert.equal(decisions.length, 4, 'one decision per driven request');
    assert.equal(decisions.filter((decision) => decision.viaClient).length, 0, 'nobody was asked');
    assert.equal(decisions.filter((decision) => decision.refused).length, 4, 'all four were refusals');
    assert.equal(
      decisions.filter((decision) => decision.entry === 'canUseTool' && decision.toolName === 'AskUserQuestion').length,
      1,
      'AskUserQuestion is answered once',
    );
    assert.equal(
      decisions.filter((decision) => decision.entry === 'canUseTool' && decision.toolName === 'ExitPlanMode').length,
      1,
      'ExitPlanMode is answered once',
    );
    assert.deepEqual(
      decisions
        .filter((decision) => decision.entry !== 'canUseTool')
        .map((decision) => decision.entry)
        .sort(),
      ['onElicitation', 'onUserDialog'],
      'the two request-shaped entries each answered once',
    );
    assert.equal(
      decisions.filter((decision) => decision.requestId !== null).length,
      0,
      'a refusal mints no request id, because no frame was sent',
    );
    // The AC's own reading of "did not enter the wait": the per-run protocol's
    // pending list is the one surface that says a wait is outstanding, and it is
    // empty for a session this host refused for.
    assert.equal(pending.length, 0, 'no refusal may leave a pending approval behind');
    assert.equal(reading?.lastConnectedCount, 0, 'the reading records the count it decided on');

    // Every refusal notified, with the fact rather than only the fact that one happened.
    assert.ok(
      leg.notifications.length >= 4,
      `each refusal must notify (notifications=${leg.notifications.length})`,
    );
    const codes = new Set(leg.notifications.map((delivery) => delivery.event.code));
    assert.deepEqual(
      [...codes],
      ['permission.unattended_refused'],
      'the notice uses its own code, so it is not read as "Claude is waiting for you"',
    );
    assert.ok(
      leg.notifications.every((delivery) => delivery.event.requiresUserAction === true),
      'the notice is flagged as needing a person, which is what it is telling them about',
    );
    const noticedEntries = new Set(
      leg.notifications.map((delivery) => (delivery.event.meta as AnyRecord)?.entry),
    );
    assert.deepEqual(
      [...noticedEntries].sort(),
      ['canUseTool', 'onElicitation', 'onUserDialog'],
      'the notice carries which entry was refused',
    );
    const askNotice = leg.notifications.find(
      (delivery) => (delivery.event.meta as AnyRecord)?.toolName === 'AskUserQuestion',
    );
    assert.ok(askNotice, 'the notice carries the tool that was refused');
    assert.ok(
      String((askNotice.event.meta as AnyRecord)?.reason).includes(UNATTENDED_WORD),
      'the notice carries the refusal wording itself',
    );

    // Positive control, in this leg's own terms: the same two entries with the
    // count flipped take the client path instead of refusing. Without this, the
    // refusals above would also be green for a host that simply cannot ask.
    let connected = 0;
    const control = createLeg(`${SESSION}-3-control`, { connected: () => connected });
    const controlWriter = await beginRound(control, 'AC168-UNATTENDED-CONTROL 说一句话');
    await endRound(control);
    const controlEntries = entriesOf(control.process.launches[0]);
    connected = 1;
    const asked = controlEntries.canUseTool('AskUserQuestion', ASK_INPUT, { signal: liveSignal() });
    await settle();
    const askedFrames = controlWriter.frames.filter((frame) => frame.kind === 'permission_request');
    say(
      `(3) control with connected=1 frames=${askedFrames.length} ` +
        `pending=${getPendingApprovalsForSession(control.sessionId).length}`,
    );
    assert.equal(
      askedFrames.length,
      1,
      'with a browser connected the same entry asks the client instead of refusing',
    );
    resolveToolApproval(askedFrames[0].requestId as string, { allow: true });
    assert.deepEqual(await asked, { behavior: 'allow', updatedInput: ASK_INPUT });
    // The attended path notifies too — that is the per-run behaviour a client
    // already renders ("Claude is waiting for you") — so what separates the two
    // paths is the code, not whether a notice was raised at all.
    assert.deepEqual(
      [...new Set(control.notifications.map((delivery) => delivery.event.code))],
      ['permission.required'],
      'the attended path raises the ask-the-user notice, never the unattended one',
    );

    // The leg's own writer, by contrast, was never asked anything.
    assert.equal(
      writer.frames.filter((frame) => frame.kind === 'permission_request').length,
      0,
      'the unattended leg sent no request frame',
    );
  }

  // ---- (4) Attended: the same three entries take the existing request flow. ----
  {
    const leg = createLeg(`${SESSION}-4-attended`, { connected: () => 1 });
    const writer = await beginRound(leg, 'AC168-ATTENDED 说一句话');
    const entries = entriesOf(leg.process.launches[0]);

    const askWait = entries.canUseTool('AskUserQuestion', ASK_INPUT, { signal: liveSignal() });
    await settle();
    const elicitWait = entries.onElicitation(elicitationRequestOf(E9_ELICITATION_FRAME), {
      signal: liveSignal(),
    });
    await settle();
    const dialogWait = entries.onUserDialog(dialogRequestOf(FORGED_DIALOG_FRAME), { signal: liveSignal() });
    await settle();

    const frames = writer.frames.filter((frame) => frame.kind === 'permission_request');
    const pending = getPendingApprovalsForSession(leg.sessionId);
    say(
      `(4) frames=${frames.length} kinds=${JSON.stringify(frames.map((frame) => frame.toolName))} ` +
        `pending=${pending.length} pendingTools=${JSON.stringify(pending.map((entry) => entry.toolName))} ` +
        `notifications=${leg.notifications.length}`,
    );
    assert.equal(frames.length, 3, 'all three entries must reach the client as request frames');
    assert.deepEqual(
      frames.map((frame) => frame.toolName),
      ['AskUserQuestion', 'onElicitation', 'onUserDialog'],
      'the frame labels a tool-shaped request by its tool and a request-shaped one by its entry',
    );
    assert.deepEqual(
      frames[0].input,
      ASK_INPUT,
      'the tool request travels verbatim, which is what a client renders',
    );
    assert.equal(frames[0].sessionId, leg.sessionId, 'the frame is addressed to the application session');
    assert.deepEqual(
      frames[1].input,
      elicitationRequestOf(E9_ELICITATION_FRAME),
      'the elicitation travels as the frame\'s input, under the SDK\'s own field names',
    );
    assert.equal(
      pending.length,
      3,
      'each frame leaves exactly one entry in the runtime\'s own pending list — the wait AC-168 says a refusal must not enter',
    );

    // The client answers, in the runtime's own protocol, and each entry answers
    // in the SDK's shape for its kind.
    const askFrame = frames[0];
    const elicitFrame = frames[1];
    const dialogFrame = frames[2];
    resolveToolApproval(askFrame.requestId as string, {
      allow: true,
      updatedInput: { questions: ASK_INPUT.questions },
    });
    assert.deepEqual(await askWait, {
      behavior: 'allow',
      updatedInput: { questions: ASK_INPUT.questions },
    });
    resolveToolApproval(elicitFrame.requestId as string, { allow: true, content: { answer: 'E9 的回答' } });
    assert.deepEqual(await elicitWait, { action: 'accept', content: { answer: 'E9 的回答' } });
    resolveToolApproval(dialogFrame.requestId as string, { allow: true, result: { choice: 'A' } });
    assert.deepEqual(await dialogWait, { behavior: 'completed', result: { choice: 'A' } });

    assert.equal(
      getPendingApprovalsForSession(leg.sessionId).length,
      0,
      'resolved requests leave the pending list',
    );
    assert.deepEqual(
      [...new Set(leg.notifications.map((delivery) => delivery.event.code))],
      ['permission.required'],
      'asking a connected browser never raises the unattended notice',
    );
    const reading = leg.driver.permissionReading(leg.sessionId);
    assert.equal(reading?.decisions.filter((decision) => decision.viaClient).length, 3);
    assert.equal(reading?.decisions.filter((decision) => decision.refused).length, 0);
    assert.equal(reading?.lastConnectedCount, 1, 'the reading records the count it decided on');

    await endRound(leg);

    // The DoD's "no residual host": the ceiling the manager holds this host
    // under is reached on the injected clock, and the close is read out of the
    // manager's own snapshot — over the whole snapshot, so "the host this leg
    // started" is not the only record the reading covers.
    leg.clock.advance(RESIDENT_IDLE_TIMEOUT);
    const snapshot = leg.manager.snapshot();
    const closed = findHost(leg);
    const open = snapshot.filter((host) => host.state !== 'closed');
    say(
      `(4) after-idle hostState=${closed.state} closeReason=${String(closed.closeReason)} ` +
        `hosts=${snapshot.length} openHosts=${open.length} pendingDeadlines=${leg.clock.pending()}`,
    );
    assert.equal(closed.state, 'closed', 'the host this leg started is closed when the criterion ends');
    assert.equal(closed.closeReason, 'idle');
    assert.deepEqual(
      open.map((host) => host.hostId),
      [],
      'no host is left unclosed by the criterion',
    );
  }
});

// ---------------------------
//----------------- AC9: the control plane settles a resident park ------------
/**
 * AC9 — the resident end-to-end leg.
 *
 * The same production driver, the same scripted process, one resident host: an
 * `AskUserQuestion` the CLI refers to this host parks on the client, and the
 * park is settled through the control plane's OWN `answerApproval` verb — the
 * verb the MCP `approval_answer` tool is a transport over — rather than by
 * reaching into the runtime the way leg (4) above does. Three facts are read off
 * the real objects:
 *
 *   - the session's live turn phase is `awaitingPermission` while the question
 *     is parked and is something else once the answer lands, which is the state
 *     the MCP `overview` / `session_get` readers project as `awaitingUser`;
 *   - the real `resolveToolApproval` is reached exactly once for that request
 *     even though two answers are fired together, and the loser is told
 *     `ALREADY_DECIDED` off the runtime's decision ledger;
 *   - the host record's `hostId` and `pid` are unchanged across the settle, so
 *     answering through the control plane does not restart the resident.
 */
test('resident permissions: the control plane settles a parked question once, leaving the host in place', async () => {
  // The control verb resolves the owning session through the database module, so
  // a database has to be live; it is pointed at a throwaway file first, or the
  // first lookup would open the checkout's own `server/database/auth.db`. No
  // session row is needed: the shared access entry answers on the caller's id
  // alone (`assertSessionAccess` ignores the session), and this leg is not about
  // ownership.
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'ac168-resident-approval-'));
  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'resident-approval.db');
    await initializeDatabase();

    const leg = createLeg(`${SESSION}-9-control-plane`, { connected: () => 1 });
    const writer = await beginRound(leg, 'AC168-CONTROL-PLANE 说一句话');
    const hostBefore = findHost(leg);
    const entries = entriesOf(leg.process.launches[0]);

    const askWait = entries.canUseTool('AskUserQuestion', ASK_INPUT, { signal: liveSignal() });
    await settle();

    const frames = writer.frames.filter((frame) => frame.kind === 'permission_request');
    assert.equal(frames.length, 1, 'the parked question reaches the client as one request frame');
    const requestId = frames[0].requestId as string;
    const parkedPhase = readSessionTurn(leg.sessionId).phase;
    const parkedPending = getPendingApprovalsForSession(leg.sessionId).length;

    // The real runtime behind a counting shim: every other facet is the service's
    // own, so the ledger, the pending set and the resolver this leg reads back are
    // production's, and only the call count is added.
    const resolveCalls: string[] = [];
    const countingRuntime = {
      ...providerRuntimeService,
      resolveToolApproval(id: string, decision: unknown, decidedBy: string | null = null): void {
        resolveCalls.push(id);
        providerRuntimeService.resolveToolApproval(id, decision as never, decidedBy);
      },
    };
    const control = createChatControlService({
      runtime: countingRuntime as never,
      listApprovalSessionIds: () => [leg.sessionId],
    });

    // TWO answers, fired together: exactly one may settle the request. The verb's
    // body has no `await` before the ledger is read, so the first call settles
    // before the second is even invoked — deterministic, not a race to observe.
    const [first, second] = await Promise.all([
      control.answerApproval(
        { userId: 1, via: 'mcp' },
        { requestId, allow: true, answers: { questions: ASK_INPUT.questions } },
      ),
      control.answerApproval({ userId: 1, via: 'mcp' }, { requestId, allow: false }),
    ]);
    const settleResult = await askWait;
    await settle();

    const hostAfter = findHost(leg);
    const resolvedPhase = readSessionTurn(leg.sessionId).phase;
    const resolveCount = resolveCalls.filter((id) => id === requestId).length;
    say(
      `(9) parkedPhase=${parkedPhase} parkedPending=${parkedPending} resolvedPhase=${resolvedPhase} ` +
        `resolveCount=${resolveCount} first=${JSON.stringify(first)} second=${JSON.stringify(second)} ` +
        `hostId=${hostBefore.hostId}->${hostAfter.hostId} pid=${String(hostBefore.pid)}->${String(hostAfter.pid)} ` +
        `spawns=${leg.process.spawns}`,
    );

    assert.equal(parkedPhase, 'awaitingPermission', 'the park is the live turn phase, not a fixture');
    assert.equal(parkedPending, 1, 'the park holds exactly one pending approval entry');
    assert.notEqual(resolvedPhase, 'awaitingPermission', 'answering leaves the awaiting phase');
    assert.equal(
      getPendingApprovalsForSession(leg.sessionId).length,
      0,
      'the settled request leaves the pending list',
    );
    assert.deepEqual(
      settleResult,
      { behavior: 'allow', updatedInput: { questions: ASK_INPUT.questions } },
      'the decision the winner wrote is the one the entry answers with',
    );
    assert.equal(resolveCount, 1, 'the real resolver is reached exactly once for the request');

    const winners = [first, second].filter((result) => result.ok === true);
    const losers = [first, second].filter((result) => result.ok === false);
    assert.equal(winners.length, 1, 'exactly one concurrent answer wins');
    assert.equal(losers.length, 1, 'exactly one concurrent answer loses');
    const loser = losers[0] as { ok: false; code: string };
    assert.equal(
      loser.code,
      'ALREADY_DECIDED',
      'the loser is told another caller settled it, not that the request expired',
    );

    assert.equal(hostAfter.hostId, hostBefore.hostId, 'answering did not replace the host');
    assert.equal(hostAfter.pid, hostBefore.pid, 'answering did not restart the process');
    assert.equal(leg.process.spawns, 1, 'answering did not open a second process');

    await endRound(leg);
    leg.clock.advance(RESIDENT_IDLE_TIMEOUT);
    assert.equal(findHost(leg).state, 'closed', 'the host this leg started is closed when the leg ends');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// ---------------------------
//----------------- THE CRITERION'S OWN TEXT ------------
/**
 * One reading that is about this file rather than about the driver.
 *
 * `side_question` is out of scope (AC-168 says so): it travels host→CLI, its
 * answer is not a refusal, and no branch here may be written for it. The word is
 * assembled from halves so that this check does not match itself, and the hits
 * are split by whether the line is a comment — so "mentioned, never asserted" is
 * a reading anyone can retake with a real `grep -c`, rather than a claim. The
 * same convention the sibling resident criterion uses for the field it must not
 * read.
 *
 * `elapsed` is the wall clock the whole file took: with a one-second budget per
 * entry call, a criterion that really waited would show it here.
 */
after(() => {
  const NOT_IN_SCOPE = ['side', '_question'].join('');
  const ownSource = readFileSync(path.join(REPO_ROOT, CRITERION_PATH), 'utf8').split('\n');
  const hits = ownSource.filter((line) => line.includes(NOT_IN_SCOPE));
  const codeHits = hits.filter((line) => {
    const trimmed = line.trim();
    return !(
      trimmed.startsWith('*') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*/')
    );
  });
  console.log(
    `perm grep -c "${NOT_IN_SCOPE}" ${CRITERION_PATH} = ${hits.length} ` +
      `(commentHits=${hits.length - codeHits.length} codeHits=${codeHits.length})`,
  );
  assert.equal(
    codeHits.length,
    0,
    `the criterion must have no branch or assertion for the out-of-scope entry (code hits: ${codeHits.join(' | ')})`,
  );

  const elapsed = Date.now() - FILE_STARTED_AT;
  console.log(`perm elapsed=${elapsed}ms budgetPerCall=${PERMISSION_BUDGET_MS}ms`);
  assert.ok(elapsed < 60_000, `the criterion took ${elapsed}ms, which means it really waited`);
});

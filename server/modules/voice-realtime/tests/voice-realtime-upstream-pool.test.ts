/**
 * AC-321's criterion for the C3 upstream session pool — the active/standby pair and the
 * transparent idle rotation between them (SPEC `docs/proposals/voice-realtime-segmented-relay-SPEC.md` §C3).
 *
 * The pool is driven ENTIRELY over `realtime-bridge-harness.ts`'s fake transports — no
 * socket, no `fetch`, no real upstream — across the readings the AC names:
 *
 *  - AC1/AC2: the pool opens one active session and one pre-warmed standby, and after the
 *    idle threshold it rotates EXACTLY once, the switch costing no more than 1.5× the
 *    session-open latency P0a-S2 measured. That baseline is READ from
 *    `experiments/voice-realtime-segmented/p0/RESULT.json` at run time — never hardcoded —
 *    so a re-measured baseline moves the bound with it.
 *  - AC3: a segment in flight postpones the switch (nothing is stranded on the retired
 *    session), and a segment that arrives at the rotation instant is committed in the NEW
 *    session exactly once and delivered exactly once.
 *  - AC4: the standby receives no audio frames before the rotation, while still being
 *    warmed through `session.update` — the whole reason it exists.
 *  - AC5: both of those readings are shown to be load-bearing by two false forms, each a
 *    copy of the shipping module mutated BESIDE it and driven through the same scenario.
 *
 * Provenance (the goal record's AC-321): this file is the criterion. Run it with THIS
 * repo's runner — the tree is TS-ESM and `node --test` cannot remap `.js` → `.ts`:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts
 *
 * Consumers: the quay worker's AC state for AC-321.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  connect,
  createUpstreamPool,
  DEFAULT_IDLE_ROTATE_MS,
  type RealtimeToolExecutor,
  type UpstreamPool,
  type UpstreamPoolRotation,
} from '../index.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

// ── where things are ─────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This module's directory — where a falsify copy must sit so its relative imports resolve. */
const MODULE_DIR = path.resolve(HERE, '..');
/** The shipping pool: what the AC5 mutations copy. */
const SHIPPING_POOL_MODULE = path.join(MODULE_DIR, 'voice-realtime-upstream-pool.ts');
/** The repo root, from `server/modules/voice-realtime/tests`. */
const REPO_ROOT = path.resolve(HERE, '../../../..');
/** The P0a record the session-open baseline comes from. */
const P0_RESULT = path.join(REPO_ROOT, 'experiments/voice-realtime-segmented/p0/RESULT.json');

/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
/** A copy this process owns: prefixed AND pid-tagged, so a sibling's copy is never mistaken for ours. */
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** The signature the shipping (and copied) `createUpstreamPool` exposes. */
type CreatePoolFn = typeof createUpstreamPool;

/** Imports a pool module by path. The specifier is dynamic, so TS types it structurally here. */
async function importPool(modulePath: string): Promise<{ createUpstreamPool: CreatePoolFn }> {
  return (await import(pathToFileURL(modulePath).href)) as { createUpstreamPool: CreatePoolFn };
}

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One 20 ms PCM16 frame, base64 — the shape the browser sends. */
const FRAME = Buffer.alloc(640, 7).toString('base64');

// ── the AC2 baseline, read rather than retyped ───────────────────────────────────────────────

/**
 * The measured session-open ceiling from P0a-S2, times the AC's 1.5 — in ms.
 *
 * P0a-S2 opened six real sessions and recorded `p50=259ms p90=736ms min=130ms max=736ms`. The
 * AC bounds a rotation's switch latency by that baseline ×1.5, and it says the baseline comes
 * FROM the record, so this reads `max` out of S2's notes rather than carrying the number. A
 * re-measured P0a therefore moves the bound without touching this file.
 */
function switchCeilingMs(): number {
  const record = JSON.parse(readFileSync(P0_RESULT, 'utf8')) as {
    stages?: Array<{ stage?: string; notes?: string }>;
  };
  const stage = record.stages?.find((entry) => entry.stage === 'S2');
  const measured = /max=(\d+)ms/.exec(stage?.notes ?? '');
  assert.ok(measured, `P0a-S2's notes must carry the measured session-open max, got: ${stage?.notes}`);
  return Number(measured[1]) * 1.5;
}

// ── the rig ───────────────────────────────────────────────────────────────────────────────────

type Rig = {
  pool: UpstreamPool;
  /** One fake transport per SESSION, in creation order: [active, standby, replacement, …]. */
  transports: FakeTransport[];
  logs: string[];
  rotations: UpstreamPoolRotation[];
  /**
   * Every state the pool REPORTED to its caller. A rotation is transparent, so this must
   * stay `['open', …]` — a standby opening and a retired session closing are the pool's own
   * business and must never reach the page as a connection that blinked.
   */
  states: string[];
  /** Every `session_send` the model asked for, across all sessions of this pool. */
  sends: Array<Record<string, unknown>>;
};

/**
 * Builds a pool over fake transports.
 *
 * `segment: { commitMode: 'manual' }` is what the shipping path uses: the segment's frames
 * are held and written at `segment_end`, so an append on the wire means a segment was
 * CLOSED on that session — which is what AC4's count reads.
 */
function buildRig(createPool: CreatePoolFn, options: { idleRotateMs: number; standbyReadyTimeoutMs?: number }): Rig {
  const transports: FakeTransport[] = [];
  const logs: string[] = [];
  const rotations: UpstreamPoolRotation[] = [];
  const states: string[] = [];
  const sends: Array<Record<string, unknown>> = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      sends.push(args);
      return { queued: false };
    },
  };
  const pool = createPool({
    createSession: (hooks) => {
      const transport = createFakeTransport();
      transports.push(transport);
      return connect(transport, [], executor, { hooks, segment: { commitMode: 'manual' } });
    },
    idleRotateMs: options.idleRotateMs,
    standbyReadyTimeoutMs: options.standbyReadyTimeoutMs ?? 1_000,
    log: (line) => logs.push(line),
    hooks: {
      onRotate: (rotation) => rotations.push(rotation),
      onStateChange: (next) => states.push(next),
    },
  });
  return { pool, transports, logs, rotations, states, sends };
}

const appends = (transport: FakeTransport): number =>
  transport.sent.filter((message) => message.type === 'input_audio_buffer.append').length;
const commits = (transport: FakeTransport): number =>
  transport.sent.filter((message) => message.type === 'input_audio_buffer.commit').length;
/** The `session.update` frames on one session, narrowed to the body a warming write carries. */
const sessionUpdates = (transport: FakeTransport): Array<{ session?: { instructions?: unknown } }> =>
  transport.sent.filter((message) => message.type === 'session.update') as Array<{
    session?: { instructions?: unknown };
  }>;

/** Whether `text` was written into `transport`'s session body — the warm-up reading. */
const toldInstructions = (transport: FakeTransport, text: string): boolean =>
  sessionUpdates(transport).some((message) => message.session?.instructions === text);

// ── AC1/AC2: one active + one warmed standby, and exactly one rotation per idle period ───────

test('AC1: the pool is a bridge — one active session, one pre-warmed standby, state stays open', async () => {
  const rig = buildRig(createUpstreamPool, { idleRotateMs: 10_000 });
  try {
    assert.equal(rig.pool.idleRotateMs, 10_000);
    await rig.pool.whenConnected();
    assert.equal(rig.pool.state, 'open');

    // Two sessions are open, not one: the standby is what makes a rotation free, so it is
    // opened with the connection rather than at the moment it is needed.
    assert.equal(rig.transports.length, 2, 'the active session AND its standby must both be open');
    assert.equal(rig.pool.activeOrdinal, 1);
    assert.equal(rig.pool.standbyOrdinal, 2);
    assert.equal(rig.transports[0]?.openCalls, 1);
    assert.equal(rig.transports[1]?.openCalls, 1);

    // Instructions reach both, so a rotation cannot land on a session that was never told
    // what it is for. This is the "预热" half of the SPEC's pair.
    rig.pool.sendSessionUpdate('INSTRUCTIONS');
    for (const [index, transport] of rig.transports.entries()) {
      assert.ok(toldInstructions(transport, 'INSTRUCTIONS'), `session ${index + 1} must have been told the instructions`);
    }

    // Every forwarded call lands on the active session — the standby is untouched by design.
    rig.pool.startSegment(1);
    rig.pool.sendSegmentAudio(1, FRAME);
    rig.pool.endSegment(1);
    await waitFor(() => appends(rig.transports[0]!) === 1);
    assert.equal(commits(rig.transports[0]), 1);
    assert.equal(appends(rig.transports[1]!), 0, 'the standby must receive no audio');
    assert.equal(commits(rig.transports[1]!), 0, 'the standby must commit nothing');
  } finally {
    await rig.pool.close();
  }
  // Closing the pool closes BOTH sessions, not just the active one.
  assert.equal(rig.transports[0]?.closeCalls, 1);
  assert.equal(rig.transports[1]?.closeCalls, 1);
});

test('AC2: the SPEC default is 90 s, and a rotation happens ONCE per idle period within the measured bound', async () => {
  assert.equal(DEFAULT_IDLE_ROTATE_MS, 90_000, "the SPEC's adopted threshold is 90 s");

  const thresholdMs = 30;
  const rig = buildRig(createUpstreamPool, { idleRotateMs: thresholdMs });
  try {
    await rig.pool.whenConnected();
    await waitFor(() => rig.rotations.length === 1, 2_000);

    const rotation = rig.rotations[0]!;
    assert.equal(rotation.from, 1, 'the session that was active');
    assert.equal(rotation.to, 2, 'the standby it switched to');
    assert.ok(rotation.idleMs >= thresholdMs, `the switch must follow the idle threshold, got idleMs=${rotation.idleMs}`);
    assert.ok(rotation.standbyAgeMs > 0, 'the standby it switched to had been open for a while');

    // AC2's bound, against the P0a-S2 baseline read from the record.
    const ceiling = switchCeilingMs();
    assert.ok(
      rotation.switchMs <= ceiling,
      `the switch (trigger → the new session able to take audio) must stay within the P0a-S2 baseline ×1.5 = ${ceiling}ms, got ${rotation.switchMs}ms`,
    );

    // The SPEC's log line, with the facts it names.
    assert.ok(
      rig.logs.some((line) => /upstream-pool rotate from=1 to=2 idleMs=\d+ standbyAgeMs=\d+ switchMs=\d+$/.test(line)),
      `a rotation must be logged as the SPEC spells it, got: ${JSON.stringify(rig.logs)}`,
    );

    // The switch is TRANSPARENT: the page never sees the connection blink. The standby's
    // open and the retired session's close are suppressed because neither is the active
    // session at the moment it happens, so the only state ever reported is the first `open`.
    assert.deepEqual(rig.states, ['open'], 'a rotation must not surface as a connection that blinked');
    assert.equal(rig.pool.state, 'open');
    assert.equal(rig.pool.activeOrdinal, 2);
    assert.equal(rig.pool.standbyOrdinal, 3, 'a replacement standby is refilled after the switch');
    assert.equal(rig.transports.length, 3);

    // ONCE: a rotation ends the idle period. Nothing further happens without new activity —
    // otherwise a connection left quiet overnight would open a fresh upstream every 90 s.
    await sleep(thresholdMs * 4);
    assert.equal(rig.rotations.length, 1, 'idle time alone must not rotate again');
    assert.equal(rig.pool.activeOrdinal, 2);

    // …and the clock restarts on the next activity, so the NEXT idle stretch rotates again.
    rig.pool.startSegment(7);
    rig.pool.sendSegmentAudio(7, FRAME);
    rig.pool.endSegment(7);
    rig.transports[1]!.peerSend({ type: 'response.done', response: { id: 'r-7' } });
    await waitFor(() => rig.rotations.length === 2, 2_000);
    assert.deepEqual(
      rig.rotations.map((entry) => [entry.from, entry.to]),
      [
        [1, 2],
        [2, 3],
      ],
    );
  } finally {
    await rig.pool.close();
  }
});

// ── AC3: what must NOT be rotated, and what must be delivered exactly once ────────────────────

/**
 * Drives AC3's in-flight reading: a segment is opened and left open past the threshold, then
 * its commit is left unanswered past it too, and only then settled. Returns how many rotations
 * had happened at each of those three points.
 */
async function driveInFlight(createPool: CreatePoolFn): Promise<{
  whileOpen: number;
  whileCommitted: number;
  afterSettle: number;
}> {
  const rig = buildRig(createPool, { idleRotateMs: 25 });
  try {
    await rig.pool.whenConnected();
    rig.pool.startSegment(1);
    rig.pool.sendSegmentAudio(1, FRAME);
    await sleep(150); // ≫ 25 ms: the timer fires several times with the segment open
    const whileOpen = rig.rotations.length;

    rig.pool.endSegment(1); // the commit is now awaiting its response
    await sleep(75);
    const whileCommitted = rig.rotations.length;

    rig.transports[0]!.peerSend({ type: 'response.done', response: { id: 'r-1' } });
    await sleep(150);
    return { whileOpen, whileCommitted, afterSettle: rig.rotations.length };
  } finally {
    await rig.pool.close();
  }
}

test('AC3: a segment in flight (and its unanswered commit) postpones the switch, which happens once both settle', async () => {
  assert.deepEqual(
    await driveInFlight(createUpstreamPool),
    { whileOpen: 0, whileCommitted: 0, afterSettle: 1 },
    'the switch must wait for the segment, then for its commit, and happen once they are done',
  );
});

test('AC3: a segment arriving at the rotation instant is committed in the new session exactly once, and delivered once', async () => {
  const rig = buildRig(createUpstreamPool, { idleRotateMs: 25 });
  try {
    await rig.pool.whenConnected();
    await waitFor(() => rig.rotations.length === 1, 2_000);
    const [retired, current] = rig.transports as [FakeTransport, FakeTransport];
    assert.equal(rig.pool.activeOrdinal, 2);

    // The instant after the switch: the segment goes to the session that is active NOW —
    // exactly one commit, one append, one response request, and nothing on the retired one.
    rig.pool.startSegment(2);
    rig.pool.sendSegmentAudio(2, FRAME);
    rig.pool.endSegment(2);
    await waitFor(() => commits(current) === 1);
    assert.equal(appends(current), 1, 'the segment audio must be written to the new session exactly once');
    assert.equal(commits(current), 1, 'exactly one commit');
    assert.equal(current.sent.filter((message) => message.type === 'response.create').length, 1);
    assert.equal(commits(retired), 0, 'the retired session must not be handed a segment it cannot answer');
    assert.equal(appends(retired), 0);

    // …and the delivery that follows belongs to that one segment: exactly one session_send.
    current.peerSend({
      type: 'function_call',
      callId: 'c2',
      name: 'session_send',
      arguments: JSON.stringify({ session: 'bound', message: 'the second thing said' }),
    });
    await waitFor(() => rig.sends.length === 1);
    await sleep(20);
    assert.equal(rig.sends.length, 1, 'a segment at the rotation instant must be delivered exactly once');
    assert.equal(rig.sends[0]!.message, 'the second thing said');
  } finally {
    await rig.pool.close();
  }
});

// ── AC4: the standby is warm but silent ───────────────────────────────────────────────────────

/** Drives AC4's reading: real audio through the active session, with no rotation in sight. */
async function driveStandbyFrames(createPool: CreatePoolFn): Promise<{
  active: number;
  standby: number;
  standbyTold: boolean;
}> {
  const rig = buildRig(createPool, { idleRotateMs: 60_000 });
  try {
    await rig.pool.whenConnected();
    rig.pool.sendSessionUpdate('INSTRUCTIONS');
    rig.pool.startSegment(1);
    rig.pool.sendSegmentAudio(1, FRAME);
    rig.pool.endSegment(1);
    await sleep(30);
    const [active, standby] = rig.transports as [FakeTransport, FakeTransport];
    return {
      active: appends(active),
      standby: appends(standby),
      standbyTold: toldInstructions(standby, 'INSTRUCTIONS'),
    };
  } finally {
    await rig.pool.close();
  }
}

test('AC4: the standby receives no audio frames before a rotation — only the session body', async () => {
  const reading = await driveStandbyFrames(createUpstreamPool);
  assert.equal(reading.active, 1, 'the active session got the frame');
  assert.equal(reading.standby, 0, 'the standby must receive NO audio frame before the rotation');
  assert.equal(reading.standbyTold, true, 'the standby is warmed by its session body, not by audio');
});

// ── AC5: the false forms ──────────────────────────────────────────────────────────────────────

/**
 * Mutation A — `canSwitchNow()` answers `true` always, so the pool rotates out from under a
 * segment that is still in flight. The in-flight reading above is what must catch it.
 */
const SWITCH_GUARD_ANCHOR =
  'return active.bridge.openSegmentSeq === null && active.bridge.committedSegmentSeq === null;';
const SWITCH_GUARD_MUTANT = 'return true;';

/**
 * Mutation B — the pool "keeps the standby in sync" by mirroring the segment's audio and its
 * end onto the spare. The standby counter reading above is what must catch it: two anchors,
 * because either alone changes nothing on the wire (manual mode holds frames until the end).
 */
const SEGMENT_AUDIO_ANCHOR = '      active.bridge.sendSegmentAudio(seq, audio);';
const SEGMENT_AUDIO_MUTANT = `${SEGMENT_AUDIO_ANCHOR}\n      standby?.bridge.sendSegmentAudio(seq, audio);`;
const SEGMENT_END_ANCHOR = '      active.bridge.endSegment(seq);';
const SEGMENT_END_MUTANT = `${SEGMENT_END_ANCHOR}\n      standby?.bridge.endSegment(seq);`;

test('AC5: the two readings are load-bearing — each mutation reddens its own case', async () => {
  const source = readFileSync(SHIPPING_POOL_MODULE, 'utf8');
  assert.equal(countOccurrences(source, SWITCH_GUARD_ANCHOR), 1, 'the switch-guard anchor must occur exactly once');
  assert.equal(countOccurrences(source, SEGMENT_AUDIO_ANCHOR), 1, 'the segment-audio anchor must occur exactly once');
  assert.equal(countOccurrences(source, SEGMENT_END_ANCHOR), 1, 'the segment-end anchor must occur exactly once');

  const basePath = ownCopy('pool-base');
  const ignoreInFlightPath = ownCopy('pool-ignore-in-flight');
  const standbyFramesPath = ownCopy('pool-standby-frames');
  const standbyFramesSource = source.replace(SEGMENT_AUDIO_ANCHOR, SEGMENT_AUDIO_MUTANT).replace(SEGMENT_END_ANCHOR, SEGMENT_END_MUTANT);
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(ignoreInFlightPath, source.replace(SWITCH_GUARD_ANCHOR, SWITCH_GUARD_MUTANT), 'utf8');
    writeFileSync(standbyFramesPath, standbyFramesSource, 'utf8');
    const base = await importPool(basePath);
    const ignoreInFlight = await importPool(ignoreInFlightPath);
    const standbyFrames = await importPool(standbyFramesPath);

    // Unmutated (a faithful COPY, not the shipping module): both readings hold — so the
    // reds below are the mutations' doing, not the copying's.
    assert.deepEqual(await driveInFlight(base.createUpstreamPool), { whileOpen: 0, whileCommitted: 0, afterSettle: 1 });
    assert.deepEqual(await driveStandbyFrames(base.createUpstreamPool), { active: 1, standby: 0, standbyTold: true });

    // Mutation A: the in-flight segment no longer holds the switch — the rotation happens
    // while it is still open, which is the strand-the-utterance bug the SPEC forbids.
    const ignoring = await driveInFlight(ignoreInFlight.createUpstreamPool);
    assert.ok(
      ignoring.whileOpen > 0,
      `ignoring a segment in flight must redden the in-flight case, got whileOpen=${ignoring.whileOpen}`,
    );

    // Mutation B: the standby is handed the segment's frames, so the "no audio before the
    // rotation" count is no longer 0.
    const leaking = await driveStandbyFrames(standbyFrames.createUpstreamPool);
    assert.ok(leaking.standby > 0, `sending the standby frames early must redden the count case, got standby=${leaking.standby}`);
    assert.equal(leaking.active, 1, 'the active session still gets its frame under the mutation');
  } finally {
    rmSync(basePath, { force: true });
    rmSync(ignoreInFlightPath, { force: true });
    rmSync(standbyFramesPath, { force: true });
  }
});

// ── residue ──────────────────────────────────────────────────────────────────────────────────

test('the false forms leave none of this process`s copies behind', () => {
  const leftovers = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});

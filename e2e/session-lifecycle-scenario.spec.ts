/**
 * The BROWSER execution surface of the unified scenario runner.
 *
 * THE CLAIM. A transcript's reduction — a busy send that must not vanish, a queued command's
 * residue, the idempotence of repeated or reordered events, and the order-stability of a refresh
 * merged with live rows — is ONE property set that must hold for the SAME timeline whatever
 * surface drives it. `gap-scenario-runner-shared-timeline-pure-slice` delivered the PURE surface
 * (the store's own exported transitions, folded under vitest); this file delivers the other half:
 * a real Chromium page, loaded from this run's own Vite dev server, folding the
 * {@link ../src/shared/scenarios/sessionLifecycle.timeline} artifact that the pure surface imports
 * too — never a copy of it.
 *
 * WHY THE SAME MODULE, TWO RUNTIMES. The failure this runner exists to catch is a timeline that
 * exists twice and drifts. Here there is exactly one artifact and exactly one fold
 * (`foldSessionLifecycleTimeline`), and the only thing that differs between the surfaces is WHERE
 * the reductions come from: vitest binds them from `@/...` under Node's resolver, and this file
 * binds them from `/src/...` under Vite's, in Chromium. The element-wise comparison below is
 * therefore a statement about the app's own reduction agreeing with itself across two module
 * graphs, two transforms (esbuild-in-Vite vs tsx) and two JavaScript engines — which is where the
 * drift the artifact exists to prevent would actually show up.
 *
 * WHAT THIS SURFACE DOES **NOT** EXPRESS (AC3's escape hatch, stated rather than skipped).
 *
 *   1. A DOM-driven leg against the scripted upstream (`e2e/voiceRealtimeScriptedUpstream.ts`).
 *      NOT EXPRESSED. Alternative reading, taken here: the merged transcript LINES — the same
 *      value the DOM renders from, produced by the app's own `mergeSessionRows` inside the
 *      browser. Reason: the four invariants are properties of the reduction, not of a renderer;
 *      a DOM leg would need a signed-in session, a project and a real turn, and would read a
 *      *rendering* of the value instead of the value. (A second reason, measured rather than
 *      assumed: `voiceRealtimeScriptedUpstream.ts` holds NO timeline array — see Notes on the
 *      task — so the "second copy" the plan expected to delete there does not exist.)
 *
 *   2. Family ④'s `refresh` seam. PARTIALLY EXPRESSED — deliberately. `useSessionStore` exports
 *      no pure refresh, so BOTH surfaces supply the same one-line model (`server := fetched
 *      rows`), which is what the store's refresh path does. The comparison therefore pins that
 *      the two surfaces agree on the model, not that the model is production's. Alternative
 *      reading, taken here: on both surfaces the refreshed arm's merged transcript must equal the
 *      never-refreshed arm's (`merged === neverRefreshed`), which is the invariant itself; the
 *      production refresh path is exercised by the store's own tests.
 *
 * ZERO EGRESS. Two readings, both taken: the browser's own request route (every non-loopback
 * request is refused and named), and the SERVER-side guard this selection arms —
 * `e2e/support/egress-guard.mjs`, preloaded into the app server with `--import`, whose log for
 * THIS run is published as `QUAY_E2E_VOICE_REALTIME_EGRESS_LOG`. An existing-but-empty log is the
 * zero-egress reading; a positive control in the same test shows the very same module producing a
 * non-empty one, so "empty" cannot be confused with "the guard never loaded".
 *
 * Run: npx playwright test e2e/session-lifecycle-scenario.spec.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  EGRESS_BLOCKED_MARKER,
  EGRESS_GUARD_LOG_ENV,
  isLoopbackUrl,
} from './support/egress-guard.mjs';
import {
  SESSION_LIFECYCLE_FAMILY_IDS,
  SESSION_LIFECYCLE_TIMELINE_ID,
} from '../src/shared/scenarios/sessionLifecycle.timeline';
import type { SessionLifecycleTerminalReading } from '../src/shared/scenarios/sessionLifecycle.timeline';

// ── The arm: ONE body, executed verbatim by both surfaces ────────────────────

/**
 * The specifiers each surface reaches the SAME four modules by. Only these differ between the
 * two arms; the body below is shared verbatim, so a difference in the readings cannot come from
 * a difference in the arm.
 *
 * `/src/...` is what this run's Vite dev server serves (the app's own entry is `/src/main.tsx` in
 * `index.html`); `@/...` is the alias `tsconfig.json` maps, which the Node arm resolves through
 * `tsx --tsconfig`.
 */
const BROWSER_MODULES = Object.freeze([
  '/src/modules/chat/hooks/useSessionStore.ts',
  '/src/modules/chat/voice-realtime/placeCaptions.ts',
  '/src/modules/chat/utils/transcript/liveRowIdentity.ts',
  '/src/shared/scenarios/sessionLifecycle.timeline.ts',
]);
const NODE_MODULES = Object.freeze([
  '@/modules/chat/hooks/useSessionStore',
  '@/modules/chat/voice-realtime/placeCaptions',
  '@/modules/chat/utils/transcript/liveRowIdentity',
  '@/shared/scenarios/sessionLifecycle.timeline',
]);

/**
 * The arm's body. It binds the four modules to a `SessionLifecycleSurface` and folds the
 * committed timeline through it THREE times, then folds a wall-clock-substituted copy three times.
 *
 * IT IS SOURCE, NOT A FUNCTION. Playwright serialises a function into the page by its own
 * `toString()`, and Babel's CommonJS transform — which is what loads this spec — rewrites a
 * dynamic `import()` inside a function body to `require`, which a browser has none of. A string
 * is evaluated where it lands and keeps the dynamic import native on both sides.
 *
 * No template literals inside: this string is interpolated into one.
 */
const ARM_BODY = `
  const [store, captions, live, timeline] = await Promise.all(MODULES.map((specifier) => import(specifier)));

  let lastMintedId = null;
  const surface = {
    pendingRow: (row) => {
      const minted = store.residentPendingRow(row.sessionId, row.content || '', row.timestamp);
      lastMintedId = minted.id;
      return minted;
    },
    applyLifecycle: (realtime, event) => store.applyCommandLifecycleToRows(realtime, event),
    refresh: (_server, rows) => rows,
    merge: (server, realtime) => store.mergeSessionRows(server, realtime),
    // THE VOICE RESIDUE, read through the ONE entry point the pane folds its rows through. A
    // spoken utterance is no longer a row of the client's own (this task), so the rows that can
    // still be pending a visible turn are the pane's HONEST state rows only; the delivered message
    // itself is a row of the transcript, filtered out here by identity exactly as the pure surface
    // does. Returned shape is the row list the fold reads lines off.
    voicePending: (utterances, deliveries, visible) => captions.voiceTranscriptRows({
      captions: utterances.map((u) => ({ itemId: u.itemId, text: u.text, final: true, at: u.at, seq: u.seq == null ? null : u.seq })),
      deliveries: deliveries.map((d) => ({
        message: d.message,
        at: d.at,
        heard: d.heard.slice(),
        itemIds: d.itemIds.slice(),
        queuedMessageUuid: d.queuedMessageUuid == null ? null : d.queuedMessageUuid,
      })),
      visibleMessages: visible.map((r) => ({ type: r.role === 'user' ? 'user' : 'assistant', content: r.content, timestamp: r.timestamp, id: r.id })),
    }).filter((row) => !visible.some((candidate) => candidate.id === row.id)),
    isLiveRowId: (id) => live.isLiveRowId(id),
  };

  const committed = timeline.SESSION_LIFECYCLE_TIMELINE;

  // THE FALSE FORM of AC5: the same families, every row re-stamped from the wall clock. Built
  // fresh per fold so each fold reads the clock again — exactly the defect the fixed time base in
  // the artifact exists to prevent.
  const stamped = (row) => ({ ...row, timestamp: new Date().toISOString() });
  const wallClockTimeline = () => ({
    id: timeline.SESSION_LIFECYCLE_TIMELINE_ID,
    families: committed.families.map((family) => ({
      ...family,
      server: family.server.map(stamped),
      realtime: family.realtime.map(stamped),
      visible: family.visible.map(stamped),
      events: family.events.map((event) => {
        if (event.kind === 'send-busy' || event.kind === 'append-realtime' || event.kind === 'voice-visible-turn') {
          return { ...event, row: stamped(event.row) };
        }
        if (event.kind === 'load-history' || event.kind === 'refresh-history') {
          return { ...event, rows: event.rows.map(stamped) };
        }
        return event;
      }),
    })),
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const readings = [];
  const mintedIdSamples = [];
  for (let run = 0; run < 3; run += 1) {
    readings.push(timeline.foldSessionLifecycleTimeline(surface, committed));
    mintedIdSamples.push(lastMintedId);
  }

  const wallClockReadings = [];
  for (let run = 0; run < 3; run += 1) {
    // A gap wider than the clock's resolution, so three folds really are three different clock
    // readings rather than three reads of one millisecond.
    await sleep(25);
    wallClockReadings.push(timeline.foldSessionLifecycleTimeline(surface, wallClockTimeline()));
  }

  return {
    readings,
    wallClockReadings,
    mintedIdSamples,
    timelineId: committed.id,
    familyIds: committed.families.map((family) => family.id),
    modules: MODULES.length,
  };
`;

/** The arm body with its module list bound in — the only difference between the two surfaces. */
const armSource = (modules: readonly string[]): string =>
  `const MODULES = ${JSON.stringify(modules)};\n${ARM_BODY}`;

// ── The arm's result, as it crosses back into this process ───────────────────

type ArmResult = {
  readings: SessionLifecycleTerminalReading[];
  wallClockReadings: SessionLifecycleTerminalReading[];
  mintedIdSamples: (string | null)[];
  timelineId: string;
  familyIds: string[];
  modules: number;
};

/** The five reads a family's terminal state is stated over — the fields compared element-wise. */
const READING_FIELDS = ['merged', 'liveRows', 'voicePending', 'afterRepeat', 'neverRefreshed'] as const;

const REPO_ROOT = process.cwd();

/** Runs the arm in this process's Node runtime, through `tsx`, so `@/...` resolves. */
const runNodeArm = (): ArmResult => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'session-lifecycle-node-arm-'));
  const driver = path.join(dir, 'arm.mts');
  writeFileSync(
    driver,
    `const __result = await (async () => {\n${armSource(NODE_MODULES)}\n})();\nconsole.log(JSON.stringify(__result));\n`,
    'utf8',
  );
  try {
    const stdout = execFileSync(
      path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      ['--tsconfig', path.join(REPO_ROOT, 'tsconfig.json'), driver],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(stdout.trim()) as ArmResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Loads the app's own page from this run's Vite dev server, then runs the arm inside it.
 *
 * The navigation is deliberately not awaited to `load`: the reading is about the MODULE GRAPH the
 * page's origin serves, and the app's own boot (projects, sessions, sockets) is not part of it.
 * Waiting for a full render would make this criterion red whenever the fixture-less checkout has
 * nothing to render — a statement about the fixture, not about the reduction.
 */
const runBrowserArm = async (page: Page): Promise<ArmResult> => {
  await page.goto('/', { waitUntil: 'commit' });
  return (await page.evaluate(`(async () => {\n${armSource(BROWSER_MODULES)}\n})()`)) as ArmResult;
};

/** Element-wise comparison of two surfaces' terminal readings, naming the family and field that differ. */
const assertReadingsEqual = (browser: SessionLifecycleTerminalReading, node: SessionLifecycleTerminalReading): void => {
  assert.equal(browser.length, node.length, 'both surfaces must read the same number of families');
  for (const [index, family] of browser.entries()) {
    const other = node[index]!;
    assert.equal(other.id, family.id, `family ${index} must be the same family on both surfaces`);
    for (const field of READING_FIELDS) {
      assert.deepEqual(
        other[field],
        family[field],
        `${family.id}.${field} must be element-wise equal across the two surfaces`,
      );
    }
  }
};

// ── §AC1 — one artifact, imported by both surfaces, copied by neither ─────────

const TIMELINE_MODULE_BASENAME = 'sessionLifecycle.timeline';
const TIMELINE_MODULE_SUFFIX = `shared/scenarios/${TIMELINE_MODULE_BASENAME}`;

type Source = { path: string; text: string };

const listSources = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
};

const readSources = (roots: readonly string[]): Source[] =>
  roots
    .filter((root) => existsSync(root))
    .flatMap((root) => listSources(root))
    .map((file) => ({ path: file, text: readFileSync(file, 'utf8') }));

/** Every file that imports the timeline, with the specifier it imported it by. */
const timelineImports = (sources: readonly Source[]): { path: string; specifier: string }[] => {
  const pattern = new RegExp(`from\\s+['"]([^'"]*${TIMELINE_MODULE_BASENAME})['"]`);
  return sources.flatMap((source) => {
    const match = source.text.match(pattern);
    return match ? [{ path: source.path, specifier: match[1]! }] : [];
  });
};

/** Every file that re-DEFINES the timeline — a second copy, under any name. */
const timelineDefinitions = (sources: readonly Source[]): string[] =>
  sources
    .filter((source) => /(?:const|let|var)\s+SESSION_LIFECYCLE_TIMELINE\b/.test(source.text))
    .map((source) => source.path);

/** Files holding the artifact's unique id literal — a second copy would repeat it. */
const timelineIdCopies = (sources: readonly Source[]): string[] =>
  sources
    .filter((source) => source.text.includes(`'${SESSION_LIFECYCLE_TIMELINE_ID}'`))
    .map((source) => source.path);

/** `@/shared/x` and `../src/shared/x` are the same module reached from two roots. */
const moduleKey = (specifier: string): string =>
  specifier.replace(/^@\//, '').replace(/^(?:\.\.\/)+src\//, '');

test('§AC1 the e2e surface imports the one timeline and holds no copy of it', () => {
  const e2eSources = readSources([path.join(REPO_ROOT, 'e2e')]);
  const ourPath = path.join(REPO_ROOT, 'e2e', 'session-lifecycle-scenario.spec.ts');

  const importer = timelineImports(e2eSources);
  console.log(
    `§AC1 e2e importers: ${importer.map((entry) => `${path.relative(REPO_ROOT, entry.path)} -> ${entry.specifier}`).join(' | ') || '(none)'}`,
  );

  // Non-vacuity first: a scan that found no importer would make every assertion below true for the
  // wrong reason — the failure mode a "must not contain X" check cannot see by itself.
  expect(importer.length, 'the e2e tree must import the timeline at all').toBeGreaterThan(0);
  expect(
    importer.some((entry) => entry.path === ourPath),
    'THIS spec is the e2e execution surface and must be one of the importers',
  ).toBe(true);

  for (const entry of importer) {
    expect(
      entry.specifier.endsWith(TIMELINE_MODULE_SUFFIX),
      `${path.relative(REPO_ROOT, entry.path)} imports ${entry.specifier}, which is not the shared artifact`,
    ).toBe(true);
  }

  expect(timelineDefinitions(e2eSources), 'the e2e tree must not define a second timeline').toEqual([]);
  expect(timelineIdCopies(e2eSources), 'the e2e tree must not carry a second copy of the id').toEqual([]);

  // The pure surface reaches the SAME module by its own idiom: two roots, one module key.
  const pureImporter = timelineImports(readSources([path.join(REPO_ROOT, 'src')])).find((entry) =>
    entry.path.endsWith('sessionLifecycleScenario.test.tsx'),
  );
  expect(pureImporter, 'the pure execution surface must import the timeline').toBeTruthy();
  const ours = importer.find((entry) => entry.path === ourPath)!;
  console.log(`§AC1 module key: pure=${moduleKey(pureImporter!.specifier)} browser=${moduleKey(ours.specifier)}`);
  expect(moduleKey(ours.specifier), 'both surfaces must resolve to the same module').toBe(
    moduleKey(pureImporter!.specifier),
  );

  // THE FALSE FORM: a second copy anywhere in the e2e tree reds this scan. The marker is
  // assembled at runtime so THIS file does not read as a second copy to its own scanner.
  const copied: Source[] = [
    ...e2eSources,
    {
      path: path.join(REPO_ROOT, 'e2e', 'copied.timeline.spec.ts'),
      text: `export const ${['SESSION_LIFECYCLE', 'TIMELINE'].join('_')} = { id: '${SESSION_LIFECYCLE_TIMELINE_ID}' };`,
    },
  ];
  expect(
    timelineDefinitions(copied).length,
    'a copy is a second definition',
  ).toBe(timelineDefinitions(e2eSources).length + 1);
  expect(
    timelineIdCopies(copied).length,
    'a copy repeats the id literal',
  ).toBe(timelineIdCopies(e2eSources).length + 1);
});

// ── §AC3 / §AC5 — the two surfaces' terminal readings, and their stability ────

test('§AC3 the browser surface and the pure surface read the same timeline identically', async ({ page, context }) => {
  // The browser's own zero-egress reading: every request that leaves the loopback is refused
  // before it is made, and named. Installed BEFORE the first navigation, so the app's own boot
  // (including the Google-Fonts <link> in `index.html`) is covered too.
  const refused: string[] = [];
  const continued: string[] = [];
  await context.route('**', (route) => {
    const url = route.request().url();
    if (/^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)) {
      continued.push(url);
      return route.continue();
    }
    refused.push(url);
    return route.abort();
  });

  const browser = await runBrowserArm(page);
  const node = runNodeArm();

  for (const [surface, arm] of [
    ['browser', browser],
    ['node', node],
  ] as const) {
    expect(arm.modules, `${surface}: the arm must have bound every module`).toBe(BROWSER_MODULES.length);
    expect(arm.timelineId, `${surface}: the arm must fold the committed artifact`).toBe(
      SESSION_LIFECYCLE_TIMELINE_ID,
    );
    expect(arm.familyIds, `${surface}: every family must be folded`).toEqual([...SESSION_LIFECYCLE_FAMILY_IDS]);
  }

  const reading = browser.readings[0]!;
  console.log(
    `§AC3 browser: ${reading
      .map((family) => `${family.id}[merged=${family.merged.length},live=${family.liveRows.length},voice=${family.voicePending.length}]`)
      .join(' ')}`,
  );

  // NON-VACUITY, before equality: two surfaces agreeing on nothing is not agreement. Each of the
  // four families' invariants is re-asserted here as a READ, so the equality below compares four
  // non-trivial values.
  const byId = (source: SessionLifecycleTerminalReading, id: string) => source.find((family) => family.id === id)!;
  const busySend = byId(reading, 'busy-send');
  expect(
    busySend.merged.some((line) => line.includes('|command_lifecycle|ship it while the answer is still streaming|started|')),
    '① the busy send must still carry its text after `started`',
  ).toBe(true);
  const queued = byId(reading, 'queued-command');
  expect(queued.liveRows, '② a completed command leaves no live lifecycle row').toEqual([]);
  expect(queued.voicePending, '② a delivered caption leaves no voice pending row').toEqual([]);
  const ordering = byId(reading, 'event-ordering');
  expect(ordering.afterRepeat, '③ a repeated late event must not move the terminal state').toEqual(ordering.merged);
  const refresh = byId(reading, 'refresh-merge');
  expect(
    refresh.merged.some((line) => line.startsWith('live:pending|command_lifecycle|keep going|')),
    '④ the live row must survive the refresh',
  ).toBe(true);
  expect(refresh.neverRefreshed, '④ refreshed must equal never refreshed').toEqual(refresh.merged);

  assertReadingsEqual(browser.readings[0]!, node.readings[0]!);
  console.log('§AC3 browser and node readings are element-wise equal');

  // §AC5 — same seed, three runs, identical readings. The runs are three folds inside each
  // surface, and the minted id sample proves they were not the same fold reported three times:
  // the live-row counter advances on every fold (it is per-process and never reset), so the raw
  // ids differ while the normalised lines cannot.
  for (const run of browser.readings) assertReadingsEqual(run, browser.readings[0]!);
  for (const run of node.readings) assertReadingsEqual(run, node.readings[0]!);
  console.log(`§AC5 minted live ids across three folds: ${browser.mintedIdSamples.join(', ')}`);
  expect(new Set(browser.mintedIdSamples).size, 'each fold must mint its own live row').toBe(3);
  for (const sample of browser.mintedIdSamples) {
    expect(sample, 'a minted id must be this process\'s own live id').toMatch(/^live:scenario-session:\d+$/);
  }

  // §AC5 false form: a timeline whose rows are stamped from the wall clock does NOT read the same
  // three times — so the stability above is a property of the fixed time base, not of the check.
  const wallClock = browser.wallClockReadings;
  console.log(
    `§AC5 wall-clock false form: ${wallClock.map((run) => byId(run, 'busy-send').merged[1] ?? '(none)').join(' | ')}`,
  );
  const allIdentical =
    JSON.stringify(wallClock[0]) === JSON.stringify(wallClock[1]) &&
    JSON.stringify(wallClock[1]) === JSON.stringify(wallClock[2]);
  expect(allIdentical, 'a wall-clock timeline must read differently run to run').toBe(false);
  expect(
    JSON.stringify(wallClock[0]),
    'and the committed timeline must NOT have been the thing that moved',
  ).not.toBe(JSON.stringify(browser.readings[0]));

  // §AC4, browser half: the route really saw this run's own traffic (so "it refused nothing
  // loopback" is a statement about a guard that was live, not about one that never fired), and by
  // the guard module's OWN definition of loopback it never refused this run's own server.
  //
  // What it DID refuse is reported rather than required to be non-empty: the one non-loopback
  // request the app shell makes is the webfonts `<link>` in `index.html`, and a criterion that
  // went red the day that link was removed would be pinning the fixture, not the guard.
  console.log(
    `§AC4 browser: continued=${continued.length} (first ${continued[0] ?? 'none'}) refused=${refused.length} (${refused.slice(0, 3).join(' | ') || 'none'})`,
  );
  expect(continued.length, 'the browser route must have seen this page\'s own requests').toBeGreaterThan(0);
  expect(
    refused.filter((url) => isLoopbackUrl(url)),
    'the route must never refuse this run\'s own server',
  ).toEqual([]);
});

// ── §AC4 — zero egress, read off the guard's own log ──────────────────────────

/**
 * The positive control's program: dial a non-loopback host through the very same guard the app
 * server is preloaded with, and report the refusal. Run in a child so the control can point the
 * guard at a log of its own — writing into the run's log would destroy the reading it protects.
 */
const CONTROL_SCRIPT = [
  "const net = require('node:net');",
  "const socket = net.connect({ host: 'example.com', port: 443 });",
  "socket.on('error', (error) => { console.log(error.code + ' ' + error.message); process.exit(0); });",
  "socket.on('connect', () => { socket.destroy(); console.log('CONNECTED'); process.exit(1); });",
].join('\n');

test('§AC4 zero egress: the guard’s log exists for this run, and it refuses when it should', () => {
  const serverLog = process.env.QUAY_E2E_VOICE_REALTIME_EGRESS_LOG;
  console.log(`§AC4 server guard log: ${serverLog ?? '(not published)'}`);
  // The published path IS the reading that the guard was armed for this run: the server learns the
  // same path through `QUAY_E2E_EGRESS_GUARD_LOG`, which is also the switch that turns it on.
  expect(serverLog, 'this selection must publish the guard log path').toBeTruthy();
  expect(existsSync(serverLog!), 'the guard must have created its log in the server process').toBe(true);
  const serverLines = readFileSync(serverLog!, 'utf8').split('\n').filter(Boolean);
  console.log(`§AC4 server refusals recorded: ${serverLines.length}${serverLines.length ? ` (${serverLines[0]})` : ''}`);
  // An EXISTING BUT EMPTY log is the zero-egress reading: the guard was live and nothing left.
  expect(serverLines, 'nothing may have left this run\'s server').toEqual([]);

  // THE CONTROL, so "empty" cannot be a guard that never loaded. Same module, same mechanism, a
  // log of its own: the refusal must happen, and the log must be non-empty and name the target.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'session-lifecycle-egress-control-'));
  const controlLog = path.join(dir, 'egress.jsonl');
  let controlStdout = '';
  try {
    controlStdout = execFileSync(
      process.execPath,
      [
        '--import',
        path.join(REPO_ROOT, 'e2e', 'support', 'egress-guard.mjs'),
        '-e',
        CONTROL_SCRIPT,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30_000,
        // A minimal environment on purpose: inheriting this worker's would hand the child the
        // run's own guard log (through `NODE_OPTIONS`) and the control would write into it.
        env: { PATH: process.env.PATH ?? '', [EGRESS_GUARD_LOG_ENV]: controlLog },
      },
    );
  } finally {
    // `execFileSync` throws on a non-zero exit; the readings below are asserted either way.
  }

  const controlLines = existsSync(controlLog)
    ? readFileSync(controlLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { target: string; via: string })
    : [];
  console.log(`§AC4 control: stdout=${JSON.stringify(controlStdout.trim())} log=${JSON.stringify(controlLines)}`);

  expect(controlStdout, 'the guard must refuse a non-loopback dial with its own marker').toContain(
    EGRESS_BLOCKED_MARKER,
  );
  expect(controlLines.length, 'the guard\'s reading must be non-empty when it refuses').toBeGreaterThan(0);
  expect(
    controlLines.every((line) => line.target.includes('example.com')),
    'each recorded refusal must name the target it refused',
  ).toBe(true);

  rmSync(dir, { recursive: true, force: true });
});

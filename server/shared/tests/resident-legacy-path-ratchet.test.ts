/**
 * AC-393 — the S1/S2 shadow-period ratchet over the OLD resident delivery path.
 *
 * The SPEC (docs/proposals/resident-delivery-turn-ledger-SPEC.md §4.4 I6, §12, §14)
 * replaces the position-proxy ledger with a real turn ledger (S1) and then retires
 * `supersedeRunning` once `RESIDENT_RUN_IS_TURN` is on and soaked (S2). Between those
 * two points the old path is still LIVE code — `supersedeRunning` is the flag-off
 * rollback path (§12 "回滚即关") — so the count cannot go to zero yet. What this
 * criterion does is stop the opposite drift: a NEW commit that writes one of the old
 * symbols again. It is a ratchet, not a retirement — the 3 live `supersedeRunning`
 * uses stay, and this file must not assert them away.
 *
 * Every reading comes from the TypeScript SYNTAX TREE (`ts.createSourceFile`), never
 * from grepped text. That distinction is load-bearing here, not decoration: the SPEC
 * deliberately leaves prose behind (it names these very symbols in §4.4/§12), and the
 * old path is documented in comments around the code. A text scan would either trip
 * over the explanation or have to be hand-taught to ignore comments — a parse gets
 * that right for free, because a comment or a string literal produces no `Identifier`
 * node at all. `(e)` proves the scanner in the SAME run: a synthetic source puts the
 * names in a comment and a string and every reading must read zero.
 *
 * Four readings (measured on this tree, 2026-10-16, TypeScript compiler API, comments
 * and strings not counted):
 *
 *   supersedeRunning    3   chat-run-registry.service.ts 2, chat-websocket.service.ts 1
 *   resultTimes         9   claude-host-driver.provider.ts
 *   resultsSeenAtStart  0   (renamed to `resultsSeenAtPush` by S0)
 *   rounds(driver)     15   claude-host-driver.provider.ts, `.rounds` property accesses
 *
 * `resultTimes` and `rounds` are generic names, so a hit is not proof of old-path
 * coupling — `(c)` builds the failure message that says so on the spot: it names the
 * new hit as `file:line` and tells the reader to RENAME an unrelated same-named local
 * rather than raise the baseline. `(a)` is the ratchet itself; `(b)` pins the inbound
 * baseline both ways (never above the initial cap, and the measured count never above
 * the baseline). The whole run is capped by the `exit 3` process budget below.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const BASELINE_PATH = path.join(TEST_DIR, 'resident-legacy-path-ratchet.baseline.json');

/** The one file whose `.rounds` property accesses are counted (the host driver). */
const DRIVER_REL = 'server/modules/providers/list/claude/claude-host-driver.provider.ts';

/** The rolled-in identifiers read across every non-test `server/` source. */
type LegacyIdentifier = 'supersedeRunning' | 'resultTimes' | 'resultsSeenAtStart';

/** The four counters, including the driver-scoped `.rounds` reading. */
type LegacyCounts = {
  supersedeRunning: number;
  resultTimes: number;
  resultsSeenAtStart: number;
  roundsDriver: number;
};

type LegacyKey = keyof LegacyCounts;

/** One live use of a counted name, located as `file:line`. */
type LegacyHit = { name: string; file: string; line: number };

/** The result of one scan: the counts, every hit, and how many files were read. */
type LegacyScan = { counts: LegacyCounts; hits: LegacyHit[]; filesScanned: number };

/** A source and its repo-relative path — real (from disk) or synthetic (a fixture). */
type SourceFile = { path: string; text: string };

type Baseline = LegacyCounts & { measuredAt: string };

const LEGACY_IDENTIFIERS: readonly LegacyIdentifier[] = ['supersedeRunning', 'resultTimes', 'resultsSeenAtStart'];

const LEGACY_KEYS: readonly LegacyKey[] = ['supersedeRunning', 'resultTimes', 'resultsSeenAtStart', 'roundsDriver'];

/**
 * The case-time upper bound the committed baseline may never exceed. Only ever lowered
 * (AC (b1)): the ratchet allows the count to fall as S1/S2 land, never to climb.
 */
const INITIAL_CAPS: LegacyCounts = {
  supersedeRunning: 3,
  resultTimes: 9,
  resultsSeenAtStart: 0,
  roundsDriver: 15,
};

// ---------------------------------------------------------------------------
// The counting core — pure over (sources, driver path), so a fixture can drive it
// ---------------------------------------------------------------------------

/** `.tsx` must be parsed as TSX; `.js`/`.mjs` as JS; everything else as TS. */
function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function emptyCounts(): LegacyCounts {
  return { supersedeRunning: 0, resultTimes: 0, resultsSeenAtStart: 0, roundsDriver: 0 };
}

/** A `.rounds` property-access hit is filed under the `roundsDriver` counter. */
function hitKey(name: string): LegacyKey {
  return name === '.rounds' ? 'roundsDriver' : (name as LegacyIdentifier);
}

/**
 * Parses every source and counts, per source text, the three rolled-in identifiers and
 * (only in `driverPath`) `.rounds` property accesses. Comments are trivia and produce
 * no node; a name inside a string literal is a `StringLiteral`, not an `Identifier` —
 * so neither can ever be counted, which is exactly the discrimination `(e)` proves.
 */
function scanLegacySources(sources: readonly SourceFile[], driverPath: string): LegacyScan {
  const counts = emptyCounts();
  const hits: LegacyHit[] = [];

  for (const source of sources) {
    const sourceFile = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, false, scriptKindFor(source.path));
    const record = (name: string, node: ts.Node): void => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      hits.push({ name, file: source.path, line: line + 1 });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && LEGACY_IDENTIFIERS.includes(node.text as LegacyIdentifier)) {
        counts[node.text as LegacyIdentifier] += 1;
        record(node.text, node);
      }
      if (source.path === driverPath && ts.isPropertyAccessExpression(node) && node.name.text === 'rounds') {
        counts.roundsDriver += 1;
        record('.rounds', node);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return { counts, hits, filesScanned: sources.length };
}

/**
 * Non-test `server/` sources: `.ts`/`.tsx`/`.js`/`.mjs`, dropping `*.test.*` and
 * `*.spec.*` by filename and pruning `node_modules/` and `dist/` directories. Read
 * straight from disk, so the reading is of what is on the tree, not of a tsconfig
 * include set.
 */
function collectNonTestSources(root: string): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(path.join(directory, entry.name));
        continue;
      }
      if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(REPO_ROOT, absolute);
      if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(relative)) continue;
      found.push({ path: relative, text: fs.readFileSync(absolute, 'utf8') });
    }
  };
  walk(root);
  return found;
}

// ---------------------------------------------------------------------------
// The failure message — names the new hit and says what to do about it
// ---------------------------------------------------------------------------

/**
 * The message a red lands on. It carries both halves AC (c) requires: every live hit
 * for the increased counter as `file:line`, and the judgment — because `resultTimes`
 * and `rounds` are generic names, an unrelated same-named local is renamed, not the
 * baseline raised.
 */
function formatIncrease(name: string, cap: number, baselineValue: number, actual: number, hits: readonly LegacyHit[]): string {
  return [
    `[ac393-ratchet] ${name} increased: baseline=${baselineValue} actual=${actual} cap=${cap}.`,
    'Live uses (file:line) — a new write of the old path, caught before it lands:',
    ...hits.map((hit) => `  ${hit.file}:${hit.line} ${hit.name}`),
    'Judgment: resultTimes / rounds are generic names, so a hit is not proof of old-path coupling —',
    'if a hit is an unrelated same-named local, rename that local rather than raising the baseline.',
    'Never raise the baseline, and never delete an old-path use just to lower the count.',
  ].join('\n');
}

/** Reads and validates the committed inbound baseline — no `any`, every field checked. */
function readBaseline(): Baseline {
  const raw: unknown = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  assert.ok(typeof raw === 'object' && raw !== null, 'the baseline must be a JSON object');
  const record = raw as Record<string, unknown>;

  const read = (key: LegacyKey): number => {
    const value = record[key];
    assert.ok(
      typeof value === 'number' && Number.isInteger(value) && value >= 0,
      `baseline.${key} must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
    return value;
  };

  const measuredAt = record.measuredAt;
  assert.ok(
    typeof measuredAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(measuredAt),
    'baseline.measuredAt must carry a date (YYYY-MM-DD)',
  );

  return {
    supersedeRunning: read('supersedeRunning'),
    resultTimes: read('resultTimes'),
    resultsSeenAtStart: read('resultsSeenAtStart'),
    roundsDriver: read('roundsDriver'),
    measuredAt,
  };
}

// ---------------------------------------------------------------------------
// Process budget guard — a hang is a budget kill, not one red case
// ---------------------------------------------------------------------------

const STARTED_AT = Date.now();
/** The AC-393 wall-clock ceiling is 20 s; the guard fires a second earlier. */
const PROCESS_BUDGET_MS = 19_000;

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${PROCESS_BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the resident-legacy-path-ratchet ` +
      `criterion did not finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, PROCESS_BUDGET_MS - 1_000);
budgetGuard.unref();

// ---------------------------------------------------------------------------
// (a) the ratchet reading, (b) the baseline it is pinned to
// ---------------------------------------------------------------------------

test('(a)(b) the four legacy readings do not grow past the committed baseline', () => {
  const scan = scanLegacySources(collectNonTestSources(SERVER_DIR), DRIVER_REL);

  // Per-file detail first, then the one summary line — all readings before any assert.
  const byFile = new Map<string, LegacyCounts>();
  for (const hit of scan.hits) {
    const counts = byFile.get(hit.file) ?? emptyCounts();
    counts[hitKey(hit.name)] += 1;
    byFile.set(hit.file, counts);
  }
  console.log(`(a) scanned ${scan.filesScanned} non-test server sources`);
  for (const [file, counts] of byFile) {
    console.log(
      `(a) ${file} supersedeRunning=${counts.supersedeRunning} resultTimes=${counts.resultTimes} ` +
        `resultsSeenAtStart=${counts.resultsSeenAtStart} rounds=${counts.roundsDriver}`,
    );
  }
  console.log(
    `legacy supersedeRunning=${scan.counts.supersedeRunning} resultTimes=${scan.counts.resultTimes} ` +
      `resultsSeenAtStart=${scan.counts.resultsSeenAtStart} rounds(driver)=${scan.counts.roundsDriver}`,
  );

  const baseline = readBaseline();

  // (b1) the committed baseline may only ever be LOWERED, never raised above its cap.
  for (const key of LEGACY_KEYS) {
    assert.ok(
      baseline[key] <= INITIAL_CAPS[key],
      `baseline ${key}=${baseline[key]} exceeds the initial cap ${INITIAL_CAPS[key]} — the baseline may only be lowered`,
    );
  }

  // (b2) the measured count may not be above the committed baseline. A red here names
  // the new hit as file:line and says to rename, not to raise the baseline (AC (c)).
  for (const key of LEGACY_KEYS) {
    const actual = scan.counts[key];
    if (actual > baseline[key]) {
      assert.fail(formatIncrease(key, INITIAL_CAPS[key], baseline[key], actual, scan.hits.filter((hit) => hitKey(hit.name) === key)));
    }
  }
});

// ---------------------------------------------------------------------------
// (a) the scanner discriminates — this is the false form's in-memory counterpart
// ---------------------------------------------------------------------------

test('(a) a live use in an in-memory source is counted and named as file:line', () => {
  const fixture: SourceFile = {
    path: 'server/modules/websocket/services/chat-websocket.service.ts',
    text: ['// a new live use outside the ledger', 'export const supersedeRunning = true;'].join('\n'),
  };
  const scan = scanLegacySources([fixture], DRIVER_REL);
  console.log(`(a-fixture) counts=${JSON.stringify(scan.counts)} hits=${JSON.stringify(scan.hits)}`);
  assert.equal(scan.counts.supersedeRunning, 1, 'the fixture holds exactly one live supersedeRunning use');
  assert.deepEqual(
    scan.hits,
    [{ name: 'supersedeRunning', file: fixture.path, line: 2 }],
    'the hit must be located at its own file:line',
  );
});

// ---------------------------------------------------------------------------
// (c) the failure message carries file:line AND the rename judgment
// ---------------------------------------------------------------------------

test('(c) an increase names the new hit as file:line and says to rename, not raise the baseline', () => {
  const fixture: SourceFile = {
    path: 'server/modules/websocket/services/chat-websocket.service.ts',
    text: ['// one new live use above the baseline', 'export const supersedeRunning = true;'].join('\n'),
  };
  const scan = scanLegacySources([fixture], DRIVER_REL);
  const message = formatIncrease('supersedeRunning', INITIAL_CAPS.supersedeRunning, 0, scan.counts.supersedeRunning, scan.hits);
  console.log(`(c) fixture failure message:\n${message}`);
  assert.match(
    message,
    /server\/modules\/websocket\/services\/chat-websocket\.service\.ts:2\b/,
    'the message must name the new hit as server/...:<line>',
  );
  assert.match(message, /rename/i, 'the message must say to rename an unrelated same-named local, not raise the baseline');
});

// ---------------------------------------------------------------------------
// (e) negative control — a name in prose or a string is not a live use
// ---------------------------------------------------------------------------

test('(e) negative control: names appearing only in comments and strings read zero', () => {
  const fixture: SourceFile = {
    path: 'server/modules/websocket/services/negative-control-source.ts',
    text: [
      '// supersedeRunning resultTimes resultsSeenAtStart .rounds — prose, not code',
      'const note = "supersedeRunning resultTimes resultsSeenAtStart .rounds";',
    ].join('\n'),
  };
  // The fixture is passed AS the driver path, so `.rounds` would be counted here were
  // it a real property access — the zero proves it is the string, not a dead detector.
  const scan = scanLegacySources([fixture], fixture.path);
  console.log(`(e) negative-control counts=${JSON.stringify(scan.counts)} hits=${JSON.stringify(scan.hits)}`);
  assert.deepEqual(
    scan.counts,
    { supersedeRunning: 0, resultTimes: 0, resultsSeenAtStart: 0, roundsDriver: 0 },
    'a name in a comment or a string literal must not be counted',
  );
  assert.deepEqual(scan.hits, [], 'no hit may be recorded for a comment-only or string-only occurrence');
});

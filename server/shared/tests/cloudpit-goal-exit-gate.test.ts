/**
 * AC-455 — GOAL-053's EXIT STRUCTURAL GATE, as a runnable criterion.
 *
 * GOAL-053's exit condition #4 reads: "相关单测、typecheck、lint 绿；不新增模块目录，不往
 * `server/shared/utils.ts` 加行（避免 AC-394 与 oversize 棘轮）". Before this file no
 * in-domain AC ran any of those structural checks: AC-448/449/450 cover the dark pipeline
 * capabilities, and the task-level ACs are not what the sufficiency judge reads. This
 * criterion is the missing in-domain reader.
 *
 * It pins exactly the two STRUCTURAL facts the exit condition names:
 *
 *   1. A RECORDED-CHANGE DIRECTORY RATCHET. The same scanner AC-394 budgets
 *      (`collectServerSources` + `scanImportGraph`) reports the tree's directory set; the
 *      assertion chain is `measured ⊆ baseline.moduleDirectories ⊆ GATE_DIRECTORY_PIN`:
 *        - every measured directory must be named by the frozen baseline
 *          (`cloudpit-goal-exit-gate.baseline.json.moduleDirectories`), so `extra=[]` is green;
 *        - every baseline directory must be named by the SOURCE pin below, so editing the JSON
 *          alone cannot bless a new directory. A new directory is a RECORDED CHANGE: the same
 *          reviewed source edit must add it to `GATE_DIRECTORY_PIN` AND to the JSON (the shape
 *          AC-394's `MANIFEST_PIN` already uses).
 *      The reading is MONOTONIC: a directory may disappear (a sibling task shrinking the tree
 *      must not red this criterion), so `missing=[...]` is printed but NOT asserted — a
 *      pre-declared directory that has not landed yet is a legitimate `missing` reading, not a
 *      red. The count is not required to equal AC-394's roster — that manifest is a
 *      cross-reading and may only shrink too.
 *
 *   2026-11-03 recorded change: human yale narrowed this arm from "never add a module
 *   directory" to this ratchet (task `gap-ac455-directory-arm-recorded-change`), because an
 *   achieved GOAL-053 left the permanent ban in the full suite and made every deliberate
 *   module split a `task-introduced-red`. The first recorded change pre-declares
 *   `modules/observation/{core,producers,session-ask,session-digest}`, landed by
 *   `gap-routine-architecture-analysis-god-package-server-observation`.
 *   2. `server/shared/utils.ts` DID NOT GROW. Its physical line count must stay `<=` the
 *      frozen `utilsLineCount` AND `<=` the committed oversize reading in
 *      `architecture-ratchet.baseline.json.oversizeFiles['server/shared/utils.ts']`. Again
 *      monotonic: the file may only shrink.
 *
 * Why not just run `architecture-ratchet.test.ts`? Because it reds on unrelated develop
 * movement across five dimensions; the exit condition needs a stable, goal-scoped reading.
 * The exact utils.ts line pin is therefore carried here, and this file reads the ratchet
 * baseline rather than running the ratchet criterion.
 *
 * FALSE FORM: the `structuralGateViolations` function below is the single assertion path used
 * by BOTH real-tree arms AND the negative controls. The controls feed it (a) a synthetic
 * directory set with one extra directory, (b) a synthetic baseline carrying one directory that
 * is not in the source pin, and (c) a synthetic line count with one extra line, and assert each
 * is reported as a violation — so `extra=[]` / `missing=[...]` cannot be vacuously green and the
 * JSON-vs-pin arm is proven to be load-bearing rather than decorative.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectServerSources, scanImportGraph, type Graph } from "../import-graph.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const UTILS_PATH = path.join(SERVER_DIR, 'shared', 'utils.ts');

const GATE_BASELINE_PATH = path.join(TEST_DIR, 'cloudpit-goal-exit-gate.baseline.json');
const CYCLE_BASELINE_PATH = path.join(TEST_DIR, 'server-import-cycle-budget.baseline.json');
const RATCHET_BASELINE_PATH = path.join(TEST_DIR, 'architecture-ratchet.baseline.json');

const UTILS_RATCHET_KEY = 'server/shared/utils.ts';

/**
 * The SOURCE pin the committed baseline may never exceed — the same recorded-change shape
 * AC-394's `MANIFEST_PIN` uses. 58 directories measured on 2026-11-03 plus the first recorded
 * change: the four `modules/observation/*` subdirectories pre-declared by human yale's
 * 2026-11-03 ruling (task `gap-ac455-directory-arm-recorded-change`), landed by
 * `gap-routine-architecture-analysis-god-package-server-observation`; and the second
 * recorded change, `modules/providers/list/claude/lifecycle`, landed by
 * `gap-routine-architecture-analysis-god-package-server-providers-claude`.
 *
 * Adding a module directory means editing THIS array and `cloudpit-goal-exit-gate.baseline.json`
 * in the same reviewed change. Editing the JSON alone is refused by the assertion chain below;
 * this array is the human-reviewable record of what was allowed to change and when.
 */
const GATE_DIRECTORY_PIN: readonly string[] = [
  '.',
  'modules/architecture',
  'modules/assets',
  'modules/assets/services',
  'modules/auth',
  'modules/browser-use',
  'modules/cli',
  'modules/cockpit',
  // SIXTH RECORDED CHANGE (2026-11-08,
  // gap-routine-architecture-analysis-server-cockpit-god-package): the cockpit
  // god-package was split into three subpackages (brief / cards / fleet), each
  // behind an index.ts barrel; the package root keeps the hub service, the
  // module wiring, the reducer and the barrel. Added here and to the JSON
  // together, exactly as the recorded-change contract requires.
  'modules/cockpit/brief',
  'modules/cockpit/cards',
  'modules/cockpit/fleet',
  'modules/commands',
  'modules/context-events',
  'modules/database',
  'modules/database/core',
  'modules/database/repositories',
  // NINTH RECORDED CHANGE (2026-11-09,
  // gap-routine-architecture-analysis-server-database-repositories-god-package):
  // the 27 flat repository files were split by domain into these five
  // subpackages behind the existing modules/database barrel. Added here and to
  // cloudpit-goal-exit-gate.baseline.json together, exactly as the
  // recorded-change contract requires; the directory graph stays acyclic and the
  // AC-394 G1 cycle is unchanged.
  'modules/database/repositories/auth',
  'modules/database/repositories/notifications',
  'modules/database/repositories/observation',
  'modules/database/repositories/providers',
  'modules/database/repositories/sessions',
  'modules/debug-agent',
  'modules/file-tree',
  'modules/git',
  'modules/liaison',
  'modules/llm-gateway',
  'modules/logging',
  'modules/mcp-gateway',
  // FOURTH RECORDED CHANGE (2026-11-04,
  // gap-routine-architecture-analysis-god-package-server-mcp-gateway): the
  // gateway's tool implementations moved into six `tools/<family>` subpackages
  // (approvals / cockpit / read / sessions / shared / ui). Added here and to the
  // JSON together, exactly as the recorded-change contract requires.
  'modules/mcp-gateway/tools/approvals',
  'modules/mcp-gateway/tools/cockpit',
  'modules/mcp-gateway/tools/read',
  'modules/mcp-gateway/tools/sessions',
  'modules/mcp-gateway/tools/shared',
  'modules/mcp-gateway/tools/ui',
  'modules/notices',
  'modules/notifications',
  'modules/notifications/services',
  'modules/notifications/websocket',
  'modules/oauth',
  'modules/observation',
  'modules/observation/core',
  'modules/observation/producers',
  'modules/observation/session-ask',
  'modules/observation/session-digest',
  'modules/plugins',
  'modules/projects',
  'modules/projects/services',
  'modules/providers',
  'modules/providers/list/claude',
  'modules/providers/list/claude/lifecycle',
  // FIFTH RECORDED CHANGE (2026-11-06,
  // gap-routine-architecture-analysis-god-package-server-codex): the codex
  // provider god-package was split into three subpackages
  // (app-server / host / sessions), each behind an index.ts barrel. Added here
  // and to the JSON together, exactly as the recorded-change contract requires.
  'modules/providers/list/codex',
  'modules/providers/list/codex/app-server',
  'modules/providers/list/codex/host',
  'modules/providers/list/codex/sessions',
  'modules/providers/list/cursor',
  'modules/providers/list/opencode',
  'modules/providers/services',
  // SEVENTH RECORDED CHANGE (2026-11-08,
  // gap-routine-architecture-analysis-server-providers-services-god-package):
  // the providers/services god-package split created these three subpackages.
  // Added here and to cloudpit-goal-exit-gate.baseline.json together, exactly as
  // the recorded-change contract requires; the AC-394 G1 cycle is unchanged.
  'modules/providers/services/claude-activity',
  'modules/providers/services/runtime',
  'modules/providers/services/sessions',
  'modules/providers/shared/base',
  'modules/providers/shared/mcp',
  'modules/providers/shared/skills',
  'modules/quay',
  'modules/reply-suggestions',
  'modules/resident-ledger',
  'modules/scheduled-messages',
  'modules/scheduled-messages/services',
  'modules/session-hosts',
  'modules/settings',
  'modules/static-assets',
  'modules/system',
  'modules/taskmaster',
  'modules/user',
  'modules/voice',
  'modules/voice-realtime',
  'modules/voice-realtime/frames',
  'modules/voice-realtime/transport',
  'modules/websocket',
  'modules/websocket/services',
  'modules/worktrees',
  'modules/worktrees/services',
  'shared',
  // SIXTH RECORDED CHANGE (2026-11-08,
  // gap-routine-architecture-analysis-server-shared-god-package): the server/shared
  // god-package split moved the root implementation files into nine subpackages
  // (shared/types, shared/utils, shared/attachments, shared/settings, shared/data,
  // shared/imports, shared/knowledge, shared/messages, shared/transcript). Added to
  // this source pin and to cloudpit-goal-exit-gate.baseline.json in the same
  // reviewed change. The split's directory graph is acyclic (no subpackage imports
  // the shared root back) and the utils.ts line ceiling was lowered 1930 -> 116.
  'shared/attachments',
  'shared/data',
  'shared/imports',
  'shared/knowledge',
  'shared/mcp-contract',
  'shared/messages',
  'shared/ports',
  'shared/settings',
  'shared/transcript',
  'shared/types',
  'shared/utils',
  'shared/utils/sessions',
];

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

/** The frozen exit-gate baseline. `moduleDirectories` is a set upper bound; `utilsLineCount` a ceiling. */
type GateBaseline = {
  measuredAt: string;
  note: string;
  moduleDirectories: string[];
  utilsLineCount: number;
};

/** One structural reading — real or synthetic — fed to the single assertion path below. */
type GateReading = {
  measuredDirectories: readonly string[];
  frozenDirectories: readonly string[];
  pinDirectories: readonly string[];
  measuredUtilsLines: number;
  frozenUtilsLines: number;
  ratchetUtilsLines: number;
};

/** A parsed JSON object, with the non-object shape rejected where it is read. */
function readJsonObject(filePath: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(
    typeof raw === 'object' && raw !== null && !Array.isArray(raw),
    `${path.basename(filePath)} must be a JSON object`,
  );
  return raw as Record<string, unknown>;
}

/** Reads and validates the frozen exit-gate baseline — every field checked, no `any`. */
function readGateBaseline(): GateBaseline {
  const record = readJsonObject(GATE_BASELINE_PATH);

  const measuredAt = record.measuredAt;
  assert.ok(
    typeof measuredAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(measuredAt),
    'gate baseline measuredAt must carry a date (YYYY-MM-DD)',
  );

  const note = record.note;
  assert.ok(typeof note === 'string' && note.length > 0, 'gate baseline note must explain the monotonic reading');

  const moduleDirectories = record.moduleDirectories;
  assert.ok(
    Array.isArray(moduleDirectories) && moduleDirectories.length > 0 && moduleDirectories.every((entry) => typeof entry === 'string'),
    'gate baseline moduleDirectories must be a non-empty array of strings',
  );
  const directories = moduleDirectories as string[];
  assert.equal(new Set(directories).size, directories.length, 'gate baseline moduleDirectories must not carry duplicates');

  const utilsLineCount = record.utilsLineCount;
  assert.ok(
    typeof utilsLineCount === 'number' && Number.isInteger(utilsLineCount) && utilsLineCount > 0,
    'gate baseline utilsLineCount must be a positive integer',
  );

  return { measuredAt, note, moduleDirectories: directories, utilsLineCount };
}

/** AC-394's committed directory roster — printed as a cross-reading, not asserted (it may only shrink). */
function readDirectoryManifest(): string[] {
  const record = readJsonObject(CYCLE_BASELINE_PATH);
  const manifest = record.directoryManifest;
  assert.ok(
    Array.isArray(manifest) && manifest.every((entry) => typeof entry === 'string'),
    'server-import-cycle-budget.baseline.json.directoryManifest must be an array of strings',
  );
  return manifest as string[];
}

/** The committed oversize ceiling for `server/shared/utils.ts` from the architecture ratchet. */
function readUtilsRatchetLineCount(): number {
  const record = readJsonObject(RATCHET_BASELINE_PATH);
  const oversize = record.oversizeFiles;
  assert.ok(typeof oversize === 'object' && oversize !== null, 'architecture-ratchet.baseline.json.oversizeFiles must be an object');
  const reading = (oversize as Record<string, unknown>)[UTILS_RATCHET_KEY];
  assert.ok(
    typeof reading === 'number' && Number.isInteger(reading) && reading > 0,
    `architecture-ratchet.baseline.json.oversizeFiles['${UTILS_RATCHET_KEY}'] must be a positive integer`,
  );
  return reading;
}

/** The real server tree, scanned once per run — the scan is not repeated per assertion. */
const realGraphOnce = (() => {
  let cached: Graph | undefined;
  return (): Graph => (cached ??= scanImportGraph(collectServerSources(SERVER_DIR)));
})();

/**
 * Physical line count of a text file. `split('\n').length - 1` is the reading AC-455's
 * criterion text names (a newline-terminated file reports the same count as `wc -l`).
 */
function lineCount(text: string): number {
  return text.split('\n').length - 1;
}

// ---------------------------------------------------------------------------
// The single assertion path (real tree AND negative control)
// ---------------------------------------------------------------------------

/** Every measured directory the frozen baseline does not name. */
function unexpectedDirectories(measured: readonly string[], frozen: readonly string[]): string[] {
  const known = new Set(frozen);
  return measured.filter((directory) => !known.has(directory));
}

/** Every frozen (baseline) directory the SOURCE pin does not name — the JSON-only raise. */
function baselineOutsidePin(frozen: readonly string[], pin: readonly string[]): string[] {
  const pinned = new Set(pin);
  return frozen.filter((directory) => !pinned.has(directory));
}

/**
 * The exit gate's structural reading. Returns one message per violation; `[]` means green.
 * Both real-tree arms and the false forms go through this function, so no control can pass by
 * exercising a different code path than the criterion.
 *
 * Directory arm = `measured ⊆ frozen ⊆ pin`. The middle link is what makes this a
 * recorded-change ratchet: a JSON edit alone cannot bless a new directory because the frozen
 * set would then step outside the source pin.
 */
function structuralGateViolations(reading: GateReading): string[] {
  const violations: string[] = [];

  const extra = unexpectedDirectories(reading.measuredDirectories, reading.frozenDirectories);
  if (extra.length > 0) {
    violations.push(
      `new module director${extra.length === 1 ? 'y' : 'ies'} outside the frozen baseline: ${extra.join(', ')} — ` +
        `the directory arm is a recorded-change ratchet: add the directory to ` +
        `cloudpit-goal-exit-gate.baseline.json.moduleDirectories AND to GATE_DIRECTORY_PIN in the same change`,
    );
  }

  const unpinned = baselineOutsidePin(reading.frozenDirectories, reading.pinDirectories);
  if (unpinned.length > 0) {
    violations.push(
      `baseline director${unpinned.length === 1 ? 'y' : 'ies'} outside the source pin GATE_DIRECTORY_PIN: ${unpinned.join(', ')} — ` +
        `the JSON may only be lowered against the source pin, never raised: a recorded change must ` +
        `edit GATE_DIRECTORY_PIN and cloudpit-goal-exit-gate.baseline.json together`,
    );
  }

  if (reading.measuredUtilsLines > reading.frozenUtilsLines) {
    violations.push(
      `server/shared/utils.ts grew to ${reading.measuredUtilsLines} lines, over the frozen exit-gate baseline of ` +
        `${reading.frozenUtilsLines} — GOAL-053's exit gate forbids adding lines to this file`,
    );
  }

  if (reading.measuredUtilsLines > reading.ratchetUtilsLines) {
    violations.push(
      `server/shared/utils.ts grew to ${reading.measuredUtilsLines} lines, over the architecture-ratchet oversize ` +
        `baseline of ${reading.ratchetUtilsLines}`,
    );
  }

  return violations;
}

// ---------------------------------------------------------------------------
// AC2 — zero new module directories
// ---------------------------------------------------------------------------

test('AC2: the measured tree is inside the frozen baseline, which is inside the source pin', () => {
  const baseline = readGateBaseline();
  const graph = realGraphOnce();
  const manifest = readDirectoryManifest();

  const extra = unexpectedDirectories(graph.nodes, baseline.moduleDirectories);
  const missing = baseline.moduleDirectories.filter((directory) => !graph.nodes.includes(directory));
  const unpinned = baselineOutsidePin(baseline.moduleDirectories, GATE_DIRECTORY_PIN);

  console.log(
    `[ac455] directory arm: measured=${graph.nodes.length} frozen=${baseline.moduleDirectories.length} ` +
      `cycleManifest=${manifest.length} extra=${JSON.stringify(extra)} missing=${JSON.stringify(missing)}`,
  );
  console.log(
    `[ac455] directory pin: pin=${GATE_DIRECTORY_PIN.length} baselineOutsidePin=${JSON.stringify(unpinned)} ` +
      `duplicatePinEntries=${GATE_DIRECTORY_PIN.length - new Set(GATE_DIRECTORY_PIN).size}`,
  );
  assert.ok(graph.nodes.length > 0, 'the scan must have seen directories — an empty tree would make the subset check vacuous');
  assert.ok(baseline.moduleDirectories.length > 0, 'the frozen baseline must name directories');
  assert.ok(GATE_DIRECTORY_PIN.length > 0, 'the source pin must name directories');
  assert.equal(
    new Set(GATE_DIRECTORY_PIN).size,
    GATE_DIRECTORY_PIN.length,
    'GATE_DIRECTORY_PIN must not carry duplicate entries',
  );
  assert.deepEqual(
    extra,
    [],
    `a directory outside the frozen baseline is a NEW module directory: ${extra.join(', ')}. ` +
      `This is a recorded-change ratchet: add it to cloudpit-goal-exit-gate.baseline.json.moduleDirectories ` +
      `AND to GATE_DIRECTORY_PIN in the same reviewed change.`,
  );
  assert.deepEqual(
    unpinned,
    [],
    `the frozen baseline names directories outside GATE_DIRECTORY_PIN: ${unpinned.join(', ')}. ` +
      `Editing the JSON alone cannot bless a directory — the source pin and the JSON must move together.`,
  );

  const violations = structuralGateViolations({
    measuredDirectories: graph.nodes,
    frozenDirectories: baseline.moduleDirectories,
    pinDirectories: GATE_DIRECTORY_PIN,
    measuredUtilsLines: baseline.utilsLineCount,
    frozenUtilsLines: baseline.utilsLineCount,
    ratchetUtilsLines: readUtilsRatchetLineCount(),
  });
  assert.deepEqual(violations, [], violations.join('\n'));
});

// ---------------------------------------------------------------------------
// AC3 — server/shared/utils.ts did not grow
// ---------------------------------------------------------------------------

test('AC3: server/shared/utils.ts is not longer than the frozen exit-gate baseline or the oversize ratchet', () => {
  const baseline = readGateBaseline();
  const ratchetLines = readUtilsRatchetLineCount();
  const measured = lineCount(fs.readFileSync(UTILS_PATH, 'utf8'));

  console.log(`[ac455] utils arm: measured=${measured} frozen=${baseline.utilsLineCount} ratchet=${ratchetLines}`);
  assert.ok(measured > 0, 'the utils.ts reading must not be a zero-line file');
  assert.ok(
    measured <= baseline.utilsLineCount,
    `server/shared/utils.ts is ${measured} lines, over the frozen exit-gate baseline of ${baseline.utilsLineCount} — add the helper elsewhere; this file may only shrink`,
  );
  assert.ok(
    measured <= ratchetLines,
    `server/shared/utils.ts is ${measured} lines, over the architecture-ratchet oversize baseline of ${ratchetLines}`,
  );

  const violations = structuralGateViolations({
    measuredDirectories: realGraphOnce().nodes,
    frozenDirectories: baseline.moduleDirectories,
    pinDirectories: GATE_DIRECTORY_PIN,
    measuredUtilsLines: measured,
    frozenUtilsLines: baseline.utilsLineCount,
    ratchetUtilsLines: ratchetLines,
  });
  assert.deepEqual(violations, [], violations.join('\n'));
});

// ---------------------------------------------------------------------------
// False form — the negative control proves the gate can red
// ---------------------------------------------------------------------------

test('AC2/AC3 false form: an extra measured directory, a JSON-only baseline raise, and an extra line each red the gate', () => {
  const baseline = readGateBaseline();
  const ratchetLines = readUtilsRatchetLineCount();

  const syntheticDirectory = 'modules/__ac455-false-form';
  const syntheticDirectories = [...baseline.moduleDirectories, syntheticDirectory];
  const syntheticText = 'export const a = 1;\n';
  const syntheticLines = lineCount(syntheticText);

  const clean = structuralGateViolations({
    measuredDirectories: baseline.moduleDirectories,
    frozenDirectories: baseline.moduleDirectories,
    pinDirectories: baseline.moduleDirectories,
    measuredUtilsLines: syntheticLines,
    frozenUtilsLines: syntheticLines,
    ratchetUtilsLines: syntheticLines,
  });
  assert.deepEqual(clean, [], 'the synthetic control must start green, otherwise the red assertions below prove nothing');

  const directoryViolations = structuralGateViolations({
    measuredDirectories: syntheticDirectories,
    frozenDirectories: baseline.moduleDirectories,
    pinDirectories: baseline.moduleDirectories,
    measuredUtilsLines: syntheticLines,
    frozenUtilsLines: syntheticLines,
    ratchetUtilsLines: syntheticLines,
  });
  console.log(`[ac455] false form (extra measured directory): ${JSON.stringify(directoryViolations)}`);
  assert.ok(directoryViolations.length > 0, 'one extra measured directory must red the gate');
  assert.ok(
    directoryViolations.some((message) => message.includes(syntheticDirectory)),
    'the directory violation must name the extra directory',
  );

  // The recorded-change arm: the synthetic directory IS in the frozen baseline, but the source
  // pin was not edited with it — the exact "only the JSON was raised" shape. It must red, and
  // the message must name the offending directory and the source pin.
  const pinViolations = structuralGateViolations({
    measuredDirectories: syntheticDirectories,
    frozenDirectories: syntheticDirectories,
    pinDirectories: baseline.moduleDirectories,
    measuredUtilsLines: syntheticLines,
    frozenUtilsLines: syntheticLines,
    ratchetUtilsLines: syntheticLines,
  });
  console.log(`[ac455] false form (baseline outside source pin): ${JSON.stringify(pinViolations)}`);
  assert.ok(pinViolations.length > 0, 'a baseline directory outside the source pin must red the gate');
  assert.ok(
    pinViolations.some((message) => message.includes(syntheticDirectory)),
    'the pin violation must name the unpinned directory',
  );
  assert.ok(
    pinViolations.some((message) => message.includes('GATE_DIRECTORY_PIN')),
    'the pin violation must name the source pin it failed to edit',
  );
  assert.ok(
    !pinViolations.some((message) => message.includes('outside the frozen baseline')),
    'the pin arm must fire on the JSON-vs-pin link, not on the measured-vs-JSON link (that would prove the wrong arm)',
  );

  const lineViolations = structuralGateViolations({
    measuredDirectories: baseline.moduleDirectories,
    frozenDirectories: baseline.moduleDirectories,
    pinDirectories: baseline.moduleDirectories,
    measuredUtilsLines: syntheticLines + 1,
    frozenUtilsLines: syntheticLines,
    ratchetUtilsLines: syntheticLines,
  });
  console.log(`[ac455] false form (extra line): ${JSON.stringify(lineViolations)}`);
  assert.ok(lineViolations.length > 0, 'one extra utils.ts line must red the gate');
  assert.ok(
    lineViolations.some((message) => message.includes('over the frozen exit-gate baseline')),
    'the line violation must name the frozen exit-gate baseline it exceeded',
  );
  assert.ok(
    lineViolations.some((message) => message.includes('architecture-ratchet oversize baseline')),
    'the line violation must also name the oversize ratchet it exceeded',
  );

  // The real ceiling is the tighter of the two, so the committed relationship is meaningful:
  // frozen <= ratchet means the exact exit-gate pin is the one that fires first.
  console.log(`[ac455] ceilings: frozen=${baseline.utilsLineCount} ratchet=${ratchetLines}`);
});

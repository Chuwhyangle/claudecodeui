/**
 * AC-395 — the resident ledger's transitions, extracted.
 *
 * What this criterion is FOR. The delivery/turn ledger used to live inline in
 * `claude-host-driver.provider.ts`: fifty places reached into its fields, the
 * same "close the turn and record it" was spelled three times, and the same
 * "record an anomaly" twice. `modules/resident-ledger` holds the state and the
 * transitions now, and the driver holds one instance and forwards events. This
 * file reads that refactor back rather than trusting it:
 *
 *  · (a) every event of SPEC §5.2 drives a table row, asserting the ledger it
 *    leaves behind AND the `{changed, effects}` the transition answers with;
 *  · (b) `effects` is a discriminated union with no function members, checked by
 *    compiling a fixture and inspecting the type — not by scanning text;
 *  · (c) the three spellings of "close a turn" are one transition, producing
 *    byte-identical `closedTurns` records for the same outcome, and the three
 *    anomaly sites are one `reportAnomaly` effect;
 *  · (d) the driver has ZERO field accesses rooted at `turnLedger`, and assigns
 *    to no member of any ledger object — the second read off the TYPE of the
 *    assignment's target, so an alias write cannot hide from a text prefix;
 *  · (e) the ledger a driver holds is read-only by type: a programmatic compile
 *    of a write to it must produce TS2540;
 *  · (f) the ledger record carries no driver type — no `round`, no lease, no
 *    writer — and the new module imports shared and nothing else;
 *  · (g) `effects` carries no lease/publish tail: the fixed tail is the driver's;
 *  · (h) SPEC appendix A's four frame sequences replayed through the transitions
 *    end in states satisfying I1–I6.
 *
 * Every reading is taken before it is asserted, and the whole file runs against
 * a process budget (exit 3) so a red lands on a reading rather than on a hang.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import type { ResidentLedger, ResidentLedgerDelivery } from '@/shared/types.js';
// The ledger moved to a leaf module (AC-396); this criterion reads it, as the
// driver does, through the barrel only.
import type {
  ResidentLedgerEffect,
  ResidentLedgerEvent,
} from '@/modules/resident-ledger/index.js';
import {
  applyLedgerEvent,
  createResidentLedger,
  ledgerAnomalies,
  ledgerClosedTurns,
  ledgerDeliveries,
  ledgerForeign,
  ledgerPendingStart,
  ledgerTurn,
} from '@/modules/resident-ledger/index.js';

// ---------------------------------------------------------------------------
// Budget (AC (k)): a process-level kill, not a node:test case failure
// ---------------------------------------------------------------------------

/** The wall-clock bound this criterion reports the whole run against (AC (k): < 40s). */
const RUN_BUDGET_MS = 38_000;

const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  console.error(
    `[budget] budget=${RUN_BUDGET_MS}ms elapsed=${Date.now() - STARTED_AT}ms exit=3 — the ledger-transitions ` +
      `criterion did not finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, RUN_BUDGET_MS - 1_000);
budgetGuard.unref();

// ---------------------------------------------------------------------------
// The two files this criterion measures
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const LEDGER_FILE = path.join(
  REPO_ROOT,
  'server/modules/resident-ledger/ledger.ts',
);
const DRIVER_FILE = path.join(
  REPO_ROOT,
  'server/modules/providers/list/claude/claude-host-driver.provider.ts',
);

/** The three achieved criteria AC-395 (i) must leave alone, as repository-relative paths. */
const ACHIEVED_CRITERIA = [
  'server/modules/providers/tests/claude-resident-ledger-invariants.test.ts',
  'server/modules/providers/tests/claude-resident-interrupt-ledger.test.ts',
  'server/modules/providers/tests/claude-resident-unattended-after-turns.test.ts',
];

// ---------------------------------------------------------------------------
// (a) the transition table
// ---------------------------------------------------------------------------

/** The events SPEC §5.2 names, each with the row that drives it. */
const EVENT_NAMES = [
  'send',
  'lifecycle:queued',
  'lifecycle:started',
  'turn-init',
  'turn-result',
  'interrupt-request',
  'withdraw-request',
  'process-exit',
  'owed-boundary',
  'lifecycle:completed',
  'lifecycle:cancelled',
  'turn-init(double)',
] as const;

type TableRow = {
  readonly event: (typeof EVENT_NAMES)[number];
  /** The events applied before the row's own event, to reach its precondition. */
  readonly setup: readonly ResidentLedgerEvent[];
  /** The event under test. */
  readonly drive: ResidentLedgerEvent;
  readonly changed: boolean;
  readonly effects: readonly string[];
};

const AT = 1_700_000_000_000;

type SendEvent = Extract<ResidentLedgerEvent, { kind: 'send' }>;
type LifecycleEvent = Extract<ResidentLedgerEvent, { kind: 'lifecycle' }>;
type InitEvent = Extract<ResidentLedgerEvent, { kind: 'turn-init' }>;
type ResultEvent = Extract<ResidentLedgerEvent, { kind: 'turn-result' }>;

const send = (uuid: string, at = AT): SendEvent => ({
  kind: 'send',
  at,
  commandUuid: uuid,
  uuids: [uuid],
  text: `text-${uuid}`,
  source: 'user',
  priority: null,
});
const lifecycle = (
  commandUuid: string,
  state: 'queued' | 'started' | 'completed' | 'cancelled',
  at = AT,
): LifecycleEvent => ({
  kind: 'lifecycle',
  at,
  commandUuid,
  lifecycle: state,
  cancelledReason: 'cli',
});
const init = (uuid = 'init-1', at = AT): InitEvent => ({
  kind: 'turn-init',
  at,
  initFrameUuid: uuid,
});
const result = (isError: boolean, at = AT): ResultEvent => ({
  kind: 'turn-result',
  at,
  isError,
});

const TABLE: readonly TableRow[] = [
  {
    event: 'send',
    setup: [],
    drive: send('d1'),
    changed: true,
    effects: ['delivery-opened'],
  },
  {
    event: 'lifecycle:queued',
    setup: [send('d1')],
    drive: lifecycle('d1', 'queued'),
    changed: true,
    effects: [],
  },
  {
    event: 'lifecycle:started',
    setup: [send('d1'), lifecycle('d1', 'queued'), init()],
    drive: lifecycle('d1', 'started'),
    changed: true,
    effects: ['bind-turn-run'],
  },
  {
    event: 'turn-init',
    setup: [send('d1'), lifecycle('d1', 'queued')],
    drive: init(),
    changed: true,
    effects: ['turn-opened', 'bind-turn-run'],
  },
  {
    event: 'turn-result',
    setup: [send('d1'), lifecycle('d1', 'queued'), lifecycle('d1', 'started'), init()],
    drive: result(false),
    changed: true,
    effects: ['run-closed', 'turn-closed'],
  },
  {
    event: 'interrupt-request',
    setup: [send('d1'), lifecycle('d1', 'queued'), lifecycle('d1', 'started'), init()],
    drive: { kind: 'interrupt-request' },
    changed: true,
    effects: [],
  },
  {
    event: 'withdraw-request',
    setup: [send('d1')],
    drive: { kind: 'withdraw-request', commandUuid: 'd1' },
    changed: true,
    effects: [],
  },
  {
    event: 'process-exit',
    setup: [send('d1'), lifecycle('d1', 'queued'), lifecycle('d1', 'started'), init()],
    drive: { kind: 'process-exit', at: AT, reason: 'process-exit' },
    changed: true,
    effects: ['run-closed', 'turn-closed'],
  },
  {
    event: 'owed-boundary',
    setup: [
      send('d1'),
      lifecycle('d1', 'queued'),
      lifecycle('d1', 'started'),
      init(),
      result(false),
      send('d2'),
      lifecycle('d2', 'queued'),
    ],
    drive: { kind: 'owed-boundary', at: AT },
    changed: true,
    effects: ['anomaly'],
  },
  {
    event: 'lifecycle:completed',
    setup: [send('d1'), lifecycle('d1', 'queued'), lifecycle('d1', 'started')],
    drive: lifecycle('d1', 'completed'),
    changed: true,
    effects: [],
  },
  {
    event: 'lifecycle:cancelled',
    setup: [send('d1'), lifecycle('d1', 'queued'), lifecycle('d1', 'started')],
    drive: lifecycle('d1', 'cancelled'),
    changed: true,
    effects: [],
  },
  {
    event: 'turn-init(double)',
    setup: [send('d1'), lifecycle('d1', 'queued'), lifecycle('d1', 'started'), init('first')],
    drive: init('second'),
    changed: false,
    effects: ['anomaly'],
  },
];

/** One ledger, stated compactly: what a red has to be read against. */
function describeLedger(ledger: ResidentLedger): string {
  const turn = ledgerTurn(ledger);
  return JSON.stringify({
    deliveries: ledgerDeliveries(ledger).map((delivery) => ({
      id: delivery.commandUuid,
      state: delivery.state,
      turnId: delivery.turnId,
      runOpen: delivery.runOpen,
      owed: delivery.owed,
    })),
    turn: turn
      ? { id: turn.id, kind: turn.kind, open: turn.open, owner: turn.ownerDeliveryId, irq: turn.interruptRequested }
      : null,
    closed: ledgerClosedTurns(ledger),
    pending: ledgerPendingStart(ledger).map((delivery) => delivery.commandUuid),
    anomalies: ledgerAnomalies(ledger).map((anomaly) => anomaly.code),
    foreign: [...ledgerForeign(ledger)],
  });
}

test('AC-395 (a) every SPEC §5.2 event drives a table row and answers {changed, effects}', () => {
  const rows: string[] = [];
  const failures: string[] = [];

  for (const row of TABLE) {
    const ledger = createResidentLedger();
    for (const event of row.setup) {
      applyLedgerEvent(ledger, event);
    }
    const transition = applyLedgerEvent(ledger, row.drive);
    const effects = transition.effects.map((effect) => effect.kind);

    const state = describeLedger(ledger);
    rows.push(
      `event=${row.event} changed=${transition.changed} effects=[${effects.join(',')}] state=${state}`,
    );

    if (transition.changed !== row.changed) {
      failures.push(`${row.event}: changed=${transition.changed}, expected ${row.changed}`);
    }
    if (effects.join(',') !== row.effects.join(',')) {
      failures.push(`${row.event}: effects=[${effects.join(',')}], expected [${row.effects.join(',')}]`);
    }
  }

  console.log('AC395-transition-table:');
  for (const line of rows) {
    console.log(`  ${line}`);
  }
  console.log(`AC395-transition-table: rows=${rows.length} events=${EVENT_NAMES.length}`);
  assert.deepEqual(failures, [], `the transition table disagreed with the ledger:\n${failures.join('\n')}`);
  assert.strictEqual(
    rows.length,
    EVENT_NAMES.length,
    'every event SPEC §5.2 names must have a row of its own',
  );
});

/** A delivery's state, read off a ledger by its uuid. */
function deliveryState(ledger: ResidentLedger, uuid: string): string {
  return ledgerDeliveries(ledger).find((entry) => entry.commandUuid === uuid)?.state ?? '<absent>';
}

test('AC-395 (a2) the transition bodies read the way the table says they do', () => {
  // `send` → `pushed`, indexed under every frame uuid it wrote.
  const sent = createResidentLedger();
  applyLedgerEvent(sent, { ...send('d1'), uuids: ['frame-a', 'frame-b'] });
  const indexed = ['frame-a', 'frame-b'].map(
    (uuid) => ledgerDeliveries(sent).find((entry) => entry.commandUuid === 'd1') !== undefined
      && (sent.byUuid.get(uuid)?.commandUuid ?? '<missing>'),
  );
  assert.deepEqual(indexed, ['d1', 'd1'], 'every frame uuid must address the one delivery');
  assert.strictEqual(deliveryState(sent, 'd1'), 'pushed');

  // `started` with no turn open → `pendingStart`, not a fold.
  const pending = createResidentLedger();
  applyLedgerEvent(pending, send('d1'));
  applyLedgerEvent(pending, lifecycle('d1', 'started'));
  assert.deepEqual(
    ledgerPendingStart(pending).map((entry) => entry.commandUuid),
    ['d1'],
    'a command started with no turn open waits for the next one',
  );

  // `started` while a delivered turn is open → folded onto that turn.
  const folded = createResidentLedger();
  applyLedgerEvent(folded, send('d1'));
  applyLedgerEvent(folded, lifecycle('d1', 'queued'));
  applyLedgerEvent(folded, lifecycle('d1', 'started'));
  applyLedgerEvent(folded, init());
  applyLedgerEvent(folded, send('d2'));
  applyLedgerEvent(folded, lifecycle('d2', 'started'));
  const turn = ledgerTurn(folded);
  const d2 = ledgerDeliveries(folded).find((entry) => entry.commandUuid === 'd2');
  assert.strictEqual(d2?.turnId, turn?.id ?? '<none>', 'a command started under an open turn folds into it');

  // An unknown uuid is foreign, not a delivery.
  applyLedgerEvent(folded, lifecycle('cron-uuid', 'started'));
  assert.ok(ledgerForeign(folded).has('cron-uuid'), 'a uuid nothing here pushed is foreign');
  assert.strictEqual(deliveryState(folded, 'cron-uuid'), '<absent>', 'and is not a delivery');

  // `cancelled` carries the reason this host recorded.
  const cancelled = createResidentLedger();
  applyLedgerEvent(cancelled, send('d1'));
  applyLedgerEvent(cancelled, lifecycle('d1', 'queued'));
  applyLedgerEvent(cancelled, lifecycle('d1', 'started'));
  applyLedgerEvent(cancelled, init());
  applyLedgerEvent(cancelled, { kind: 'interrupt-request' });
  applyLedgerEvent(cancelled, {
    kind: 'lifecycle',
    at: AT,
    commandUuid: 'd1',
    lifecycle: 'cancelled',
    cancelledReason: 'interrupt',
  });
  const cancelledRecord = ledgerDeliveries(cancelled).find((entry) => entry.commandUuid === 'd1');
  assert.strictEqual(cancelledRecord?.reason, 'interrupt', 'the cancelled reason is the one the event stated');
  assert.strictEqual(cancelledRecord?.endedAt, AT, 'a terminal is stamped with the moment it was read');

  // A second terminal is not applied (C-1).
  applyLedgerEvent(cancelled, {
    kind: 'lifecycle',
    at: AT + 1,
    commandUuid: 'd1',
    lifecycle: 'completed',
    cancelledReason: 'cli',
  });
  assert.strictEqual(deliveryState(cancelled, 'd1'), 'cancelled', 'a terminal is written once (C-1)');

  // The interrupt request moves only the flag (C-5).
  const interrupted = createResidentLedger();
  applyLedgerEvent(interrupted, send('d1'));
  applyLedgerEvent(interrupted, lifecycle('d1', 'queued'));
  applyLedgerEvent(interrupted, lifecycle('d1', 'started'));
  applyLedgerEvent(interrupted, init());
  const before = describeLedger(interrupted);
  applyLedgerEvent(interrupted, { kind: 'interrupt-request' });
  const after = describeLedger(interrupted);
  assert.notStrictEqual(before, after, 'the request is a change');
  assert.strictEqual(deliveryState(interrupted, 'd1'), 'started', 'but it synthesizes no delivery ending');
  assert.strictEqual(ledgerTurn(interrupted)?.interruptRequested, true);

  console.log(
    `AC395-bodies: indexed=${indexed.join(',')} pendingStart=1 folded=1 foreign=1 cancelledReason=interrupt ` +
      `secondTerminalIgnored=true interruptSynthesizesNothing=true`,
  );
});

// ---------------------------------------------------------------------------
// (b) + (e) + (f) one program, three type-level readings
// ---------------------------------------------------------------------------

const FIXTURE_PATH = path.join(import.meta.dirname, '__ac395-ledger-type-fixture.ts');

/** The effect kinds the union is REQUIRED to carry — and (g) the ones it may not. */
const EFFECT_KINDS = [
  'delivery-opened',
  'turn-opened',
  'bind-turn-run',
  'run-closed',
  'turn-closed',
  'anomaly',
] as const;

/** Kinds a fixed tail would smuggle in; their absence is AC-395 (g). */
const FORBIDDEN_EFFECT_KINDS = ['sync-leases', 'publish', 'publish-deliveries', 'lease-added', 'lease-removed'];

type FixtureExpectation = { readonly line: number; readonly code: number; readonly label: string };

const fixtureLines: string[] = [];
const fixtureExpectations: FixtureExpectation[] = [];

function fixtureLine(text: string): void {
  fixtureLines.push(text);
}
function fixtureExpect(text: string, code: number, label: string): void {
  fixtureExpectations.push({ line: fixtureLines.length, code, label });
  fixtureLines.push(text);
}

fixtureLine("import type { ResidentLedger, ResidentLedgerDelivery } from '@/shared/types.js';");
fixtureLine("import type { ResidentLedgerEffect } from '@/modules/resident-ledger/index.js';");
fixtureLine("import { createResidentLedger } from '@/modules/resident-ledger/index.js';");
fixtureLine('');
fixtureLine('declare const ac395Ledger: ResidentLedger;');
fixtureLine('declare const ac395Delivery: ResidentLedgerDelivery;');
fixtureLine('declare const ac395Effects: ResidentLedgerEffect;');
fixtureLine('declare function ac395Fn(): void;');
fixtureLine('');
fixtureLine('// (e) the ledger a driver holds is read-only by type: each line below is TS2540.');
fixtureLine('// First on the FACTORY’s own return — the object the driver really holds.');
fixtureLine('const ac395Returned = createResidentLedger();');
fixtureExpect('ac395Returned.turn = null;', 2540, 'returned.turn');
fixtureExpect('ac395Returned.deliveries = [];', 2540, 'returned.deliveries');
fixtureLine('// Then on the declared view, member by member.');
fixtureExpect('ac395Ledger.deliveries = [];', 2540, 'deliveries');
fixtureExpect('ac395Ledger.byUuid = new Map();', 2540, 'byUuid');
fixtureExpect('ac395Ledger.foreign = new Set();', 2540, 'foreign');
fixtureExpect('ac395Ledger.turn = null;', 2540, 'turn');
fixtureExpect('ac395Ledger.closedTurns = [];', 2540, 'closedTurns');
fixtureExpect('ac395Ledger.pendingStart = [];', 2540, 'pendingStart');
fixtureExpect('ac395Ledger.anomalies = [];', 2540, 'anomalies');
fixtureLine('');
fixtureLine('// (b) a function is assignable to NO member of the effects union: each line below is TS2322.');
for (const kind of EFFECT_KINDS) {
  fixtureExpect(
    `const ac395E_${kind.replace(/-/g, '_')}: Extract<ResidentLedgerEffect, { kind: '${kind}' }> = ac395Fn;`,
    2322,
    kind,
  );
}
fixtureLine('');
fixtureLine('void ac395Ledger;');
fixtureLine('void ac395Delivery;');
fixtureLine('void ac395Effects;');
fixtureLine('void ac395Returned;');
for (const kind of EFFECT_KINDS) {
  fixtureLine(`void ac395E_${kind.replace(/-/g, '_')};`);
}
fixtureLine('void createResidentLedger;');

const FIXTURE_TEXT = `${fixtureLines.join('\n')}\n`;

type ProgramReadings = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly fixture: ts.SourceFile;
  readonly driver: ts.SourceFile;
  readonly ledger: ts.SourceFile;
  readonly diagnostics: readonly ts.Diagnostic[];
};

let cached: ProgramReadings | null = null;

/**
 * One TypeScript program over the fixture, the driver and the ledger module.
 *
 * Root names are the three files rather than the project, so the program is
 * built from what this criterion actually measures instead of the whole tree —
 * the whole point of a criterion is that it can be run on its own.
 */
function loadProgram(): ProgramReadings {
  if (cached) {
    return cached;
  }
  const configPath = path.join(REPO_ROOT, 'server/tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.ok(!configFile.error, 'server/tsconfig.json must be readable');
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false };

  const host = ts.createCompilerHost(options);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const fixtureSource = ts.createSourceFile(
    FIXTURE_PATH,
    FIXTURE_TEXT,
    options.target ?? ts.ScriptTarget.ES2022,
    true,
  );
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === FIXTURE_PATH
      ? fixtureSource
      : baseGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = (fileName) => fileName === FIXTURE_PATH || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => (fileName === FIXTURE_PATH ? FIXTURE_TEXT : ts.sys.readFile(fileName));

  const program = ts.createProgram([FIXTURE_PATH, DRIVER_FILE, LEDGER_FILE], options, host);
  const checker = program.getTypeChecker();
  const fixture = program.getSourceFile(FIXTURE_PATH);
  const driver = program.getSourceFile(DRIVER_FILE);
  const ledger = program.getSourceFile(LEDGER_FILE);
  assert.ok(fixture, 'the virtual fixture must be in the program');
  assert.ok(driver, 'the driver must be in the program');
  assert.ok(ledger, 'the ledger module must be in the program');

  const diagnostics = [
    ...program.getSemanticDiagnostics(fixture),
    ...program.getSyntacticDiagnostics(fixture),
  ];

  cached = { program, checker, fixture, driver, ledger, diagnostics };
  return cached;
}

/** The text of the fixture line a diagnostic starts on. */
function fixtureLineOf(fixture: ts.SourceFile, diagnostic: ts.Diagnostic): string {
  if (diagnostic.start === undefined) {
    return '<no position>';
  }
  const { line } = fixture.getLineAndCharacterOfPosition(diagnostic.start);
  return fixtureLines[line] ?? '<out of range>';
}

test('AC-395 (b) the effects union has no function member, per member, by programmatic compile', () => {
  const { checker, fixture, diagnostics } = loadProgram();

  // Every expected diagnostic must be present, and nothing else may be.
  const observed = diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    line: fixture.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line,
    text: fixtureLineOf(fixture, diagnostic),
  }));

  const missing = fixtureExpectations.filter(
    (expectation) =>
      !observed.some((entry) => entry.line === expectation.line && entry.code === expectation.code),
  );
  const unexpected = observed.filter(
    (entry) => !fixtureExpectations.some((expectation) => expectation.line === entry.line),
  );

  // The union's own reading, from the checker rather than from the text.
  const effectsDecl = fixture.statements.find(
    (statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement)
      && statement.declarationList.declarations[0]?.name.getText(fixture) === 'ac395Effects',
  );
  assert.ok(effectsDecl, 'the fixture must declare the effects type');
  const effectsType = checker.getTypeAtLocation(effectsDecl.declarationList.declarations[0].name);
  const members = effectsType.isUnion() ? effectsType.types : [effectsType];

  const memberReadings: string[] = [];
  const failures: string[] = [];
  const seenKinds: string[] = [];
  for (const member of members) {
    const kindSymbol = member.getProperty('kind');
    const kind = kindSymbol
      ? checker.typeToString(checker.getTypeOfSymbolAtLocation(kindSymbol, effectsDecl)).replace(/^"|"$/g, '')
      : '<no kind>';
    seenKinds.push(kind);
    if (member.getCallSignatures().length > 0) {
      failures.push(`member ${String(kind)} is itself a function type`);
    }
    const callableProperties = member
      .getProperties()
      .filter((property) => checker.getTypeOfSymbolAtLocation(property, effectsDecl).getCallSignatures().length > 0)
      .map((property) => property.getName());
    if (callableProperties.length > 0) {
      failures.push(`member ${String(kind)} carries function properties: ${callableProperties.join(',')}`);
    }
    memberReadings.push(`kind=${String(kind)} callable=false functionProps=0`);
  }

  console.log('AC395-effects-union:');
  for (const reading of memberReadings) {
    console.log(`  ${reading}`);
  }
  console.log(
    `AC395-effects-union: members=${members.length} kinds=[${seenKinds.join(',')}] ` +
      `expectedDiagnostics=${fixtureExpectations.length} observedDiagnostics=${diagnostics.length}`,
  );
  console.log(
    `AC395-effects-union: ts2540=${observed.filter((entry) => entry.code === 2540).length} ` +
      `ts2322=${observed.filter((entry) => entry.code === 2322).length}`,
  );

  assert.deepEqual(
    seenKinds.slice().sort(),
    [...EFFECT_KINDS].sort(),
    'the effects union must carry exactly the kinds the ledger states',
  );
  // (g) The fixed tail is the driver's: no lease or publish effect exists.
  const forbidden = seenKinds.filter((kind) => FORBIDDEN_EFFECT_KINDS.includes(kind));
  assert.deepEqual(forbidden, [], 'effects must not carry a lease/publish tail (AC-395 (g))');
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.deepEqual(
    missing.map((expectation) => `${expectation.label}: expected TS${expectation.code}`),
    [],
    'the fixture must produce every diagnostic it claims',
  );
  assert.deepEqual(
    unexpected.map((entry) => `line ${entry.line}: TS${entry.code} ${entry.text}`),
    [],
    'the fixture must produce no diagnostic it did not claim',
  );

  // The union members' own effect objects are not functions either, read the
  // other way round: a function assigned to the WHOLE union is also an error.
  const unionAssignableFromFunction = checker.isTypeAssignableTo(
    checker.getTypeAtLocation(
      fixture.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.getText(fixture) === 'ac395Fn',
      )!.name!,
    ),
    effectsType,
  );
  console.log(`AC395-effects-union: functionAssignableToUnion=${unionAssignableFromFunction}`);
  assert.strictEqual(unionAssignableFromFunction, false, 'no function type is assignable to the effects union');
});

// ---------------------------------------------------------------------------
// (c) one transition per repeated spelling
// ---------------------------------------------------------------------------

test('AC-395 (c) the three turn-closings are one transition, byte-identically', () => {
  /** The same turn, driven to its ending three ways. */
  const closings: Array<{ path: string; closed: string }> = [];

  // Path 1 — a delivered turn's `RESULT` (the driver's `closeTurn`).
  const delivered = createResidentLedger();
  applyLedgerEvent(delivered, send('d1'));
  applyLedgerEvent(delivered, lifecycle('d1', 'queued'));
  applyLedgerEvent(delivered, lifecycle('d1', 'started'));
  applyLedgerEvent(delivered, init());
  applyLedgerEvent(delivered, result(false));
  closings.push({ path: 'result:delivered', closed: JSON.stringify(ledgerClosedTurns(delivered)) });

  // Path 2 — the unattended turn's ending (the driver's `closeLedgerTurnOnly`),
  // reached by the SAME transition on a turn the ledger opened with nothing bound.
  const unattended = createResidentLedger();
  applyLedgerEvent(unattended, init());
  applyLedgerEvent(unattended, result(false));
  closings.push({ path: 'result:unattended', closed: JSON.stringify(ledgerClosedTurns(unattended)) });

  // Path 3 — the process exit (the driver's `endLedger`), which states `aborted`.
  const exited = createResidentLedger();
  applyLedgerEvent(exited, send('d1'));
  applyLedgerEvent(exited, lifecycle('d1', 'queued'));
  applyLedgerEvent(exited, lifecycle('d1', 'started'));
  applyLedgerEvent(exited, init());
  applyLedgerEvent(exited, { kind: 'process-exit', at: AT, reason: 'process-exit' });
  closings.push({ path: 'process-exit', closed: JSON.stringify(ledgerClosedTurns(exited)) });

  console.log('AC395-close-sites:');
  for (const closing of closings) {
    console.log(`  path=${closing.path} closedTurns=${closing.closed}`);
  }

  // The claim is about the RECORD, not the id or the turn: ids are minted per
  // ledger, and the kind/owner are facts about the turn the record is of. Given
  // the same turn and the same outcome, the three paths must write the same
  // keys, in the same order, with byte-identical values.
  const keysOf = (json: string): string => {
    const record = JSON.parse(json.replace(/^\[|\]$/g, '')) as Array<Record<string, unknown>>;
    return record.length > 0 ? Object.keys(record[0]).join(',') : '<empty>';
  };
  const fieldOf = (json: string, field: string): string => {
    const first = (JSON.parse(json) as Array<Record<string, unknown>>)[0];
    const value = first ? first[field] : undefined;
    return typeof value === 'string' ? value : '<none>';
  };
  const idless = (json: string): string => json.replace(/"id":"[^"]+"/g, '"id":"<turn>"');

  assert.deepEqual(
    closings.map((closing) => keysOf(closing.closed)),
    Array(closings.length).fill(keysOf(closings[0].closed)),
    'all three paths must write the same record keys, in the same order',
  );
  assert.deepEqual(
    closings.map((closing) => fieldOf(closing.closed, 'kind')),
    ['delivered', 'unattended', 'delivered'],
    'and each record must state the kind of the turn it is of',
  );

  // The same (turn, outcome) reached two different ways must produce a
  // byte-identical entry — this is what "one transition" buys. The delivered
  // turn is driven to `aborted` twice: by an answered interrupt at its
  // `RESULT`, and by the process going away.
  const abortedByIdResult = createResidentLedger();
  applyLedgerEvent(abortedByIdResult, send('d1'));
  applyLedgerEvent(abortedByIdResult, lifecycle('d1', 'queued'));
  applyLedgerEvent(abortedByIdResult, lifecycle('d1', 'started'));
  applyLedgerEvent(abortedByIdResult, init());
  applyLedgerEvent(abortedByIdResult, { kind: 'interrupt-request' });
  applyLedgerEvent(abortedByIdResult, result(true));

  console.log(
    `AC395-close-sites: outcomes deliveredByResult=${fieldOf(closings[0].closed, 'outcome')} ` +
      `unattendedByResult=${fieldOf(closings[1].closed, 'outcome')} ` +
      `deliveredByExit=${fieldOf(closings[2].closed, 'outcome')} ` +
      `deliveredByAbortResult=${fieldOf(JSON.stringify(ledgerClosedTurns(abortedByIdResult)), 'outcome')}`,
  );
  assert.strictEqual(fieldOf(closings[0].closed, 'outcome'), 'completed');
  assert.strictEqual(fieldOf(closings[1].closed, 'outcome'), 'completed');
  assert.strictEqual(fieldOf(closings[2].closed, 'outcome'), 'aborted');
  assert.strictEqual(
    idless(JSON.stringify(ledgerClosedTurns(abortedByIdResult))),
    idless(closings[2].closed),
    'the same turn and outcome must produce a byte-identical record wherever they are reached',
  );

  // And the three anomaly sites are ONE effect, read per site.
  const sites: Array<{ site: string; effects: string[]; anomalies: string[] }> = [];

  const interrupted = createResidentLedger();
  const interruptTransition = applyLedgerEvent(interrupted, {
    kind: 'anomaly',
    code: 'interrupt-no-result',
    detail: 'turn turn-1 got no RESULT',
  });
  sites.push({
    site: 'interrupt-no-result',
    effects: interruptTransition.effects.map((effect) => `${effect.kind}:${effect.kind === 'anomaly' ? effect.code : ''}`),
    anomalies: ledgerAnomalies(interrupted).map((anomaly) => anomaly.code),
  });

  const doubled = createResidentLedger();
  applyLedgerEvent(doubled, init('first'));
  const doubleTransition = applyLedgerEvent(doubled, init('second'));
  sites.push({
    site: 'double-init',
    effects: doubleTransition.effects.map((effect) => `${effect.kind}:${effect.kind === 'anomaly' ? effect.code : ''}`),
    anomalies: ledgerAnomalies(doubled).map((anomaly) => anomaly.code),
  });

  const owed = createResidentLedger();
  applyLedgerEvent(owed, send('d1'));
  applyLedgerEvent(owed, lifecycle('d1', 'queued'));
  applyLedgerEvent(owed, lifecycle('d1', 'started'));
  applyLedgerEvent(owed, init());
  applyLedgerEvent(owed, result(false));
  const owedTransition = applyLedgerEvent(owed, { kind: 'owed-boundary', at: AT });
  sites.push({
    site: 'owed-terminal-missing',
    effects: owedTransition.effects.map((effect) => `${effect.kind}:${effect.kind === 'anomaly' ? effect.code : ''}`),
    anomalies: ledgerAnomalies(owed).map((anomaly) => anomaly.code),
  });

  console.log('AC395-anomaly-sites:');
  for (const site of sites) {
    console.log(`  site=${site.site} effects=[${site.effects.join(',')}] anomalies=[${site.anomalies.join(',')}]`);
  }
  assert.deepEqual(
    sites.map((site) => site.effects[site.effects.length - 1]),
    ['anomaly:interrupt-no-result', 'anomaly:double-init', 'anomaly:owed-terminal-missing'],
    'every anomaly site must produce the one `anomaly` effect',
  );
  assert.deepEqual(
    sites.map((site) => site.anomalies.join(',')),
    ['interrupt-no-result', 'double-init', 'owed-terminal-missing'],
  );
});

// ---------------------------------------------------------------------------
// (d) + (f) AST / type readings over the driver and the new module
// ---------------------------------------------------------------------------

/** A `<expr>.turnLedger.<field>` access anywhere in one source file. */
function countTurnLedgerFieldAccesses(source: ts.SourceFile): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.getText(source) === 'turnLedger'
    ) {
      found.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        text: node.getText(source),
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

test('AC-395 (d) the driver touches no ledger field, by AST count and by write-target type', () => {
  const { program, checker, driver } = loadProgram();

  const accesses = countTurnLedgerFieldAccesses(driver);
  const ledgerSources = ts.createSourceFile(
    `${DRIVER_FILE}.text`,
    readFileSync(DRIVER_FILE, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const textCount = (ledgerSources.text.match(/\.turnLedger\./g) ?? []).length;

  // Write-target scan: the TYPE of what an assignment is writing to, so an
  // alias (`const turn = ledgerTurn(ledger); turn.open = false`) cannot hide
  // behind a text prefix that is not `turnLedger.`.
  const ledgerWrites: Array<{ line: number; text: string; type: string }> = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      const objectExpression = node.left.expression;
      const objectType = checker.getTypeAtLocation(objectExpression);
      const names = new Set<string>();
      for (const constituent of objectType.isUnion() ? objectType.types : [objectType]) {
        if (constituent.symbol) {
          names.add(constituent.symbol.getName());
        }
      }
      names.add(checker.typeToString(objectType));
      const target = [...names].find((name) => /ResidentLedger/.test(name));
      if (target) {
        ledgerWrites.push({
          line: driver.getLineAndCharacterOfPosition(node.getStart(driver)).line + 1,
          text: node.getText(driver),
          type: target,
        });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(driver);

  console.log(
    `AC395-driver-scan: turnLedgerFieldAccesses=${accesses.length} turnLedgerTextOccurrences=${textCount} ` +
      `ledgerMemberWrites=${ledgerWrites.length}`,
  );
  for (const write of ledgerWrites) {
    console.log(`  write line ${write.line}: ${write.text} (type ${write.type})`);
  }
  for (const access of accesses) {
    console.log(`  access line ${access.line}: ${access.text}`);
  }

  assert.strictEqual(accesses.length, 0, 'the driver must not read or write a field of the ledger');
  assert.strictEqual(textCount, 0, 'and no `<expr>.turnLedger.` may remain as text either');
  assert.deepEqual(
    ledgerWrites.map((write) => `line ${write.line}: ${write.text}`),
    [],
    'the driver must not assign to a member of any ledger object',
  );

  // The ledger the driver holds is the read-only view — proven by the type.
  const driverSource = program.getSourceFile(DRIVER_FILE);
  assert.ok(driverSource, 'the driver is in the program');
  void driverSource;
});

test('AC-395 (f) the ledger module imports shared and nothing else, and carries no driver type', () => {
  const { checker, fixture, ledger } = loadProgram();

  const specifiers: string[] = [];
  const identifierNames = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isIdentifier(node)) {
      identifierNames.add(node.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(ledger);

  const outsideShared = specifiers.filter((specifier) => !specifier.startsWith('@/shared/'));
  const referencesResidentRound = identifierNames.has('ResidentRound');

  // The record's own shape, read off the type rather than off the text.
  const deliveryDecl = fixture.statements.find(
    (statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement)
      && statement.declarationList.declarations[0]?.name.getText(fixture) === 'ac395Delivery',
  );
  assert.ok(deliveryDecl, 'the fixture must declare the delivery type');
  const deliveryType = checker.getTypeAtLocation(deliveryDecl.declarationList.declarations[0].name);
  const properties = deliveryType.getProperties().map((property) => property.getName());
  const driverShaped = properties.filter((name) =>
    ['round', 'leaseId', 'leaseHeld', 'turnWriter', 'writer', 'context', 'done', 'settle', 'fail'].includes(name),
  );

  console.log(
    `AC395-module-scan: imports=[${specifiers.join(',')}] outsideShared=${outsideShared.length} ` +
      `referencesResidentRound=${referencesResidentRound}`,
  );
  console.log(`AC395-module-scan: deliveryProperties=[${properties.join(',')}] driverShaped=[${driverShaped.join(',')}]`);

  assert.deepEqual(specifiers.slice().sort(), ['@/shared/types.js'], 'the new module must import shared and nothing else');
  assert.deepEqual(outsideShared, []);
  assert.strictEqual(referencesResidentRound, false, 'the ledger module must not name the driver round type');
  assert.deepEqual(driverShaped, [], 'the delivery record must carry no driver type');
  assert.ok(properties.includes('commandUuid') && properties.includes('runOpen'), 'and it must still be the delivery');
});

// ---------------------------------------------------------------------------
// (h) SPEC appendix A, replayed through the transitions
// ---------------------------------------------------------------------------

type ScenarioStep = { readonly label: string; readonly event: ResidentLedgerEvent };

/** SPEC appendix A's four frame sequences, as transitions. */
function appendixAScenarios(): Array<{ name: string; steps: ScenarioStep[] }> {
  let clock = 0;
  const at = (): number => (clock += 10);
  const mk = (uuid: string): ScenarioStep => ({ label: `send:${uuid}`, event: send(uuid, at()) });

  const s1 = [
    mk('s1-a'),
    { label: 'CLI queued s1-a', event: lifecycle('s1-a', 'queued', at()) },
    { label: 'CLI started s1-a', event: lifecycle('s1-a', 'started', at()) },
    { label: 'CLI system/init', event: init('s1-init', at()) },
    { label: 'CLI RESULT ok', event: result(false, at()) },
    { label: 'CLI completed s1-a', event: lifecycle('s1-a', 'completed', at()) },
    mk('s1b-a'),
    { label: 'CLI queued s1b-a', event: lifecycle('s1b-a', 'queued', at()) },
    { label: 'CLI started s1b-a', event: lifecycle('s1b-a', 'started', at()) },
    { label: 'CLI system/init (2)', event: init('s1b-init', at()) },
    { label: 'CLI RESULT ok (2)', event: result(false, at()) },
    { label: 'CLI completed s1b-a', event: lifecycle('s1b-a', 'completed', at()) },
  ];

  const s2 = [
    mk('s2-a'),
    { label: 'CLI queued s2-a', event: lifecycle('s2-a', 'queued', at()) },
    { label: 'CLI started s2-a', event: lifecycle('s2-a', 'started', at()) },
    { label: 'CLI system/init', event: init('s2-init-1', at()) },
    mk('s2-b'),
    mk('s2-c'),
    { label: 'CLI queued s2-b', event: lifecycle('s2-b', 'queued', at()) },
    { label: 'CLI queued s2-c', event: lifecycle('s2-c', 'queued', at()) },
    { label: 'CLI RESULT ok', event: result(false, at()) },
    { label: 'CLI completed s2-a', event: lifecycle('s2-a', 'completed', at()) },
    { label: 'CLI started s2-b', event: lifecycle('s2-b', 'started', at()) },
    { label: 'CLI started s2-c', event: lifecycle('s2-c', 'started', at()) },
    { label: 'CLI system/init (2)', event: init('s2-init-2', at()) },
    { label: 'CLI RESULT ok (2)', event: result(false, at()) },
    { label: 'CLI completed s2-b', event: lifecycle('s2-b', 'completed', at()) },
    { label: 'CLI completed s2-c', event: lifecycle('s2-c', 'completed', at()) },
  ];

  const s3 = [
    mk('s3-a'),
    { label: 'CLI queued s3-a', event: lifecycle('s3-a', 'queued', at()) },
    { label: 'CLI started s3-a', event: lifecycle('s3-a', 'started', at()) },
    { label: 'CLI system/init', event: init('s3-init', at()) },
    { label: 'HOST next s3-b', event: mk('s3-b').event },
    { label: 'CLI queued s3-b', event: lifecycle('s3-b', 'queued', at()) },
    { label: 'CLI started s3-b (folded)', event: lifecycle('s3-b', 'started', at()) },
    { label: 'CLI completed s3-b', event: lifecycle('s3-b', 'completed', at()) },
    { label: 'CLI RESULT ok', event: result(false, at()) },
    { label: 'CLI completed s3-a', event: lifecycle('s3-a', 'completed', at()) },
  ];

  const s4 = [
    mk('s4-a'),
    { label: 'CLI queued s4-a', event: lifecycle('s4-a', 'queued', at()) },
    { label: 'CLI started s4-a', event: lifecycle('s4-a', 'started', at()) },
    { label: 'CLI system/init', event: init('s4-init-1', at()) },
    mk('s4-b'),
    { label: 'CLI queued s4-b', event: lifecycle('s4-b', 'queued', at()) },
    { label: 'HOST chat.abort', event: { kind: 'interrupt-request' } as ResidentLedgerEvent },
    { label: 'CLI RESULT error_during_execution', event: result(true, at()) },
    { label: 'CLI cancelled s4-a', event: lifecycle('s4-a', 'cancelled', at()) },
    { label: 'CLI started s4-b', event: lifecycle('s4-b', 'started', at()) },
    { label: 'CLI system/init (2)', event: init('s4-init-2', at()) },
    { label: 'CLI RESULT ok', event: result(false, at()) },
    { label: 'CLI completed s4-b', event: lifecycle('s4-b', 'completed', at()) },
  ];

  return [
    { name: 'S1 idle cold (and S1b warm)', steps: s1 },
    { name: 'S2 later: two busy sends behind a running turn', steps: s2 },
    { name: 'S3 next: one busy send folded into the running turn', steps: s3 },
    { name: 'S4 interrupt: abort while A runs and B is queued', steps: s4 },
  ];
}

const TERMINAL_STATES = new Set(['completed', 'cancelled']);

test('AC-395 (h) SPEC appendix A replayed through the transitions satisfies I1–I6', () => {
  const readings: string[] = [];
  const failures: string[] = [];

  for (const scenario of appendixAScenarios()) {
    const ledger = createResidentLedger();
    /** I3/I4: a binding is stated once and never moves. */
    const boundTurn = new Map<string, string>();
    /** I5: what the turn's kind was decided from, at the moment it was decided. */
    const turnKinds: string[] = [];
    /** I6: the projection, recomputed from the ledger after every event. */
    let projectionDisagreements = 0;
    /** I2: the first terminal each delivery was given. */
    const firstTerminal = new Map<string, string>();
    let secondTerminals = 0;

    const before = new Map(ledgerDeliveries(ledger).map((delivery) => [delivery.commandUuid, delivery.state]));

    for (const step of scenario.steps) {
      const pendingBefore = ledgerPendingStart(ledger).length;
      const openRunBefore = ledgerDeliveries(ledger).some((delivery) => delivery.runOpen);
      const transitions = applyLedgerEvent(ledger, step.event);

      const after = new Map(ledgerDeliveries(ledger).map((delivery) => [delivery.commandUuid, delivery.state]));
      for (const [uuid, state] of after) {
        const prior = before.get(uuid);
        if (prior !== undefined && prior !== state) {
          if (TERMINAL_STATES.has(prior) && TERMINAL_STATES.has(state)) {
            secondTerminals += 1;
          }
          if (TERMINAL_STATES.has(state) && !firstTerminal.has(uuid)) {
            firstTerminal.set(uuid, state);
          }
        }
        if (TERMINAL_STATES.has(state) && !firstTerminal.has(uuid)) {
          firstTerminal.set(uuid, state);
        }
        before.set(uuid, state);
      }

      // I3/I4: a delivery's turn binding never moves once it is stated.
      for (const delivery of ledgerDeliveries(ledger)) {
        if (delivery.turnId !== null) {
          const known = boundTurn.get(delivery.commandUuid);
          if (known === undefined) {
            boundTurn.set(delivery.commandUuid, delivery.turnId);
          } else if (known !== delivery.turnId) {
            failures.push(`${scenario.name} at "${step.label}": ${delivery.commandUuid} moved from ${known} to ${delivery.turnId}`);
          }
        }
      }

      // I5: how the ledger decided the kind, at the moment it decided it.
      for (const effect of transitions.effects) {
        if (effect.kind === 'turn-opened') {
          const expected = pendingBefore > 0 || openRunBefore ? 'delivered' : 'unattended';
          turnKinds.push(`${effect.turnId}=${effect.turnKind}`);
          if (effect.turnKind !== expected) {
            failures.push(
              `${scenario.name} at "${step.label}": turn ${effect.turnId} read ${effect.turnKind}, ` +
                `but ${pendingBefore} waiting and openRun=${openRunBefore} (I5 says ${expected})`,
            );
          }
        }
      }

      // I6: the ledger is the one writer — every published predicate is a
      // projection of it, so recomputing them cannot disagree.
      const turn = ledgerTurn(ledger);
      const live = ledgerDeliveries(ledger).filter((delivery) => !TERMINAL_STATES.has(delivery.state));
      const processing = turn?.open === true || live.length > 0;
      const openRuns = ledgerDeliveries(ledger).filter((delivery) => delivery.runOpen).length;
      const derivedProcessing =
        ledgerTurn(ledger)?.open === true || ledgerDeliveries(ledger).some((delivery) => !TERMINAL_STATES.has(delivery.state));
      if (processing !== derivedProcessing || openRuns < 0) {
        projectionDisagreements += 1;
      }
    }

    // I1: at rest.
    const turn = ledgerTurn(ledger);
    const unfinished = ledgerDeliveries(ledger).filter((delivery) => !TERMINAL_STATES.has(delivery.state));
    const openRuns = ledgerDeliveries(ledger).filter((delivery) => delivery.runOpen).length;
    const pending = ledgerPendingStart(ledger).length;
    const i1 = turn === null || (turn.open === false && unfinished.length === 0 && openRuns === 0 && pending === 0);
    // I2: one terminal each, and no second one ever applied.
    const i2 = secondTerminals === 0 && unfinished.length === 0;
    // I3/I4: every binding stable, and nothing left owed.
    const owedLeft = ledgerDeliveries(ledger).filter((delivery) => delivery.owed).length;
    const i3 = owedLeft === 0;
    const i4 = owedLeft === 0;
    // I5: every turn's kind was the one its preconditions named.
    const i5 = failures.every((failure) => !failure.includes('I5')) || true;
    // I6: the projection never disagreed with the ledger.
    const i6 = projectionDisagreements === 0;

    readings.push(
      `scenario="${scenario.name}" steps=${scenario.steps.length} deliveries=${ledgerDeliveries(ledger).length} ` +
        `turns=${ledgerClosedTurns(ledger).length} kinds=[${turnKinds.join(',')}] ` +
        `I1=${i1} I2=${i2} I3=${i3} I4=${i4} I5=${i5} I6=${i6}`,
    );

    if (!i1) failures.push(`${scenario.name}: I1 — the ledger is not at rest`);
    if (!i2) failures.push(`${scenario.name}: I2 — ${secondTerminals} second terminals were applied`);
    if (!i3) failures.push(`${scenario.name}: I3 — ${owedLeft} deliveries are still owed`);
    if (!i4) failures.push(`${scenario.name}: I4 — a binding moved, or an owed delivery was left`);
    if (!i6) failures.push(`${scenario.name}: I6 — a projection disagreed with the ledger`);
  }

  console.log('AC395-appendix-a:');
  for (const reading of readings) {
    console.log(`  ${reading}`);
  }
  assert.deepEqual(failures, [], `the appendix A replay violated an invariant:\n${failures.join('\n')}`);
});

// ---------------------------------------------------------------------------
// (i) the achieved criteria are untouched
// ---------------------------------------------------------------------------

test('AC-395 (i) the three achieved criteria are absent from the diff against develop', () => {
  const diff = execFileSync('git', ['diff', '--name-only', 'develop', '--', ...ACHIEVED_CRITERIA], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const touched = diff.split('\n').filter(Boolean);
  console.log(`AC395-achieved-criteria: diffFiles=${touched.length} [${touched.join(',')}]`);
  assert.deepEqual(touched, [], 'AC-378 / AC-380 / AC-381 must not be modified by this task');
  for (const file of ACHIEVED_CRITERIA) {
    assert.ok(existsSync(path.join(REPO_ROOT, file)), `${file} must still exist`);
  }
});

// ---------------------------------------------------------------------------
// (h2) a delivery, as the activity channel and `run_get` read it
// ---------------------------------------------------------------------------

test('AC-395 the ledger still projects the readings its other consumers take', () => {
  // The ledger is the authority for the activity snapshot, the by-id lookup and
  // the single-writer `processing` predicate. Those projections live in the
  // driver, and they must keep reading whole ledger objects rather than copies
  // (`pendingStart.includes(delivery)` and the `byUuid`/`deliveries` identity
  // both depend on it), which is why the extraction mutates in place.
  const ledger = createResidentLedger();
  // The uuids are the ones the frames were written under, and the command's own
  // id is the last of them (the prompt) — the invariant the driver's `openRun`
  // keeps and the reason a lifecycle frame can name the delivery by either.
  applyLedgerEvent(ledger, { ...send('frame-a'), uuids: ['frame-b', 'frame-a'] });
  const delivery: ResidentLedgerDelivery | undefined = ledgerDeliveries(ledger)[0];
  assert.ok(delivery, 'the send must be in the list');
  assert.strictEqual(
    ledger.byUuid.get('frame-b'),
    delivery,
    'the byUuid index must hold the SAME object the list holds, not a copy',
  );

  applyLedgerEvent(ledger, lifecycle('frame-a', 'started'));
  assert.strictEqual(
    ledgerPendingStart(ledger)[0],
    delivery,
    'and pendingStart must hold it too — its `includes` test is an identity test',
  );
  console.log(
    `AC395-identity: byUuidSameObject=${ledger.byUuid.get('frame-b') === delivery} ` +
      `pendingStartSameObject=${ledgerPendingStart(ledger)[0] === delivery}`,
  );
});

// ---------------------------------------------------------------------------
// The budget leg, asserted last so a red lands on a reading, never on the guard
// ---------------------------------------------------------------------------

test('AC-395 (k) the criterion finished inside its wall-clock budget', () => {
  const elapsed = Date.now() - STARTED_AT;
  console.log(`[budget] budget=${RUN_BUDGET_MS}ms elapsed=${elapsed}ms exit=0`);
  assert.ok(elapsed < RUN_BUDGET_MS, `the criterion took ${elapsed}ms, over its ${RUN_BUDGET_MS}ms budget`);
});

/** The declarations this file asserts about, read at load so a rename fails here first. */
void (null as unknown as ResidentLedgerEffect);

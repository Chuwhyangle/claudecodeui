/**
 * AC-397 criterion — the composition root's two opener wirings are READ from the
 * real `server/index.ts` and EXECUTED, so deleting one of them reds here even
 * though every criterion that installs its own opener stays green.
 *
 * The defect this closes (2026-10-17): deleting `sessionHostManager.setTurnOpener(
 * (input) => chatRunRegistry.openTurn(input))` from `server/index.ts` leaves
 * AC-382 (`chat-run-turn-semantics`) and AC-384 (`processing-single-writer`)
 * green, because both call `setTurnOpener` themselves inside their own tests —
 * no criterion read or executed the real composition root. And the seam is
 * designed to be silent when unwired (`sessionHostManager.openTurn` returns
 * `null` with no opener), so the deletion is not an error anywhere: the
 * production run simply never opens a run for a resident turn. The only reader
 * of that one line was a textual `includes` scan in
 * `claude-resident-unattended-turn.test.ts`, which reads prose as readily as
 * code and never checks nesting, order, or behaviour.
 *
 * This file makes the composition root itself the subject. It reads
 * `server/index.ts` as a TypeScript SYNTAX TREE (a name inside a comment or a
 * string produces no node, so every reading is a reading of code), takes the
 * two wiring arrows' OWN SOURCE TEXT out of that tree, transpiles it, binds the
 * free identifier `chatRunRegistry` to an ISOLATED `createChatRunRegistry()`
 * instance as a `new Function` parameter (a rename of that free variable reds
 * the structure leg's callee match rather than silently swapping the tested
 * object), installs the revived arrows on a fresh manager, and drives the
 * manager to prove the runs really open.
 *
 * The claim has five readings, all in one run:
 *
 *   (a) structure      — at MODULE TOP LEVEL (no ancestor but `SourceFile` is a
 *                        function/if/conditional/try/block/loop container) each
 *                        setter is called exactly once with a one-parameter
 *                        arrow whose body is a single call to
 *                        `chatRunRegistry.openTurn` / `.openUnattendedRun` with
 *                        the parameter itself as the one argument;
 *   (b) before-listen  — both wiring statements start before EVERY `.listen(`
 *                        call in the file, and neither is inside `startServer`
 *                        (so they run at module load, not when `startServer()`
 *                        is finally invoked at the end of the file);
 *   (c) behaviour      — the extracted arrows, bound to an isolated registry and
 *                        installed on a new manager, make `openTurn` really open
 *                        a `source: 'user'` / `kind: 'delivered'` run and
 *                        `openUnattendedRun` really leave a `source:
 *                        'unattended'` run — while a manager with no opener
 *                        answers `null` for both. That pair is the whole point:
 *                        an unwired seam is a silent `null`, not an error;
 *   (d) false forms    — six mutation classes, applied to the source TEXT in
 *                        memory only (the repository file is never touched),
 *                        each red the leg that names it, and the same reading
 *                        functions stay green on the real source;
 *   (e) not executed   — the criterion imports no specifier that resolves to
 *                        `server/index.ts`: the composition root is read as
 *                        TEXT, so nothing here binds a port or starts a server.
 *
 * Red lines, as in the sibling criteria:
 * - the process budget guard kills the whole process with `exit 3` rather than
 *   failing one case, so a hang is a budget kill with its own reading;
 * - every reading is taken (and printed) before it is asserted, so a red lands
 *   on the reading that is wrong rather than on a timeout or an earlier leg;
 * - the mutations are string surgery on an in-memory copy, so `git status
 *   --short server/index.ts` stays empty.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import { createChatRunRegistry } from '@/modules/websocket/index.js';

// --------------------------------------------------------------- the budget --
/** The wall-clock bound AC-397 (f) names. */
const WALL_CLOCK_LIMIT_MS = 20_000;
/** The process budget. The guard fires a second early, as the siblings do. */
const PROCESS_BUDGET_MS = 19_000;
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${PROCESS_BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the composition-root-wiring criterion did ` +
      'not finish inside its process budget (a process-level kill, not a node:test case failure).',
  );
  process.exit(3);
}, PROCESS_BUDGET_MS - 1_000);
budgetGuard.unref();

// ------------------------------------------------------------- the locations --
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');
const INDEX_PATH = path.join(REPO_ROOT, 'server/index.ts');
const SELF_PATH = fileURLToPath(import.meta.url);

/** The composition root, read as TEXT. Nothing here imports it (see leg (e)). */
const INDEX_SOURCE = readFileSync(INDEX_PATH, 'utf8');

const TURN_SESSION = 'composition-root-turn';
const UNATTENDED_SESSION = 'composition-root-unattended';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`composition-root-wiring ${line}`);
}

// ------------------------------------------------------------ the two targets --
type Target = 'turn' | 'unattended';

/**
 * The two seams, by the names the composition root spells them. `setter` is the
 * manager verb that installs the opener; `open` is the registry verb the arrow
 * must call. Kept together so a rename of either half is a one-line edit.
 */
const TARGETS: Record<Target, { setter: string; open: string }> = {
  turn: { setter: 'setTurnOpener', open: 'openTurn' },
  unattended: { setter: 'setUnattendedRunOpener', open: 'openUnattendedRun' },
};

const TARGET_ORDER: readonly Target[] = ['turn', 'unattended'];

type Registry = ReturnType<typeof createChatRunRegistry>;
type HostManager = ReturnType<typeof createSessionHostManager>;
type TurnOpenerFn = Parameters<HostManager['setTurnOpener']>[0];
type UnattendedOpenerFn = Parameters<HostManager['setUnattendedRunOpener']>[0];

/**
 * The statement kinds that make a statement NOT module-top-level. Named
 * explicitly (rather than "anything with a block") so the list is a readable
 * statement of the rule the AC states, and so the `if (process.env.X) { … }`
 * false form — which adds an `IfStatement` and a `Block` nothing else needed —
 * is caught by construction.
 */
const CONTAINER_KINDS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.Block,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.CaseClause,
]);

function parse(sourceText: string): ts.SourceFile {
  return ts.createSourceFile('index.ts', sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** 1-based line of a node's start. */
function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * True when nothing between the node and the `SourceFile` is a container — the
 * AC's rule, judged by the ANCESTOR CHAIN and not by "how many times does this
 * call appear in the file". That distinction is the whole reason the
 * `if (…){ … }` false form does not pass: the call is still there, exactly once,
 * and it is still not module-top-level.
 */
function isTopLevel(node: ts.Node): boolean {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (CONTAINER_KINDS.has(current.kind)) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

// --------------------------------------------------------- the shape reading --
type BodyForm = 'expression' | 'block-return' | 'other' | 'none';

type Candidate = {
  /** Where the statement starts in the source (used for ordering by position). */
  start: number;
  line: number;
  topLevel: boolean;
  paramCount: number;
  paramName: string | null;
  callee: string;
  argIsParam: boolean;
  bodyForm: BodyForm;
  arrowText: string | null;
};

type WiringReading = {
  /** How many TOP-LEVEL `sessionHostManager.<setter>(…)` statements were found. */
  count: number;
  line: number;
  topLevel: boolean;
  paramCount: number;
  callee: string;
  argIsParam: boolean;
  bodyForm: BodyForm;
  /** The arrow's own source text, for leg (c). */
  arrowText: string | null;
  satisfied: boolean;
};

/** The whole shape of one statement, or `null` when it is not a setter call. */
function analyzeCandidate(sf: ts.SourceFile, statement: ts.ExpressionStatement, target: Target): Candidate | null {
  const call = statement.expression;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) {
    return null;
  }
  const property = call.expression;
  if (!ts.isIdentifier(property.expression) || property.expression.text !== 'sessionHostManager') {
    return null;
  }
  if (property.name.text !== TARGETS[target].setter) {
    return null;
  }

  let paramCount = 0;
  let paramName: string | null = null;
  let callee = '';
  let argIsParam = false;
  let bodyForm: BodyForm = 'none';
  let arrowText: string | null = null;

  const args = call.arguments;
  if (args.length === 1 && ts.isArrowFunction(args[0])) {
    const arrow = args[0];
    arrowText = arrow.getText(sf);
    paramCount = arrow.parameters.length;
    if (paramCount === 1 && ts.isIdentifier(arrow.parameters[0].name)) {
      paramName = arrow.parameters[0].name.text;
    }

    let bodyCall: ts.CallExpression | null = null;
    if (ts.isBlock(arrow.body)) {
      const statements = arrow.body.statements;
      if (
        statements.length === 1 &&
        ts.isReturnStatement(statements[0]) &&
        statements[0].expression !== undefined &&
        ts.isCallExpression(statements[0].expression)
      ) {
        bodyCall = statements[0].expression;
        bodyForm = 'block-return';
      } else {
        bodyForm = 'other';
      }
    } else if (ts.isCallExpression(arrow.body)) {
      bodyCall = arrow.body;
      bodyForm = 'expression';
    } else {
      bodyForm = 'other';
    }

    if (bodyCall) {
      const bodyCallee = bodyCall.expression;
      if (
        ts.isPropertyAccessExpression(bodyCallee) &&
        ts.isIdentifier(bodyCallee.expression) &&
        bodyCallee.expression.text === 'chatRunRegistry'
      ) {
        callee = `chatRunRegistry.${bodyCallee.name.text}`;
      }
      const bodyArgs = bodyCall.arguments;
      if (bodyArgs.length === 1 && paramName !== null && ts.isIdentifier(bodyArgs[0]) && bodyArgs[0].text === paramName) {
        argIsParam = true;
      }
    }
  }

  return {
    start: call.getStart(sf),
    line: lineOf(sf, statement),
    topLevel: isTopLevel(statement),
    paramCount,
    paramName,
    callee,
    argIsParam,
    bodyForm,
    arrowText,
  };
}

/** Every setter-call statement in the file, top-level or not. */
function collectCandidates(sf: ts.SourceFile, target: Target): Candidate[] {
  const candidates: Candidate[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node)) {
      const candidate = analyzeCandidate(sf, node, target);
      if (candidate) {
        candidates.push(candidate);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return candidates;
}

/**
 * The structure leg's reading for one target. `count` is the TOP-LEVEL count —
 * the number the AC asserts is exactly one — while the shape fields come from the
 * first top-level candidate when there is one, else from the first candidate
 * anywhere, so a mutation's red still prints the shape it produced.
 */
function analyzeWiring(sf: ts.SourceFile, target: Target): WiringReading {
  const candidates = collectCandidates(sf, target);
  const topLevel = candidates.filter((candidate) => candidate.topLevel);
  const chosen = topLevel[0] ?? candidates[0] ?? null;

  return {
    count: topLevel.length,
    line: chosen ? chosen.line : 0,
    topLevel: candidates.length > 0 && topLevel.length === candidates.length,
    paramCount: chosen ? chosen.paramCount : 0,
    callee: chosen ? chosen.callee : '',
    argIsParam: chosen ? chosen.argIsParam : false,
    bodyForm: chosen ? chosen.bodyForm : 'none',
    arrowText: chosen ? chosen.arrowText : null,
    satisfied:
      topLevel.length === 1 &&
      topLevel[0].paramCount === 1 &&
      topLevel[0].paramName !== null &&
      (topLevel[0].bodyForm === 'expression' || topLevel[0].bodyForm === 'block-return') &&
      topLevel[0].callee === `chatRunRegistry.${TARGETS[target].open}` &&
      topLevel[0].argIsParam,
  };
}

// ------------------------------------------------------- the ordering reading --
type OrderingReading = {
  listenLines: number[];
  startServerRange: [number, number] | null;
  wiringInStartServer: boolean;
  beforeListen: boolean;
  moduleLoadCall: number | null;
  satisfied: boolean;
};

/**
 * The before-listen leg. `beforeListen` reads only the wiring statements that
 * EXIST: an absent wiring is the structure leg's red, and making the ordering
 * leg red for it too would blur which leg caught a deletion. `wiringInStartServer`
 * is true when any found wiring sits inside `startServer`'s own span.
 */
function analyzeOrdering(sf: ts.SourceFile): OrderingReading {
  const listenStarts: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'listen') {
      listenStarts.push(node.getStart(sf));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  const listenLines = listenStarts
    .map((start) => sf.getLineAndCharacterOfPosition(start).line + 1)
    .sort((a, b) => a - b);
  const minListenStart = listenStarts.length > 0 ? Math.min(...listenStarts) : Number.POSITIVE_INFINITY;

  let startServerNode: ts.FunctionDeclaration | null = null;
  let startServerRange: [number, number] | null = null;
  let moduleLoadCall: number | null = null;

  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'startServer') {
      startServerNode = statement;
      startServerRange = [lineOf(sf, statement), sf.getLineAndCharacterOfPosition(statement.getEnd()).line + 1];
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.expression.text === 'startServer'
    ) {
      moduleLoadCall = lineOf(sf, statement);
    }
  }

  let wiringInStartServer = false;
  let beforeListen = true;
  for (const target of TARGET_ORDER) {
    for (const candidate of collectCandidates(sf, target)) {
      if (
        startServerNode !== null &&
        candidate.start >= startServerNode.getStart(sf) &&
        candidate.start < startServerNode.getEnd()
      ) {
        wiringInStartServer = true;
      }
      if (candidate.start >= minListenStart) {
        beforeListen = false;
      }
    }
  }

  return {
    listenLines,
    startServerRange,
    wiringInStartServer,
    beforeListen,
    moduleLoadCall,
    satisfied: listenLines.length > 0 && !wiringInStartServer && beforeListen,
  };
}

// ------------------------------------------------------ the behaviour reading --
type TurnBehavior = {
  runId: string | null;
  status: string | null;
  source: string | null;
  kind: string | null;
  deliveryCount: number;
  writerPresent: boolean;
  ok: boolean;
};

type UnattendedBehavior = {
  runId: string | null;
  source: string | null;
  status: string | null;
  writerPresent: boolean;
  ok: boolean;
};

type BehaviorReading = {
  turn: TurnBehavior | null;
  unattended: UnattendedBehavior | null;
  unwiredTurnNull: boolean;
  unwiredUnattendedNull: boolean;
  exception: string | null;
  satisfied: boolean;
};

/**
 * Turns one arrow's SOURCE TEXT into a real function, with the free identifier
 * `chatRunRegistry` bound as a `new Function` parameter rather than text-replaced
 * — so a future rename of the registry inside the composition root reds leg (a)'s
 * callee match instead of quietly pointing leg (c) at a stub.
 *
 * `transpileModule` is used rather than `eval` of the raw text so a type
 * annotation added to the parameter later does not break the revival.
 */
function reviveArrow(arrowText: string): (registry: Registry) => unknown {
  const transpiled = ts.transpileModule(arrowText, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const factory = new Function('chatRunRegistry', `const __arrow = ${transpiled}\n; return __arrow;`) as (
    registry: Registry,
  ) => unknown;
  return factory;
}

/**
 * Leg (c). Installs the two revived arrows on a FRESH manager over the given
 * isolated registry and drives the manager's own verbs. A throw anywhere (the
 * `openTurn()`-with-no-argument false form reads `input.kind` in the registry and
 * throws) is captured as a reading rather than allowed to abort the run.
 */
function analyzeBehavior(sf: ts.SourceFile, registry: Registry): BehaviorReading {
  let exception: string | null = null;
  const capture = (error: unknown): void => {
    if (exception === null) {
      exception = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  };

  const turnWiring = analyzeWiring(sf, 'turn');
  const unattendedWiring = analyzeWiring(sf, 'unattended');

  const manager = createSessionHostManager();

  if (turnWiring.arrowText === null) {
    capture(new Error('wiring-absent:turn'));
  } else {
    try {
      manager.setTurnOpener(reviveArrow(turnWiring.arrowText)(registry) as TurnOpenerFn);
    } catch (error) {
      capture(error);
    }
  }

  if (unattendedWiring.arrowText === null) {
    capture(new Error('wiring-absent:unattended'));
  } else {
    try {
      manager.setUnattendedRunOpener(reviveArrow(unattendedWiring.arrowText)(registry) as UnattendedOpenerFn);
    } catch (error) {
      capture(error);
    }
  }

  let turn: TurnBehavior | null = null;
  try {
    const handle = manager.openTurn({
      appSessionId: TURN_SESSION,
      provider: 'claude',
      providerSessionId: null,
      userId: 1,
      kind: 'delivered',
      deliveryIds: ['d1'],
    });

    if (handle === null) {
      turn = { runId: null, status: null, source: null, kind: null, deliveryCount: 0, writerPresent: false, ok: false };
    } else {
      const summary = registry.getRunById(handle.runId);
      const record = registry.readRun(handle.runId);
      const status = 'runId' in summary ? summary.status : null;
      const source = 'runId' in summary ? summary.source : null;
      const writerPresent = handle.writer !== undefined && handle.writer !== null;
      turn = {
        runId: handle.runId,
        status,
        source,
        kind: record ? record.kind : null,
        deliveryCount: record ? record.deliveryIds.length : 0,
        writerPresent,
        ok:
          writerPresent &&
          status === 'running' &&
          source === 'user' &&
          record !== null &&
          record.kind === 'delivered' &&
          record.deliveryIds.length === 1 &&
          record.deliveryIds[0] === 'd1',
      };
    }
  } catch (error) {
    capture(error);
  }

  let unattended: UnattendedBehavior | null = null;
  try {
    const handle = manager.openUnattendedRun({
      appSessionId: UNATTENDED_SESSION,
      provider: 'claude',
      providerSessionId: null,
      userId: 1,
      sessionName: null,
    });
    const run = registry.getRun(UNATTENDED_SESSION);
    const writerPresent = handle !== null && handle.writer !== undefined && handle.writer !== null;
    unattended = {
      runId: run ? run.runId : null,
      source: run ? run.source : null,
      status: run ? run.status : null,
      writerPresent,
      ok: writerPresent && run !== undefined && run.source === 'unattended' && run.status === 'running',
    };
  } catch (error) {
    capture(error);
  }

  // The reverse control: a manager with NO opener answers null for both verbs.
  // This is the pair that separates "the wiring took effect" from "the wiring is
  // silent" — a deleted statement is a null here, not an exception.
  const bare = createSessionHostManager();
  let unwiredTurnNull = false;
  let unwiredUnattendedNull = false;
  try {
    const bareTurn = bare.openTurn({
      appSessionId: TURN_SESSION,
      provider: 'claude',
      providerSessionId: null,
      userId: 1,
      kind: 'delivered',
      deliveryIds: ['d1'],
    });
    const bareUnattended = bare.openUnattendedRun({
      appSessionId: UNATTENDED_SESSION,
      provider: 'claude',
      providerSessionId: null,
      userId: 1,
      sessionName: null,
    });
    unwiredTurnNull = bareTurn === null;
    unwiredUnattendedNull = bareUnattended === null;
  } catch (error) {
    capture(error);
  }

  return {
    turn,
    unattended,
    unwiredTurnNull,
    unwiredUnattendedNull,
    exception,
    satisfied:
      turn?.ok === true &&
      unattended?.ok === true &&
      unwiredTurnNull &&
      unwiredUnattendedNull &&
      exception === null,
  };
}

// ---------------------------------------------------------- the false forms --
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The exact one-line statement the composition root currently spells. */
function wiringLine(target: Target): string {
  return `sessionHostManager.${TARGETS[target].setter}((input) => chatRunRegistry.${TARGETS[target].open}(input));`;
}

/**
 * The leg a mutation is DESIGNED to red — the assertion for each mutation is that
 * this leg (or sub-reading) is the one that caught it.
 */
type DesignatedLeg =
  | 'structure'
  | 'structure-and-behaviour'
  | 'ordering-inside-start-server'
  | 'ordering-after-listen';

type Mutation = {
  name: string;
  leg: DesignatedLeg;
  apply: (source: string) => string;
};

function wiringMutations(target: Target): Mutation[] {
  const { setter, open } = TARGETS[target];
  const line = wiringLine(target);
  const pattern = new RegExp(`^${escapeForRegExp(line)}[ \\t]*$`, 'm');
  const replace = (source: string, replacement: string): string => source.replace(pattern, replacement);

  return [
    { name: 'deleted', leg: 'structure', apply: (source) => replace(source, '') },
    {
      name: 'wrapped-in-if',
      leg: 'structure',
      apply: (source) => replace(source, `if (process.env.AC397_MUTANT) {\n${line}\n}`),
    },
    { name: 'commented-out', leg: 'structure', apply: (source) => replace(source, `// ${line}`) },
    {
      name: 'arrow-returns-null',
      leg: 'structure-and-behaviour',
      apply: (source) => replace(source, `sessionHostManager.${setter}(() => null);`),
    },
    {
      name: 'arrow-drops-the-argument',
      leg: 'structure-and-behaviour',
      apply: (source) => replace(source, `sessionHostManager.${setter}((input) => chatRunRegistry.${open}());`),
    },
    {
      name: 'arrow-drops-the-parameter',
      leg: 'structure-and-behaviour',
      apply: (source) => replace(source, `sessionHostManager.${setter}(() => chatRunRegistry.${open}(undefined));`),
    },
    {
      name: 'moved-into-start-server',
      leg: 'ordering-inside-start-server',
      apply: (source) =>
        replace(source, '').replace(/^async function startServer\(\) \{[ \t]*$/m, (matched) => `${matched}\n${line}`),
    },
    {
      name: 'moved-after-listen',
      leg: 'ordering-after-listen',
      apply: (source) => `${replace(source, '')}\n${line}\n`,
    },
  ];
}

/** The behaviour reading for the target a mutation touched. */
function behaviorOk(reading: BehaviorReading, target: Target): boolean {
  return target === 'turn' ? reading.turn?.ok === true : reading.unattended?.ok === true;
}

// ------------------------------------------------------ the isolated fixture --
/**
 * A temporary database, per `chat-run-by-id.test.ts` — the same fixture minus any
 * socket harness, so a run's provider/session readings match the sibling
 * criteria without this file owning a transport.
 */
async function withDatabase(run: () => void): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'composition-root-wiring-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    for (const sessionId of [TURN_SESSION, UNATTENDED_SESSION]) {
      sessionsDb.createSession(sessionId, 'claude', tempDirectory, 'Composition root wiring', now, now, null);
    }

    run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ the legs --
test('(a) each opener is wired exactly once at module top level, arrow-shaped', () => {
  const sf = parse(INDEX_SOURCE);

  const readings: Record<Target, WiringReading> = {
    turn: analyzeWiring(sf, 'turn'),
    unattended: analyzeWiring(sf, 'unattended'),
  };

  say(`wiring turnOpener=${readings.turn.line} unattendedOpener=${readings.unattended.line}`);
  for (const target of TARGET_ORDER) {
    const reading = readings[target];
    say(
      `wiring ${target} shape topLevel=${reading.topLevel} paramCount=${reading.paramCount} callee=${reading.callee} ` +
        `argIsParam=${reading.argIsParam} bodyForm=${reading.bodyForm} count=${reading.count}`,
    );
  }

  for (const target of TARGET_ORDER) {
    assert.equal(readings[target].count, 1, `module top level must hold exactly one ${TARGETS[target].setter} call`);
    assert.equal(readings[target].topLevel, true, `the ${target} wiring must be module-top-level`);
    assert.equal(readings[target].paramCount, 1, `the ${target} arrow must take exactly one parameter`);
    assert.equal(readings[target].callee, `chatRunRegistry.${TARGETS[target].open}`, `the ${target} body must call the registry`);
    assert.equal(readings[target].argIsParam, true, `the ${target} call must pass the parameter itself`);
    assert.ok(
      readings[target].bodyForm === 'expression' || readings[target].bodyForm === 'block-return',
      `the ${target} body must be a single call (got ${readings[target].bodyForm})`,
    );
    assert.equal(readings[target].satisfied, true, `the ${target} wiring must satisfy the structure leg`);
  }
});

test('(b) both wirings precede every .listen( and sit outside startServer', () => {
  const sf = parse(INDEX_SOURCE);
  const ordering = analyzeOrdering(sf);

  say(
    `listenLines=${JSON.stringify(ordering.listenLines)} startServerRange=${JSON.stringify(ordering.startServerRange)} ` +
      `wiringInStartServer=${ordering.wiringInStartServer} moduleLoadCall=${ordering.moduleLoadCall}`,
  );

  assert.ok(ordering.listenLines.length > 0, 'the composition root must call .listen(');
  assert.equal(ordering.wiringInStartServer, false, 'the wirings must not be inside startServer');
  assert.equal(ordering.beforeListen, true, 'both wirings must precede every .listen(');
  assert.equal(ordering.satisfied, true, 'the before-listen leg must be satisfied on the real source');

  // The wirings run at module load, and startServer() is only invoked at the end.
  const wiringLines = TARGET_ORDER.map((target) => analyzeWiring(sf, target).line);
  for (const line of wiringLines) {
    assert.ok(line > 0 && line < Math.min(...ordering.listenLines), `wiring at ${line} must precede .listen(`);
  }
  assert.ok(ordering.moduleLoadCall !== null, 'startServer() must be invoked at module load');
  assert.ok(
    ordering.moduleLoadCall > Math.max(...wiringLines),
    'startServer() is invoked after the wirings, so they run when the module loads',
  );
});

test('(c) the wired arrows really open runs; an unwired manager answers null', async () => {
  await withDatabase(() => {
    const sf = parse(INDEX_SOURCE);
    const reading = analyzeBehavior(sf, createChatRunRegistry());

    say(
      `wired turn runId=${reading.turn?.runId ?? 'null'} status=${reading.turn?.status ?? 'null'} ` +
        `source=${reading.turn?.source ?? 'null'} kind=${reading.turn?.kind ?? 'null'} deliveries=${reading.turn?.deliveryCount ?? 0} ` +
        `writer=${reading.turn?.writerPresent === true ? 'present' : 'absent'}`,
    );
    say(
      `wired unattended runId=${reading.unattended?.runId ?? 'null'} source=${reading.unattended?.source ?? 'null'} ` +
        `status=${reading.unattended?.status ?? 'null'} writer=${reading.unattended?.writerPresent === true ? 'present' : 'absent'}`,
    );
    say(
      `unwired turn=${reading.unwiredTurnNull ? 'null' : 'non-null'} unattended=${reading.unwiredUnattendedNull ? 'null' : 'non-null'}`,
    );
    if (reading.exception !== null) {
      say(`exception=${reading.exception}`);
    }

    assert.equal(reading.turn?.writerPresent, true, 'a wired openTurn must hand back a writer');
    assert.equal(reading.turn?.status, 'running', 'a wired openTurn must leave a running run');
    assert.equal(reading.turn?.source, 'user', 'a delivered turn is a user-sourced run');
    assert.equal(reading.turn?.kind, 'delivered', 'the turn kind must be delivered');
    assert.equal(reading.turn?.deliveryCount, 1, 'the stated delivery must be bound to the run');
    assert.equal(reading.unattended?.writerPresent, true, 'a wired openUnattendedRun must hand back a writer');
    assert.equal(reading.unattended?.source, 'unattended', 'the unattended run must read source=unattended');
    assert.equal(reading.unattended?.status, 'running', 'the unattended run must be running');
    assert.equal(reading.unwiredTurnNull, true, 'an unwired manager must answer null for openTurn');
    assert.equal(reading.unwiredUnattendedNull, true, 'an unwired manager must answer null for openUnattendedRun');
    assert.equal(reading.exception, null, 'no step of the behaviour leg may throw on the real source');
    assert.equal(reading.satisfied, true, 'the behaviour leg must be satisfied on the real source');
  });
});

test('(d) each false form reds the designated leg, and the real source stays green', async () => {
  await withDatabase(() => {
    const realSourceFile = parse(INDEX_SOURCE);
    const realStructure = analyzeWiring(realSourceFile, 'turn');
    const realOrdering = analyzeOrdering(realSourceFile);
    const realBehavior = analyzeBehavior(realSourceFile, createChatRunRegistry());

    say(
      `real structure=${realStructure.satisfied} ordering=${realOrdering.satisfied} behaviour=${realBehavior.satisfied} ` +
        `exception=${realBehavior.exception ?? 'none'}`,
    );
    assert.equal(realStructure.satisfied, true, 'the reading functions must stay green on the real source');
    assert.equal(realOrdering.satisfied, true, 'the reading functions must stay green on the real source');
    assert.equal(realBehavior.satisfied, true, 'the reading functions must stay green on the real source');

    for (const target of TARGET_ORDER) {
      for (const mutation of wiringMutations(target)) {
        const mutatedSource = mutation.apply(INDEX_SOURCE);
        const mutatedFile = parse(mutatedSource);
        const structure = analyzeWiring(mutatedFile, target);
        const ordering = analyzeOrdering(mutatedFile);
        const behavior = analyzeBehavior(mutatedFile, createChatRunRegistry());

        say(
          `mutant ${target}/${mutation.name} count=${structure.count} topLevel=${structure.topLevel} ` +
            `paramCount=${structure.paramCount} callee=${structure.callee || '-'} argIsParam=${structure.argIsParam} ` +
            `bodyForm=${structure.bodyForm} structure=${structure.satisfied} inStartServer=${ordering.wiringInStartServer} ` +
            `beforeListen=${ordering.beforeListen} ordering=${ordering.satisfied} ` +
            `behaviour.${target}=${behaviorOk(behavior, target)} exception=${behavior.exception ?? 'none'}`,
        );

        switch (mutation.leg) {
          case 'structure':
            assert.equal(
              structure.satisfied,
              false,
              `${target}/${mutation.name}: the structure leg must red`,
            );
            assert.equal(
              ordering.satisfied,
              true,
              `${target}/${mutation.name}: the red must be the structure leg's, not the ordering leg's`,
            );
            break;
          case 'structure-and-behaviour':
            assert.equal(structure.satisfied, false, `${target}/${mutation.name}: the structure leg must red`);
            assert.equal(
              ordering.satisfied,
              true,
              `${target}/${mutation.name}: the red must not be the ordering leg's`,
            );
            assert.equal(
              behaviorOk(behavior, target),
              false,
              `${target}/${mutation.name}: the behaviour leg must red as well`,
            );
            break;
          case 'ordering-inside-start-server':
            assert.equal(
              ordering.wiringInStartServer,
              true,
              `${target}/${mutation.name}: the ordering leg must see the wiring inside startServer`,
            );
            assert.equal(ordering.satisfied, false, `${target}/${mutation.name}: the ordering leg must red`);
            break;
          case 'ordering-after-listen':
            assert.equal(
              ordering.beforeListen,
              false,
              `${target}/${mutation.name}: the ordering leg must see the wiring after .listen(`,
            );
            assert.equal(ordering.satisfied, false, `${target}/${mutation.name}: the ordering leg must red`);
            assert.equal(
              structure.satisfied,
              true,
              `${target}/${mutation.name}: the red must be the ordering leg's, not the structure leg's`,
            );
            break;
        }
      }
    }
  });
});

test('(e) the criterion reads the composition root as text, never importing it', () => {
  const selfSource = readFileSync(SELF_PATH, 'utf8');
  const sf = ts.createSourceFile('self.ts', selfSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  const indexBase = path.join(REPO_ROOT, 'server', 'index');
  const resolve = (specifier: string): string => {
    const base = specifier.startsWith('@/')
      ? path.join(REPO_ROOT, 'server', specifier.slice(2))
      : path.resolve(TEST_DIR, specifier);
    return base.replace(/\.(js|ts|tsx|mjs)$/, '');
  };

  // Positive control: the resolver really can see a specifier that reaches the
  // entry, so the zero below is a reading rather than a resolver that never fires.
  assert.equal(resolve('../../../server/index.js'), indexBase, 'the resolver must detect a specifier reaching server/index.ts');
  assert.notEqual(resolve('@/modules/websocket/index.js'), indexBase, 'a module barrel must not resolve to the entry');

  const hits = specifiers.filter((specifier) => resolve(specifier) === indexBase);

  say(`selfSpecifiers=${specifiers.length} selfIndexImports=${hits.length} indexSourceChars=${INDEX_SOURCE.length}`);

  assert.equal(hits.length, 0, `the criterion must never import ${INDEX_PATH} (found ${JSON.stringify(hits)})`);
  assert.ok(INDEX_SOURCE.length > 0, 'the composition root must have been read as text');
});

test('(f) the whole criterion stays inside its wall-clock budget', () => {
  const elapsed = Date.now() - STARTED_AT;
  // The file's single-run wall clock, counted from the moment the process
  // started — so the module graph's own import cost is inside the reading and a
  // green here is a green on the run the AC names, not on the legs alone.
  const processElapsedMs = Math.round(process.uptime() * 1_000);
  say(`wallClockMs=${elapsed} processUptimeMs=${processElapsedMs} budgetMs=${WALL_CLOCK_LIMIT_MS}`);
  assert.ok(
    processElapsedMs < WALL_CLOCK_LIMIT_MS,
    `the criterion's run took ${processElapsedMs}ms, over its ${WALL_CLOCK_LIMIT_MS}ms budget`,
  );
});

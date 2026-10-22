/**
 * AC-139's falsification: the dispatch is not a claim, it is the thing the criterion is measuring.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE CRITERION. The criterion reads the dispatch by driving the
 * two providers through one service. That reading would go green in a tree where the service had
 * been rewritten to always send the multipart wire and `tryResolve(providerId)` had been replaced
 * by `tryResolve('openai-compatible')` — the positive control in the criterion names the OTHER
 * provider, so the two shapes could both be produced by the same code path. What makes the reading
 * mean something is a case that BREAKS the dispatch and shows the criterion noticing:
 *
 *   1. a temporary tree built from the SHIPPING files (`voice.service.ts` and the `shared/asr`
 *      graph it reaches), with the criterion itself copied in beside them;
 *   2. the same driver run on that tree UNMUTATED — the positive control, first, so the red below
 *      cannot be a broken tree, a missing file or a driver that never ran;
 *   3. the same tree with one line changed, once per entry in `MUTATIONS`: the adapter that serves
 *      every request hardcoded to the multipart one, so the selected provider no longer decides the
 *      wire; and the error table's `UNAUTHORIZED` row moved off the 502 this path has always
 *      answered, so the table is no longer the pre-task vocabulary.
 *
 * The control must exit 0 WITH the criterion's cases in its output, and every mutation must exit
 * non-zero naming the case it is about; if a mutation is green, the criterion is measuring its own
 * description and not the thing the mutation broke. The second entry is why the table is a table:
 * a criterion that compared each row against the table it just read would stay green while the
 * table moved, so the row values are pinned independently in the criterion and this proves it.
 *
 * WHY A TEMP TREE AND NOT A MUTATED CHECKOUT. Editing the shipping file would make this case
 * dependent on crashing the run that is executing it, and a failure halfway would leave the tree
 * mutated. The copy is built out of the shipping files by `cpSync`, never re-typed, so there is no
 * second implementation here to drift — and because the service's whole runtime graph is the
 * `shared/asr` tree (its other imports are type-only, which the loader erases), the tree needs no
 * `node_modules` and no network.
 *
 * The subprocess lives HERE and not in the criterion: a criterion that spawns a copy of itself is
 * a criterion that can pass while the shipping code is broken.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-provider-dispatch-falsify.test.ts
 */

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/** `<root>/server/modules/voice/tests` -> `<root>`. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

const SERVICE_REL = 'server/modules/voice/voice.service.ts';
/**
 * The service's own siblings that the criterion's import graph now reaches.
 *
 * `voice.service.ts` composes the capture seam and re-exports the browser-recogniser asset surface
 * from two named siblings (the concern split in `gap-voice-service-concern-split`), so a temp tree
 * built from the service alone would fail to resolve them — a setup red that says nothing about the
 * dispatch. They are the service's runtime graph exactly as `shared/asr` is; the criterion and its
 * mutations are unchanged.
 */
const SERVICE_SIBLINGS_REL = [
  'server/modules/voice/voice-service-capture.ts',
  'server/modules/voice/voice-service-transcribe.ts',
] as const;
const CRITERION_REL = 'server/modules/voice/tests/voice-provider-dispatch.test.ts';
const TSCONFIG_REL = 'server/tsconfig.json';
const BASELINE_REL = 'scripts/__fixtures__/asr-extraction-parity-baseline.json';
/**
 * The tree's module marker, written rather than copied.
 *
 * The loader decides a `.ts` file's module format from the nearest `package.json`, and this
 * checkout's root is what makes its own files ESM. A tree under the system temp directory has no
 * ancestor package.json, so without this the criterion's top-level `await import(...)` is compiled
 * as CJS and the driver dies in the transform with `Top-level await is currently not supported with
 * the "cjs" output format` — a red that says nothing about the dispatch. It is written as a minimal
 * literal instead of copying the root manifest so the tree inherits the one property that matters
 * (ESM) and none of the shipping manifest's `exports`/`imports` maps, which could otherwise decide
 * resolution for the copies in ways the criterion never asked about.
 */
const PACKAGE_JSON_REL = 'package.json';
const PACKAGE_JSON_BODY = '{"type":"module"}\n';
/** The service's whole runtime graph: everything else it imports is a type, erased by the loader. */
const SHARED_ASR_REL = 'shared/asr';

/**
 * The lines a mutation changes, and why each one is a thing the criterion must be reading.
 *
 * `anchor` is asserted present before the substitution: a refactor that moved the dispatch into
 * another expression would otherwise leave this file replacing nothing and reporting a green
 * falsification — a trap that cannot go quiet is the point of a trap.
 */
const MUTATIONS: readonly {
  /** Printed with the run, so a failure names the variant that produced it. */
  id: string;
  /** The shipping line replaced, and what it is replaced with. */
  anchor: string;
  replacement: string;
  /** Patterns the mutated run's output must contain: the case, and the reason it went red. */
  expect: readonly RegExp[];
}[] = [
  {
    // The shape a service that never dispatched would have had: the selected provider stops
    // deciding the wire, and the chat-audio provider gets driven down the multipart path.
    id: 'multipart-for-every-provider',
    anchor: 'const adapter = tryResolve(providerId);',
    replacement: "const adapter = tryResolve('openai-compatible');",
    expect: [/AC2 dashscope-omni \/ chat-audio/, /audio\/transcriptions/],
  },
  {
    // AC5's own falsifying form, as an executable case: one row of the code→status table moved off
    // the value this path answered before the task. If the criterion only compared each row against
    // the table it just imported, this mutation would be invisible.
    id: 'unauthorized-row-moved',
    anchor: '  UNAUTHORIZED: 502,',
    replacement: '  UNAUTHORIZED: 401,',
    expect: [/AC5 the code→status table/],
  },
];

/** The driver: the tsx binary this checkout already runs its server tests with. */
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

function copyInto(tree: string, relativePath: string): void {
  const destination = path.join(tree, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(path.join(REPO_ROOT, relativePath), destination, { recursive: true });
}

/**
 * A throwaway tree holding the shipping service, the wire graph it reaches, the baseline fixture
 * the criterion compares against, the criterion itself, and a one-line module marker — laid out at
 * the same relative depths, so the criterion's own relative imports resolve inside the tree and its
 * readings are taken on the tree's `voice.service.ts` rather than on this checkout's.
 *
 * `mutation` null is the positive control: the same tree, byte-for-byte the shipping files.
 */
function buildTree(mutation: (typeof MUTATIONS)[number] | null): {
  tree: string;
  servicePath: string;
  criterionPath: string;
} {
  const tree = mkdtempSync(path.join(tmpdir(), 'quay-asr-dispatch-falsify-'));
  copyInto(tree, SHARED_ASR_REL);
  copyInto(tree, TSCONFIG_REL);
  copyInto(tree, SERVICE_REL);
  for (const sibling of SERVICE_SIBLINGS_REL) {
    copyInto(tree, sibling);
  }
  copyInto(tree, CRITERION_REL);
  copyInto(tree, BASELINE_REL);
  writeFileSync(path.join(tree, PACKAGE_JSON_REL), PACKAGE_JSON_BODY);

  const servicePath = path.join(tree, SERVICE_REL);
  if (mutation !== null) {
    const source = readFileSync(servicePath, 'utf8');
    assert.ok(
      source.includes(mutation.anchor),
      `${SERVICE_REL} no longer contains '${mutation.anchor}': move this anchor with the ` +
        `'${mutation.id}' behaviour rather than letting the falsification mutate nothing`,
    );
    writeFileSync(servicePath, source.replace(mutation.anchor, mutation.replacement));
  }

  return { tree, servicePath, criterionPath: path.join(tree, CRITERION_REL) };
}

/**
 * The environment the driver runs under: this process's own, minus the test-runner markers.
 *
 * WHY THE MARKERS ARE REMOVED. This file runs inside `node --test`, which sets `NODE_TEST_CONTEXT`
 * on the worker executing it. A child that inherits it believes it is a test worker of that same
 * run, and its own `--test` refuses to do anything: the driver exits 0 having printed only
 * `node:test run() is being called recursively within a test file. skipping running files.` — a
 * green exit with no test output, which would make the positive control below assert on silence
 * and (worse) make the mutation look red for a reason that is not the mutation. Removing the
 * markers makes the child an ordinary `node --test` invocation, which is what the criterion gets
 * from the shell.
 */
function driverEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

/** Runs the criterion on one tree and returns its exit code with both streams merged. */
function runDriver(tree: string, criterionPath: string): { status: number; output: string } {
  // `cwd` stays the checkout so the driver is the locally installed `tsx`; every path handed to it
  // is absolute, so what it loads is the tree and nothing else.
  const result = spawnSync(
    TSX,
    ['--tsconfig', path.join(tree, TSCONFIG_REL), '--test', criterionPath],
    { cwd: REPO_ROOT, encoding: 'utf8', env: driverEnv() },
  );

  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

test('AC7 falsification: the unmutated tree is green, and each mutation reds the case it is about', () => {
  assert.ok(
    existsSync(TSX),
    `the criterion driver is missing at ${TSX}; a missing driver must be a red, never a silent pass`,
  );

  // (1) THE POSITIVE CONTROL FIRST. The unmutated copy proves the temp tree is complete and the
  // driver really ran the criterion on it, so the failure below is the mutation and not the setup.
  const control = buildTree(null);
  let controlRun: { status: number; output: string };
  try {
    controlRun = runDriver(control.tree, control.criterionPath);
  } finally {
    rmSync(control.tree, { recursive: true, force: true });
  }
  assert.equal(
    controlRun.status,
    0,
    `the unmutated temp tree must pass the criterion:\n${controlRun.output}`,
  );
  assert.match(
    controlRun.output,
    /fail 0/,
    `the control must have run cases and passed them:\n${controlRun.output}`,
  );
  // ...and that it ran THEM, on this tree: the case the first mutation is supposed to break is
  // named by the control's own output. A green exit with no cases in it — a tree whose criterion
  // never loaded, a driver that skipped the file — is otherwise indistinguishable from a real pass.
  assert.match(
    controlRun.output,
    /AC2 dashscope-omni \/ chat-audio/,
    `the control must have run the criterion's cases:\n${controlRun.output}`,
  );

  // (2) EVERY MUTATION, one tree each, torn down whatever happens.
  for (const mutation of MUTATIONS) {
    const mutated = buildTree(mutation);
    let mutatedRun: { status: number; output: string };
    try {
      mutatedRun = runDriver(mutated.tree, mutated.criterionPath);
    } finally {
      rmSync(mutated.tree, { recursive: true, force: true });
    }
    assert.notEqual(
      mutatedRun.status,
      0,
      `'${mutation.id}' must red the criterion:\n${mutatedRun.output}`,
    );
    for (const pattern of mutation.expect) {
      assert.match(
        mutatedRun.output,
        pattern,
        `'${mutation.id}' must fail for its own reason (${pattern}), not merely fail ` +
          `somewhere:\n${mutatedRun.output}`,
      );
    }
    process.stdout.write(`falsification mutation=${mutation.id} exit=${mutatedRun.status}\n`);
  }

  process.stdout.write(
    `falsification control=exit-${controlRun.status} mutations=${MUTATIONS.length} ` +
      `cases=${MUTATIONS.map((mutation) => mutation.id).join(',')}\n`,
  );
});

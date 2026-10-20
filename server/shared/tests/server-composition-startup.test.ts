/**
 * AC-1 — the server composition root's module graph initializes without a TDZ.
 *
 * WHAT IS BEING PINNED. `server/index.ts` is the composition root: it imports
 * the providers, websocket, session-hosts, projects, mcp-gateway and
 * voice-realtime modules, and the old 11-directory import cycle meant the ORDER
 * those modules evaluated in was load-bearing. A cycle closed by a static or
 * dynamic import can throw
 * `ReferenceError: Cannot access '<class>' before initialization` while the
 * process is still building its module graph — a failure no behavioural unit
 * test sees, because the test would have to be the module that closes the loop.
 * This criterion imports the same module graph in the order the composition
 * root's imports reach it, prints what loaded, and only then asserts that
 * nothing threw and that no `before initialization` error appeared. It also
 * reads the directory graph itself and fails on the three edges the task's port
 * extraction removed: a re-coupled graph need not TDZ on THIS tree (ESM permits
 * importing a mid-evaluation module's bindings; the crash only appears when one
 * is READ during evaluation), so the structural assertion is what a false form
 * must red on.
 *
 * WHY THE BARRELS, NOT `server/index.ts`. Importing `server/index.ts` runs
 * `startServer()` at top level, which binds a port and installs signal handlers;
 * a criterion that did that would be testing a live server, not a module graph.
 * The barrels below are the exact module set `server/index.ts` pulls in (its
 * static import list), and importing them in order drives the same evaluation.
 * The composition root's own dynamic bits — env loading, express wiring — are
 * not part of the import-cycle question.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/shared/tests/server-composition-startup.test.ts
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectServerSources, scanImportGraph } from '@/shared/import-graph.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(TEST_DIR, '../..');

/**
 * The composition root's runtime module set, in the order its static imports
 * reach them. `server/index.ts` starts with the providers barrel, then the
 * websocket and session-hosts barrels, then the feature modules, and finishes
 * with the realtime/gateway pair. The order is deliberate: the providers graph
 * is the side that used to throw when a later module re-entered it mid-eval.
 */
const COMPOSITION_MODULE_ORDER = [
  '@/modules/providers/index.js',
  '@/modules/websocket/index.js',
  '@/modules/session-hosts/index.js',
  '@/modules/projects/index.js',
  '@/modules/voice/index.js',
  '@/modules/mcp-gateway/index.js',
  '@/modules/voice-realtime/index.js',
] as const;

test('AC1: the composition-root module graph loads without a TDZ', async () => {
  const readings: Array<{ specifier: string; state: 'loaded' | 'failed'; detail?: string }> = [];

  for (const specifier of COMPOSITION_MODULE_ORDER) {
    try {
      await import(specifier);
      readings.push({ specifier, state: 'loaded' });
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      readings.push({ specifier, state: 'failed', detail });
    }
  }

  const failures = readings
    .filter((reading) => reading.state === 'failed')
    .map((reading) => `${reading.specifier} -> ${reading.detail ?? 'unknown error'}`);
  const loaded = readings.filter((reading) => reading.state === 'loaded');

  // Print the reading BEFORE any assertion, so a red still records how far the
  // graph got and which module threw. The AC asks for exactly this ordering.
  console.log(`[composition-startup] requested=${COMPOSITION_MODULE_ORDER.length}`);
  readings.forEach((reading, index) => {
    const suffix = reading.detail === undefined ? '' : ` (${reading.detail})`;
    console.log(`[composition-startup] ${index + 1}. ${reading.specifier} ${reading.state}${suffix}`);
  });
  console.log(
    `[composition-startup] loaded=${loaded.length} failures=${failures.length}`,
  );

  // No module may fail to evaluate at all.
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.equal(loaded.length, COMPOSITION_MODULE_ORDER.length, 'every composition module loaded');

  // And the specific failure the cycle used to produce must not appear. This is
  // stated separately from the count so a future TDZ that is caught somewhere
  // else still names itself in the failure list above and here.
  const joined = failures.join('\n');
  assert.doesNotMatch(
    joined,
    /ReferenceError: Cannot access .* before initialization/,
    `a module-graph TDZ appeared:\n${joined}`,
  );

  // ---- the corresponding cycle-edge reading ---------------------------------
  //
  // A module graph can be re-coupled without producing a TDZ on THIS tree: ESM
  // lets a mid-evaluation module's bindings be imported, and the failure only
  // appears when a binding is read during evaluation. The criterion therefore
  // also reads the static+literal-dynamic directory graph the task's port
  // extraction reshaped, and fails on the precise edges that used to close the
  // initialization cycle. This is the assertion a false form (re-adding
  // `session-hosts -> mcp-gateway`) must red on: the cycle is structural, not
  // only a crash.
  const graph = scanImportGraph(collectServerSources(SERVER_DIR), { includeDynamic: true });
  const forbiddenEdges = [
    // The gateway/session-hosts pair (AC-2): both directions used to exist.
    ['modules/session-hosts', 'modules/mcp-gateway'],
    // The providers/list/claude -> websocket/services edge (AC-3).
    ['modules/providers/list/claude', 'modules/websocket/services'],
    // The driver's voice-realtime import, static or dynamic (AC-4).
    ['modules/providers/list/claude', 'modules/voice-realtime'],
  ] as const;
  const presentForbiddenEdges = forbiddenEdges
    .filter(([from, to]) => graph.dirEdges.some((edge) => edge.from === from && edge.to === to))
    .map(([from, to]) => `${from} -> ${to}`);

  const providerComponent = graph.nonTrivialSccs.find((component) =>
    component.includes('modules/providers'),
  );

  console.log(
    `[composition-startup] forbiddenEdges=${JSON.stringify(presentForbiddenEdges)} providerScc=${providerComponent === undefined ? 'none' : providerComponent.length}`,
  );

  assert.deepEqual(
    presentForbiddenEdges,
    [],
    `an edge that closed the server initialization cycle is back:\n${presentForbiddenEdges.join('\n')}`,
  );
  assert.ok(
    providerComponent === undefined || providerComponent.length < 11,
    `the provider initialization SCC grew back to ${providerComponent?.length ?? 0} members (baseline 11)`,
  );
});

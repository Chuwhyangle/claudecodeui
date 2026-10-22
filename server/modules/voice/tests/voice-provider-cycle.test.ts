/**
 * The criterion for `gap-voice-provider-cycle-port-break`: `modules/voice` is
 * out of the directory-level import cycle.
 *
 * The cycle this reads is the server's only 8-member directory SCC —
 * `modules/projects`, `modules/projects/services`, `modules/providers`,
 * `modules/providers/list/claude`, `modules/providers/services`, `modules/voice`,
 * `modules/websocket`, `modules/websocket/services`. `modules/voice` sat in it on
 * exactly two edges: one out (`voice-lexicon.ts`'s literal dynamic `import()`
 * naming the provider barrel) and one in
 * (`websocket/services -> voice`, the send hook). The task replaced the out-edge
 * with a shared port, so the remaining seven directories still form a cycle and
 * `modules/voice` must no longer be in it.
 *
 * NOT A SECOND SCANNER. This file reuses AC-394's measuring core —
 * `collectServerSources`, `scanImportGraph` and `strongComponents` from
 * `server/shared/import-graph.ts`, the same code the cycle-budget ratchet drives
 * — rather than re-walking the tree with its own grep. A second reading would
 * be free to disagree with the ratchet about what an edge is.
 *
 * Shaped so "green" cannot be vacuous: the real-tree case prints the summary
 * and every non-trivial component, asserts the tree still has at least one
 * non-trivial SCC (the seven-member remainder — a scanner that stopped finding
 * cycles would satisfy "voice is not in one" for the wrong reason), and the
 * synthetic case proves the SAME scanner really does put `modules/voice` into a
 * component when the offending import is present.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectServerSources, scanImportGraph, strongComponents, type SourceFile } from '@/shared/import-graph.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
/** `server/modules/voice/tests` -> `server`. */
const SERVER_DIR = path.resolve(TEST_DIR, '../../..');
const VOICE_DIRECTORY = 'modules/voice';

test('modules/voice is in no non-trivial directory SCC on the real server tree', () => {
  const graph = scanImportGraph(collectServerSources(SERVER_DIR), { includeDynamic: true });
  console.log(
    `[voice-cycle] files=${graph.files} staticEdges=${graph.staticFileEdges} dynamicEdges=${graph.dynamicFileEdges} sccs=[${graph.nonTrivialSccs.map((component) => component.length).join(',')}]`,
  );
  // Read the components DIRECTLY through the shared core as well: fold the
  // scanner's own directory edges into adjacency and hand them to
  // `strongComponents`. This is the same Tarjan pass `scanImportGraph` runs
  // internally; asserting the two agree means the criterion really is reading
  // the directory SCCs and not trusting a second, hand-rolled walk.
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) adjacency.set(node, []);
  for (const edge of graph.dirEdges) adjacency.get(edge.from)?.push(edge.to);
  const components = strongComponents(graph.nodes, adjacency).filter((component) => component.length >= 2);
  assert.deepEqual(components, graph.nonTrivialSccs, 'the direct strongComponents reading must agree with scanImportGraph nonTrivialSccs');
  for (const component of components) {
    console.log(`[voice-cycle] SCC[${component.length}] ${component.join(', ')}`);
  }

  const containing = components.filter((component) => component.includes(VOICE_DIRECTORY));
  const voiceInAnyScc = containing.length > 0;
  console.log(`voiceInAnyScc=${voiceInAnyScc}`);

  // Non-vacuity: a dead walk finds no files and no cycles, and would pass the
  // "voice is not in one" assertion without having read anything.
  assert.ok(graph.files > 0, 'the scanner must have read the server tree');
  assert.ok(
    components.length > 0,
    'the tree must still contain at least one non-trivial SCC (the remaining provider cycle) — otherwise this criterion is green because the scanner found no cycles at all',
  );

  assert.deepEqual(
    containing,
    [],
    `${VOICE_DIRECTORY} is still inside a non-trivial SCC: ${containing.map((component) => `[${component.join(', ')}]`).join(' ')} — an import back into modules/providers reopened the cycle`,
  );
  assert.equal(voiceInAnyScc, false);
});

test('the same scanner puts modules/voice into an SCC when the providers import is present (false form)', () => {
  const sources: SourceFile[] = [
    { path: 'modules/voice/index.ts', text: "import('./voice-lexicon.js');\n" },
    { path: 'modules/voice/voice-lexicon.ts', text: "export async function read() { return import('../providers/index.js'); }\n" },
    { path: 'modules/providers/index.ts', text: "import '@/modules/voice/index.js';\n" },
  ];
  const graph = scanImportGraph(sources, { includeDynamic: true });
  console.log(`[voice-cycle] fixture SCCs=${JSON.stringify(graph.nonTrivialSccs)}`);
  assert.deepEqual(
    graph.nonTrivialSccs.map((component) => [...component].sort()),
    [['modules/providers', 'modules/voice']],
    'a literal dynamic import of the provider barrel must pull modules/voice into the SCC — proof the real-tree assertion can discriminate',
  );
});

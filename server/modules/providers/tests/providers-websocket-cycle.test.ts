/**
 * The providers-group exit criterion for the provider/websocket import cycle.
 *
 * WHAT THIS PINS. `modules/providers/services/sessions.service.ts` imported
 * `broadcastSessionUpserted` and `chatRunRegistry` from `modules/websocket`, and
 * `sessions-watcher.service.ts` imported `broadcastSessionUpsertedBatch` from
 * the same barrel. Those were the providers group's ONLY outgoing edges into
 * the five-member providers/websocket cycle (websocket/services imports the
 * providers module back for session lookups and the synchronizer), so the group
 * sat IN the cycle even though its other edges point one way. This task replaced
 * the three symbols with two shared install seams —
 * `shared/ports/session-broadcast.port.ts` (new) and the existing
 * `shared/ports/chat-run-registry.port.ts` (its optional `isProcessing` read) —
 * both installed by `server/index.ts`. The reading below is the one that says
 * the websocket group LEFT the component rather than that a file merely
 * appeared: the remaining component is the three-member providers group.
 *
 * HOW IT IS READ. The scan is AC-394's own measuring core
 * (`server/shared/import-graph.ts`): `collectServerSources` walks the shipping
 * server tree and `strongComponents` computes the non-trivial SCCs. The
 * aggregate scanner (`scanImportGraph`) supplies the edges, and the SCCs are
 * recomputed from those same edges with `strongComponents` — the same function
 * AC-394 budgets the tree with, so this criterion cannot drift into a second
 * opinion. The two readings are asserted equal before the absence is asserted.
 *
 * The absence reading is guarded against vacuity from both sides: the providers
 * and websocket directories must be nodes in the scan, and the providers group
 * must still carry outbound edges (a group with no source files would trivially
 * be in no cycle). The outbound edge list itself is read for any websocket
 * target before the SCC absence is asserted.
 *
 * The remaining non-trivial component is printed, but its membership count is
 * NOT asserted here beyond "contains no websocket directory" — that shrink is
 * AC-394's ratchet, and this criterion must stay green if a later task removes
 * the last cycle entirely.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectServerSources, scanImportGraph, strongComponents } from '@/shared/import-graph.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');

const PROVIDERS_GROUP = [
  'modules/providers',
  'modules/providers/list/claude',
  'modules/providers/services',
] as const;
const WEBSOCKET_GROUP = ['modules/websocket', 'modules/websocket/services'] as const;

test('(c) the websocket group sits in no non-trivial import cycle, and the providers component holds no websocket member', () => {
  const graph = scanImportGraph(collectServerSources(SERVER_DIR), { includeDynamic: true });

  // Recompute the SCCs from the scanner's own edges with AC-394's `strongComponents`,
  // rather than trusting only the aggregate field.
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.dirEdges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const nonTrivialSccs = strongComponents(graph.nodes, adjacency).filter((component) => component.length >= 2);

  console.log(`[providers-websocket-cycle] scanned files=${graph.files} dirs=${graph.nodes.length} edges=${graph.dirEdges.length}`);
  for (const component of nonTrivialSccs) {
    console.log(`[providers-websocket-cycle] SCC[${component.length}] ${component.join(', ')}`);
  }

  assert.deepEqual(
    nonTrivialSccs,
    graph.nonTrivialSccs,
    'the strongComponents reading from the scanner edges must equal the scanner aggregate — otherwise one of the two readings is broken',
  );

  // Anti-vacuity: both groups must actually have been scanned, and the providers group
  // must still carry outbound edges to some other directory.
  for (const directory of [...PROVIDERS_GROUP, ...WEBSOCKET_GROUP]) {
    assert.ok(graph.nodes.includes(directory), `${directory} must be a node in the server import graph`);
  }
  const outbound = graph.dirEdges.filter((edge) => (PROVIDERS_GROUP as readonly string[]).includes(edge.from));
  assert.ok(outbound.length > 0, 'the providers group must still carry outbound directory edges — an empty group is not evidence of leaving a cycle');
  console.log(`[providers-websocket-cycle] providers outbound edges: ${outbound.map((edge) => `${edge.from} -> ${edge.to}`).join(', ')}`);

  // The direct reading of the break: no providers-group edge may target a websocket directory
  // (static or literal dynamic — both kinds are in `dirEdges` for this scan).
  const crossGroup = outbound.filter((edge) => (WEBSOCKET_GROUP as readonly string[]).some((dir) => edge.to === dir));
  assert.deepEqual(crossGroup, [], `the providers group must not import the websocket group: ${JSON.stringify(crossGroup)}`);

  const providersScc = nonTrivialSccs.find((component) => (PROVIDERS_GROUP as readonly string[]).some((dir) => component.includes(dir)));
  const websocketInProvidersScc = providersScc === undefined
    ? false
    : providersScc.some((member) => (WEBSOCKET_GROUP as readonly string[]).includes(member));
  console.log(`[providers-websocket-cycle] providers SCC=[${(providersScc ?? []).join(', ')}] websocketInProvidersScc=${websocketInProvidersScc}`);
  assert.equal(websocketInProvidersScc, false, 'no websocket directory may sit in the import component that holds the providers group');

  // websocket's own exit: neither websocket directory may sit in ANY non-trivial cycle.
  const websocketInAnyScc = WEBSOCKET_GROUP.filter((directory) => nonTrivialSccs.some((component) => component.includes(directory)));
  console.log(`[providers-websocket-cycle] websocket dirs in a non-trivial SCC: ${JSON.stringify(websocketInAnyScc)}`);
  assert.deepEqual(websocketInAnyScc, [], 'the websocket group must have left every non-trivial import cycle');
});

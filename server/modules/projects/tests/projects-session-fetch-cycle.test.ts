/**
 * The projects-group exit criterion for the provider/websocket import cycle.
 *
 * WHAT THIS PINS. `modules/projects/services/projects-with-sessions-fetch.service.ts`
 * used to import `sessionSynchronizerService` from `modules/providers` and
 * `WS_OPEN_STATE` / `connectedClients` from `modules/websocket`. Those were the
 * projects group's only outgoing edges into the seven-member
 * provider/websocket cycle (providers/services and websocket/services import
 * `generateDisplayName` back from `modules/projects`), so the group sat IN the
 * cycle even though its other edges — database, shared, architecture, quay —
 * point one way. This task replaced the two imports with the shared port
 * `shared/ports/projects-session-fetch.port.ts`, installed by `server/index.ts`.
 * The reading below is the one that says the group LEFT the component rather
 * than that a file merely appeared.
 *
 * HOW IT IS READ. The scan is AC-394's own measuring core
 * (`server/shared/import-graph.ts`): `collectServerSources` walks the shipping
 * server tree and `strongComponents` computes the non-trivial SCCs. The
 * aggregate scanner (`scanImportGraph`) is used for its edges, and the SCCs are
 * recomputed from those same edges with `strongComponents` — the same function
 * AC-394 budgets the tree with, so this criterion cannot drift into a second
 * opinion. The two readings are asserted equal before the absence is asserted.
 *
 * The absence reading is guarded against vacuity from both sides: the projects
 * directories must be nodes in the scan and the group must still have outbound
 * edges (a group with no source files would trivially be in no cycle), and the
 * outbound edge list itself is read for any provider/websocket target before the
 * SCC absence is asserted. The remaining non-trivial component (G1) is printed,
 * but its existence is NOT asserted here — that is AC-394's ratchet, and this
 * criterion must stay green if a later task removes the last cycle entirely.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectServerSources, scanImportGraph, strongComponents } from '@/shared/import-graph.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');

const PROJECTS_DIR = 'modules/projects';
const PROJECTS_SERVICES_DIR = 'modules/projects/services';
const CROSS_GROUP_PREFIXES = ['modules/providers', 'modules/websocket'] as const;

test('(c) modules/projects and modules/projects/services sit in no non-trivial import cycle', () => {
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

  console.log(`[projects-session-fetch] scanned files=${graph.files} dirs=${graph.nodes.length} edges=${graph.dirEdges.length}`);
  for (const component of nonTrivialSccs) {
    console.log(`[projects-session-fetch] SCC[${component.length}] ${component.join(', ')}`);
  }

  assert.deepEqual(
    nonTrivialSccs,
    graph.nonTrivialSccs,
    'the strongComponents reading from the scanner edges must equal the scanner aggregate — otherwise one of the two readings is broken',
  );

  // Anti-vacuity: the groups must actually have been scanned, and must still have outbound
  // edges to some other directory.
  assert.ok(graph.nodes.includes(PROJECTS_DIR), `${PROJECTS_DIR} must be a node in the server import graph`);
  assert.ok(graph.nodes.includes(PROJECTS_SERVICES_DIR), `${PROJECTS_SERVICES_DIR} must be a node in the server import graph`);
  const outbound = graph.dirEdges.filter((edge) => edge.from === PROJECTS_DIR || edge.from === PROJECTS_SERVICES_DIR);
  assert.ok(outbound.length > 0, 'the projects group must still carry outbound directory edges — an empty group is not evidence of leaving a cycle');
  console.log(`[projects-session-fetch] projects outbound edges: ${outbound.map((edge) => `${edge.from} -> ${edge.to}`).join(', ')}`);

  // The direct reading of the break: no outbound edge may target the provider or websocket
  // groups (static or literal dynamic — both kinds are in `dirEdges` for this scan).
  const crossGroup = outbound.filter((edge) => CROSS_GROUP_PREFIXES.some((prefix) => edge.to === prefix || edge.to.startsWith(`${prefix}/`)));
  assert.deepEqual(crossGroup, [], `the projects group must import neither providers nor websocket: ${JSON.stringify(crossGroup)}`);

  const inAnyScc = (directory: string): boolean => nonTrivialSccs.some((component) => component.includes(directory));
  const projectsInAnyScc = inAnyScc(PROJECTS_DIR);
  const projectsServicesInAnyScc = inAnyScc(PROJECTS_SERVICES_DIR);
  console.log(`projectsInAnyScc=${projectsInAnyScc} projectsServicesInAnyScc=${projectsServicesInAnyScc}`);

  assert.equal(projectsInAnyScc, false, `${PROJECTS_DIR} must not sit in any non-trivial import cycle`);
  assert.equal(projectsServicesInAnyScc, false, `${PROJECTS_SERVICES_DIR} must not sit in any non-trivial import cycle`);
});

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatQuayUri, parseQuayUri } from '@/modules/quay/quayUri';
import type { QuayParsedObject, QuayUriRejection } from '@/modules/quay/quayUri';

/**
 * The wall's address grammar, pinned in both directions.
 *
 * WHAT IS ACTUALLY BEING PINNED. A reference is only useful if every writer and reader agree
 * on it byte for byte, so the criterion is a ROUND TRIP over all five forms — not "parse
 * returns something". The rejection cases are the other half: a permissive parser would turn
 * the old project-less `quay://task/<id>` or an invented `quay://proj/widget/<id>` into a
 * plausible-looking object, and a downstream resolver would then fetch the wrong thing.
 */

/** Every form, with ids taken from this repository's real naming shapes. */
const ROUND_TRIP: QuayParsedObject[] = [
  {
    type: 'task',
    project: 'claudecodeui',
    id: 'quay-wall-addressable-view-and-input-package',
    ac: null,
  },
  {
    type: 'task',
    project: 'claudecodeui',
    id: 'quay-wall-addressable-view-and-input-package',
    ac: 3,
  },
  { type: 'goal', project: 'claudecodeui', id: 'GOAL-043' },
  {
    type: 'ledger',
    project: 'claudecodeui',
    name: 'task-status-events',
    eventId: 'evt-20261023-1',
  },
  { type: 'board', project: 'claudecodeui' },
];

/** Parses and asserts rejection, returning the reason so each case can name its own reading. */
function rejection(uri: string): QuayUriRejection {
  const parsed = parseQuayUri(uri);
  if (parsed.ok) {
    throw new Error(`${uri} was accepted as ${JSON.stringify(parsed.object)}`);
  }
  return parsed.reason;
}

test('① the five URI forms parse and format to themselves', () => {
  // The canonical spelling of each form, stated once so a change to the grammar is visible.
  assert.equal(
    formatQuayUri(ROUND_TRIP[0]),
    'quay://claudecodeui/task/quay-wall-addressable-view-and-input-package',
  );
  assert.equal(
    formatQuayUri(ROUND_TRIP[1]),
    'quay://claudecodeui/task/quay-wall-addressable-view-and-input-package#ac-3',
  );
  assert.equal(formatQuayUri(ROUND_TRIP[2]), 'quay://claudecodeui/goal/GOAL-043');
  assert.equal(
    formatQuayUri(ROUND_TRIP[3]),
    'quay://claudecodeui/ledger/task-status-events/evt-20261023-1',
  );
  assert.equal(formatQuayUri(ROUND_TRIP[4]), 'quay://claudecodeui/board');

  for (const object of ROUND_TRIP) {
    const uri = formatQuayUri(object);
    const parsed = parseQuayUri(uri);
    assert.deepEqual(parsed, { ok: true, object }, `${uri} did not parse back to its own object`);
    assert.equal(formatQuayUri((parsed as { ok: true; object: QuayParsedObject }).object), uri);
  }
});

test('① an #ac-<n> fragment is a positive decimal criterion number, and only on a task', () => {
  const parsed = parseQuayUri('quay://claudecodeui/task/gap-x#ac-12');
  assert.deepEqual(parsed, {
    ok: true,
    object: { type: 'task', project: 'claudecodeui', id: 'gap-x', ac: 12 },
  });

  // `#ac-0`, `#ac-x` and a fragment on a goal are not this grammar.
  assert.equal(rejection('quay://claudecodeui/task/gap-x#ac-0'), 'malformed');
  assert.equal(rejection('quay://claudecodeui/task/gap-x#ac-x'), 'malformed');
  assert.equal(rejection('quay://claudecodeui/goal/GOAL-1#ac-2'), 'malformed');
  assert.equal(rejection('quay://claudecodeui/board#ac-1'), 'malformed');
});

test('② the project-less form is rejected as missing-project, not accepted vacuously', () => {
  // This is the shape an early draft used. It must be named specifically, because a caller
  // still writing it needs to learn the project segment exists.
  assert.equal(rejection('quay://task/gap-x'), 'missing-project');
  assert.equal(rejection('quay://goal/GOAL-1'), 'missing-project');
  assert.equal(rejection('quay://board'), 'missing-project');
  assert.equal(rejection('quay:///task/gap-x'), 'missing-project');
});

test('② unknown object kinds and non-quay strings are rejected', () => {
  assert.equal(rejection('quay://claudecodeui/widget/x'), 'unknown-type');
  assert.equal(rejection('quay://claudecodeui/'), 'malformed');
  assert.equal(rejection('https://example.com/task/x'), 'not-a-quay-uri');
  assert.equal(rejection('gap-x'), 'not-a-quay-uri');
});

test('② empty ids, names and event ids are rejected', () => {
  assert.equal(rejection('quay://claudecodeui/task/'), 'empty-id');
  assert.equal(rejection('quay://claudecodeui/goal/'), 'empty-id');
  assert.equal(rejection('quay://claudecodeui/ledger/name/'), 'empty-id');
  assert.equal(rejection('quay://claudecodeui/ledger//evt-1'), 'empty-id');
});

test('② a known kind with the wrong number of segments is malformed', () => {
  assert.equal(rejection('quay://claudecodeui/task/a/b'), 'malformed');
  assert.equal(rejection('quay://claudecodeui/goal/a/b'), 'malformed');
  assert.equal(rejection('quay://claudecodeui/ledger/only-a-name'), 'malformed');
  assert.equal(rejection('quay://claudecodeui/board/extra'), 'malformed');
  // A query string is not part of the address grammar.
  assert.equal(rejection('quay://claudecodeui/task/x?y=1'), 'malformed');
});

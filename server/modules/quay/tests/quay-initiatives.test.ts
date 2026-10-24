/**
 * AC3 — the initiative view / decision queue reading, driven through the REAL service with an
 * injected child-process seam and a temp fleet home.
 *
 * Three readings:
 *   ① the reading: `initiative list --json` rows become one project cell per charter project,
 *      the `blocks` edge is flagged with the oldest live escalation's timestamp, the
 *      `initiative-decision` attention entry becomes a typed queue item, and only
 *      `kind ∈ {inference, llm}` ledger rows reach the audit sample;
 *   ② the write: one human ruling spawns exactly one `initiative decide … --by human`, with no
 *      `--kind` (the fleet derives it), and a non-human provenance is refused before any child;
 *   ③ the fallback: a CLI that cannot answer still leaves the queue intact.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/quay/tests/quay-initiatives.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { QuayFleetCommandResult, QuayFleetExec } from '../quay-initiatives.js';
import { createQuayInitiatives } from '../quay-initiatives.js';

const FIRST_SEEN = '2026-10-24T08:00:00.000Z';
const DECIDED_AT = '2026-10-24T09:30:00.000Z';

const INITIATIVE = {
  slug: 'cockpit-observation-wall',
  status: 'active',
  charter: {
    intent: 'Ship the cockpit observation wall.',
    projects: ['claudecodeui', 'quay-fleet'],
    completionCriteria: ['wall ships'],
    grantScope: { mayDecide: ['layout'], mustEscalate: ['scope'] },
    exitConditions: ['both projects green'],
    expiresAt: '2026-12-31T00:00:00.000Z',
  },
  members: [
    { project: 'claudecodeui', taskRefs: ['observation-wall-ui'], goalRefs: ['GOAL-cockpit'], liaison: 'liaison:claudecodeui' },
    { project: 'quay-fleet', taskRefs: [], goalRefs: [], liaison: null },
  ],
  edges: [
    {
      from: 'quay://quay-fleet/task/fleet-initiative-store-and-cli',
      to: 'quay://claudecodeui/task/cockpit-initiative-view-and-decision-queue',
      kind: 'blocks',
    },
    { from: 'quay://claudecodeui/board', to: 'quay://quay-fleet/board', kind: 'contract' },
  ],
};

const DECISIONS = [
  {
    at: DECIDED_AT,
    initiative: 'cockpit-observation-wall',
    by: 'liaison:claudecodeui',
    kind: 'inference',
    question: 'Which layout should the row use?',
    options: ['a', 'b'],
    chosen: 'a',
    rationale: 'The liaison chose the compact layout.',
    refs: [],
  },
  {
    at: DECIDED_AT,
    initiative: 'cockpit-observation-wall',
    by: 'human',
    kind: 'fact',
    question: 'Was the queue approved?',
    options: ['yes'],
    chosen: 'yes',
    rationale: 'A person approved it.',
    refs: [],
  },
];

let home = '';

function ok(stdout: unknown): QuayFleetCommandResult {
  return { ok: true, code: 0, stdout: JSON.stringify(stdout), stderr: '' };
}

test.before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'quay-initiatives-'));
  await writeFile(
    path.join(home, 'initiatives.json'),
    JSON.stringify({ version: 1, initiatives: [INITIATIVE] }),
  );
  await writeFile(
    path.join(home, 'attention.json'),
    JSON.stringify({
      version: 1,
      entries: {
        att_one: {
          attentionId: 'att_one',
          projectId: 'quay-fleet',
          category: 'initiative-decision',
          entity: 'initiative:cockpit-observation-wall@abc123',
          state: 'open',
          options: [
            { id: 'own-it', label: 'Draw it in the cockpit' },
            { id: 'link-out', label: 'Link to the fleet UI' },
          ],
          // THE REAL SHAPE: the fleet stores the candidate's `reason` on the EVIDENCE item,
          // never on the entry. A fixture with a top-level `reason` would not exercise the
          // path the production document uses.
          evidence: [
            {
              ref: 'decisions.jsonl@esc:cockpit-observation-wall@abc123',
              reason: 'initiative escalate: Which layout should the decision queue use?',
            },
          ],
          firstSeenAt: FIRST_SEEN,
        },
        // A different category must never leak into this queue.
        att_other: {
          attentionId: 'att_other',
          projectId: 'quay-fleet',
          category: 'state-problem',
          entity: 'initiative:cockpit-observation-wall@other',
          state: 'open',
          options: [],
          evidence: [],
          firstSeenAt: FIRST_SEEN,
        },
      },
    }),
  );
});

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The stub fleet: `list`/`show` answer the fixture; `decide` records its argv. */
function stubExec(
  calls: string[][],
  overrides: { listFails?: boolean } = {},
): QuayFleetExec {
  return async (_file, args) => {
    calls.push([...args]);
    if (args[0] !== 'initiative') {
      return { ok: false, code: 2, stdout: '', stderr: 'unexpected command' };
    }
    if (args[1] === 'list') {
      return overrides.listFails
        ? { ok: false, code: 2, stdout: '', stderr: '', error: 'quay-fleet was not found' }
        : ok({ ok: true, initiatives: [INITIATIVE], count: 1 });
    }
    if (args[1] === 'show') {
      return ok({ ok: true, initiative: INITIATIVE, decisions: DECISIONS, ledger: { byteLength: 1, corruptLines: 0 } });
    }
    if (args[1] === 'decide') {
      return ok({
        ok: true,
        decision: {
          at: DECIDED_AT,
          initiative: 'cockpit-observation-wall',
          by: 'human',
          kind: 'fact',
          question: 'Which layout should the decision queue use?',
          options: ['own-it', 'link-out'],
          chosen: 'link-out',
          rationale: 'The cockpit already owns the human surface.',
          refs: ['decisions.jsonl@dec_1'],
        },
        attentionClosed: [{ attentionId: 'att_one' }],
      });
    }
    return { ok: false, code: 2, stdout: '', stderr: 'unexpected subcommand' };
  };
}

test('reads initiatives, blocking edges, the typed queue and the audit sample', async () => {
  const calls: string[][] = [];
  const service = createQuayInitiatives({
    exec: stubExec(calls),
    binPath: 'quay-fleet',
    home,
    auditRatio: 1 / 5,
  });

  const reading = await service.read();
  assert.equal(reading.ok, true);
  if (!reading.ok) return;

  assert.equal(reading.initiatives.length, 1);
  const initiative = reading.initiatives[0]!;
  assert.equal(initiative.slug, 'cockpit-observation-wall');
  assert.equal(initiative.uri, 'quay://fleet/initiative/cockpit-observation-wall');
  assert.deepEqual(
    initiative.members.map((member) => member.project),
    ['claudecodeui', 'quay-fleet'],
  );
  assert.deepEqual(initiative.members[0]!.taskRefs, ['observation-wall-ui']);
  assert.equal(initiative.members[1]!.taskRefs.length, 0);

  // The blocks edge is flagged with the escalation's firstSeenAt; the contract edge never is.
  const [blocks, contract] = initiative.edges;
  assert.equal(blocks!.blocked, true);
  assert.equal(blocks!.blockedSince, FIRST_SEEN);
  assert.equal(contract!.blocked, false);
  assert.equal(contract!.blockedSince, null);

  // The queue carries the typed options and the parsed question, and only this category.
  assert.equal(reading.decisionQueue.length, 1);
  const queue = reading.decisionQueue[0]!;
  assert.equal(queue.attentionId, 'att_one');
  assert.equal(queue.initiative, 'cockpit-observation-wall');
  assert.equal(queue.question, 'Which layout should the decision queue use?');
  assert.deepEqual(queue.options, [
    { id: 'own-it', label: 'Draw it in the cockpit' },
    { id: 'link-out', label: 'Link to the fleet UI' },
  ]);
  assert.equal(queue.evidence.length, 1);

  // Only the inference row is auditable; the fact row is a person's own decision.
  assert.equal(reading.audit.length, 1);
  assert.equal(reading.audit[0]!.kind, 'inference');
  assert.equal(reading.audit[0]!.by, 'liaison:claudecodeui');
  assert.equal(reading.auditRatio, 1 / 5);
});

test('records one human ruling through `initiative decide --by human` (no --kind)', async () => {
  const calls: string[][] = [];
  const service = createQuayInitiatives({ exec: stubExec(calls), binPath: 'quay-fleet', home });

  const result = await service.decide('cockpit-observation-wall', {
    question: 'Which layout should the decision queue use?',
    options: [
      { id: 'own-it', label: 'Draw it in the cockpit' },
      { id: 'link-out', label: 'Link to the fleet UI' },
    ],
    chosen: 'link-out',
    rationale: 'The cockpit already owns the human surface.',
    refs: ['decisions.jsonl@dec_1'],
    by: 'human',
    kind: 'fact',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.decision.by, 'human');
  assert.equal(result.decision.kind, 'fact');
  assert.equal(result.decision.chosen, 'link-out');
  assert.equal(result.attentionClosed.length, 1);

  const decideCalls = calls.filter((args) => args[1] === 'decide');
  assert.equal(decideCalls.length, 1);
  const argv = decideCalls[0]!;
  assert.equal(argv[0], 'initiative');
  assert.equal(argv[2], 'cockpit-observation-wall');
  assert.ok(argv.includes('--by'));
  assert.equal(argv[argv.indexOf('--by') + 1], 'human');
  // The fleet derives `kind` from `by`; forwarding `--kind` would be refused by its CLI.
  assert.equal(argv.includes('--kind'), false);
  assert.equal(argv[argv.indexOf('--chosen') + 1], 'link-out');
  assert.ok(argv.includes('--refs'));
});

test('refuses a non-human provenance without spawning the CLI', async () => {
  const calls: string[][] = [];
  const service = createQuayInitiatives({ exec: stubExec(calls), binPath: 'quay-fleet', home });

  const result = await service.decide('cockpit-observation-wall', {
    question: 'Which layout?',
    options: [{ id: 'a', label: 'A' }],
    chosen: 'a',
    rationale: 'A liaison must not write through the cockpit.',
    refs: [],
    // Deliberately outside the type: the transport must not be able to express it.
    by: 'liaison:claudecodeui' as 'human',
    kind: 'inference' as 'fact',
  });

  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'human-fact-required');
  assert.equal(calls.length, 0);
});

test('a fleet CLI that cannot answer still leaves the decision queue intact', async () => {
  const calls: string[][] = [];
  const service = createQuayInitiatives({
    exec: stubExec(calls, { listFails: true }),
    binPath: 'quay-fleet',
    home,
  });

  const reading = await service.read();
  assert.equal(reading.ok, false);
  assert.equal(reading.available, false);
  if (reading.ok) return;
  assert.match(reading.reason, /quay-fleet/);
  assert.equal(reading.decisionQueue.length, 1);
  assert.equal(reading.decisionQueue[0]!.question, 'Which layout should the decision queue use?');
});

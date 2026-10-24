import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeBlockers } from '../quay-blockers-summary.js';

/**
 * The task-library fixture the criterion drives the summarizer with.
 *
 * `a` and `b` are the SAME failure at two counts (a normalised signature must merge them);
 * `c` asks a person without ever writing a Blocker section (status-derived); `d` is done and
 * keeps its historical Blocker section (must not be plotted); `e`/`f` wait on different members
 * of the merged group, `g` is a done dependent (must not count), and `i` is a needs-human task
 * that DOES carry a section (the section's signature wins over the status fallback).
 */
const TASKS = [
  {
    id: 'task-a',
    status: 'ready',
    updatedAt: Date.parse('2026-10-24T08:00:00.000Z'),
    body: [
      '## Proposal',
      'prose',
      '## Blocker',
      '',
      '**2026-10-24T07:00:00.000Z — worker 未落地（exited-not-landed）**',
      '',
      '- 未落地原因：suite 红（3 个文件）——重跑观察',
      '',
      '**2026-10-24T08:00:00.000Z — worker 未落地（exited-not-landed）**',
      '',
      '- 未落地原因：AC 未全勾（checked 0/6，剩余未勾 6）——续做只需验证并勾选 AC',
      '',
      '## AC',
      '- [ ] AC1',
    ].join('\n'),
  },
  {
    id: 'task-b',
    status: 'ready',
    updatedAt: Date.parse('2026-10-24T09:00:00.000Z'),
    body: [
      '## Blocker',
      '',
      '**2026-10-24T09:00:00.000Z — worker 未落地（exited-not-landed）**',
      '',
      '- 未落地原因：AC 未全勾（checked 0/4，剩余未勾 4）',
    ].join('\n'),
  },
  {
    id: 'task-c',
    status: 'needs-human',
    updatedAt: Date.parse('2026-10-24T10:00:00.000Z'),
    body: '## Proposal\n\nparked for a person\n',
  },
  {
    id: 'task-d',
    status: 'done',
    updatedAt: Date.parse('2026-10-24T11:00:00.000Z'),
    depends_on: ['task-a'],
    body: '## Blocker\n\n**2026-10-23T00:00:00.000Z — worker 未落地（exited-not-landed）**\n\n- 未落地原因：suite 红（1 个文件）',
  },
  {
    id: 'task-e',
    status: 'ready',
    updatedAt: Date.parse('2026-10-24T12:00:00.000Z'),
    depends_on: ['task-a', 'task-c'],
    body: '## Proposal\n\nwaiting on a and c\n',
  },
  {
    id: 'task-f',
    status: 'todo',
    updatedAt: Date.parse('2026-10-24T12:30:00.000Z'),
    depends_on: ['task-b'],
    body: '## Proposal\n\nwaiting on b\n',
  },
  {
    id: 'task-g',
    status: 'done',
    updatedAt: Date.parse('2026-10-24T13:00:00.000Z'),
    depends_on: ['task-c'],
    body: '## Proposal\n\nlanded, no longer waits\n',
  },
  {
    id: 'task-i',
    status: 'needs-human',
    updatedAt: Date.parse('2026-10-24T14:00:00.000Z'),
    body: '## Blocker\n\n**2026-10-24T14:00:00.000Z — worker 未落地（exited-not-landed）**\n\n- 未落地原因：suite 红（3 个文件）——重跑观察',
  },
] as const;

test('merges the same normalised signature and keeps the earliest start', () => {
  const blockers = summarizeBlockers(TASKS);
  assert.ok(blockers !== null);

  const merged = blockers.find((blocker) => blocker.occurrences === 2);
  assert.ok(merged !== undefined, 'the two "AC 未全勾" tasks must merge into one group');
  assert.equal(merged.since, '2026-10-24T08:00:00.000Z', 'the group starts at its earliest occurrence');
  assert.equal(merged.taskId, 'task-a', 'the representative task is the earliest occurrence');
  // The LAST entry in a task's Blocker section is the current obstruction: a and b are one
  // signature, while task-i's earlier `suite 红（3 个文件）` shares the OTHER signature.
  assert.doesNotMatch(merged.signature, /\d/, 'digits are normalised out of the signature');
  assert.match(merged.signature, /AC 未全勾/);
});

test('groups a status-derived needs-human task and a section-bearing one by different rules', () => {
  const blockers = summarizeBlockers(TASKS);
  assert.ok(blockers !== null);

  const statusOnly = blockers.find((blocker) => blocker.signature === 'needs-human');
  assert.ok(statusOnly !== undefined, 'a needs-human task without a Blocker section is still blocked');
  assert.equal(statusOnly.since, '2026-10-24T10:00:00.000Z', 'its age is its last update');
  assert.equal(statusOnly.occurrences, 1);

  // task-i is needs-human but carries a section: the section's signature must win, so it is its
  // own `suite 红` group instead of joining the status fallback. task-a's EARLIER `suite 红`
  // entry is history (the last entry is the current obstruction), so it contributes nothing.
  const suiteGroup = blockers.find((blocker) => /suite 红/.test(blocker.signature));
  assert.ok(suiteGroup !== undefined, 'a needs-human task with a section uses the section signature');
  assert.equal(suiteGroup.occurrences, 1);
  assert.equal(suiteGroup.since, '2026-10-24T14:00:00.000Z');
  assert.equal(suiteGroup.taskId, 'task-i');
});

test('counts only unfinished dependents of the group members', () => {
  const blockers = summarizeBlockers(TASKS);
  assert.ok(blockers !== null);

  const merged = blockers.find((blocker) => blocker.occurrences === 2 && /AC 未全勾/.test(blocker.signature));
  assert.ok(merged !== undefined);
  // e waits on a, f waits on b (the same merged failure). d is done and points at a; it must
  // not count. The merged group's members are exactly a and b.
  assert.deepEqual(merged.dependents, ['task-e', 'task-f']);

  const statusOnly = blockers.find((blocker) => blocker.signature === 'needs-human');
  assert.ok(statusOnly !== undefined);
  // e waits on c; g is done and also points at c, so only e remains.
  assert.deepEqual(statusOnly.dependents, ['task-e']);
});

test('a done task keeps its Blocker section as history but is never a live blocker', () => {
  const blockers = summarizeBlockers(TASKS);
  assert.ok(blockers !== null);
  assert.equal(
    blockers.some((blocker) => blocker.taskId === 'task-d'),
    false,
    'a landed task is not a current obstruction',
  );
});

test('an unread store is null, an empty store is an empty reading', () => {
  assert.equal(summarizeBlockers(null), null);
  assert.equal(summarizeBlockers(undefined), null);
  assert.equal(summarizeBlockers({ tasks: [] }), null);
  assert.deepEqual(summarizeBlockers([]), []);
});

test('orders the groups oldest first, so the longest-blocked item starts the row', () => {
  const blockers = summarizeBlockers(TASKS);
  assert.ok(blockers !== null);
  const starts = blockers.map((blocker) => Date.parse(blocker.since));
  assert.deepEqual(starts, [...starts].sort((left, right) => left - right));
});

test('a malformed record is skipped without failing the whole reading', () => {
  const blockers = summarizeBlockers([
    null,
    'not a task',
    { id: '', status: 'ready' },
    { id: 'ok', status: 'needs-human', updatedAt: '2026-10-24T10:00:00.000Z' },
    // A blocker section whose heading carries no parseable instant cannot be placed on a
    // timeline, so the record contributes nothing rather than inventing a start.
    { id: 'no-instant', status: 'ready', body: '## Blocker\n\n**worker 未落地**\n\n- 未落地原因：suite 红（3 个文件）' },
  ]);
  assert.deepEqual(blockers?.map((blocker) => blocker.taskId), ['ok']);
});

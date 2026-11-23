/**
 * The round prompt: what the goal session is told, and what it must not be told.
 *
 *   ① the objective, the exit conditions and every failing AC are named;
 *   ② a passing AC leaves no trace — its output would invite a pointless "fix";
 *   ③ the failure tail is kept (the head is setup noise) and truncation is bounded;
 *   ④ the constraints keep the agent inside the goal worktree;
 *   ⑤ the text is a pure function of its input, so a round's prompt can be compared.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/goals/tests/round-prompt.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { CriterionReading, Goal, GoalAc } from '../../../shared/types.js';
import { buildRoundPrompt, tailExcerpt } from '../round-prompt.js';

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    userId: 7,
    projectId: 'proj-1',
    sessionId: 'session-1',
    worktreePath: '/tmp/worktrees/goal-1',
    branch: 'goal/goal-1',
    title: 'Ship the goal loop',
    objective: 'A person can author a goal and every AC must pass on its own command.',
    exitConditions: ['goal-1-AC-001', 'goal-1-AC-002'],
    status: 'active',
    budget: { maxRounds: 20, maxWallClockMs: 7_200_000, maxNoProgress: 3 },
    createdAt: '2026-11-11T00:00:00.000Z',
    activatedAt: '2026-11-11T00:01:00.000Z',
    achievedAt: null,
    ...overrides,
  };
}

function makeAc(id: string, overrides: Partial<GoalAc> = {}): GoalAc {
  return {
    id,
    goalId: 'goal-1',
    title: `Criterion ${id}`,
    criterion: `node --test ${id}.test.ts`,
    expect: 'It fails while the feature is missing.',
    status: 'active',
    createdAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  };
}

function reading(verdict: 'pass' | 'fail', output: string): CriterionReading {
  return {
    exitCode: verdict === 'pass' ? 0 : 1,
    timedOut: false,
    output,
    outputDigest: `digest-of-${output.length}`,
    verdict,
  };
}

test('names the objective, the exit conditions and every failing criterion', () => {
  const redAc = makeAc('goal-1-AC-001');

  const prompt = buildRoundPrompt({
    goal: makeGoal(),
    redAcs: [redAc],
    readings: [{ acId: redAc.id, reading: reading('fail', 'assertion failed: expected 3, got 2') }],
    roundSeq: 2,
  });

  assert.match(prompt, /^# Goal round 2: Ship the goal loop/);
  assert.match(prompt, /A person can author a goal/);
  assert.match(prompt, /goal-1-AC-001/);
  assert.match(prompt, /goal-1-AC-002/);
  assert.match(prompt, /Criterion goal-1-AC-001/);
  assert.match(prompt, /It fails while the feature is missing\./);
  assert.match(prompt, /node --test goal-1-AC-001\.test\.ts/);
  assert.match(prompt, /assertion failed: expected 3, got 2/);
});

test('a passing criterion leaves no trace in the prompt', () => {
  const redAc = makeAc('goal-1-AC-001');
  const greenAc = makeAc('goal-1-AC-002', { title: 'ALREADY-GREEN-MARKER' });

  const prompt = buildRoundPrompt({
    goal: makeGoal({ exitConditions: [] }),
    redAcs: [redAc],
    readings: [
      { acId: redAc.id, reading: reading('fail', 'red output') },
      { acId: greenAc.id, reading: reading('pass', 'GREEN-OUTPUT-MARKER') },
    ],
    roundSeq: 1,
  });

  assert.doesNotMatch(prompt, /ALREADY-GREEN-MARKER/);
  assert.doesNotMatch(prompt, /GREEN-OUTPUT-MARKER/);
});

test('keeps the tail of a long failure and drops the head', () => {
  const redAc = makeAc('goal-1-AC-001');
  const head = 'HEAD-MARKER setup noise';
  const tail = 'TAIL-MARKER assertion failed';
  const output = `${head}\n${'filler line\n'.repeat(200)}${tail}`;

  const prompt = buildRoundPrompt({
    goal: makeGoal(),
    redAcs: [redAc],
    readings: [{ acId: redAc.id, reading: reading('fail', output) }],
    roundSeq: 1,
  });

  assert.match(prompt, /TAIL-MARKER/);
  assert.doesNotMatch(prompt, /HEAD-MARKER/);
});

test('an unrun criterion still gets a placeholder instead of an empty block', () => {
  const redAc = makeAc('goal-1-AC-001');

  const prompt = buildRoundPrompt({
    goal: makeGoal(),
    redAcs: [redAc],
    readings: [],
    roundSeq: 1,
  });

  assert.match(prompt, /\(the criterion produced no output\)/);
});

test('constrains the agent to the goal worktree and forbids editing the criteria', () => {
  const prompt = buildRoundPrompt({
    goal: makeGoal(),
    redAcs: [makeAc('goal-1-AC-001')],
    readings: [],
    roundSeq: 1,
  });

  assert.match(prompt, /\/tmp\/worktrees\/goal-1/);
  assert.match(prompt, /goal\/goal-1/);
  assert.match(prompt, /Change only files inside the goal worktree/);
  assert.match(prompt, /Do not edit the goal, its acceptance criteria, or the criterion commands/);
  assert.match(prompt, /main checkout/);
});

test('the prompt is deterministic for the same inputs', () => {
  const redAc = makeAc('goal-1-AC-001');
  const input = {
    goal: makeGoal(),
    redAcs: [redAc],
    readings: [{ acId: redAc.id, reading: reading('fail', 'same output') }],
    roundSeq: 3,
  };

  assert.equal(buildRoundPrompt(input), buildRoundPrompt(input));
});

test('tailExcerpt caps both the line count and the character count', () => {
  const longLines = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');

  const byLines = tailExcerpt(longLines, 5, 10_000);
  assert.equal(byLines.split('\n').length, 5);
  assert.match(byLines, /line 99$/);

  const byChars = tailExcerpt('x'.repeat(100) + 'END', 40, 10);
  assert.equal(byChars, `${'x'.repeat(7)}END`);

  assert.equal(tailExcerpt('   \n\n'), '');
});

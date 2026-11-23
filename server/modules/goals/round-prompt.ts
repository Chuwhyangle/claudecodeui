import type { CriterionReading, Goal, GoalAc } from '@/shared/types.js';

// --------------------------- Excerpts ------------

/** How many trailing lines of one criterion's output a prompt or evidence row keeps. */
const EXCERPT_MAX_LINES = 40;

/** Upper bound on the kept excerpt, so one noisy criterion cannot bloat a prompt. */
const EXCERPT_MAX_CHARS = 4_000;

/**
 * Keeps the END of a criterion's output: the failing assertion, the stack trace,
 * and the summary are what explain a red reading, while the head is setup noise.
 *
 * Consumers: `buildRoundPrompt` (shows the failure to the goal session) and
 * `run-round.ts` (stores the same tail as the evidence excerpt), so a person
 * replaying a round reads exactly what the agent was shown.
 */
export function tailExcerpt(
  output: string,
  maxLines: number = EXCERPT_MAX_LINES,
  maxChars: number = EXCERPT_MAX_CHARS,
): string {
  const trimmed = output.trimEnd();
  if (!trimmed) return '';

  const lines = trimmed.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}

// --------------------------- Round prompt ------------

/**
 * Everything one round's prompt is built from: the goal, the ACs that failed
 * this round, and the readings those failures came from.
 */
export type RoundPromptInput = {
  goal: Goal;
  redAcs: GoalAc[];
  readings: Array<{ acId: string; reading: CriterionReading }>;
  roundSeq: number;
};

/**
 * Assembles the message one loop round sends to the goal's bound session
 * (docs/proposals/goal-loop.md §4.2).
 *
 * Consumers: `run-round.ts`, which hands the result back to the caller that
 * will send it. The function is pure and carries no timestamps on purpose: the
 * same goal, ACs, and readings always produce the same text, which is what lets
 * a round's prompt be compared across attempts.
 *
 * Only failing ACs are described — a passing criterion's output would invite the
 * agent to "fix" something that already works.
 */
export function buildRoundPrompt(input: RoundPromptInput): string {
  const { goal, redAcs, readings, roundSeq } = input;
  const worktreePath = goal.worktreePath ?? '(the goal worktree)';
  const branch = goal.branch ? ` (branch \`${goal.branch}\`)` : '';
  const exitConditions = goal.exitConditions.length > 0
    ? goal.exitConditions.map((acId) => `- ${acId}`).join('\n')
    : '- (none recorded yet)';

  const sections: string[] = [
    `# Goal round ${roundSeq}: ${goal.title}`,
    '',
    '## Objective',
    goal.objective,
    '',
    '## Exit conditions',
    'Every acceptance criterion listed here must pass; the exit condition is their conjunction.',
    exitConditions,
    '',
    '## Worktree',
    `Work only inside \`${worktreePath}\`${branch}.`,
    `This worktree is the goal's own copy of the project. The user's main checkout is off limits, and nothing outside this directory may be changed.`,
    '',
    `## Failing acceptance criteria (${redAcs.length})`,
  ];

  for (const ac of redAcs) {
    const reading = readings.find((entry) => entry.acId === ac.id)?.reading;
    const excerpt = reading ? tailExcerpt(reading.output) : '';

    sections.push(
      '',
      `### ${ac.id} — ${ac.title}`,
      `Expectation: ${ac.expect}`,
      `Criterion command: \`${ac.criterion}\``,
      'Last output:',
      '```',
      excerpt || '(the criterion produced no output)',
      '```',
    );
  }

  sections.push(
    '',
    '## Constraints',
    '- Change only files inside the goal worktree.',
    '- Do not edit the goal, its acceptance criteria, or the criterion commands: a criterion rewritten until it passes proves nothing.',
    "- Do not touch the user's main checkout, other worktrees, or the goal record itself.",
    '- Stop when the work is done; the next round re-runs every criterion as-is.',
    '',
    'The goal is achieved when every acceptance criterion passes in the same round.',
  );

  return sections.join('\n');
}

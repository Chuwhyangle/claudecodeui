import type { CriterionReading } from '@/shared/types.js';

/**
 * The red-first gate's answer: either every criterion was red (activation may
 * proceed), or the listed ACs were already green (activation must be refused).
 * An empty input is also a refusal — there is nothing to prove red.
 */
export type RedFirstVerdict = { ok: true } | { ok: false; greenAcIds: string[] };

/**
 * Decides whether a goal may be activated, from the first run of its criteria.
 *
 * Consumers: the goal activation path (`goals.service.ts`). A criterion that is
 * already green before the agent touches anything cannot distinguish "the
 * agent fixed it" from "the criterion is always true", which is the main source
 * of false greens in quay's history (docs/proposals/goal-loop.md §5.1), so
 * activation is refused while any reading passes.
 *
 * Pure: no I/O, no clock, no state — the same readings always give the same
 * verdict. Order of `greenAcIds` follows the input order.
 */
export function verifyRedFirst(
  readings: Array<{ acId: string; reading: CriterionReading }>,
): RedFirstVerdict {
  if (readings.length === 0) {
    return { ok: false, greenAcIds: [] };
  }

  const greenAcIds = readings
    .filter((entry) => entry.reading.verdict === 'pass')
    .map((entry) => entry.acId);

  return greenAcIds.length > 0 ? { ok: false, greenAcIds } : { ok: true };
}

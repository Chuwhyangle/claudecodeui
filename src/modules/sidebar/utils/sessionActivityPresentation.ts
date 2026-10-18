import type { TFunction } from 'i18next';

import { activityPhaseLabelKey } from '@/modules/chat';
import type { SessionActivity } from '@/shared/types';

/**
 * What a sidebar row draws for one running session, derived once from its
 * activity entry.
 *
 * The phase word is not a word table of the sidebar's own: `activityPhaseLabelKey`
 * is the same reduction the chat activity dock uses, so a session that says
 * "Running Bash" in the transcript says it in the sidebar too. The elapsed
 * reading is the turn's age from the entry's own `startedAt` — the server's run
 * start when the running-sessions poll supplied it — so the row cannot disagree
 * with the turn the activity map reports.
 */
export type SessionActivityPresentation = {
  /** The server's phase reading, or null when no snapshot has named one. */
  phase: SessionActivity['phase'] | null;
  /** The pending tool's name while `phase` is `tool`; null otherwise. */
  toolName: string | null;
  /** The translated phase word, or the provider's status line when no phase is known. */
  phaseLabel: string | null;
  /** The turn's age in ms, or null without a start anchor. */
  elapsedMs: number | null;
  /** `elapsedMs` as the dock's own seconds/minutes wording. */
  elapsedLabel: string | null;
};

/** Elapsed milliseconds as the chat dock writes it (`12s`, `3m 05s`). */
export function formatActivityElapsed(elapsedMs: number, t: TFunction): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes < 1
    ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
    : t('claudeStatus.elapsed.minutesSeconds', {
        minutes,
        seconds,
        defaultValue: '{{minutes}}m {{seconds}}s',
      });
}

/**
 * Reduce one activity entry to the row's readings.
 *
 * `t` must be the chat namespace: the phase keys and the elapsed wording are
 * the dock's, and reusing them is what keeps one vocabulary across surfaces.
 */
export function presentSessionActivity(
  activity: SessionActivity | undefined,
  now: number,
  t: TFunction,
): SessionActivityPresentation {
  const phase = activity?.phase ?? null;
  const toolName = phase === 'tool' ? (activity?.toolName ?? null) : null;
  const phaseLabelKey = phase === null ? null : activityPhaseLabelKey(phase, toolName);
  const phaseLabel = phaseLabelKey === null
    ? (activity?.statusText ?? null)
    : t(phaseLabelKey, { tool: toolName ?? '', defaultValue: phase });
  const elapsedMs = activity === undefined ? null : Math.max(0, now - activity.startedAt);

  return {
    phase,
    toolName,
    phaseLabel,
    elapsedMs,
    elapsedLabel: elapsedMs === null ? null : formatActivityElapsed(elapsedMs, t),
  };
}

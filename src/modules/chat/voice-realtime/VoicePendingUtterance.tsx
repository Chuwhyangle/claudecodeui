import { useTranslation } from 'react-i18next';
import { XIcon } from 'lucide-react';

import type { VoicePendingUtterance } from '@/modules/chat/voice-realtime/useVoicePendingWithdraw';

/**
 * One spoken sentence the CLI's queue may still be holding, drawn on the Live Voice surface with
 * the ONE action this task adds: taking it back (GOAL-041 / AC-351, SPEC §0.3 D-11).
 *
 * It is the voice sibling of `PendingResidentMessage` and reads the same three host states, but it
 * is a different row for a different reason. That row is a message this client SENT into a resident
 * process and drew from its own store; this one is a message the RELAY delivered, and the only thing
 * the page ever had about it is the delivery — plus the command's own queue id, which is what makes
 * a single sentence withdrawable. So the surface is Live Voice's, and the row is `queued` (withdraw)
 * → `cancelled` (withdrawn) → gone once the sentence is a turn.
 *
 * WHAT IS NEVER DRAWN. A row with no queue id is never handed here at all (the hook skips it): there
 * is no command to take back, and a button that could not be addressed is exactly the thing this
 * task must not ship. And a sentence that has STARTED is not this row's business either — it is a
 * turn now, with its own rows in the transcript — so a plain `started` renders nothing, while an
 * `already-started` NOTICE (the host's answer to an ask this person actually made) renders the
 * honest line and no button.
 */
type VoicePendingUtteranceProps = {
  utterance: VoicePendingUtterance;
  /** Asks the host to take this command back, by the queue id the row carries. */
  onWithdraw: (queuedMessageUuid: string) => void;
};

export function VoicePendingUtteranceRow({ utterance, onWithdraw }: VoicePendingUtteranceProps) {
  const { t } = useTranslation('chat');
  const uuid = utterance.queuedMessageUuid;

  // The host answered a withdrawal with `already-started`: the sentence had left the queue before
  // the person asked. This is a fact about the REQUEST, and it is said rather than hidden behind a
  // vanished button — the ask was made, and "it cannot be withdrawn any more" is its answer.
  if (utterance.notice === 'already-started') {
    return (
      <div
        data-testid="voice-pending-utterance"
        data-voice-pending-uuid={uuid}
        data-voice-withdraw-unavailable="already-started"
        className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 px-2 py-1 text-xs text-muted-foreground"
      >
        <span className="min-w-0 truncate" title={utterance.message}>
          {utterance.message}
        </span>
        <span className="flex-shrink-0 text-amber-600 dark:text-amber-400">
          {t('voice.realtime.withdraw.alreadyStarted', {
            defaultValue: 'Already started — it cannot be withdrawn',
          })}
        </span>
      </div>
    );
  }

  // Withdrawn: the sentence left the queue with the withdrawal, and what stays is that it was taken
  // back. Shown rather than silently dropped, so "did that go out?" has an answer on screen.
  if (utterance.state === 'cancelled') {
    return (
      <div
        data-testid="voice-pending-utterance"
        data-voice-pending-uuid={uuid}
        data-voice-withdrawn="true"
        className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 px-2 py-1 text-xs text-muted-foreground"
      >
        <span className="min-w-0 truncate" title={utterance.message}>
          {utterance.message}
        </span>
        <span className="flex-shrink-0">{t('voice.realtime.withdraw.withdrawn', { defaultValue: 'Withdrawn' })}</span>
      </div>
    );
  }

  // A sentence that has simply started is a turn now: its own rows are the record, and a row here
  // would be a second copy of them. Only the `already-started` notice above keeps a started row.
  if (utterance.state !== 'queued') {
    return null;
  }

  return (
    <div
      data-testid="voice-pending-utterance"
      data-voice-pending-uuid={uuid}
      data-voice-withdrawable="true"
      className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/50 px-2 py-1 text-xs"
    >
      <span className="min-w-0 flex-1 truncate text-foreground" title={utterance.message}>
        {utterance.message}
      </span>
      <span className="hidden flex-shrink-0 text-muted-foreground sm:inline">
        {t('voice.realtime.withdraw.pending', { defaultValue: 'Waiting in the queue' })}
      </span>
      <button
        type="button"
        data-voice-withdraw="true"
        onClick={() => onWithdraw(uuid)}
        className="flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <XIcon className="h-3 w-3" aria-hidden />
        <span>{t('voice.realtime.withdraw.withdraw', { defaultValue: 'Withdraw' })}</span>
      </button>
    </div>
  );
}

/**
 * The stack of pending/withdrawn rows the Live Voice bar draws beneath its banner.
 *
 * It filters out the sentences that need no row — a plain `started` one is a turn now — and renders
 * nothing at all when none is left, so the ordinary Live Voice surface is unchanged: the stack only
 * exists while there is something to say about the queue.
 */
export default function VoicePendingUtteranceList({
  utterances,
  onWithdraw,
}: {
  utterances: readonly VoicePendingUtterance[];
  onWithdraw: (queuedMessageUuid: string) => void;
}) {
  const visible = utterances.filter((utterance) => utterance.state !== 'started' || utterance.notice !== null);
  if (visible.length === 0) return null;
  return (
    <div data-testid="voice-pending-utterances" className="mb-1 flex flex-col gap-1">
      {visible.map((utterance) => (
        <VoicePendingUtteranceRow key={utterance.queuedMessageUuid} utterance={utterance} onWithdraw={onWithdraw} />
      ))}
    </div>
  );
}

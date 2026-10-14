import { useTranslation } from 'react-i18next';

/**
 * THE ONE WAITING CARD for Live Voice, in its two states — drawn as a single read-only card above the
 * bar (ruling 2026-10-14; second state added 2026-10-14 evening).
 *
 * WHY ONE CARD AND NOT A ROW PER SENTENCE. Until this ruling a sentence spoken while Claude was busy
 * became a command in the CLI's own queue as soon as the relay model passed it on, so the page drew
 * one row per sentence and the person watched a stack of them grow — two registries disagreeing about
 * what was waiting, and a row that would not go away. The copy of the ruling is unambiguous: there is
 * ONE bubble while queued. Every genuinely-queued spoken sentence is merged into ONE message and sent
 * to Claude Code once, and this is what that message says right now. As more is said the SAME card's
 * text grows; there is never a second one.
 *
 * TWO STATES, STILL ONE CARD. The 2026-10-14 evening reading found the OTHER half of the same wait
 * invisible: the relay's hold hands the merged message to the session and takes its card down, but a
 * delivery the CLI QUEUES does not appear in the conversation until the CLI dequeues it (3–54 s later,
 * measured), and for that whole gap the screen showed nothing — the person read the vanished card as a
 * lost message. So the same ONE card also draws that wait (`queuedText`), with its own label saying the
 * words are delivered and waiting for the current answer to finish. The HOLD takes priority: at any
 * moment the card is the relay's hold when there is one, and the delivered-queued wait only when there
 * is not — so the two can never both be on screen, and the "ONE card" ruling is preserved across both.
 *
 * IT IS READ-ONLY, AND THAT IS THE WHOLE POINT. The text-mode card of the same wait (`QueuedMessageCard`)
 * carries Edit and Delete; a spoken sentence cannot be edited back out of the microphone, and the
 * withdrawal control this task deletes was the previous attempt to offer one. So this card renders the
 * words and a label, and NOTHING a pointer can press: no `button`, no `XIcon`, no affordance that could
 * be read as "withdraw". A test pins that by counting the buttons inside it — a card that quietly grew
 * one would be the old defect coming back under a new name.
 *
 * NOTHING IS DRAWN when both texts are empty: the hold's clear frame sets its text to `''`, and the
 * card is the visual half of "there is nothing waiting any more".
 *
 * Consumers: `ChatInterface` hands it to `VoiceRealtimeBar`'s `pendingMessage` slot, built from the
 * live session's `pendingMessage` and `queuedDeliveryText`.
 */
export default function VoicePendingMessageCard({ text, queuedText = '' }: { text: string; queuedText?: string }) {
  const { t } = useTranslation('chat');
  // The hold wins when it is non-empty; the delivered-queued wait is the card only in the gap the hold
  // leaves behind (see the module comment). Both empty ⇒ nothing waits ⇒ no card.
  const holding = text.trim() !== '';
  const queuedBody = holding ? '' : queuedText.trim();
  const body = holding ? text : queuedBody;
  if (body === '') return null;

  return (
    <div
      // The card's own name, for readers that have to count these. It says "this is the ONE message
      // waiting" — what this component IS — rather than naming a class or a sentence, both of which
      // change for reasons that have nothing to do with it. BOTH states carry it, so a reader that
      // counts cards sees exactly one whichever state it is in (AC5).
      data-testid="voice-pending-message"
      className="mx-auto mb-2 max-w-[54.25rem] rounded-xl rounded-t-none border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary/70">
            <span>
              {holding ? t('input.queue.label', { defaultValue: 'Queued' }) : t('input.queue.delivered', { defaultValue: 'Delivered, queued' })}
            </span>
            <span className="normal-case text-muted-foreground/60">
              ·{' '}
              {holding
                ? t('input.queue.willSend', { defaultValue: 'Will send when this finishes' })
                : t('input.queue.deliveredDetail', { defaultValue: 'Will be handled when this answer finishes' })}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 break-words text-sm text-foreground/90">{body}</p>
        </div>
      </div>
    </div>
  );
}

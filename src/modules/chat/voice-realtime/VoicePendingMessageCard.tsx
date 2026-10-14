import { useTranslation } from 'react-i18next';

/**
 * THE ONE MESSAGE the relay is holding while the session is busy — drawn as a single read-only card
 * above the Live Voice bar (ruling 2026-10-14).
 *
 * WHY ONE CARD AND NOT A ROW PER SENTENCE. Until this ruling a sentence spoken while Claude was busy
 * became a command in the CLI's own queue as soon as the relay model passed it on, so the page drew
 * one row per sentence and the person watched a stack of them grow — two registries disagreeing about
 * what was waiting, and a row that would not go away. The copy of the ruling is unambiguous: there is
 * ONE bubble while queued. Every genuinely-queued spoken sentence is merged into ONE message and sent
 * to Claude Code once, and this is what that message says right now. As more is said the SAME card's
 * text grows; there is never a second one.
 *
 * IT IS READ-ONLY, AND THAT IS THE WHOLE POINT. The text-mode card of the same wait (`QueuedMessageCard`)
 * carries Edit and Delete; a spoken sentence cannot be edited back out of the microphone, and the
 * withdrawal control this task deletes was the previous attempt to offer one. So this card renders the
 * words and a label, and NOTHING a pointer can press: no `button`, no `XIcon`, no affordance that could
 * be read as "withdraw". A test pins that by counting the buttons inside it — a card that quietly grew
 * one would be the old defect coming back under a new name.
 *
 * Nothing is drawn for an EMPTY text: the hold's clear frame sets the text to `''`, and the card is
 * the visual half of "there is nothing waiting any more".
 */
export default function VoicePendingMessageCard({ text }: { text: string }) {
  const { t } = useTranslation('chat');
  if (text.trim() === '') return null;

  return (
    <div
      // The card's own name, for readers that have to count these. It says "this is the ONE message
      // the relay is holding" — what this component IS — rather than naming a class or a sentence,
      // both of which change for reasons that have nothing to do with it.
      data-testid="voice-pending-message"
      className="mx-auto mb-2 max-w-[54.25rem] rounded-xl rounded-t-none border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary/70">
            <span>{t('input.queue.label', { defaultValue: 'Queued' })}</span>
            <span className="normal-case text-muted-foreground/60">
              · {t('input.queue.willSend', { defaultValue: 'Will send when this finishes' })}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 break-words text-sm text-foreground/90">{text}</p>
        </div>
      </div>
    </div>
  );
}

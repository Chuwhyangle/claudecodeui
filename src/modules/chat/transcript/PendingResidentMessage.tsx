import { useTranslation } from 'react-i18next';
import { XIcon } from 'lucide-react';

import type { ChatMessage } from '@/shared/types';

/**
 * The `resident.pending` sentence each state of a queued command shows, as the
 * locale key rather than the sentence.
 *
 * The three keys live here and are published to the DOM as `data-resident-*`
 * values, so a reader that wants the copy looks it up in the shipped locale
 * rather than transcribing it: which words a state gets is the user's language's
 * answer, and a sentence held in this file would be a second one. The same
 * reason `readDividerLabel` reads `resident.divider.*` at render time.
 */
const PENDING_ANNOTATION_KEY = 'resident.pending.annotation';
const STARTED_ANNOTATION_KEY = 'resident.pending.started';

type PendingResidentMessageProps = {
  message: ChatMessage;
  /**
   * Asks the host to take this command back. Absent hides the button rather than
   * drawing one that would do nothing — a client with no way to send the request
   * has no withdrawal to offer.
   */
  onWithdraw?: (message: ChatMessage) => void;
};

/**
 * Rendered by chat's ChatMessagesPane for a message a resident process is
 * holding, in the three states the host's own `command_lifecycle` events put it
 * in.
 *
 * It is not `QueuedMessageCard` and deliberately shares none of its skin. That
 * card is this client's own queue: it is shown while the message waits for *the
 * browser* to send it, and taking it back is a local edit. Nothing here waits
 * for the browser — the message is already the process's, and every state drawn
 * below is one the process reported. The one thing the two have in common is
 * that the user is looking at a message that has no turn yet.
 *
 * The bubble is the message; everything under it is the host's account of where
 * the command is. Which of the two is on screen is the whole state machine:
 *
 *  - `queued` — the message, the sentence saying it will be handled when the
 *    current answer finishes, and [withdraw].
 *  - `started` — no bubble and no [withdraw], just the sentence saying it is
 *    running now. The message itself is the turn's own rows at this point, and a
 *    bubble here would be a second copy of it.
 *  - `cancelled` — no bubble either, and a notice in its place: the message left
 *    the record with the queue, and what stays is that it was taken back.
 */
export default function PendingResidentMessage({ message, onWithdraw }: PendingResidentMessageProps) {
  const { t } = useTranslation('chat');
  const state = message.residentCommandState ?? 'queued';
  const commandUuid = message.residentCommandUuid ?? '';
  // The row's identity as the activity channel named it. Published to the DOM in
  // its own right rather than folded into `data-command-uuid`, which carries the
  // legacy lifecycle frame's id: the two are the same value in the transition
  // period, and a reader asserting "one delivery, one row" needs the identity the
  // delivery is drawn from, not the one a frame happened to arrive with.
  const deliveryId = message.residentDeliveryId ?? '';
  const content = String(message.content ?? '');
  const annotationKey = state === 'started' ? STARTED_ANNOTATION_KEY : PENDING_ANNOTATION_KEY;

  if (state === 'cancelled') {
    return (
      <div
        data-command-uuid={commandUuid}
        data-delivery-id={deliveryId}
        data-resident-withdrawn="true"
        className="chat-message resident-pending flex justify-end px-3 sm:px-0"
      >
        <div className="flex w-full items-end sm:w-auto">
          <div className="flex min-w-0 flex-1 flex-col items-end gap-1 sm:flex-initial">
            <div className="rounded-2xl rounded-br-md border border-dashed border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
              {t('resident.pending.withdrawn')}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-command-uuid={commandUuid}
      data-delivery-id={deliveryId}
      className="chat-message resident-pending flex justify-end px-3 sm:px-0"
    >
      <div className="flex w-full items-end sm:w-auto sm:max-w-[85%] md:max-w-md lg:max-w-lg xl:max-w-xl">
        <div className="flex min-w-0 flex-1 flex-col items-end gap-1 sm:flex-initial">
          {content.trim().length > 0 && (
            <div
              data-resident-pending-message="true"
              className="max-w-full rounded-2xl rounded-br-md border border-border/60 bg-muted/60 px-3 py-2 text-foreground shadow-sm dark:bg-gray-800/60 sm:px-4"
            >
              {/* Rendered as plain text rather than through the markdown
                  pipeline the settled user bubble uses: nothing here is a
                  transcript row yet, and a message that has not been sent has no
                  business being parsed for structure it may never be sent with. */}
              <div dir="auto" className="whitespace-pre-wrap break-words font-serif text-sm">
                {content}
              </div>
            </div>
          )}

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span data-resident-annotation={annotationKey}>{t(annotationKey)}</span>
            {state === 'queued' && onWithdraw && (
              <button
                type="button"
                data-resident-withdraw="true"
                onClick={() => onWithdraw(message)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
              >
                <XIcon className="h-3 w-3" />
                <span>{t('resident.pending.withdraw')}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

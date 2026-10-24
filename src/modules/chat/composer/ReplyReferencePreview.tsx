import { useTranslation } from 'react-i18next';

import type { ReplyItem, ReplyReference } from '@/modules/chat/utils/transcript/replyItems';

type ReplyReferencePreviewProps = {
  reference: ReplyReference;
  items: readonly ReplyItem[];
};

/** True when the ordinals form one unbroken run (1,2,3 — not 1,3). */
function isContiguous(ordinals: readonly number[]): boolean {
  return ordinals.every((ordinal, index) => index === 0 || ordinal === ordinals[index - 1] + 1);
}

/**
 * Used by chat's ChatComposer: the one-line readout above the input box that
 * says what the draft just pointed at, before the message is sent.
 *
 * It is a reading aid only — nothing here rewrites the draft. The agent already
 * sees its own reply, so the preview exists to let the person confirm they
 * pointed at the right point; the text that leaves the composer is exactly the
 * text they typed.
 */
export default function ReplyReferencePreview({ reference, items }: ReplyReferencePreviewProps) {
  const { t } = useTranslation('chat');

  if (reference.kind === 'none') {
    return null;
  }

  const previewBaseClass =
    'mx-auto mb-1 flex max-w-[54.25rem] flex-wrap items-center gap-1.5 px-1 text-[11px] leading-5 text-muted-foreground';

  if (reference.kind === 'mismatch') {
    return (
      <div
        data-slot="reply-reference-preview"
        data-reply-reference-kind="mismatch"
        data-reply-reference-expected={reference.expected ?? undefined}
        data-reply-reference-total={reference.total ?? 0}
        role="status"
        className={previewBaseClass}
      >
        <span data-reply-reference-mismatch="true">
          {t('replyReference.mismatch', {
            ns: 'common',
            count: reference.total ?? 0,
            defaultValue: 'The latest reply has only {{count}} items',
          })}
        </span>
      </div>
    );
  }

  if (reference.kind === 'reply') {
    return (
      <div
        data-slot="reply-reference-preview"
        data-reply-reference-kind="reply"
        role="status"
        className={previewBaseClass}
      >
        <span data-reply-reference-label="true">
          {t('replyReference.wholeReply', {
            ns: 'common',
            defaultValue: 'the whole reply',
          })}
        </span>
      </div>
    );
  }

  // One ordinal reads as 「第 2 点」, not the degenerate range 「第 2–2 点」.
  const referenceLabel = reference.ordinals.length > 1 && isContiguous(reference.ordinals)
    ? t('replyReference.itemsRange', {
        ns: 'common',
        from: reference.ordinals[0],
        to: reference.ordinals[reference.ordinals.length - 1],
        defaultValue: 'Items {{from}}–{{to}}',
      })
    : t('replyReference.itemsList', {
        ns: 'common',
        list: reference.ordinals.join(', '),
        defaultValue: 'Items {{list}}',
      });

  return (
    <div
      data-slot="reply-reference-preview"
      data-reply-reference-kind="items"
      role="status"
      className={previewBaseClass}
    >
      <span data-reply-reference-label="true">{referenceLabel}</span>
      <span aria-hidden="true">→</span>
      {reference.ordinals.map((ordinal) => {
        const item = items.find((candidate) => candidate.ordinal === ordinal);
        if (!item) {
          return null;
        }
        return (
          <span
            key={ordinal}
            data-reply-reference-item={ordinal}
            className="rounded bg-muted/70 px-1 text-foreground/80"
          >
            {t('replyReference.item', {
              ns: 'common',
              label: item.label,
              excerpt: item.excerpt,
              defaultValue: '{{label}}「{{excerpt}}」',
            })}
          </span>
        );
      })}
    </div>
  );
}

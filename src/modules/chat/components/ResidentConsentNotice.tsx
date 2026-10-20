import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';

import { Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';

/**
 * The resident-mode disclosure, rendered as a read-only hint beside its affordance.
 *
 * Used by `ProviderSelectionEmptyState` (inside `ResidentToggle`, the switch row) and by the sidebar's
 * `SessionOptions` (in the menu header, next to the conversion item). Both places read the same `chat`
 * i18n keys, so the new-session entry point and the menu cannot drift into two different explanations.
 *
 * It explains; it does not gate. Nothing about it sits between the user and the switch or the
 * conversion — the switch being on is the whole of the intent, and the conversion runs the moment its
 * menu item is chosen. The Tooltip opens on hover or a touch long-press and closes again on its own.
 */
type ResidentConsentNoticeProps = {
  /** Draw the shared title beside the icon, for the one place with no other label (the menu header). */
  withLabel?: boolean;
  className?: string;
};

export default function ResidentConsentNotice({
  withLabel = false,
  className,
}: ResidentConsentNoticeProps) {
  const { t } = useTranslation('chat');
  const title = t('resident.notice.title');

  return (
    <Tooltip
      content={(
        // `whitespace-normal` overrides the Tooltip's own `whitespace-nowrap` by inheritance, so the
        // two paragraphs wrap instead of running off one long line. `data-slot` is what the criteria
        // read the disclosed copy by.
        <span
          data-slot="resident-hint-content"
          className="block max-w-xs whitespace-normal text-left leading-5"
        >
          <span className="block">{t('resident.notice.bypass')}</span>
          <span className="mt-1 block">{t('resident.notice.trustBoundary')}</span>
        </span>
      )}
    >
      <button
        type="button"
        // Structural marker for the criteria that read this hint: the trigger's own `aria-label`
        // comes from an i18n key, so a reader keyed on the copy alone could match unrelated text.
        data-slot="resident-consent-notice"
        aria-label={title}
        title={title}
        className={cn(
          'inline-flex items-center gap-1 rounded-md text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary',
          className,
        )}
      >
        <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {withLabel && <span>{title}</span>}
      </button>
    </Tooltip>
  );
}

/**
 * The resident switch and its hint as one row.
 *
 * Used by `ProviderSelectionEmptyState` (for a session that has none, where it sits under the model
 * card). It is the only home now: the composer's own copy was removed, and a session that already
 * exists is converted from the session menu instead, so the switch belongs to the moment before the
 * first turn and nowhere else.
 */
type ResidentToggleProps = {
  /** Whether the switch is on for the next send. */
  enabled: boolean;
  /** Flips it. Owned by the caller, because the submit path it feeds lives there. */
  onToggle: () => void;
  className?: string;
};

export function ResidentToggle({ enabled, onToggle, className }: ResidentToggleProps) {
  const { t } = useTranslation('chat');

  return (
    <div className={cn('flex w-full items-center gap-1', className)}>
      <button
        type="button"
        role="switch"
        // Structural marker for the criteria that read this affordance: the switch's own `aria-label`
        // comes from an i18n key, so a reader keyed on the *name* could also match an unrelated switch.
        // `data-resident-enable` is the affordance itself, addressable without the copy.
        data-resident-enable="true"
        aria-checked={enabled}
        aria-label={t('resident.toggle')}
        onClick={onToggle}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left text-xs transition-colors',
          enabled ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'relative h-4 w-7 shrink-0 rounded-full transition-colors',
            enabled ? 'bg-primary' : 'bg-muted-foreground/30',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-3 w-3 rounded-full bg-background transition-all',
              enabled ? 'left-3.5' : 'left-0.5',
            )}
          />
        </span>
        <span className="truncate">{t('resident.toggle')}</span>
      </button>
      <ResidentConsentNotice />
    </div>
  );
}

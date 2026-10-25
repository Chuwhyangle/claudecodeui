import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';

import { cn } from '@/shared/utils';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

type ScheduleMessagePopoverProps = {
  disabled: boolean;
  onSchedule: (scheduledFor: Date) => void;
  /**
   * `icon` (default) is the clock button the desktop footer renders on its own.
   * `menu-item` renders a menu row that expands into the picker *in place*,
   * which is what the mobile "more" menu needs: it already has a surface open,
   * so a second portalled one would be two interactive overlays at once.
   */
  variant?: 'icon' | 'menu-item';
};

/** Offsets people actually mean when they say "later". */
const QUICK_OFFSETS_MINUTES = [15, 60, 8 * 60, 24 * 60];

/**
 * Turns the picker's `datetime-local` value into an absolute instant.
 *
 * That input carries no zone, and `new Date(value)` reads it in the browser's
 * — which is what the user meant, since they picked it off their own clock.
 * Converting here means the server stores one unambiguous instant, so the
 * schedule does not move if they are on another device when it fires.
 */
function readLocalDateTime(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toLocalInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * The picker itself — the offsets and the custom instant — with no surface of
 * its own, so either variant can put it wherever its menu already lives.
 *
 * The custom value is seeded an hour out here rather than at the trigger, so a
 * picker that opens on "now" is impossible: by the time anyone reads the field,
 * the time they mean has usually moved on.
 */
function SchedulePicker({ onCommit }: { onCommit: (scheduledFor: Date) => void }) {
  const { t } = useTranslation('chat');
  const [customValue, setCustomValue] = useState(() => toLocalInputValue(new Date(Date.now() + 3_600_000)));

  return (
    <>
      <ComposerMenuHeading>{t('schedule.heading')}</ComposerMenuHeading>
      {QUICK_OFFSETS_MINUTES.map((minutes) => (
        <ComposerMenuItem
          key={minutes}
          label={t(`schedule.in.${minutes}`)}
          description={new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
          isSelected={false}
          onSelect={() => onCommit(new Date(Date.now() + minutes * 60_000))}
        />
      ))}

      <ComposerMenuSeparator />
      <div className="px-2.5 pb-1.5">
        <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="schedule-at">
          {t('schedule.customLabel')}
        </label>
        <input
          id="schedule-at"
          type="datetime-local"
          value={customValue}
          onChange={(event) => setCustomValue(event.target.value)}
          // `min-w-0` for the same reason as the surface: a native date/time input
          // has an intrinsic minimum width of its own, and without this it widens
          // the menu past the anchor's `maxWidth` on a phone.
          className="mt-1 w-full min-w-0 max-w-full rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-foreground"
        />
        <button
          type="button"
          onClick={() => {
            const parsed = readLocalDateTime(customValue);
            if (parsed) onCommit(parsed);
          }}
          className="mt-2 w-full rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          {t('schedule.confirm')}
        </button>
      </div>
    </>
  );
}

/**
 * Rendered by chat's ChatComposer beside the send button so the message in the
 * box can be sent later instead of now; its `menu-item` variant is rendered by
 * ChatComposer's ComposerMobileMoreMenu, which offers the same picker inside
 * the mobile "more" menu.
 */
export function ScheduleMessagePopover({ disabled, onSchedule, variant = 'icon' }: ScheduleMessagePopoverProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  // menu-item variant only: the row was chosen and the picker body is showing in
  // the host menu's surface. The host unmounts this component with its surface,
  // so the picker can never outlive the menu it renders into — that is what keeps
  // the two from being open at once.
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  // Portalled and anchored like the model and permission menus: the composer
  // sits inside the scrolling transcript's stacking context, so a popover
  // positioned inside it is clipped by the message pane. Inert in the menu-item
  // variant, which never opens this surface.
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  const commit = (scheduledFor: Date) => {
    onSchedule(scheduledFor);
    setIsOpen(false);
    setIsPickerOpen(false);
  };

  const ariaLabel = t('schedule.trigger');

  if (variant === 'menu-item') {
    if (isPickerOpen) {
      return <SchedulePicker onCommit={commit} />;
    }

    return (
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        aria-disabled={disabled || undefined}
        onClick={() => setIsPickerOpen(true)}
        className={cn(
          'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
          'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
          disabled ? 'cursor-not-allowed opacity-40' : 'text-foreground/90',
        )}
      >
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
          <Clock className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate leading-5">{ariaLabel}</span>
        </span>
      </button>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground transition-colors',
          disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted hover:text-foreground',
          isOpen && 'text-foreground',
        )}
      >
        <Clock className="h-4 w-4" />
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          <SchedulePicker onCommit={commit} />
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

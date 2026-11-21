import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ActivityIcon, MessageSquareIcon, MoreHorizontalIcon } from 'lucide-react';

import { useComposerMenuAnchor } from '@/modules/chat-composer/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSurface,
} from '@/modules/chat-composer/composer/menus/ComposerMenuPrimitives';
import { PromptInputButton } from '@/modules/chat-composer/composer/PromptInput';
import { ScheduleMessagePopover } from '@/modules/chat-composer/composer/ScheduleMessagePopover';
import TokenUsageSummary from '@/modules/chat-composer/composer/TokenUsageSummary';

type ComposerMobileMoreMenuProps = {
  /** The open session's token reading, shown compactly in the menu and opened in full on click. */
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  /** True while there is text to schedule; an empty message stays unschedulable, as in the footer. */
  canSchedule: boolean;
  onScheduleMessage: (scheduledFor: Date) => void;
};

/**
 * Rendered by chat's ChatComposer in place of the commands, schedule and token
 * controls when the viewport is narrower than the `md` breakpoint, so the
 * composer's primary row fits on one line on a phone.
 *
 * It is a display layer only: every item calls the same action its desktop
 * counterpart calls, and the schedule picker and the token reading are the
 * original components in their menu variants — no business state is copied here.
 */
export default function ComposerMobileMoreMenu({
  tokenBudget,
  onShowTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  canSchedule,
  onScheduleMessage,
}: ComposerMobileMoreMenuProps) {
  const { t } = useTranslation('chat');
  // Whether the menu is showing; anchored to the trigger below like the model
  // and permission menus, because the composer sits in the transcript's
  // scrolling stacking context and an in-flow popover would be clipped by it.
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  const label = t('input.moreTools', { defaultValue: 'More tools' });

  return (
    <>
      <PromptInputButton
        ref={triggerRef}
        tooltip={{ content: label }}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
      >
        <MoreHorizontalIcon />
      </PromptInputButton>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={label}>
          <ComposerMenuHeading>{label}</ComposerMenuHeading>

          <ComposerMenuItem
            role="menuitem"
            icon={<MessageSquareIcon className="h-4 w-4" />}
            label={t('input.showAllCommands', { defaultValue: 'Show all commands' })}
            isSelected={false}
            trailing={slashCommandsCount > 0 ? (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {slashCommandsCount}
              </span>
            ) : undefined}
            onSelect={() => {
              onToggleCommandMenu();
              close();
            }}
          />

          {/*
            The token reading is this row's trailing text rather than a control of
            its own: the row already opens the detailed panel, and a button inside
            a menu row would nest two controls in one.
          */}
          <ComposerMenuItem
            role="menuitem"
            icon={<ActivityIcon className="h-4 w-4" />}
            label={t('misc.showTokenUsage', { defaultValue: 'Show token usage' })}
            isSelected={false}
            trailing={<TokenUsageSummary usage={tokenBudget} variant="inline" />}
            onSelect={() => {
              onShowTokenUsage();
              close();
            }}
          />

          {/*
            Last, because choosing it expands the picker in place: with no row
            below it, the menu grows downward instead of shuffling the items
            already read.
          */}
          <ScheduleMessagePopover
            variant="menu-item"
            disabled={!canSchedule}
            onSchedule={onScheduleMessage}
          />
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

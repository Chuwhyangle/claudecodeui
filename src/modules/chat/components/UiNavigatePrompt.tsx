import { useTranslation } from 'react-i18next';

import type { UiNavigateTarget } from '@/shared/types';

/**
 * Props for the confirmation bar. Deliberately flat primitives: the bar renders a
 * request it did not create and answers it through the four callbacks, so it holds
 * no state of its own and its host decides what each answer means.
 */
type UiNavigatePromptProps = {
  /** The external client that asked for the navigation, named as the frame carried it. */
  requester: string;
  /** The target session's title, or null when it could not be resolved. */
  sessionTitle: string | null;
  /** Where the request wants the transcript placed; null means "the latest messages". */
  target: UiNavigateTarget | null;
  /** Opens the session and places the transcript, once. */
  onJump: () => void;
  /** Refuses this navigation only. */
  onIgnore: () => void;
  /** Makes `accept` this device's policy and jumps now. */
  onAlwaysAccept: () => void;
  /** Makes `reject` this device's policy and refuses now. */
  onAlwaysReject: () => void;
};

/**
 * Used by the chat module's ChatInterface to show an incoming MCP navigation
 * request that this device's `ask` policy wants confirmed before it acts.
 *
 * The bar is deliberately non-blocking: it is one line above the transcript with
 * plain buttons, not a modal, because the request is a convenience rather than an
 * interruption the user has to clear before continuing to type. That is also why
 * every answer — including the two that rewrite the device policy — is a single
 * click, with the settings change named on the button's own line rather than
 * hidden behind it.
 */
/**
 * The `uiNavigate` key naming what the request wants placed.
 *
 * One label per target family so the bar tells the user whether this opens a
 * session at its tail, jumps to one message or turn, or reveals a diff or a task
 * — a request that says only "jump" would not say what it is about to change.
 */
function targetLabelKey(target: UiNavigateTarget | null): string {
  if (!target || 'latest' in target) {
    return 'uiNavigate.atLatest';
  }
  if ('messageId' in target) {
    return 'uiNavigate.atMessage';
  }
  if ('turnId' in target) {
    return 'uiNavigate.atTurn';
  }
  if ('diffFile' in target) {
    return 'uiNavigate.atDiff';
  }
  return 'uiNavigate.atTask';
}

export function UiNavigatePrompt({
  requester,
  sessionTitle,
  target,
  onJump,
  onIgnore,
  onAlwaysAccept,
  onAlwaysReject,
}: UiNavigatePromptProps) {
  const { t } = useTranslation('chat');

  return (
    <div
      role="status"
      data-testid="ui-navigate-prompt"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-card/95 px-3 py-2 text-foreground shadow-sm"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{t('uiNavigate.title')}</p>
        <p className="truncate text-xs text-muted-foreground">
          {t('uiNavigate.requester', { name: requester })}
          {' · '}
          {sessionTitle
            ? t('uiNavigate.targetSession', { title: sessionTitle })
            : t('uiNavigate.unknownSession')}
          {' · '}
          {t(targetLabelKey(target))}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="ui-navigate-jump"
          onClick={onJump}
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t('uiNavigate.jump')}
        </button>
        <button
          type="button"
          data-testid="ui-navigate-ignore"
          onClick={onIgnore}
          className="rounded-md border border-border/60 px-2.5 py-1 text-xs hover:bg-accent"
        >
          {t('uiNavigate.ignore')}
        </button>
        {/* Named on this line because both buttons below change this device's
            saved policy, and a control that silently rewrites a setting is the
            kind of surprise the user should not have to discover later. */}
        <span className="text-xs text-muted-foreground">{t('uiNavigate.settingsHint')}</span>
        <button
          type="button"
          data-testid="ui-navigate-always-accept"
          onClick={onAlwaysAccept}
          className="rounded-md border border-border/60 px-2.5 py-1 text-xs hover:bg-accent"
        >
          {t('uiNavigate.alwaysAccept')}
        </button>
        <button
          type="button"
          data-testid="ui-navigate-always-reject"
          onClick={onAlwaysReject}
          className="rounded-md border border-border/60 px-2.5 py-1 text-xs hover:bg-accent"
        >
          {t('uiNavigate.alwaysReject')}
        </button>
      </div>
    </div>
  );
}

export default UiNavigatePrompt;

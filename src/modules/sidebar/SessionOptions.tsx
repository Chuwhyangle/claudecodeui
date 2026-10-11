import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Edit2, EyeOff, GitBranch, Info, MoreHorizontal, PowerOff, Timer, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider } from '@/shared/types';
import { useResidentProviders, useSessionForkingProviders } from '@/shared/hooks/useProviderCapabilities';
import { api } from '@/shared/api';
import { useProviderSessionIdCopy } from '@/modules/sidebar/hooks/useProviderSessionIdCopy';
import { PROVIDER_LABELS } from '@/modules/sidebar/utils/sidebarProjectFormatting';

type SessionOptionsProps = {
  sessionId: string;
  sessionName: string;
  provider: LLMProvider;
  /**
   * The project that owns the session. Null where the row does not know it, in
   * which case rename is withheld rather than guessed — it is keyed by project.
   */
  projectId: string | null;
  /** A running session cannot be deleted or forked, matching the Projects row. */
  isProcessing: boolean;
  isEditing: boolean;
  renameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectId: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Bound by the caller, which owns the session object the fork needs. */
  onFork?: () => void;
  /** Opens the project's session filter seeded from this name; withheld where the row cannot reach that editor. */
  onHideSimilar?: (sessionName: string) => void;
  /** Withheld where the row has nowhere to send a delete. */
  canDelete?: boolean;
  className?: string;
  t: TFunction;
};

/**
 * A session row's controls: the options menu, and the inline rename that
 * replaces it while a rename is open.
 *
 * Shared by the Projects list and the Conversations list so the two rows cannot
 * drift — the first cut of the Conversations row copied this markup, which is
 * how two rows end up diverging one fix at a time. Callers keep only what is
 * genuinely theirs: where the controls sit, and whether deleting is offered.
 */
export default function SessionOptions({
  sessionId,
  sessionName,
  provider,
  projectId,
  isProcessing,
  isEditing,
  renameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onDeleteSession,
  onFork,
  onHideSimilar,
  canDelete = true,
  className,
  t,
}: SessionOptionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const providerLabel = PROVIDER_LABELS[provider];
  const { copyState, copyLabel, setOptionsOpen, handleCopyAction, isCopyPending, CopyStateIcon } =
    useProviderSessionIdCopy(sessionId, providerLabel);

  // Read from the backend capability matrix rather than branching on the
  // provider id here; the request is cached module-side, so every row shares one.
  const forkableProviders = useSessionForkingProviders();
  const canFork = Boolean(onFork) && forkableProviders.has(provider) && !isProcessing;
  // The same matrix answers the resident question, through the same kind of hook.
  const residentProviders = useResidentProviders();
  // In-flight conversion, so the item cannot be fired twice while the server decides.
  const [residentConverting, setResidentConverting] = useState(false);
  // A refused conversion (a live host mid-turn, most likely). Held so the item can say so instead of
  // resting there as though nothing had been asked of it.
  const [residentFailed, setResidentFailed] = useState(false);
  // The session's stored lifecycle mode, read when the menu opens. The workspace's own
  // session objects carry no mode — the projects listing drops the column — so the host
  // listing is the only place this menu can learn whether the session is resident, and
  // it answers per session row rather than per process: a resident session that was
  // never started has no host and still reads `resident`.
  const [sessionLifecycleMode, setSessionLifecycleMode] = useState<string | null>(null);
  // In-flight mode change, so the item cannot be fired twice while the server decides.
  const [residentClosing, setResidentClosing] = useState(false);
  // A refused change — a live host mid-turn, most likely. Held so the item can say so
  // instead of resting there as though nothing had been asked of it.
  const [residentCloseFailed, setResidentCloseFailed] = useState(false);
  // Whether this row should offer the conversion at all: the matrix lists the provider, and the
  // session is not already resident — converting a resident session to resident is a no-op the
  // server answers with `changed: false`, and the way out of the mode is the item below, not this one.
  // Read by the menu item and by the hint beside it, so the two cannot come apart. Derived, never
  // stored: a second copy of this answer could disagree with the item it is meant to sit beside.
  const canConvertResident = residentProviders.has(provider) && sessionLifecycleMode !== 'resident';
  // The disclosure's sentences are chat's, not this module's: they are the same two facts the chat
  // entry points state, and sharing the keys is what keeps the three entry points from drifting into
  // three different disclosures. Only the menu's own wording lives in the sidebar namespace.
  const { t: tChat } = useTranslation('chat');

  const convertToResident = async () => {
    setResidentConverting(true);
    setResidentFailed(false);
    try {
      const response = await api.providers.setSessionLifecycleMode(provider, sessionId, 'resident');
      if (!response.ok) {
        throw new Error(`Failed to convert session to resident (${response.status})`);
      }
      // The listing is the only thing that knows this row's mode, and it has just changed: without
      // this the menu would go on offering the conversion that has already happened.
      setSessionLifecycleMode('resident');
    } catch (error) {
      console.error('Resident conversion failed:', error);
      setResidentFailed(true);
    } finally {
      setResidentConverting(false);
    }
  };

  const readSessionLifecycleMode = async () => {
    try {
      const response = await api.sessionHostState(sessionId);
      if (!response.ok) return;
      const body = (await response.json()) as {
        data?: { sessions?: { appSessionId?: string; lifecycleMode?: string }[] };
      };
      const row = body.data?.sessions?.find((entry) => entry.appSessionId === sessionId);
      // A row the listing does not know is per-run: the mode column's own default, and
      // the reading that keeps the ordinary session's menu ordinary.
      setSessionLifecycleMode(row?.lifecycleMode ?? 'per-run');
    } catch (error) {
      console.error('Error reading the session lifecycle mode:', error);
    }
  };

  const closeResidentMode = async () => {
    setResidentClosing(true);
    setResidentCloseFailed(false);
    try {
      const response = await api.providers.setSessionLifecycleMode(provider, sessionId, 'per-run');
      if (!response.ok) {
        throw new Error(`Failed to close resident mode (${response.status})`);
      }
      setSessionLifecycleMode('per-run');
    } catch (error) {
      console.error('Closing resident mode failed:', error);
      setResidentCloseFailed(true);
    } finally {
      setResidentClosing(false);
    }
  };

  // While editing, dismiss only when the click lands outside the rename panel,
  // matching Escape and the cancel button.
  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const container = containerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onCancelEditingSession();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isEditing, onCancelEditingSession]);

  const saveRename = () => {
    if (projectId === null) {
      onCancelEditingSession();
      return;
    }
    onSaveEditingSession(projectId, sessionId, renameDraft, provider);
  };

  return (
    <div ref={containerRef} className={cn('flex items-center gap-1', className)}>
      {isEditing ? (
        <>
          <input
            type="text"
            value={renameDraft}
            onChange={(event) => onRenameDraftChange(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                saveRename();
              } else if (event.key === 'Escape') {
                onCancelEditingSession();
              }
            }}
            onClick={(event) => event.stopPropagation()}
            className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
          <button
            className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
            onClick={(event) => {
              event.stopPropagation();
              saveRename();
            }}
            title={t('tooltips.save')}
          >
            <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
            onClick={(event) => {
              event.stopPropagation();
              onCancelEditingSession();
            }}
            title={t('tooltips.cancel')}
          >
            <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
          </button>
        </>
      ) : (
        <ActionMenu
          label="Session options"
          ariaLabel={`Session options for ${sessionName}`}
          icon={MoreHorizontal}
          iconOnly
          portal
          variant="ghost"
          size="icon"
          onOpenChange={(open) => {
            setOptionsOpen(open);
            if (open) {
              // Read on open rather than on mount: a sidebar of rows would otherwise
              // fetch the listing once per row, and the answer only matters here.
              void readSessionLifecycleMode();
            } else {
              // A closed menu takes its complaint about the last attempt with it, so a reopened
              // menu does not report a failure the user has already moved on from.
              setResidentFailed(false);
              setResidentCloseFailed(false);
            }
          }}
          triggerClassName="h-7 w-7 text-muted-foreground opacity-70 hover:bg-muted hover:opacity-100"
          menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
          header={(
            <div className="mb-1 border-b border-border px-3 py-2">
              <p className="truncate text-xs font-medium text-foreground" title={sessionName}>
                {sessionName}
              </p>
              <div className="mt-0.5 flex items-center gap-1">
                <p className="text-[11px] text-muted-foreground">{providerLabel} session</p>
                {/*
                  The disclosure, as a hint rather than a step.

                  It sits in the header, beside the conversion item it explains, for the reason the
                  panel it replaced did: the row lives in a scrolling, clipped list and anything
                  hanging out of it would be cut off. It is drawn exactly when the item is offered,
                  from the same `canConvertResident`, so an explanation of an action that is not on
                  the menu is not left on it.

                  Its markup is written out here rather than imported from the chat module's
                  `ResidentConsentNotice`, which draws the same hint beside the chat-side switches:
                  a feature module may not deep-import another's components, and the shared i18n keys
                  below are what actually holds the three entry points to the same sentences.

                  Nothing here gates anything. Choosing the menu item converts, there and then.
                */}
                {canConvertResident && (
                  <Tooltip
                    content={(
                      <span
                        data-slot="resident-hint-content"
                        className="block max-w-xs whitespace-normal text-left leading-5"
                      >
                        <span className="block">{tChat('resident.notice.bypass')}</span>
                        <span className="mt-1 block">{tChat('resident.notice.trustBoundary')}</span>
                      </span>
                    )}
                  >
                    <button
                      type="button"
                      data-slot="resident-consent-notice"
                      aria-label={tChat('resident.notice.title')}
                      title={tChat('resident.notice.title')}
                      className="inline-flex items-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
          )}
          items={[
            ...(projectId !== null ? [{
              key: 'rename',
              label: 'Rename session',
              icon: Edit2,
              onSelect: () => onStartEditingSession(projectId, sessionId, sessionName),
            }] : []),
            {
              key: 'copy',
              label: copyLabel,
              description: copyState === 'error' ? 'Click to try again.' : undefined,
              icon: CopyStateIcon,
              loading: isCopyPending,
              closeOnSelect: false,
              onSelect: handleCopyAction,
            },
            // Offered only to a session that is not already resident — `canConvertResident` is that
            // rule, shared with the hint beside it.
            ...(canConvertResident ? [{
              key: 'convert-to-resident',
              label: t('sessionMenu.convertToResident'),
              // The failure replaces the hint rather than sitting under it: the row is one line of
              // description wide, and a refused conversion is what the user needs to read there.
              description: residentFailed
                ? t('sessionMenu.residentConsentFailed')
                : t('sessionMenu.convertToResidentHint'),
              icon: Timer,
              // The menu stays open on selection so the item can say the conversion failed where it
              // happened, rather than closing as though it had worked. On success the item itself is
              // replaced by the one that closes the mode — a visible answer either way.
              closeOnSelect: false,
              // Present but unusable while a turn is in flight — the server refuses a mode change
              // under a live host, and offering the action would promise something it cannot keep.
              disabled: isProcessing || residentConverting,
              loading: residentConverting,
              // One click converts. The disclosure in the header above is read-only and asks for
              // nothing, so there is no step between choosing this and the session becoming resident.
              onSelect: () => { void convertToResident(); },
            }] : []),
            // The way back out. The Shell tab's closure is what a resident session costs, so
            // the same menu has to be able to lift it — and the change takes effect without a
            // reload, because the workspace re-reads the mode rather than caching it.
            ...(sessionLifecycleMode === 'resident' ? [{
              key: 'close-resident-mode',
              label: t('sessionMenu.closeResidentMode'),
              description: residentCloseFailed
                ? t('sessionMenu.closeResidentModeFailed')
                : t('sessionMenu.closeResidentModeHint'),
              icon: PowerOff,
              // Stays open while the change is in flight, so a refusal is visible where it
              // happened rather than a menu that closed as if the mode had changed.
              closeOnSelect: false,
              disabled: isProcessing || residentClosing,
              loading: residentClosing,
              onSelect: () => { void closeResidentMode(); },
            }] : []),
            ...(canFork && onFork ? [{
              key: 'fork',
              label: 'Fork session',
              description: 'Continue from a copy, leaving this one untouched.',
              icon: GitBranch,
              onSelect: onFork,
            }] : []),
            ...(onHideSimilar ? [{
              key: 'hide-similar',
              label: t('sessionFilter.hideSimilar'),
              description: t('sessionFilter.hideSimilarHint'),
              icon: EyeOff,
              onSelect: () => onHideSimilar(sessionName),
            }] : []),
            ...(canDelete && !isProcessing ? [{
              key: 'delete',
              label: 'Archive or delete session',
              icon: Trash2,
              isDanger: true,
              showDividerBefore: true,
              onSelect: () => onDeleteSession(sessionId, sessionName),
            }] : []),
          ]}
        />
      )}
    </div>
  );
}

import { MessageSquare, Terminal, Folder, GitBranch, ClipboardCheck, Activity, Network, MonitorPlay, ChevronDown, type LucideIcon } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogTitle, DialogTrigger, Tooltip, PillBar, Pill } from '@/shared/ui';
import type { AppTab } from '@/shared/types';
import { usePlugins,PluginIcon } from '@/modules/plugins';

type WorkspaceTabsProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
  /** Optional so a caller that only knows about Tasks/Browser keeps compiling; absent means "no Quay tab". */
  shouldShowQuayTab?: boolean;
  /** Optional, absent means "no architecture tab", the same contract as `shouldShowQuayTab`. */
  shouldShowArchitectureTab?: boolean;
  shouldShowBrowserTab: boolean;
  /**
   * Whether the selected session asked to run as a resident process. A resident
   * session's Shell view would hand the user a terminal onto the very process the
   * mode exists to keep under the app's control, so the view is offered disabled
   * rather than silently removed — the user can see the tab exists and why it is
   * closed to this session.
   *
   * Optional, and absent means "not resident": only a caller that has read the
   * session's mode can close the tab, so the default has to be the open tab.
   */
  isResidentSession?: boolean;
};

/**
 * Id of the workspace-level notice that explains that closure. WorkspaceMain
 * renders the element; the tab points at it with `aria-describedby`, so the
 * reason travels with the tab itself instead of living only in a `title`, which
 * no touch device ever shows.
 */
export const RESIDENT_SHELL_NOTICE_ID = 'resident-shell-notice';

type ShellTabState = {
  className: string;
  disabled?: boolean;
  'aria-disabled'?: boolean;
  title?: string;
  'aria-describedby'?: string;
  'data-disabled-reason'?: string;
};

/**
 * The props that close the Shell tab to a resident session — or only its ordinary
 * class when the tab is open. Kept in one place because the desktop pill and the
 * mobile selector draw the same tab and must not disagree about whether it works.
 * `notice` is the sentence the disabled tab points at, already translated.
 */
function shellTabState(isResidentSession: boolean, tabId: AppTab, notice: string): ShellTabState {
  if (!(isResidentSession && tabId === 'shell')) {
    return { className: 'h-8 max-w-44 px-2.5 py-[5px]' };
  }

  return {
    disabled: true,
    'aria-disabled': true,
    title: notice,
    'aria-describedby': RESIDENT_SHELL_NOTICE_ID,
    'data-disabled-reason': 'resident',
    className: 'h-8 max-w-44 cursor-not-allowed px-2.5 py-[5px] opacity-50',
  };
}

// The icon class differs per kind, so the shared renderer takes both rather than
// one class that would have to be wrong for one of the two.
const BUILT_IN_ICON_CLASS = 'h-3.5 w-3.5 shrink-0';
const PLUGIN_ICON_CLASS = 'flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full';

type BuiltInTabSource = {
  id: AppTab;
  labelKey: string;
  /**
   * The label to render when the shipped locale bundles do not carry
   * `labelKey` yet. Without it react-i18next prints the raw key name, which is
   * how the Quay tab once shipped reading `tabs.quay`.
   */
  defaultLabel?: string;
  icon: LucideIcon;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  label: string;
  icon: LucideIcon;
};

type PluginTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

type WorkspaceTabDefinition = BuiltInTab | PluginTab;

const BASE_TABS: BuiltInTabSource[] = [
  { id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { id: 'files', labelKey: 'tabs.files', icon: Folder },
  { id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
];

const BROWSER_TAB: BuiltInTabSource = {
  id: 'browser',
  labelKey: 'tabs.browser',
  icon: MonitorPlay,
};

const TASKS_TAB: BuiltInTabSource = {
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

const QUAY_TAB: BuiltInTabSource = {
  id: 'quay',
  labelKey: 'tabs.quay',
  icon: Activity,
};

const ARCHITECTURE_TAB: BuiltInTabSource = {
  id: 'architecture',
  labelKey: 'tabs.architecture',
  defaultLabel: 'Architecture',
  icon: Network,
};

/**
 * The single source of truth for the workspace view list: the four built-in tabs,
 * the conditionally enabled Browser/Tasks tabs and every enabled plugin tab, each
 * carrying its already-translated label. Both the desktop pill bar and the mobile
 * selector read it, so neither can drift into a second copy of the list.
 */
function useWorkspaceTabDefinitions({ shouldShowTasksTab, shouldShowQuayTab, shouldShowArchitectureTab, shouldShowBrowserTab }: {
  shouldShowTasksTab: boolean;
  shouldShowQuayTab: boolean;
  shouldShowArchitectureTab: boolean;
  shouldShowBrowserTab: boolean;
}): { tabs: WorkspaceTabDefinition[]; builtInCount: number } {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const builtInSources = [
    ...BASE_TABS,
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
    ...(shouldShowQuayTab ? [QUAY_TAB] : []),
    // Right of Quay, as ADR-005 asks: the architecture view is about the
    // session's own files, so it sits after the project-level Quay dashboard.
    ...(shouldShowArchitectureTab ? [ARCHITECTURE_TAB] : []),
  ];

  const builtInTabs: BuiltInTab[] = builtInSources.map((tab) => ({
    kind: 'builtin',
    id: tab.id,
    label: tab.defaultLabel === undefined
      ? t(tab.labelKey)
      : t(tab.labelKey, { defaultValue: tab.defaultLabel }),
    icon: tab.icon,
  }));

  const pluginTabs: PluginTab[] = plugins
    .filter((p) => p.enabled)
    .map((p) => ({
      kind: 'plugin',
      id: `plugin:${p.name}` as AppTab,
      label: p.displayName,
      pluginName: p.name,
      iconFile: p.icon,
    }));

  return { tabs: [...builtInTabs, ...pluginTabs], builtInCount: builtInTabs.length };
}

/** Renders a workspace view's icon, built-in or plugin-supplied; used by both workspace view lists. */
function WorkspaceTabIcon({ tab, strokeWidth }: { tab: WorkspaceTabDefinition; strokeWidth?: number }) {
  if (tab.kind === 'plugin') {
    return <PluginIcon pluginName={tab.pluginName} iconFile={tab.iconFile} className={PLUGIN_ICON_CLASS} />;
  }

  return <tab.icon className={BUILT_IN_ICON_CLASS} strokeWidth={strokeWidth} />;
}

/** Rendered by WorkspaceHeader on desktop as the scrollable horizontal workspace tab bar. */
export default function WorkspaceTabs({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowQuayTab = false,
  shouldShowArchitectureTab = false,
  shouldShowBrowserTab,
  isResidentSession = false,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { tabs, builtInCount } = useWorkspaceTabDefinitions({ shouldShowTasksTab, shouldShowQuayTab, shouldShowArchitectureTab, shouldShowBrowserTab });
  // The sentence the disabled Shell tab points at. Read here so the `title` and the
  // notice element WorkspaceMain renders cannot disagree: both are this key.
  const residentShellNotice = t('tabs.shellResidentDisabled');

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabList = event.currentTarget.closest('[role="tablist"]');
    if (!tabList) return;

    const tabButtons = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    let nextIndex: number;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    else return;

    event.preventDefault();
    tabButtons[nextIndex]?.focus();
    tabButtons[nextIndex]?.click();
  };

  return (
    <PillBar
      role="tablist"
      aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
      className="min-w-max border border-border/40 bg-muted/50 shadow-inner shadow-black/[0.025] dark:shadow-black/10"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab;

        return (
          <Fragment key={`${tab.id}-${index}`}>
            {index === builtInCount && tabs.length > builtInCount && (
              <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
            )}
            <Tooltip content={tab.label} position="bottom">
              <Pill
                role="tab"
                aria-label={tab.label}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                isActive={isActive}
                // The shell cell's stable contract, on the desktop surface too: the same
                // hook the mobile selector carries, so a reading of "which view is this"
                // and of "why is it closed" does not have to go through translated text.
                data-workspace-tab={tab.id}
                // `aria-selected` is the tablist's own marker; `aria-current` is the
                // one every workspace surface shares, mobile rows included, so a
                // reader that is not a screen reader — `ui_visible_context` — can
                // ask "which view is this tab showing" with one selector on either
                // layout instead of knowing a different convention per layout.
                aria-current={isActive ? 'true' : undefined}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={handleTabKeyDown}
                {...shellTabState(isResidentSession, tab.id, residentShellNotice)}
              >
                <WorkspaceTabIcon tab={tab} strokeWidth={isActive ? 2.2 : 1.8} />
                <span className={`${isActive ? 'inline max-w-28' : 'hidden'} truncate md:max-w-36 lg:inline`}>
                  {tab.label}
                </span>
              </Pill>
            </Tooltip>
          </Fragment>
        );
      })}
    </PillBar>
  );
}

/**
 * Rendered by WorkspaceHeader on mobile, where the header is a single row: it shows
 * the active workspace and opens a bottom dialog listing every workspace view —
 * including each enabled plugin, which must stay reachable when the pill bar is
 * collapsed away.
 */
export function CollapsedWorkspaceSelector({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowQuayTab = false,
  shouldShowArchitectureTab = false,
  shouldShowBrowserTab,
  isResidentSession = false,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { tabs } = useWorkspaceTabDefinitions({ shouldShowTasksTab, shouldShowQuayTab, shouldShowArchitectureTab, shouldShowBrowserTab });
  // The same sentence the desktop pill carries: the dialog is the only way to reach
  // the Shell view on a narrow screen, so it has to close the view for the same
  // reason and say the same thing.
  const residentShellNotice = t('tabs.shellResidentDisabled');

  // Whether the workspace picker is open. The open state cannot be derived: the
  // trigger that has to report `aria-expanded` is rendered outside DialogContent,
  // so the dialog is controlled from here.
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const titleId = useId();

  const activeTabDefinition = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  const selectWorkspace = (id: AppTab) => {
    setActiveTab(id);
    setIsPickerOpen(false);
  };

  return (
    <Dialog open={isPickerOpen} onOpenChange={setIsPickerOpen}>
      {/*
        The trigger *is* this layout's statement of the active view: it shows the
        active view's icon and label, and it is the only thing on screen that
        names a view while the picker is closed. It therefore carries the same
        `data-workspace-tab`/`aria-current` pair as the rows inside the dialog —
        without it, a reading of "which view is this tab showing" returns nothing
        on every narrow screen, because the rows it would have read are in a
        dialog that is not open.
      */}
      <DialogTrigger
        // The trigger's visible text is gone (the pulse strip beside it needs the room), so the
        // accessible name has to carry the active view: without it the control would announce
        // only as "button".
        aria-label={activeTabDefinition.label}
        aria-haspopup="dialog"
        aria-expanded={isPickerOpen}
        data-workspace-tab={activeTabDefinition.id}
        aria-current="true"
        className="flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/50 px-2 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <WorkspaceTabIcon tab={activeTabDefinition} strokeWidth={2} />
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </DialogTrigger>

      <DialogContent
        aria-labelledby={titleId}
        className="bottom-0 left-0 top-auto max-w-full translate-x-0 translate-y-0 rounded-b-none rounded-t-xl pb-safe-area-inset-bottom"
      >
        <DialogTitle id={titleId} className="not-sr-only px-4 pb-2 pt-4 text-sm font-semibold">
          {t('tabs.views', { defaultValue: 'Workspace views' })}
        </DialogTitle>
        <div className="scrollbar-hide max-h-[70vh] overflow-y-auto px-2 pb-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              data-workspace-tab={tab.id}
              aria-current={tab.id === activeTab ? 'true' : undefined}
              {...(isResidentSession && tab.id === 'shell' ? {
                disabled: true,
                'aria-disabled': true,
                title: residentShellNotice,
                'aria-describedby': RESIDENT_SHELL_NOTICE_ID,
                'data-disabled-reason': 'resident',
              } : {})}
              onClick={() => selectWorkspace(tab.id)}
              className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
                isResidentSession && tab.id === 'shell' ? 'cursor-not-allowed opacity-50 hover:bg-transparent' : ''
              }`}
            >
              <WorkspaceTabIcon tab={tab} strokeWidth={2} />
              <span className="min-w-0 truncate">{tab.label}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

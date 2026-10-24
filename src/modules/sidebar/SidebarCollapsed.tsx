import { Settings, Sparkles, PanelLeftOpen, Bug, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';

import { DiscordIcon } from '@/shared/ui';
import SidebarModeSwitch from '@/modules/sidebar/SidebarModeSwitch';

const DISCORD_INVITE_URL = 'https://discord.gg/buxwujPNRE';
const GITHUB_ISSUES_URL = 'https://github.com/siteboon/claudecodeui/issues/new';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onShowSettings: () => void;
  updateAvailable: boolean;
  restartRequired: boolean;
  onShowVersionModal: () => void;
  /** The selected project, so the rail's mode switch can deep-link its registered board. */
  selectedProjectId?: string | null;
  t: TFunction;
};

/** Rendered by Sidebar instead of SidebarContent when the panel is collapsed to its icon rail. */
export default function SidebarCollapsed({
  onExpand,
  onShowSettings,
  updateAvailable,
  restartRequired,
  onShowVersionModal,
  selectedProjectId,
  t,
}: SidebarCollapsedProps) {
  return (
    <div className="flex h-full w-12 flex-col items-center gap-1 bg-background/80 py-3 backdrop-blur-sm">
      {/* Expand button with brand logo */}
      <button
        onClick={onExpand}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('common:versionUpdate.ariaLabels.showSidebar')}
        title={t('common:versionUpdate.ariaLabels.showSidebar')}
      >
        <PanelLeftOpen className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      {/* The same two-mode control the expanded header draws, stacked to fit the rail. */}
      <SidebarModeSwitch
        mode="sessions"
        selectedProjectId={selectedProjectId}
        layout="column"
        t={t}
      />

      <div className="nav-divider my-1 w-6" />

      {/* Settings */}
      <button
        onClick={onShowSettings}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('actions.settings')}
        title={t('actions.settings')}
      >
        <Settings className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      {/* Report Issue */}
      <a
        href={GITHUB_ISSUES_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('actions.reportIssue')}
        title={t('actions.reportIssue')}
      >
        <Bug className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </a>

      {/* Discord */}
      <a
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('actions.joinCommunity')}
        title={t('actions.joinCommunity')}
      >
        <DiscordIcon className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </a>

      {/* Restart-required indicator */}
      {restartRequired && (
        <div
          className="relative flex h-8 w-8 items-center justify-center rounded-lg"
          aria-label={t('version.restartRequired')}
          title={t('version.restartRequired')}
        >
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        </div>
      )}

      {/* Update indicator */}
      {updateAvailable && (
        <button
          onClick={onShowVersionModal}
          className="relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
          aria-label={t('common:versionUpdate.ariaLabels.updateAvailable')}
          title={t('common:versionUpdate.ariaLabels.updateAvailable')}
        >
          <Sparkles className="h-4 w-4 text-blue-500" />
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
        </button>
      )}
    </div>
  );
}

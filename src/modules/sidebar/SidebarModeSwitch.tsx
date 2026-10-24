import type { MouseEvent } from 'react';
import { LayoutDashboard, MessageSquare } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useHref, useInRouterContext, useLocation, useNavigate } from 'react-router-dom';

import { cn } from '@/shared/utils';
import {
  cockpitViewPath,
  readCockpitReturnPath,
  rememberCockpitReturnPath,
} from '@/modules/cockpit';
import { useFleetAttention } from '@/modules/sidebar/hooks/useFleetAttention';
import type { FleetAttentionReading } from '@/modules/sidebar/hooks/useFleetAttention';

/** Which of the app's two top-level surfaces a switch is showing. */
export type SidebarMode = 'sessions' | 'cockpit';

type SidebarModeSwitchProps = {
  /** The surface this instance is rendered on; its segment is the highlighted one. */
  mode: SidebarMode;
  /**
   * The selected CloudCLI project. When the fleet registry lists it, the cockpit segment
   * deep-links straight to that project's board instead of the fleet overview.
   */
  selectedProjectId?: string | null;
  /** `row` for the two headers and the mobile drawer, `column` for the collapsed icon rail. */
  layout?: 'row' | 'column';
  /** The owning module's translator; sidebar callers pass one whose default namespace is `sidebar`. */
  t: TFunction;
};

/** The cockpit link for a selection: the project's board when registered, else the fleet view. */
function cockpitPathForSelection(
  attention: FleetAttentionReading,
  selectedProjectId: string | null | undefined,
): string {
  const fleetProjectId =
    selectedProjectId === null || selectedProjectId === undefined
      ? undefined
      : attention.fleetProjectIdByProject.get(selectedProjectId);
  return fleetProjectId === undefined
    ? cockpitViewPath({ type: 'fleet' })
    : cockpitViewPath({ type: 'board', project: fleetProjectId });
}

/** True for a click the browser should handle itself (new tab/window/download). */
function isModifiedClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

type ModeSwitchViewProps = {
  mode: SidebarMode;
  layout: 'row' | 'column';
  sessionsHref: string;
  cockpitHref: string;
  attention: FleetAttentionReading;
  onSelect: (mode: SidebarMode, event: MouseEvent<HTMLAnchorElement>) => void;
  t: TFunction;
};

/**
 * The presentational switch. Two real `<a href>` segments, because the cockpit is routinely
 * parked on a second screen: Ctrl/middle-click must open it in another tab, which only an
 * anchor can do. The active segment carries `aria-current="page"`.
 */
function ModeSwitchView({
  mode,
  layout,
  sessionsHref,
  cockpitHref,
  attention,
  onSelect,
  t,
}: ModeSwitchViewProps) {
  const sessionsLabel = t('common:cockpit.modeSessions', 'Sessions');
  const cockpitLabel = t('common:cockpit.modeCockpit', 'Cockpit');
  const switchLabel = t('common:cockpit.modeSwitchLabel', 'Switch between sessions and cockpit');
  const isColumn = layout === 'column';

  // The badge's accessible name has to carry the unit: read aloud on its own, "3" says
  // nothing. `{{n}}` (not i18next's plural-aware `{{count}}`) keeps one string for 1 and 99.
  const attentionLabel = t('common:cockpit.attentionBadge', {
    n: attention.needsHumanTotal,
    defaultValue: '{{n}} project items need you',
  });
  const attentionWarning = t('common:cockpit.attentionUnavailable', {
    reason: attention.fleetReason ?? '',
    defaultValue: 'Attention unavailable: {{reason}}',
  });
  const badgeText = attention.needsHumanTotal > 99 ? '99+' : String(attention.needsHumanTotal);
  // `ok` is the only state that needs no explanation; `null` is an older server that said
  // nothing, and inventing a warning from silence would put a grey dot on every deployment.
  const showFleetWarning = attention.fleetState !== null && attention.fleetState !== 'ok';

  const segmentClass = (active: boolean): string =>
    cn(
      'relative flex items-center justify-center rounded-md text-muted-foreground transition-all',
      isColumn ? 'h-11 w-11' : 'min-h-11 min-w-11 md:min-h-8 md:min-w-8 md:px-1.5',
      active
        ? 'bg-background text-foreground shadow-sm'
        : 'hover:text-foreground hover:bg-accent/60',
    );

  return (
    <div
      role="group"
      aria-label={switchLabel}
      data-testid="sidebar-mode-switch"
      data-sidebar-mode={mode}
      data-layout={layout}
      className={cn(
        'flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5',
        isColumn ? 'flex-col' : 'flex-row',
      )}
    >
      <a
        href={sessionsHref}
        onClick={(event) => onSelect('sessions', event)}
        aria-current={mode === 'sessions' ? 'page' : undefined}
        aria-label={sessionsLabel}
        title={sessionsLabel}
        data-mode-switch-link="sessions"
        className={segmentClass(mode === 'sessions')}
      >
        <MessageSquare className="h-3.5 w-3.5" aria-hidden />
      </a>

      <a
        href={cockpitHref}
        onClick={(event) => onSelect('cockpit', event)}
        aria-current={mode === 'cockpit' ? 'page' : undefined}
        aria-label={cockpitLabel}
        title={cockpitLabel}
        data-mode-switch-link="cockpit"
        className={segmentClass(mode === 'cockpit')}
      >
        <LayoutDashboard className="h-3.5 w-3.5" aria-hidden />
        {attention.needsHumanTotal > 0 && (
          <span
            role="status"
            aria-label={attentionLabel}
            data-testid="cockpit-attention-badge"
            // A count is the one state that asks the person to act: amber, at the badge's own
            // corner, never the wide decorative chip that would compete with the tile's icon.
            className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[8px] font-semibold leading-none text-white shadow-sm ring-1 ring-background"
          >
            <span aria-hidden>{badgeText}</span>
          </span>
        )}
        {showFleetWarning && (
          <span
            data-testid="cockpit-attention-dot"
            title={attentionWarning}
            className="absolute -right-0 -top-0 h-2 w-2 rounded-full bg-gray-400 ring-1 ring-background dark:bg-gray-500"
          />
        )}
      </a>
    </div>
  );
}

/** In-router rendering: real hrefs through the deployment basename, and in-app navigation. */
function RoutedModeSwitch({
  mode,
  selectedProjectId,
  layout,
  attention,
  t,
}: SidebarModeSwitchProps & { layout: 'row' | 'column'; attention: FleetAttentionReading }) {
  const location = useLocation();
  const navigate = useNavigate();
  // In sessions mode the sessions segment points at the page already open (a no-op that keeps
  // the current view); the cockpit segment remembers where it came from. In cockpit mode the
  // roles swap: sessions leads back to the remembered route, or home.
  const sessionsPath =
    mode === 'cockpit' ? readCockpitReturnPath() : `${location.pathname}${location.search}`;
  const cockpitPath = cockpitPathForSelection(attention, selectedProjectId);
  const sessionsHref = useHref(sessionsPath);
  const cockpitHref = useHref(cockpitPath);

  const handleSelect = (selected: SidebarMode, event: MouseEvent<HTMLAnchorElement>) => {
    // A modified click belongs to the browser (new tab/window). Record the return route first
    // so the tab the cockpit opens in still knows where the person was.
    if (selected === 'cockpit') {
      rememberCockpitReturnPath(`${location.pathname}${location.search}`);
    }
    if (isModifiedClick(event)) return;
    event.preventDefault();
    navigate(selected === 'cockpit' ? cockpitPath : sessionsPath);
  };

  return (
    <ModeSwitchView
      mode={mode}
      layout={layout}
      sessionsHref={sessionsHref}
      cockpitHref={cockpitHref}
      attention={attention}
      onSelect={handleSelect}
      t={t}
    />
  );
}

/**
 * Rendering outside a router (legacy unit renders of the header): same visual, plain hrefs,
 * no navigation interception. Production always mounts this under `App`'s router; the
 * fallback exists so the component is not the reason a header test needs a router.
 */
function PlainModeSwitch({
  mode,
  selectedProjectId,
  layout,
  attention,
  t,
}: SidebarModeSwitchProps & { layout: 'row' | 'column'; attention: FleetAttentionReading }) {
  const currentPath =
    typeof window === 'undefined'
      ? '/'
      : `${window.location.pathname}${window.location.search}`;
  return (
    <ModeSwitchView
      mode={mode}
      layout={layout}
      sessionsHref={mode === 'cockpit' ? readCockpitReturnPath() : currentPath}
      cockpitHref={cockpitPathForSelection(attention, selectedProjectId)}
      attention={attention}
      onSelect={() => undefined}
      t={t}
    />
  );
}

/**
 * Used by the sidebar header, the collapsed rail, the mobile drawer and the cockpit header —
 * one control, so 「how do I get to the other mode」 has one answer wherever a person is.
 */
export default function SidebarModeSwitch({
  mode,
  selectedProjectId,
  layout = 'row',
  t,
}: SidebarModeSwitchProps) {
  const attention = useFleetAttention();
  const inRouter = useInRouterContext();
  return inRouter ? (
    <RoutedModeSwitch
      mode={mode}
      selectedProjectId={selectedProjectId}
      layout={layout}
      attention={attention}
      t={t}
    />
  ) : (
    <PlainModeSwitch
      mode={mode}
      selectedProjectId={selectedProjectId}
      layout={layout}
      attention={attention}
      t={t}
    />
  );
}

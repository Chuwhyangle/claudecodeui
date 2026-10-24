import type { QuayFleetCliState } from '@/shared/types';
import { useFleetSummaryReading } from '@/modules/sidebar/hooks/useFleetTaskCounts';

/**
 * The fleet-wide attention reading behind the sidebar mode switch's badge.
 *
 * Summed over every registered project rather than per row: the badge answers "does anything
 * anywhere need me", so a person who is not looking at the owning project's row can still see
 * it. The raw fleet state travels with the count so an unreadable fleet draws a stated grey dot
 * instead of a silent zero.
 */
export type FleetAttentionReading = {
  /** `loading` only before the first fleet answer; a later failure keeps the last count. */
  status: 'loading' | 'loaded' | 'error';
  /** The needs-human total across all projects in the fleet summary. */
  needsHumanTotal: number;
  /** The CLI locator's state; `null` when the server did not report one (an older server). */
  fleetState: QuayFleetCliState | null;
  /** The locator's stated reason, shown in the grey dot's tooltip. */
  fleetReason: string | null;
  /** projectId → quay-fleet registry id, for deep-linking a project into the cockpit. */
  fleetProjectIdByProject: ReadonlyMap<string, string>;
};

/**
 * Used by `SidebarModeSwitch` (in the sidebar header, the collapsed rail, the mobile drawer
 * and the cockpit header) and by `SidebarProjectItem` for its 「在驾驶舱中查看」 link.
 *
 * Both read the SAME module-level store as `useFleetTaskCounts`, so the whole sidebar still
 * issues one request per 60-second poll and polls nothing while the tab is hidden.
 */
export function useFleetAttention(): FleetAttentionReading {
  return useFleetSummaryReading();
}

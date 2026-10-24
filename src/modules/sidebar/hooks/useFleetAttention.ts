import { useMemo } from 'react';

import type { QuayFleetCliState } from '@/shared/types';
import { useFleetSummaryReading } from '@/modules/sidebar/hooks/useFleetTaskCounts';

/** One registered project that has work waiting for a person, named the way the fleet names it. */
export type FleetAttentionProject = {
  /** The quay-fleet registry id (`quay-fleet`, `archguard`, …), never the CloudCLI UUID. */
  name: string;
  /** How many of this project's tasks need a person. */
  needsHuman: number;
};

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
  /**
   * The registered projects that actually have needs-human tasks, most first. The badge's
   * tooltip and accessible name list these so a count can be traced to the project that
   * produced it instead of standing for an unidentifiable fleet-wide number.
   */
  attentionByProject: readonly FleetAttentionProject[];
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
  const reading = useFleetSummaryReading();
  // Derived from the same one snapshot the sidebar already polls: no extra request, and the
  // list can only name projects the cockpit can actually open (registered ones).
  const attentionByProject = useMemo(() => {
    const waiting: FleetAttentionProject[] = [];
    for (const [projectId, name] of reading.fleetProjectIdByProject) {
      const needsHuman = reading.countsByProject.get(projectId)?.needsHuman ?? 0;
      if (needsHuman > 0) waiting.push({ name, needsHuman });
    }
    // Most first; `sort` is stable, so equal counts keep the fleet's own order.
    return waiting.sort((left, right) => right.needsHuman - left.needsHuman);
  }, [reading.countsByProject, reading.fleetProjectIdByProject]);

  return { ...reading, attentionByProject };
}

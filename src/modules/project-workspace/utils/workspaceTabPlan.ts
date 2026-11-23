/**
 * The desktop tab strip's layout rule, React-free so the header only measures and renders.
 *
 * Given every tab's measured width (with and without its word) and the room the header has,
 * it decides which tabs show their word and which fall behind the overflow menu. The decision
 * degrades in four steps, never all-or-nothing:
 *
 *   full     every tab spells its name
 *   partial  the active tab and the highest-priority tabs spell theirs, the rest are icons
 *   icon     only the active tab spells its name
 *   overflow the lowest-priority tabs leave the strip for the overflow menu
 *
 * Priority is fixed (not usage-ranked) so the strip does not rearrange itself while it is used.
 */

/**
 * Tab ids from most to least important; plugin tabs (any id not listed) rank after all of them.
 *
 * `api-speed` is registered LAST deliberately: it is a diagnostic view of this
 * machine's gateway link rather than a place work happens, so it is the first
 * label to lose its word and the first tab to leave the strip for the overflow
 * menu. Listing it explicitly (rather than leaving it as an unknown id) keeps
 * that rank from being decided by its display position among the plugin tabs.
 */
const BUILT_IN_PRIORITY: readonly string[] = ['chat', 'quay', 'files', 'git', 'goals', 'architecture', 'tasks', 'browser', 'shell', 'api-speed'];

/** Gap `PillBar` draws between two neighbouring pills. */
const GAP_PX = 2;
/** The strip's own padding (3px each side) plus its 1px border (each side). */
const STRIP_CHROME_PX = 8;
/** The plugin divider: `mx-1` plus its 1px rule. The gap on either side is counted as slots. */
const DIVIDER_PX = 9;
/** The overflow trigger is an icon-only pill: the same width as any icon-only tab. */
const OVERFLOW_TRIGGER_PX = 34;
/** Slack kept between the room and the strip so a rounding error never clips the last pill. */
const ROOM_SLACK_PX = 4;
/** Extra room a richer layout must have before the strip upgrades to it, so a drag does not flicker. */
const UPGRADE_HYSTERESIS_PX = 12;

/** The gap between a tab's icon and its word; subtracted to derive an icon-only pill's width. */
export const TAB_LABEL_GAP_PX = 6;

/** One tab as measured on the off-screen full-label copy, in display order. */
export type WorkspaceTabMeasure = {
  id: string;
  fullWidth: number;
  iconWidth: number;
};

/** Which tabs spell their name and which sit behind the overflow menu. */
export type WorkspaceTabPlan = {
  level: 'full' | 'partial' | 'icon' | 'overflow';
  labelledIds: readonly string[];
  overflowIds: readonly string[];
};

type PlanInput = {
  tabs: readonly WorkspaceTabMeasure[];
  activeId: string;
  available: number;
};

const isPlugin = (id: string): boolean => id.startsWith('plugin:');

function priorityRank(id: string): number {
  const index = BUILT_IN_PRIORITY.indexOf(id);
  return index === -1 ? BUILT_IN_PRIORITY.length : index;
}

/** Ids by importance, the active tab first. The sort is stable, so plugins keep display order. */
function idsByImportance(tabs: readonly WorkspaceTabMeasure[], activeId: string): string[] {
  return tabs
    .map((tab) => tab.id)
    .sort((a, b) => (a === activeId ? -1 : b === activeId ? 1 : priorityRank(a) - priorityRank(b)));
}

function stripWidth(
  tabs: readonly WorkspaceTabMeasure[],
  visible: ReadonlySet<string>,
  labelled: ReadonlySet<string>,
  hasOverflow: boolean,
): number {
  const shown = tabs.filter((tab) => visible.has(tab.id));
  let width = STRIP_CHROME_PX;
  for (const tab of shown) width += labelled.has(tab.id) ? tab.fullWidth : tab.iconWidth;
  const slots = shown.length + (hasOverflow ? 1 : 0);
  width += GAP_PX * Math.max(0, slots - 1);
  if (hasOverflow) width += OVERFLOW_TRIGGER_PX;
  if (shown.some((tab) => isPlugin(tab.id)) && shown.some((tab) => !isPlugin(tab.id))) width += DIVIDER_PX;
  return width;
}

function levelOf(total: number, labelledCount: number, overflowCount: number): WorkspaceTabPlan['level'] {
  if (overflowCount > 0) return 'overflow';
  if (labelledCount >= total) return 'full';
  return labelledCount <= 1 ? 'icon' : 'partial';
}

function choosePlan({ tabs, activeId, available }: PlanInput): WorkspaceTabPlan {
  const everyId = tabs.map((tab) => tab.id);
  const all = new Set(everyId);
  const order = idsByImportance(tabs, activeId);
  const make = (visible: ReadonlySet<string>, labelled: ReadonlySet<string>): WorkspaceTabPlan => {
    const overflowIds = everyId.filter((id) => !visible.has(id));
    const labelledIds = everyId.filter((id) => labelled.has(id));
    return { level: levelOf(everyId.length, labelledIds.length, overflowIds.length), labelledIds, overflowIds };
  };

  // A 0 reading is "not laid out yet" (jsdom, or before layout), never "no room": treating it as
  // no room would open the header icon-only and flash to full labels once layout landed.
  const unmeasured = available <= 0 || tabs.every((tab) => tab.fullWidth <= 0);
  if (unmeasured || stripWidth(tabs, all, all, false) <= available) return make(all, all);

  // The active tab always spells its name; labels then return one by one in priority order and
  // stop at the first that does not fit, so the labelled set is always a priority prefix.
  const labelled = new Set<string>(everyId.includes(activeId) ? [activeId] : []);
  if (stripWidth(tabs, all, labelled, false) <= available) {
    for (const id of order) {
      if (labelled.has(id)) continue;
      const next = new Set(labelled).add(id);
      if (stripWidth(tabs, all, next, false) > available) break;
      labelled.add(id);
    }
    return make(all, labelled);
  }

  // Icons alone do not fit: tabs leave the strip from the least important end.
  const visible = new Set<string>();
  for (const id of order) {
    const next = new Set(visible).add(id);
    const fits = stripWidth(tabs, next, labelled, next.size < everyId.length) <= available;
    if (!fits && visible.size > 0) break;
    visible.add(id);
  }
  return make(visible, labelled);
}

/** How much a plan shows: visible tabs dominate, spelled names break the tie. */
function richness(plan: WorkspaceTabPlan, total: number): number {
  return (total - plan.overflowIds.length) * 1000 + plan.labelledIds.length;
}

/**
 * Used by WorkspaceHeader to choose the strip's layout from its measured room. `previous` is the
 * plan currently on screen: a plan that shows MORE than it needs this much extra room, so a
 * window drag across a boundary does not flip the strip back and forth.
 */
export function planWorkspaceTabs(input: PlanInput, previous: WorkspaceTabPlan | null): WorkspaceTabPlan {
  const fresh = choosePlan({ ...input, available: input.available - ROOM_SLACK_PX });
  if (previous === null) return fresh;
  const total = input.tabs.length;
  if (richness(fresh, total) <= richness(previous, total)) return fresh;
  return choosePlan({ ...input, available: input.available - ROOM_SLACK_PX - UPGRADE_HYSTERESIS_PX });
}

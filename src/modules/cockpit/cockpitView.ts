import type { QuayDriverState, QuayFleetTaskCounts, QuayViewContract } from '@/shared/types';
import { formatQuayUri } from '@/modules/quay';

/**
 * The cockpit's serializable view description and the small contract types it shares with the
 * rest of the module.
 *
 * WHY THESE TYPES LIVE HERE, NOT IN `src/shared/types.ts`. The cockpit is the only consumer of
 * its view description, its project projection and its latency reading; nothing outside
 * `src/modules/cockpit/` imports them. Keeping them beside the parser/formatter that defines
 * them means one file owns the grammar, and the module barrel is the only way in from outside.
 */

/**
 * One quay project as the cockpit's project strip and fleet tiles show it: identity, the
 * display name derived from the project path, the driver reading and the fleet task counts.
 * Built from one entry of `GET /api/quay/fleet-summary`.
 */
export type CockpitProject = {
  projectId: string;
  /** Display name — the project path's last segment, falling back to the id for a bare path. */
  name: string;
  projectPath: string;
  driverState: QuayDriverState;
  tasks: QuayFleetTaskCounts;
  /** True when the fleet reading for this project was served from the backend's TTL cache. */
  cached: boolean;
  /** The backend's stated reason when this project's reading failed; `null` on success. */
  error: string | null;
};

/**
 * What the cockpit stage currently shows. Two views ship in this task:
 *
 *   { type: 'fleet' }                    — every quay project as a tile
 *   { type: 'board', project: <id> }     — one project's board / in-flight tasks
 *
 * The description is deliberately serializable: the URL carries exactly these fields, so a
 * view can be linked, reloaded and restored without any client-side registry.
 */
export type CockpitView = { type: 'fleet' } | { type: 'board'; project: string };

/**
 * One measured intent → first-frame latency. `source` names what caused the view change so the
 * future scenario runner can tell a typed intent apart from a key press or the initial URL.
 */
export type CockpitTiming = {
  source: 'intent' | 'key' | 'pointer' | 'url';
  /** The phrase or key that caused the change, verbatim, for the report. */
  input: string;
  /** Milliseconds from parsing the input to the new view's first committed render. */
  ms: number;
};

/** The top-level cockpit route; the view description travels in the query string. */
export const COCKPIT_PATH = '/cockpit';

/** Circled ordinals ①…⑳ — the short spoken label a focusable object carries, same as the Quay wall. */
const CIRCLED_ORDINALS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/**
 * The colour bucket a project tile is drawn in, derived from its driver reading, so 「红的那个」
 * over the fleet names a project whose driver is stale and never depends on CSS classes.
 */
const DRIVER_COLORS: Record<QuayDriverState, string> = {
  running: 'green',
  idle: 'blue',
  stale: 'amber',
  'not-configured': 'gray',
  unavailable: 'gray',
};

/**
 * Builds the fleet view's contract: one focusable per project, addressed as its board
 * (`quay://<project>/board`). The ordinal is the tile's spatial order — a single column, so
 * `pos.column` is always 1 — and is the same number the tile draws (①, ②, …), making 「第二个」
 * and the second tile the same object by construction.
 */
export function buildCockpitFleetContract(projects: readonly CockpitProject[]): QuayViewContract {
  return {
    focusables: projects.map((project, index) => ({
      uri: formatQuayUri({ type: 'board', project: project.projectId }),
      label: CIRCLED_ORDINALS[index] ?? `(${index + 1})`,
      display: {
        status: project.driverState,
        color: DRIVER_COLORS[project.driverState],
        ordinal: index + 1,
        pos: { row: index + 1, column: 1 },
      },
    })),
  };
}

const VIEW_QUERY_KEY = 'view';
const PROJECT_QUERY_KEY = 'project';

/**
 * The display name for a project: its path's last non-empty segment. A path that ends in a
 * separator, or one with no segments at all, falls back to the project id rather than showing
 * an empty tile.
 */
export function projectNameFromPath(projectPath: string, projectId: string): string {
  const segments = projectPath.split(/[\\/]+/).filter((segment) => segment !== '');
  return segments.length > 0 ? segments[segments.length - 1] : projectId;
}

/**
 * Parses the cockpit's query string into a view description.
 *
 * Every malformed or unknown reading falls back to the fleet view rather than throwing: the
 * URL is user-editable, and a broken link must still land on a usable stage. An unknown
 * `view` value and a `board` with no project are both "not a view I can render".
 */
export function parseCockpitView(search: string): CockpitView {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const viewType = params.get(VIEW_QUERY_KEY);
  if (viewType === 'board') {
    const project = params.get(PROJECT_QUERY_KEY)?.trim() ?? '';
    return project === '' ? { type: 'fleet' } : { type: 'board', project };
  }
  return { type: 'fleet' };
}

/**
 * Formats a view description as a query string (leading `?`), the inverse of
 * {@link parseCockpitView}: `parse(format(view))` returns `view` for every renderable view.
 * `URLSearchParams` owns the escaping, so a project id with a space or slash survives the
 * round trip unchanged.
 */
export function formatCockpitView(view: CockpitView): string {
  const params = new URLSearchParams();
  params.set(VIEW_QUERY_KEY, view.type);
  if (view.type === 'board') {
    params.set(PROJECT_QUERY_KEY, view.project);
  }
  return `?${params.toString()}`;
}

/** The full router path for a view description, used by `navigate` and by the link-out. */
export function cockpitViewPath(view: CockpitView): string {
  return `${COCKPIT_PATH}${formatCockpitView(view)}`;
}

/**
 * The `quay://` address of the view itself, for the status bar's fallback when no object is
 * focused (a board whose snapshot failed still names the board it is showing). The fleet view
 * has no `quay://` address — it is a CloudCLI-level view — so it returns `null`.
 */
export function cockpitViewUri(view: CockpitView): string | null {
  return view.type === 'board' ? `quay://${view.project}/board` : null;
}

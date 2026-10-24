import type {
  QuayDriverState,
  QuayFleetTaskCounts,
  QuayFocusableObject,
  QuayViewContract,
} from '@/shared/types';
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
  /**
   * The project's quay-fleet registry id — the project segment every `quay://` address and
   * spoken project name resolves against. `null` (or absent, which reads the same) when its
   * root is not registered: such a project has no addressable board and declares no focusable
   * object.
   */
  fleetProjectId?: string | null;
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
 * Builds the fleet view's contract: one focusable per REGISTERED project, addressed as its
 * board (`quay://<fleetProjectId>/board`). The ordinal is the tile's order among the DECLARED
 * objects and is the same number the tile draws (①, ②, …), making 「第二个」 and the second
 * focusable tile the same object by construction.
 *
 * `pos` IS THE TILE'S CELL IN THE DRAWN GRID, computed over `projects` — every tile, in the
 * order the stage maps them — and not over the focusable subset. An unregistered project still
 * occupies its cell with a non-focusable placeholder tile, so re-numbering the registered tiles
 * from 1 would report e.g. (1,2) for a tile actually drawn at (1,3) and let ↓ land on the tile
 * below the REPORTED cell instead of the one below the tile the person is looking at. `columns`
 * mirrors the stage's grid classes (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3`).
 *
 * A project whose root is not registered with quay-fleet is absent from the set: there is no
 * fleet id to mint an address from, and the CloudCLI project id is not a fleet handle. Its
 * tile still renders (with the counts) but carries no address and cannot receive focus.
 */
export function buildCockpitFleetContract(
  projects: readonly CockpitProject[],
  columns: number,
): QuayViewContract {
  const width = Math.max(1, columns);
  const focusables: QuayFocusableObject[] = [];
  projects.forEach((project, index) => {
    const fleetProjectId = project.fleetProjectId ?? null;
    if (fleetProjectId === null) return;
    const ordinal = focusables.length + 1;
    focusables.push({
      uri: formatQuayUri({ type: 'board', project: fleetProjectId }),
      label: CIRCLED_ORDINALS[ordinal - 1] ?? `(${ordinal})`,
      display: {
        status: project.driverState,
        color: DRIVER_COLORS[project.driverState],
        ordinal,
        pos: { row: Math.floor(index / width) + 1, column: (index % width) + 1 },
      },
    });
  });
  return { focusables };
}

const VIEW_QUERY_KEY = 'view';
const PROJECT_QUERY_KEY = 'project';

/**
 * Where the browser session remembers the page the person left to enter the cockpit.
 *
 * Session storage, not local storage: the return trip belongs to this tab, and a second
 * window opened on the cockpit (Ctrl+click) must not overwrite the first tab's origin.
 */
const RETURN_PATH_STORAGE_KEY = 'cockpit.returnPath';

/**
 * Remembers the router-relative path the cockpit was entered from, so the cockpit's
 * 「会话」 segment can lead back to it. Relative to the router (basename already stripped),
 * matching what {@link readCockpitReturnPath} hands back to `useHref`.
 */
export function rememberCockpitReturnPath(path: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(RETURN_PATH_STORAGE_KEY, path);
  } catch {
    // A blocked storage area must not break the switch: the cockpit simply falls back home.
  }
}

/**
 * The remembered pre-cockpit route, or `/` when nothing usable was recorded.
 *
 * Only a single-slash absolute path is accepted: a stored value that is empty, relative or
 * protocol-relative would navigate somewhere the person never was (and `//host` is an
 * off-site redirect), so it reads as "no record" instead.
 */
export function readCockpitReturnPath(): string {
  if (typeof window === 'undefined') return '/';
  try {
    const stored = window.sessionStorage.getItem(RETURN_PATH_STORAGE_KEY);
    if (stored !== null && stored.startsWith('/') && !stored.startsWith('//')) {
      return stored;
    }
  } catch {
    // Fall through to the home route.
  }
  return '/';
}

/**
 * Resolves the project a view's `project` segment names.
 *
 * BOTH handles are accepted because both are minted by this app: the cockpit's own URL uses
 * the CloudCLI project id (the id the snapshot route is keyed by), while the sidebar's entry
 * links speak the quay-fleet registry id (the same segment every `quay://` address carries).
 * Matching projectId first keeps an id that could be either from being re-read as the other.
 */
export function resolveCockpitProject(
  projects: readonly CockpitProject[],
  segment: string,
): CockpitProject | null {
  const target = segment.trim();
  if (target === '') return null;
  return (
    projects.find((project) => project.projectId === target) ??
    projects.find(
      (project) => (project.fleetProjectId ?? '').toLowerCase() === target.toLowerCase(),
    ) ??
    null
  );
}

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
 * focused (a board whose snapshot failed still names the board it is showing).
 *
 * The project segment is the board project's quay-fleet REGISTRY ID, passed in because the
 * view description itself carries the CloudCLI project id (the id the snapshot route is keyed
 * by). `null` when the fleet does not register the project: there is no honest address, and
 * the fleet view — a CloudCLI-level view — has none either.
 */
export function cockpitViewUri(view: CockpitView, fleetProjectId: string | null): string | null {
  return view.type === 'board' && fleetProjectId !== null
    ? `quay://${fleetProjectId}/board`
    : null;
}

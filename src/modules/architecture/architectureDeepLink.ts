import {
  ARCHITECTURE_DETAIL_TIERS,
  ARCHITECTURE_SCOPE_MAX,
  ARCHITECTURE_SCOPE_MIN,
  type ArchitectureDetailTier,
} from '@/modules/architecture/detailRanking';

/**
 * The architecture page's standalone deep link.
 *
 * `/session/:sessionId/architecture` is a page of its own, so the view a reader
 * is looking at has to survive being opened in a new tab. The link carries the
 * same knobs the panel already remembers (`architecture.scope.<project>`,
 * `architecture.detail.<project>`) plus the current selection, and nothing
 * else: the parameters decide the FIRST paint only. Later changes stay in the
 * page (the panel never writes them back to the address bar), so a link copied
 * from a tab keeps describing the reading it was copied from.
 *
 * Every parser here is forgiving by design: an unknown parameter, a malformed
 * scope or a tier this build does not know is IGNORED, and the project's
 * remembered state fills the gap. A shareable URL must never be able to break
 * the page.
 */

/** The two subgraphs a link can name (`class` is the entity/class diagram). */
export type ArchitectureDeepLinkView = 'class' | 'file';

/** One standalone link's readings; `null` means "not requested, use stored state". */
export type ArchitectureDeepLinkState = {
  readonly view: ArchitectureDeepLinkView | null;
  readonly scope: number | null;
  readonly detail: ArchitectureDetailTier | null;
  /** The entity to select and centre on open. */
  readonly entity: string | null;
  /** `neighbourhood` drills into the entity's own graph; null keeps the overview. */
  readonly mode: 'neighbourhood' | null;
};

/** The state of a link that names nothing; also the fallback for a malformed value. */
export const EMPTY_ARCHITECTURE_DEEP_LINK: ArchitectureDeepLinkState = {
  view: null,
  scope: null,
  detail: null,
  entity: null,
  mode: null,
};

/** The parameter names, in the order {@link buildArchitectureDeepLinkParams} emits them. */
const PARAM_VIEW = 'view';
const PARAM_SCOPE = 'scope';
const PARAM_DETAIL = 'detail';
const PARAM_ENTITY = 'entity';
const PARAM_MODE = 'mode';

/** Parse the stepper's depth, refusing anything the stepper itself cannot produce. */
function parseScope(raw: string | null): number | null {
  if (raw === null) return null;
  // Only the plain decimal form the panel writes. `parseInt` would accept
  // `2abc`, and a negative or fractional depth is not a request the server can
  // answer, so those are ignored rather than clamped into a different reading.
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  if (value < ARCHITECTURE_SCOPE_MIN || value > ARCHITECTURE_SCOPE_MAX) return null;
  return value;
}

/** Parse one of the three detail tiers, ignoring anything else. */
function parseDetail(raw: string | null): ArchitectureDetailTier | null {
  if (raw === null) return null;
  return (ARCHITECTURE_DETAIL_TIERS as readonly string[]).includes(raw)
    ? (raw as ArchitectureDetailTier)
    : null;
}

/** Parse one of the two subgraph names. */
function parseView(raw: string | null): ArchitectureDeepLinkView | null {
  return raw === 'class' || raw === 'file' ? raw : null;
}

/**
 * Read a link's state from a query string (`location.search`, with or without
 * the leading `?`). Unknown parameters are not part of the result.
 */
export function parseArchitectureDeepLink(search: string): ArchitectureDeepLinkState {
  const params = new URLSearchParams(search);
  const entity = params.get(PARAM_ENTITY);
  return {
    view: parseView(params.get(PARAM_VIEW)),
    scope: parseScope(params.get(PARAM_SCOPE)),
    detail: parseDetail(params.get(PARAM_DETAIL)),
    entity: entity === null || entity === '' ? null : entity,
    mode: params.get(PARAM_MODE) === 'neighbourhood' ? 'neighbourhood' : null,
  };
}

/** Whether a scope value can be written into a link the parser would read back. */
function isWritableScope(scope: number | null): scope is number {
  return scope !== null
    && Number.isSafeInteger(scope)
    && scope >= ARCHITECTURE_SCOPE_MIN
    && scope <= ARCHITECTURE_SCOPE_MAX;
}

/**
 * Build the query string for a view state. Absent readings are omitted, so the
 * output is deterministic for a given state and
 * {@link parseArchitectureDeepLink} maps it back to the same object.
 */
export function buildArchitectureDeepLinkParams(state: ArchitectureDeepLinkState): string {
  const params = new URLSearchParams();
  if (state.view !== null) params.set(PARAM_VIEW, state.view);
  if (isWritableScope(state.scope)) params.set(PARAM_SCOPE, String(state.scope));
  if (state.detail !== null) params.set(PARAM_DETAIL, state.detail);
  if (state.entity !== null && state.entity !== '') params.set(PARAM_ENTITY, state.entity);
  if (state.mode === 'neighbourhood') params.set(PARAM_MODE, 'neighbourhood');
  return params.toString();
}

/**
 * The standalone page's href for one session and view state.
 *
 * The router may be mounted under a basename (a reverse proxy serves the app
 * from `/ai`, for example). Reading the CURRENT pathname and keeping everything
 * before `/session/` preserves that prefix without the panel having to know the
 * router's configuration.
 */
export function buildArchitectureStandaloneHref(options: {
  readonly pathname: string;
  readonly sessionId: string;
  readonly state: ArchitectureDeepLinkState;
}): string {
  const { pathname, sessionId, state } = options;
  const sessionMarker = '/session/';
  const markerIndex = pathname.indexOf(sessionMarker);
  const prefix = markerIndex >= 0 ? pathname.slice(0, markerIndex) : '';
  const path = `${prefix}${sessionMarker}${encodeURIComponent(sessionId)}/architecture`;
  const query = buildArchitectureDeepLinkParams(state);
  return query === '' ? path : `${path}?${query}`;
}

import type { QuayObjectKind, QuayObjectUri } from '@/shared/types';

/**
 * Pure parse/format helpers for the wall's `quay://` address space.
 *
 * WHY A PROJECT SEGMENT. A wall can show more than one project, and the fleet stores objects
 * per project, so a bare `quay://task/<id>` is not addressable across the fleet. Every URI
 * therefore carries the project first:
 *
 *   quay://<project>/task/<id>
 *   quay://<project>/task/<id>#ac-<n>
 *   quay://<project>/goal/<id>
 *   quay://<project>/ledger/<name>/<eventId>
 *   quay://<project>/board
 *
 * WHY PARSE/FORMAT LIVE HERE, NOT IN THE VOICE PACK. A reference is an opaque string to
 * whoever carries it; both the view that mints one and any reader that inspects it need the
 * SAME grammar. One module means a URI cannot mean one thing to the renderer and another to
 * the resolver. This module is deliberately pure — no fetch, no snapshot lookup: dereferencing
 * is a separate concern (`quay-wall-uri-dereference-with-snapshot-fallback`).
 *
 * The L1 `type` is part of the parsed object because consumers need it; `actions` is NOT
 * minted here — the fleet is the sole source of the action set, and this side only consumes it.
 */

/** One parsed L1 object reference, discriminated by the URI's object kind. */
export type QuayParsedObject =
  | { type: 'task'; project: string; id: string; ac: number | null }
  | { type: 'goal'; project: string; id: string }
  | { type: 'ledger'; project: string; name: string; eventId: string }
  | { type: 'board'; project: string };

/**
 * Why a string is not a valid wall URI.
 *
 * `missing-project` is its own reason, not `unknown-type`: the project-less form
 * (`quay://task/<id>`) is the shape an early draft used, so naming it specifically is what
 * lets a caller tell "someone used the old form" from "someone invented an object kind".
 */
export type QuayUriRejection =
  | 'not-a-quay-uri'
  | 'missing-project'
  | 'unknown-type'
  | 'empty-id'
  | 'malformed';

/** The outcome of {@link parseQuayUri}; a rejected URI never throws. */
export type QuayUriParseResult =
  | { ok: true; object: QuayParsedObject }
  | { ok: false; reason: QuayUriRejection; uri: string };

/** The object kinds the URI grammar knows. The fleet's L1 `type` enum is the source. */
export const QUAY_OBJECT_TYPES: readonly QuayObjectKind[] = ['task', 'goal', 'ledger', 'board'];

const QUAY_URI_PREFIX = 'quay://';

/** A path segment must be non-empty and carry no whitespace; slashes are already split away. */
function isSegment(segment: string): boolean {
  return segment !== '' && !/\s/.test(segment);
}

/** Rejects a URI with a stated reason — every failure path goes through here, so no throw escapes. */
function reject(reason: QuayUriRejection, uri: string): QuayUriParseResult {
  return { ok: false, reason, uri };
}

/**
 * Parses one `quay://` reference into its L1 shape, or says why it is not one.
 *
 * WHAT IS REJECTED, and why each is a separate reading:
 *  - `not-a-quay-uri` — the string does not start with `quay://` (an http URL, a plain id);
 *  - `missing-project` — the first segment is an object kind, i.e. the old project-less form
 *    `quay://task/<id>` (or there is no first segment at all);
 *  - `unknown-type` — the project is there but the kind is not one of {@link QUAY_OBJECT_TYPES};
 *  - `empty-id` — the kind is known but an id/name/event segment is empty
 *    (`quay://proj/task/`, `quay://proj/ledger//evt`);
 *  - `malformed` — a known kind with the wrong number of segments, a fragment on a non-task
 *    kind, a query string, or an `#ac-` fragment that is not a positive decimal integer.
 */
export function parseQuayUri(uri: string): QuayUriParseResult {
  if (!uri.startsWith(QUAY_URI_PREFIX)) {
    return reject('not-a-quay-uri', uri);
  }

  const rest = uri.slice(QUAY_URI_PREFIX.length);
  if (rest.includes('?')) {
    return reject('malformed', uri);
  }

  const hashAt = rest.indexOf('#');
  const fragment = hashAt === -1 ? null : rest.slice(hashAt + 1);
  const path = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const segments = path.split('/');
  if (segments.length === 0 || segments[0] === '') {
    return reject('missing-project', uri);
  }

  const [project, kind, ...tail] = segments;
  if (!isSegment(project)) {
    return reject('malformed', uri);
  }
  // The project-less draft form: `quay://task/<id>` parses the kind as the project.
  if ((QUAY_OBJECT_TYPES as readonly string[]).includes(project)) {
    return reject('missing-project', uri);
  }
  if (kind === undefined) {
    return reject('malformed', uri);
  }
  if (kind === '') {
    // A trailing slash after the project is a missing object kind, not an invented one.
    return reject('malformed', uri);
  }
  if (!(QUAY_OBJECT_TYPES as readonly string[]).includes(kind)) {
    return reject('unknown-type', uri);
  }

  switch (kind) {
    case 'task': {
      if (tail.length !== 1) return reject(tail.length === 0 || tail[0] === '' ? 'empty-id' : 'malformed', uri);
      const [id] = tail;
      if (!isSegment(id)) return reject(id === '' ? 'empty-id' : 'malformed', uri);
      if (fragment === null) return { ok: true, object: { type: 'task', project, id, ac: null } };
      const ac = /^ac-([1-9]\d*)$/.exec(fragment);
      if (ac === null) return reject('malformed', uri);
      return { ok: true, object: { type: 'task', project, id, ac: Number(ac[1]) } };
    }
    case 'goal': {
      if (fragment !== null || tail.length !== 1) {
        return reject(tail.length === 1 && tail[0] === '' ? 'empty-id' : 'malformed', uri);
      }
      const [id] = tail;
      if (!isSegment(id)) return reject(id === '' ? 'empty-id' : 'malformed', uri);
      return { ok: true, object: { type: 'goal', project, id } };
    }
    case 'ledger': {
      if (fragment !== null || tail.length !== 2) {
        return reject(tail.length === 2 && (tail[0] === '' || tail[1] === '') ? 'empty-id' : 'malformed', uri);
      }
      const [name, eventId] = tail;
      if (!isSegment(name) || !isSegment(eventId)) {
        return reject(name === '' || eventId === '' ? 'empty-id' : 'malformed', uri);
      }
      return { ok: true, object: { type: 'ledger', project, name, eventId } };
    }
    case 'board': {
      if (fragment !== null || tail.length !== 0) {
        return reject('malformed', uri);
      }
      return { ok: true, object: { type: 'board', project } };
    }
    default:
      // Unreachable: the kind was checked against QUAY_OBJECT_TYPES above. Kept so the
      // function is total for the compiler without widening the parsed union.
      return reject('unknown-type', uri);
  }
}

/**
 * Formats one parsed object back into its canonical URI — the inverse of {@link parseQuayUri}
 * for every accepted input (`format(parse(uri)) === uri`).
 *
 * Inputs are expected to be the URL-safe ids the parsed side produced; this function does not
 * escape what the grammar could not have parsed in the first place.
 */
export function formatQuayUri(object: QuayParsedObject): QuayObjectUri {
  switch (object.type) {
    case 'task':
      return `quay://${object.project}/task/${object.id}${
        object.ac === null ? '' : `#ac-${object.ac}`
      }` as QuayObjectUri;
    case 'goal':
      return `quay://${object.project}/goal/${object.id}` as QuayObjectUri;
    case 'ledger':
      return `quay://${object.project}/ledger/${object.name}/${object.eventId}` as QuayObjectUri;
    case 'board':
      return `quay://${object.project}/board` as QuayObjectUri;
  }
}

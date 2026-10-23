import {
  ARCHITECTURE_DEFAULT_FILTER,
  ARCHITECTURE_ELEMENT_KINDS,
  ARCHITECTURE_RELATION_PRESETS,
  type ArchitectureElementRelationFilter,
  type ArchitectureFilterHidden,
  type ArchitectureRelationPreset,
} from '@/modules/architecture/elementRelationFilter';
import type { ArchitectureGraphResult } from '@/modules/architecture/useArchitectureGraph';

// The panel's pure filter layer: the stored element/relation filter and its
// validation, the composition of the server's `hidden` reading with a local
// narrowing, and the truncation reading. Nothing here touches React.

/** The two subgraphs the endpoint returns together; switching between them is local. */
export type ArchitectureGranularity = 'file' | 'entity';

/**
 * Where one project's element/relation filter is remembered: the sibling of
 * the scope/detail keys owned by `panelPersistence.ts`.
 */
const FILTER_STORAGE_PREFIX = 'architecture.filter.';

/** True when `value` is one of the element axis' kinds. */
export function isElementKind(value: unknown): value is (typeof ARCHITECTURE_ELEMENT_KINDS)[number] {
  return typeof value === 'string' && (ARCHITECTURE_ELEMENT_KINDS as readonly string[]).includes(value);
}

/** True when `value` is one of the relation axis' presets. */
export function isRelationPreset(value: unknown): value is ArchitectureRelationPreset {
  return typeof value === 'string' && (ARCHITECTURE_RELATION_PRESETS as readonly string[]).includes(value);
}

/**
 * Read one project's remembered element/relation filter.
 *
 * The stored value is a JSON object written by this panel; a hand-edited or
 * older entry (or storage being unavailable) falls back to the shipped default
 * rather than throwing. Validation is per FIELD, so one unknown kind does not
 * discard the other two selections.
 */
export function readStoredFilter(projectId: string | null): ArchitectureElementRelationFilter {
  if (projectId === null || typeof window === 'undefined') return ARCHITECTURE_DEFAULT_FILTER;
  try {
    const stored = window.localStorage.getItem(`${FILTER_STORAGE_PREFIX}${projectId}`);
    if (stored === null) return ARCHITECTURE_DEFAULT_FILTER;
    const parsed: unknown = JSON.parse(stored);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return ARCHITECTURE_DEFAULT_FILTER;
    }
    const record = parsed as Record<string, unknown>;
    const kinds = Array.isArray(record.kinds)
      ? record.kinds.filter(isElementKind)
      : ARCHITECTURE_DEFAULT_FILTER.kinds;
    return {
      kinds,
      relations: isRelationPreset(record.relations)
        ? record.relations
        : ARCHITECTURE_DEFAULT_FILTER.relations,
      hideIsolated: typeof record.hideIsolated === 'boolean'
        ? record.hideIsolated
        : ARCHITECTURE_DEFAULT_FILTER.hideIsolated,
      // An entry written before the switches existed has no such field: the
      // shipped default (no kind exempt) is the right fallback, not "all on".
      keepMentionedKinds: Array.isArray(record.keepMentionedKinds)
        ? record.keepMentionedKinds.filter(isElementKind)
        : ARCHITECTURE_DEFAULT_FILTER.keepMentionedKinds,
    };
  } catch {
    return ARCHITECTURE_DEFAULT_FILTER;
  }
}

/** Remember one project's filter; a failed write must not break the popover. */
export function writeStoredFilter(projectId: string | null, filter: ArchitectureElementRelationFilter): void {
  if (projectId === null) return;
  try {
    window.localStorage.setItem(`${FILTER_STORAGE_PREFIX}${projectId}`, JSON.stringify(filter));
  } catch {
    // See readStoredScope: remembering is best-effort, the knob is not.
  }
}

/** Add two `hidden` readings; the narrow path composes the local cut onto the server's. */
export function addHidden(base: ArchitectureFilterHidden, extra: ArchitectureFilterHidden): ArchitectureFilterHidden {
  const byKind: Partial<Record<string, number>> = { ...base.byKind };
  for (const [kind, count] of Object.entries(extra.byKind)) {
    byKind[kind] = (byKind[kind] ?? 0) + (count ?? 0);
  }
  const byRelation: Record<string, number> = { ...base.byRelation };
  for (const [type, count] of Object.entries(extra.byRelation)) {
    byRelation[type] = (byRelation[type] ?? 0) + count;
  }
  // The mentioned subset is summed on the same axes as `byKind`: the server cut
  // is one reading and a local narrowing is another, and the readout's "N of
  // them mentioned" has to describe both. Absent on both sides ⇒ absent, so an
  // old payload keeps its exact shape.
  const mentionedByKind: Partial<Record<string, number>> = { ...base.mentionedByKind };
  for (const [kind, count] of Object.entries(extra.mentionedByKind ?? {})) {
    mentionedByKind[kind] = (mentionedByKind[kind] ?? 0) + (count ?? 0);
  }
  // Per-node relation removals compose the same way: the server's relation axis
  // and a local narrowing are one reading of what the box in front of the
  // reader lost.
  const byNodeRelations: Record<string, Record<string, number>> = {};
  for (const source of [base.byNodeRelations ?? {}, extra.byNodeRelations ?? {}]) {
    for (const [id, counts] of Object.entries(source)) {
      const merged = byNodeRelations[id] ?? {};
      for (const [type, count] of Object.entries(counts)) {
        merged[type] = (merged[type] ?? 0) + count;
      }
      byNodeRelations[id] = merged;
    }
  }
  return {
    byKind,
    byRelation,
    isolated: base.isolated + extra.isolated,
    ...(Object.keys(mentionedByKind).length === 0 ? {} : { mentionedByKind }),
    ...(Object.keys(byNodeRelations).length === 0 ? {} : { byNodeRelations }),
  };
}

/** An empty `hidden` reading, for a payload whose server carried no filter stats. */
export const EMPTY_HIDDEN: ArchitectureFilterHidden = { byKind: {}, byRelation: {}, isolated: 0 };

/**
 * One granularity's truncation reading, taken from the response alone.
 *
 * The per-granularity flags are optional on the wire (a payload from an older
 * server has only the legacy `truncated` boolean), so an absent flag falls back
 * to `truncated`. When a granularity was cut, the retained count IS the budget
 * the generator applied, so it stands in for the limit.
 */
export function truncationReading(result: ArchitectureGraphResult, granularity: ArchitectureGranularity) {
  const { stats } = result;
  if (granularity === 'file') {
    return {
      truncated: stats.fileTruncated ?? stats.truncated,
      shown: stats.fileNodes,
      total: stats.fileTotal ?? stats.fileNodes,
    };
  }
  return {
    truncated: stats.entityTruncated ?? stats.truncated,
    shown: stats.entityNodes,
    total: stats.entityTotal ?? stats.entityNodes,
  };
}

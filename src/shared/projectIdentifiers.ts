/**
 * The names a project really has, as the identifier repair wants them.
 *
 * `repairIdentifiers` is a pure function of its candidate list — it knows how to
 * match a recogniser's mistake against a name, and nothing about where names come
 * from. This module is that other half: it asks the project's shared file index
 * what exists and hands back the two shapes the repair is written against.
 *
 * Two shapes, because a recogniser breaks a name in one of two ways and each pass
 * of the repair sees only one of them:
 *
 *  - `voice.routes.ts` keeps its dot and comes back mis-spelled, so the basename is
 *    offered;
 *  - `useVoiceInput` is rendered as ordinary words ("use voice input"), which carry
 *    no dot at all, so the bare stem is offered beside it — a name that could only
 *    ever be matched by the dotless, whitespace-removed pass.
 *
 * This is the same flattening the recovery corpus is measured with
 * (`experiments/voice-identifiers/identifierRepair.mjs`, `fileCandidates`), so a
 * reading taken here and a reading taken there are the same reading.
 *
 * Every failure is silent by design. The candidates are an *improvement* to a
 * transcription that already works without them: a project whose tree cannot be
 * listed loses the repair, and must not lose the dictation with it.
 */

import { loadProjectFileIndex } from '@/modules/file-tree';

/** One entry, as much of an index entry (or a legacy tree node) as this module reads. */
type FileIndexEntry = {
  type?: string;
  name?: unknown;
  children?: unknown;
};

/** The last extension of a name — the same shape `repairIdentifiers` treats as dotted. */
const EXTENSION = /\.[a-z]{1,5}$/i;

/**
 * Every name the repair may match, from a file index (or a file tree).
 *
 * Reads the response defensively because it is network data: anything that is
 * not a file entry is skipped rather than trusted, so a changed response shape
 * yields fewer candidates instead of a thrown error inside the transcription
 * path. A flat index entry carries no `type`; the directory guard keeps this
 * function correct for the tree shape it was first written against.
 */
export function flattenProjectIdentifiers(entries: unknown): string[] {
  const names = new Set<string>();

  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const entry = node as FileIndexEntry;
      if (
        entry.type !== 'directory' &&
        typeof entry.name === 'string' &&
        entry.name.length > 0
      ) {
        names.add(entry.name);
        const stem = entry.name.replace(EXTENSION, '');
        if (stem.length > 0 && stem !== entry.name) names.add(stem);
      }
      walk(entry.children);
    }
  };

  walk(entries);
  return [...names];
}

/**
 * The project's identifier candidates, fetched at most once per project id.
 *
 * The request and its cache live in the shared file index, so the composer
 * joins the same one load as every other filename-reference surface. Never
 * rejects: a missing id, a failed request and an empty project all resolve to
 * `[]`, which the repair reads as "nothing to do" and the transcript path
 * reads as unchanged behaviour.
 */
export function loadProjectIdentifiers(projectId: string | null | undefined): Promise<string[]> {
  if (!projectId) return Promise.resolve([]);
  return loadProjectFileIndex(projectId).then(flattenProjectIdentifiers);
}

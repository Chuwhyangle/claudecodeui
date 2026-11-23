import path from 'node:path';

// ---------------------------
//----------------- PROJECT DISPLAY NAMING UTILITIES ------------
/**
 * The stable label a project row is drawn under: the user's own name when they
 * set one, otherwise the last path segment, otherwise the whole path.
 *
 * Extraction history: this was a module-private function in
 * `modules/providers/services/sessions.service.ts`, where the archive API used
 * it to keep its rows labelled even for a project that is no longer in the
 * active sidebar payload. The awaiting-reply list needs the same answer for the
 * same reason — it spans projects too, and a row for a session whose project
 * page never loaded still has to say which project it belongs to — so it lives
 * here rather than being copied, which would let the two lists name one project
 * differently.
 *
 * `customProjectName` is the stored override and may be absent (a project row
 * that never had one, or a session whose path has no project row at all); a
 * whitespace-only value counts as absent. `projectPath` may be `null` for the
 * same reason, in which case there is nothing to derive from and the answer is
 * a fixed placeholder rather than an empty label.
 *
 * Consumed by `modules/providers/services/sessions.service.ts` (archive rows)
 * and `modules/providers/services/session-awaiting-reply.service.ts` (the
 * sidebar's awaiting-reply rows).
 */
export function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

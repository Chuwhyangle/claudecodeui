import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The total size in bytes of every regular file directly under `directory`.
 *
 * DIRECT CHILDREN ONLY. A subdirectory is skipped, not walked: both callers keep
 * a flat store (`<dir>/<file>`) and cap that flat store, so walking deeper would
 * count bytes the trim loop below can never remove. The read is BEST-EFFORT: a
 * file that vanishes between the listing and the stat contributes no bytes
 * instead of throwing, because the trim runs after a write in a directory a
 * concurrent connection or request may be emptying, and this figure is only ever
 * compared against a ceiling — one missed file costs a slightly conservative
 * reading, never a failed write.
 *
 * Consumed by `server/modules/voice-realtime/voice-realtime-log.ts` (the
 * per-connection realtime journal's ceiling) and
 * `server/modules/voice/voice-data.ts` (the local voice-record store's ceiling).
 * Both write first and then trim to this figure, so the two must sum the same
 * bytes or a deployment's disk bound would mean different things per store.
 */
export function directoryBytes(directory: string): number {
  let total = 0;
  for (const name of readdirSync(directory)) {
    try {
      const stats = statSync(path.join(directory, name));
      if (stats.isFile()) {
        total += stats.size;
      }
    } catch {
      // A file that vanished between the listing and the stat is not bytes we have to account for.
    }
  }
  return total;
}

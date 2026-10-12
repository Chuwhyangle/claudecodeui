/**
 * The logging module's public surface.
 *
 * Consumers: `server/load-env.ts` installs the stamp (it is the one module every entry point
 * imports first, so every line after it is dated); this module's own criterion imports both
 * members directly from the implementation file.
 */
export { installTimestampedConsole, stampLines } from './timestamped-console.js';
export type { TimestampedConsoleSink } from './timestamped-console.js';

import { format } from 'node:util';

/**
 * The process-wide stdout stamp: every line the deployment writes carries the instant it was
 * written.
 *
 * WHY IT IS A WRAPPER AND NOT A CALL-SITE CHANGE. `server.log` is the systemd unit's
 * `StandardOutput=append:` target and the only record of everything the backend says that is not
 * the relay's own journal. It had no timestamps at all, and it is written from hundreds of
 * `console.log` call sites across every module — dating it at one call site would date one line.
 * Wrapping the sink dates every line, including the ones written before a module finished
 * evaluating and the ones a dependency writes through `console`.
 *
 * WHY EVERY LINE AND NOT JUST THE FIRST. The reading that motivated this was attribution: two
 * process-fatal crashes on 2026-10-09 whose stack traces are multi-line, in a 78 MB log with no
 * dates anywhere — each could only be placed in time by finding a later line that happened to
 * embed one. Stamping only the head of a message leaves exactly those continuation lines
 * undatable, which is the whole failure being fixed.
 */

/** The console methods the stamp covers — the whole of what the deployment writes through. */
export type TimestampedConsoleSink = Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>;

/**
 * Marks a function this module already wrapped, so a second install is a no-op rather than a
 * second stamp. A `Symbol.for` (not a module-local symbol) so the marker survives the module
 * being loaded twice — which is what happens when `server/load-env.ts` and a CLI entry point
 * both reach it through different specifiers.
 */
const STAMPED = Symbol.for('claudecodeui.timestamped-console');

/**
 * Prefixes every line of `text` with `at` in ISO-8601 UTC, preserving a trailing newline.
 *
 * Exported for the criterion alone: it is the pure half of the stamp, so a criterion can assert
 * the exact instant instead of pattern-matching something date-shaped. Production only reaches it
 * through {@link installTimestampedConsole}.
 */
export function stampLines(text: string, at: Date): string {
  const prefix = `${at.toISOString()} `;
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  const stamped = body
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
  return trailingNewline ? `${stamped}\n` : stamped;
}

/**
 * Installs the stamp on a console-shaped sink and returns the uninstall.
 *
 * Arguments are rendered with `node:util`'s `format` before stamping, so `%s`-style substitution
 * and object inspection behave as `console.log` did — the app's own JSON-ish dumps stay readable.
 * The wrapped method calls the ORIGINAL bound to the sink, so `console.error` keeps reaching
 * stderr and nothing about the routing changes. Installing twice is a no-op; uninstalling
 * restores the exact functions the sink had before.
 *
 * Consumers: `server/index.ts`, at the one point every entry path passes through before it logs
 * anything, and this module's criterion.
 */
export function installTimestampedConsole(
  sink: TimestampedConsoleSink,
  options: { now?: () => Date } = {},
): () => void {
  const now = options.now ?? (() => new Date());
  const restores: Array<() => void> = [];

  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = sink[method];
    if (typeof original !== 'function') continue;
    if ((original as { [STAMPED]?: boolean })[STAMPED] === true) continue;

    const wrapped = (...args: unknown[]): void => {
      original.call(sink, stampLines(format(...args), now()));
    };
    Object.defineProperty(wrapped, STAMPED, { value: true });
    sink[method] = wrapped;
    restores.push(() => {
      sink[method] = original;
    });
  }

  return () => {
    for (const restore of restores) restore();
  };
}

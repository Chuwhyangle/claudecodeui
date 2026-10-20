/**
 * The bounded memory both provider runtimes keep beside their live approval maps.
 *
 * WHY IT IS SHARED. A runtime's live pending map empties the instant a prompt
 * settles, so it cannot tell an id it HELD and then dropped (or answered) from
 * one it never minted — both read as absent. The MCP `approval_answer` surface
 * has to report those apart (AC-287), so each runtime keeps two bounded memories
 * beside the live map: the ids it held, and the decision it recorded for each
 * settled id. The debug agent and the real Claude runtime encode the SAME policy,
 * and that policy is subtle enough that a fork between them would change what
 * `ALREADY_DECIDED` means depending on which runtime answered. This module is
 * that one policy:
 *
 *  - eviction is OLDEST-FIRST once the cap is exceeded;
 *  - re-remembering an id moves it to the newest end (it is not a duplicate);
 *  - an id evicted from the held ledger degrades to the conservative
 *    `never_issued`, and one evicted from the decision ledger degrades to
 *    `expired`/`never_issued`, never a false `expired`/`ALREADY_DECIDED`.
 *
 * Consumed by `server/modules/debug-agent/debug-agent.provider.ts` and
 * `server/modules/providers/list/claude/claude-runtime.provider.ts`, each of
 * which holds one `createBoundedLedger<true>()` for its held ids and one
 * `createBoundedLedger<ApprovalDecisionRecord>()` for its settled decisions.
 */

/** How many held/decided request ids a runtime remembers. */
export const MAX_REMEMBERED_APPROVALS = 512;

/**
 * A fixed-capacity, insertion-ordered key/value memory.
 *
 * `remember` is the ONLY write: it re-inserts the key, which moves it to the
 * newest end, then evicts the oldest key(s) past `cap`. `read` returns
 * `undefined` for an evicted or never-remembered key, so a caller that needs the
 * two apart must keep its own distinction (the held ledger's `has` is that
 * distinction: the value it stores is only a placeholder).
 *
 * The cap is fixed at construction; there is no growth path, which is the
 * property the two runtimes rely on for a long-lived process.
 */
export type BoundedLedger<T> = {
  /** Records `key` at the newest end, evicting the oldest key past the cap. */
  remember(key: string, value: T): void;
  /** The value recorded for `key`, or `undefined` when it was evicted or never recorded. */
  read(key: string): T | undefined;
  /** Whether `key` is currently within the cap. */
  has(key: string): boolean;
  /** The remembered keys, OLDEST FIRST — the order eviction walks. */
  keys(): string[];
  /** How many keys are currently remembered (never more than the cap). */
  readonly size: number;
};

/**
 * Builds a {@link BoundedLedger} with the given capacity.
 *
 * `cap` must be a positive integer; a non-positive or fractional cap is a
 * programming error and throws rather than silently remembering nothing or
 * rounding. Omitting it uses {@link MAX_REMEMBERED_APPROVALS}, the value both
 * provider runtimes ship.
 */
export function createBoundedLedger<T>(cap: number = MAX_REMEMBERED_APPROVALS): BoundedLedger<T> {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new RangeError(`bounded ledger capacity must be a positive integer, got ${cap}`);
  }
  const entries = new Map<string, T>();

  return {
    remember(key: string, value: T): void {
      // Delete-then-set moves a re-remembered key to the newest end; a plain set
      // would keep its original insertion order and let it be evicted early.
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > cap) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) {
          entries.delete(oldest);
        }
      }
    },
    read(key: string): T | undefined {
      return entries.get(key);
    },
    has(key: string): boolean {
      return entries.has(key);
    },
    keys(): string[] {
      return [...entries.keys()];
    },
    get size(): number {
      return entries.size;
    },
  };
}

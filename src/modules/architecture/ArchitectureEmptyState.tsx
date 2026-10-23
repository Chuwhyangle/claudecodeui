import type { ReactNode } from 'react';

/**
 * The panel's empty state, for "no session selected", "no seeds found", and the
 * third state the seed-only check misses: the session DID resolve seeds, but the
 * granularity on screen has no node to draw (typically a class view over a
 * cache that carries files but no entities).
 *
 * `action` is an optional trailing node (a button that switches to the
 * granularity that does have content); existing callers pass only `message` and
 * are unchanged.
 *
 * Used by `ArchitecturePanel` only.
 */
export function ArchitectureEmptyState({
  message,
  action,
}: {
  message: string;
  action?: ReactNode;
}) {
  return (
    <div data-architecture-empty="true" className="p-6 text-sm text-muted-foreground">
      <p>{message}</p>
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  );
}

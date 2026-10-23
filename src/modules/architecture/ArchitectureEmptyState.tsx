/**
 * The panel's empty state, for both "no session selected" and "no seeds found".
 *
 * Used by `ArchitecturePanel` only.
 */
export function ArchitectureEmptyState({ message }: { message: string }) {
  return (
    <p data-architecture-empty="true" className="p-6 text-sm text-muted-foreground">
      {message}
    </p>
  );
}

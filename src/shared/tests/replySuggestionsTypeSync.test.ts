import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

/**
 * The two ends of the reply-suggestions wire declare the same literal unions:
 * the server validates the ledger payload against its `ReplySuggestionsEventName`
 * / `ReplySuggestionsExpansionSource`, and the composer types the same fields
 * from `src/shared/types.ts`; the failure notice picks its copy from
 * `ReplySuggestionsFailureCategory`, declared on both ends too. Nothing in the
 * build ties them together, so this criterion reads both declarations and reds
 * the moment one side gains or loses a member without the other.
 *
 * The files are read through `process.cwd()`: Vitest serves this module through
 * Vite, where `import.meta.url` is a dev-server URL rather than a `file:` one.
 */

const repoRoot = process.cwd();
// The frontend wire declarations moved to a type-only leaf beside the API readers
// (the shared barrel's oversize baseline may only shrink); the two-end pin follows them.
const frontendTypesFile = path.join(repoRoot, 'src', 'shared', 'api', 'replySuggestionsType.ts');
const serverTypesFile = path.join(
  repoRoot,
  'server',
  'modules',
  'reply-suggestions',
  'reply-suggestions.service.ts',
);
const serverFailureFile = path.join(
  repoRoot,
  'server',
  'modules',
  'reply-suggestions',
  'reply-suggestions-failure-state.ts',
);

/** Reads one exported literal union's members from a source file. */
const readLiteralUnion = (file: string, typeName: string): string[] => {
  const source = readFileSync(file, 'utf8');
  // `\\s*` after `=`: a long union may be declared on the following lines.
  const declaration = new RegExp(`export type ${typeName} =\\s*([^;]+);`).exec(source);
  assert.ok(declaration, `${typeName} must be declared in ${file}`);
  const members = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(members.length > 0, `${typeName} must be a literal union`);
  return [...new Set(members)].sort();
};

describe('reply-suggestions type sync', () => {
  it('(a) both ends name the same ledger events', () => {
    assert.deepEqual(
      readLiteralUnion(frontendTypesFile, 'ReplySuggestionsEventName'),
      readLiteralUnion(serverTypesFile, 'ReplySuggestionsEventName'),
    );
  });

  it('(b) both ends name the same expansion sources', () => {
    assert.deepEqual(
      readLiteralUnion(frontendTypesFile, 'ReplySuggestionsExpansionSource'),
      readLiteralUnion(serverTypesFile, 'ReplySuggestionsExpansionSource'),
    );
  });

  it('(c) both ends name the same failure categories', () => {
    assert.deepEqual(
      readLiteralUnion(frontendTypesFile, 'ReplySuggestionsFailureCategory'),
      readLiteralUnion(serverFailureFile, 'ReplySuggestionsFailureCategory'),
    );
  });

  it('(d) reads a non-empty declaration on both ends, so (a)-(c) cannot pass vacuously', () => {
    assert.ok(readLiteralUnion(frontendTypesFile, 'ReplySuggestionsEventName').length > 0);
    assert.ok(readLiteralUnion(serverTypesFile, 'ReplySuggestionsEventName').length > 0);
    assert.ok(readLiteralUnion(frontendTypesFile, 'ReplySuggestionsExpansionSource').length > 0);
    assert.ok(readLiteralUnion(serverTypesFile, 'ReplySuggestionsExpansionSource').length > 0);
    assert.ok(readLiteralUnion(frontendTypesFile, 'ReplySuggestionsFailureCategory').length > 0);
    assert.ok(readLiteralUnion(serverFailureFile, 'ReplySuggestionsFailureCategory').length > 0);
  });
});

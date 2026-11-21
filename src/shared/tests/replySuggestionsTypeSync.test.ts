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
const frontendTypesFile = path.join(repoRoot, 'src', 'shared', 'replySuggestionsType.ts');
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
const readLiteralUnionFrom = (source: string, typeName: string, file: string): string[] => {
  const declaration = new RegExp(`export type ${typeName} =\\s*([^;]+);`).exec(source);
  assert.ok(declaration, `${typeName} must be declared in ${file}`);
  const members = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(members.length > 0, `${typeName} must be a literal union`);
  return [...new Set(members)].sort();
};

const readLiteralUnion = (file: string, typeName: string): string[] =>
  readLiteralUnionFrom(readFileSync(file, 'utf8'), typeName, file);

/** Reads one exported object type's declared field names from a source string. */
const readObjectFieldsFrom = (source: string, typeName: string, file: string): string[] => {
  const declaration = new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\};`).exec(source);
  assert.ok(declaration, `${typeName} must be declared as an object type in ${file}`);
  const fields = [...declaration[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map((match) => match[1]);
  assert.ok(fields.length > 0, `${typeName} must declare at least one field`);
  return [...new Set(fields)].sort();
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

  it('(c2) both ends declare the same ReplySuggestionsStatus fields (including debugLog)', () => {
    const frontend = readFileSync(frontendTypesFile, 'utf8');
    const server = readFileSync(serverFailureFile, 'utf8');
    const fields = readObjectFieldsFrom(frontend, 'ReplySuggestionsStatus', frontendTypesFile);
    assert.deepEqual(
      fields,
      readObjectFieldsFrom(server, 'ReplySuggestionsStatus', serverFailureFile),
      'the /status reading drifted between the client and the server',
    );
    assert.ok(fields.includes('debugLog'), 'the opt-in debug-ledger switch is declared on both ends');
  });

  it('(c3) a one-sided field change is caught, and restoring the bytes passes again', () => {
    const frontend = readFileSync(frontendTypesFile, 'utf8');
    const server = readFileSync(serverFailureFile, 'utf8');
    const mutatedFrontend = frontend.replace(
      '  debugLog?: boolean;\n',
      '  debugLog?: boolean;\n  debugLogLines?: number;\n',
    );
    assert.notEqual(mutatedFrontend, frontend, 'the mutation must actually change the source');
    assert.throws(
      () => assert.deepEqual(
        readObjectFieldsFrom(mutatedFrontend, 'ReplySuggestionsStatus', frontendTypesFile),
        readObjectFieldsFrom(server, 'ReplySuggestionsStatus', serverFailureFile),
      ),
      'an extra client-side status field must fail the comparison',
    );
    assert.doesNotThrow(() => assert.deepEqual(
      readObjectFieldsFrom(frontend, 'ReplySuggestionsStatus', frontendTypesFile),
      readObjectFieldsFrom(server, 'ReplySuggestionsStatus', serverFailureFile),
    ));
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

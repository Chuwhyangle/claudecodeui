import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

/**
 * The two ends of the draft-rewrite wire, read field by field.
 *
 * WHY A SOURCE PARSER AND NOT AN IMPORT. The server module is not part of the client's
 * TypeScript project, and the wire is a declaration contract, not a shared runtime object. The
 * existing reply-suggestions pin reads both declarations the same way; this file extends that
 * discipline to the rewrite's request, response, error codes and stop reason.
 *
 * THE NEGATIVE CONTROL IS PART OF THE CRITERION. A comparator that always answers "equal"
 * would pass this file while proving nothing, so `mutation is caught` adds a member to one
 * side in memory and asserts the comparison fails, then restores the original bytes and asserts
 * it passes again. The same is done for an object field.
 */

const repoRoot = process.cwd();
const clientTypesFile = path.join(repoRoot, 'src', 'shared', 'replySuggestionsType.ts');
const serverDrawFile = path.join(repoRoot, 'server', 'modules', 'reply-suggestions', 'reply-suggestions-draw.ts');
const serverServiceFile = path.join(repoRoot, 'server', 'modules', 'reply-suggestions', 'reply-suggestions.service.ts');

const clientSource = readFileSync(clientTypesFile, 'utf8');
const serverDrawSource = readFileSync(serverDrawFile, 'utf8');
const serverServiceSource = readFileSync(serverServiceFile, 'utf8');

/** Reads one exported literal union's members from source text, sorted and de-duplicated. */
function readLiteralUnion(source: string, typeName: string): string[] {
  const declaration = new RegExp(`export type ${typeName} =\\s*([^;]+);`).exec(source);
  assert.ok(declaration, `${typeName} must be declared`);
  const members = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(members.length > 0, `${typeName} must be a literal union`);
  return [...new Set(members)].sort();
}

/** Reads one exported object type's field names from source text, sorted. */
function readObjectFields(source: string, typeName: string): string[] {
  const declaration = new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\};`).exec(source);
  assert.ok(declaration, `${typeName} must be declared as an object type`);
  const fields = [...declaration[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map((match) => match[1]);
  assert.ok(fields.length > 0, `${typeName} must declare at least one field`);
  return [...new Set(fields)].sort();
}

function assertSameUnion(clientSourceText: string, serverSourceText: string, typeName: string): void {
  assert.deepEqual(
    readLiteralUnion(clientSourceText, typeName),
    readLiteralUnion(serverSourceText, typeName),
    `${typeName} drifted between the client and the server`,
  );
}

function assertSameFields(clientSourceText: string, serverSourceText: string, clientName: string, serverName: string): void {
  assert.deepEqual(
    readObjectFields(clientSourceText, clientName),
    readObjectFields(serverSourceText, serverName),
    `${clientName}/${serverName} fields drifted`,
  );
}

describe('draft rewrite type sync', () => {
  it('the request declares the same fields on both ends', () => {
    assertSameFields(clientSource, serverServiceSource, 'DraftRewriteRequest', 'DraftRewriteInput');
    assert.deepEqual(readObjectFields(clientSource, 'DraftRewriteRequest'), ['retry', 'text']);
  });

  it('the response declares the same fields on both ends', () => {
    assertSameFields(clientSource, serverServiceSource, 'DraftRewriteResult', 'DraftRewriteResult');
    assert.deepEqual(readObjectFields(clientSource, 'DraftRewriteResult'), ['rewrittenText']);
  });

  it('the stop reason union is identical', () => {
    assertSameUnion(clientSource, serverDrawSource, 'DraftRewriteStopReason');
    assert.deepEqual(readLiteralUnion(clientSource, 'DraftRewriteStopReason'), ['finished', 'truncated']);
  });

  it('the rejection and failure-category unions are identical', () => {
    assertSameUnion(clientSource, serverDrawSource, 'DraftRewriteRejection');
    assertSameUnion(clientSource, serverDrawSource, 'DraftRewriteFailureCategory');
    assert.ok(readLiteralUnion(clientSource, 'DraftRewriteRejection').length > 0);
    assert.ok(readLiteralUnion(clientSource, 'DraftRewriteFailureCategory').length > 0);
  });

  it('the machine error-code union is identical', () => {
    assertSameUnion(clientSource, serverDrawSource, 'DraftRewriteErrorCode');
    assert.ok(readLiteralUnion(clientSource, 'DraftRewriteErrorCode').length > 0);
  });

  it('the failure object exposes the correlation fields the controller reads', () => {
    assert.deepEqual(
      readObjectFields(clientSource, 'DraftRewriteFailure'),
      ['at', 'category', 'code', 'httpStatus', 'message', 'model', 'requestId'],
    );
  });

  it('a one-sided union change is caught, and restoring the bytes passes again', () => {
    const mutated = clientSource.replace(
      "export type DraftRewriteStopReason = 'finished' | 'truncated';",
      "export type DraftRewriteStopReason = 'finished' | 'truncated' | 'cancelled';",
    );
    assert.notEqual(mutated, clientSource, 'the mutation must actually change the source');
    assert.throws(
      () => assertSameUnion(mutated, serverDrawSource, 'DraftRewriteStopReason'),
      'an extra client member must fail the comparison',
    );
    assert.doesNotThrow(() => assertSameUnion(clientSource, serverDrawSource, 'DraftRewriteStopReason'));
  });

  it('a one-sided field change is caught, and restoring the bytes passes again', () => {
    const mutated = clientSource.replace(
      '  retry?: boolean;\n};',
      '  retry?: boolean;\n  model?: string;\n};',
    );
    assert.notEqual(mutated, clientSource, 'the mutation must actually change the source');
    assert.throws(
      () => assertSameFields(mutated, serverServiceSource, 'DraftRewriteRequest', 'DraftRewriteInput'),
      'an extra request field must fail the comparison',
    );
    assert.doesNotThrow(() => assertSameFields(clientSource, serverServiceSource, 'DraftRewriteRequest', 'DraftRewriteInput'));
  });

  it('a server-side removal is caught too, so the pin is two-directional', () => {
    const mutatedServer = serverDrawSource.replace(
      "export type DraftRewriteErrorCode =\n  | 'DRAFT_REWRITE_INPUT_TOO_LONG'\n  | 'DRAFT_REWRITE_REJECTED'",
      "export type DraftRewriteErrorCode =\n  | 'DRAFT_REWRITE_INPUT_TOO_LONG'",
    );
    assert.notEqual(mutatedServer, serverDrawSource);
    assert.throws(
      () => assertSameUnion(clientSource, mutatedServer, 'DraftRewriteErrorCode'),
      'a server-side removal must fail the comparison',
    );
    assert.doesNotThrow(() => assertSameUnion(clientSource, serverDrawSource, 'DraftRewriteErrorCode'));
  });
});

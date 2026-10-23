import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildArchitectureDeepLinkParams,
  buildArchitectureStandaloneHref,
  EMPTY_ARCHITECTURE_DEEP_LINK,
  parseArchitectureDeepLink,
  type ArchitectureDeepLinkState,
} from '@/modules/architecture/architectureDeepLink';

/**
 * The standalone architecture page's deep link.
 *
 * The link is what makes "Open in new tab" land on the SAME reading. Its two
 * halves have to be inverses — a generated link parsed back must be the state it
 * was generated from — and it must be forgiving in one direction only: every
 * malformed or unknown parameter is IGNORED so a hand-edited URL can never break
 * the page. These cases pin the parser, the builder and the href shape.
 */

const FULL_STATE: ArchitectureDeepLinkState = {
  view: 'file',
  scope: 1,
  detail: 'core',
  entity: 'src/modules/alpha/A.ts.Alpha',
  mode: 'neighbourhood',
};

test('parses every supported parameter', () => {
  assert.deepEqual(
    parseArchitectureDeepLink(
      '?view=file&scope=1&detail=core&entity=src%2Fmodules%2Falpha%2FA.ts.Alpha&mode=neighbourhood',
    ),
    FULL_STATE,
  );
});

test('accepts the entity subgraph under the name the task gives it', () => {
  assert.deepEqual(parseArchitectureDeepLink('?view=class'), {
    ...EMPTY_ARCHITECTURE_DEEP_LINK,
    view: 'class',
  });
});

test('parses a bare query string and a leading-question-mark form identically', () => {
  assert.deepEqual(
    parseArchitectureDeepLink('view=class&scope=2'),
    parseArchitectureDeepLink('?view=class&scope=2'),
  );
});

test('ignores invalid values instead of clamping or throwing', () => {
  const parsed = parseArchitectureDeepLink(
    '?view=sequence&scope=abc&detail=verbose&entity=&mode=drill',
  );
  assert.deepEqual(parsed, EMPTY_ARCHITECTURE_DEEP_LINK);
});

test('ignores a scope outside the stepper range and non-integer forms', () => {
  for (const raw of ['-1', '9', '1.5', '2abc', '', '+2']) {
    assert.equal(
      parseArchitectureDeepLink(`?scope=${raw}`).scope,
      null,
      `scope=${raw} must be ignored, not interpreted`,
    );
  }
  for (const raw of ['0', '1', '2', '3']) {
    assert.equal(parseArchitectureDeepLink(`?scope=${raw}`).scope, Number(raw));
  }
});

test('ignores unknown parameters and keeps the known ones', () => {
  const parsed = parseArchitectureDeepLink('?view=class&future=whatever&scope=3');
  assert.deepEqual(parsed, { ...EMPTY_ARCHITECTURE_DEEP_LINK, view: 'class', scope: 3 });
});

test('an empty search is the empty state', () => {
  assert.deepEqual(parseArchitectureDeepLink(''), EMPTY_ARCHITECTURE_DEEP_LINK);
});

test('the builder and the parser are inverses', () => {
  assert.deepEqual(parseArchitectureDeepLink(buildArchitectureDeepLinkParams(FULL_STATE)), FULL_STATE);
});

test('the builder omits absent readings', () => {
  const params = buildArchitectureDeepLinkParams({ ...EMPTY_ARCHITECTURE_DEEP_LINK, view: 'class' });
  assert.equal(params, 'view=class');
  assert.deepEqual(parseArchitectureDeepLink(params), {
    ...EMPTY_ARCHITECTURE_DEEP_LINK,
    view: 'class',
  });
});

test('entity ids with query-significant characters survive the round trip encoded', () => {
  const state: ArchitectureDeepLinkState = {
    ...EMPTY_ARCHITECTURE_DEEP_LINK,
    entity: 'src/a b&c=d+e/文件.ts.Thing%Thing',
  };
  const params = buildArchitectureDeepLinkParams(state);
  // The raw separator characters must never appear inside the entity VALUE; the
  // only `=`/`&` in the string are the parameter's own.
  const entityValue = params.slice(params.indexOf('entity=') + 'entity='.length);
  assert.equal(/[&=]/.test(entityValue), false, `entity value leaked a separator: ${params}`);
  assert.equal(entityValue.includes(' '), false, 'a space must be percent-encoded');
  assert.deepEqual(parseArchitectureDeepLink(params), state);
});

test('the same input produces the same output (no reliance on insertion order outside the contract)', () => {
  const first = buildArchitectureDeepLinkParams(FULL_STATE);
  const second = buildArchitectureDeepLinkParams({ ...FULL_STATE });
  assert.equal(first, second);
  assert.deepEqual(parseArchitectureDeepLink(first), parseArchitectureDeepLink(second));
});

test('the standalone href keeps the deployment basename and encodes the session', () => {
  const href = buildArchitectureStandaloneHref({
    pathname: '/ai/session/a b',
    sessionId: 'session/1',
    state: { ...EMPTY_ARCHITECTURE_DEEP_LINK, view: 'class', scope: 2, detail: 'all' },
  });
  assert.equal(
    href,
    '/ai/session/session%2F1/architecture?view=class&scope=2&detail=all',
  );
});

test('the standalone href works when the root deploy has no basename', () => {
  const href = buildArchitectureStandaloneHref({
    pathname: '/session/session-1/architecture',
    sessionId: 'session-1',
    state: EMPTY_ARCHITECTURE_DEEP_LINK,
  });
  assert.equal(href, '/session/session-1/architecture');
});

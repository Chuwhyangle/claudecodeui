import assert from 'node:assert/strict';

import { afterEach, describe, it, vi } from 'vitest';

import { api } from '@/shared/api';

/**
 * The reply-suggestions endpoints' response reading.
 *
 * The parsers moved out of the composer hook and into the API layer, so this is
 * where the shape rules are pinned: a legal answer is typed, partial answers are
 * cleaned rather than trusted, and a refused or unreadable answer is the agreed
 * failure value (`null`) the controller falls back from. Nothing here asserts UI
 * behaviour — only the transport reading.
 */

const respond = (body: unknown, status = 200) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.replySuggestions.suggest', () => {
  it('returns the typed batch for a legal answer', async () => {
    const fetchMock = respond({ chips: ['答复一', '答复二'], draw: 7 });

    const result = await api.replySuggestions.suggest({ sessionId: 'session-a' });

    assert.deepEqual(result, { chips: ['答复一', '答复二'], draw: 7 });
    assert.equal(fetchMock.mock.calls.length, 1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    assert.equal(url, '/api/reply-suggestions');
    assert.equal(init.method, 'POST');
  });

  it('drops non-string elements and trims the rest', async () => {
    respond({ chips: ['  答复一  ', 3, null, '', '   ', '答复二'], draw: 1 });

    const result = await api.replySuggestions.suggest({ sessionId: 'session-a' });

    assert.deepEqual(result, { chips: ['答复一', '答复二'], draw: 1 });
  });

  it('caps the batch at maxChips', async () => {
    respond({ chips: ['一', '二', '三', '四'], draw: 1 });

    const result = await api.replySuggestions.suggest(
      { sessionId: 'session-a' },
      { maxChips: 2 },
    );

    assert.deepEqual(result, { chips: ['一', '二'], draw: 1 });
  });

  it('reads a missing or mistyped draw as 0', async () => {
    respond({ chips: ['一'], draw: 'not-a-number' });

    const result = await api.replySuggestions.suggest({ sessionId: 'session-a' });

    assert.deepEqual(result, { chips: ['一'], draw: 0 });
  });

  it('returns the failure value for a non-2xx answer', async () => {
    respond({ chips: ['一'], draw: 1 }, 502);

    assert.equal(await api.replySuggestions.suggest({ sessionId: 'session-a' }), null);
  });

  it('returns the failure value when the body is not an object', async () => {
    respond('not-an-object');
    assert.equal(await api.replySuggestions.suggest({ sessionId: 'session-a' }), null);

    respond([]);
    assert.equal(await api.replySuggestions.suggest({ sessionId: 'session-a' }), null);
  });
});

describe('api.replySuggestions.status', () => {
  it('returns the typed reading for a legal answer', async () => {
    const fetchMock = respond({ enabled: true, expansion: 'vary', maxChips: 5, maxChipChars: 80 });

    const result = await api.replySuggestions.status();

    assert.deepEqual(result, {
      enabled: true,
      expansion: 'vary',
      maxChips: 5,
      maxChipChars: 80,
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    assert.equal(url, '/api/reply-suggestions/status');
  });

  it('falls back to the disabled/default reading for missing fields', async () => {
    respond({ enabled: true });

    assert.deepEqual(await api.replySuggestions.status(), {
      enabled: true,
      expansion: 'off',
      maxChips: 3,
      maxChipChars: 120,
    });
  });

  it('returns the failure value for a non-2xx answer', async () => {
    respond({ enabled: true }, 503);

    assert.equal(await api.replySuggestions.status(), null);
  });

  it('returns the failure value when the body is not an object', async () => {
    respond(null);

    assert.equal(await api.replySuggestions.status(), null);
  });
});

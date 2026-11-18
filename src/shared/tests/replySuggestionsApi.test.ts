import assert from 'node:assert/strict';

import { afterEach, describe, it, vi } from 'vitest';

import { api } from '@/shared/api';

/**
 * The reply-suggestions endpoints' response reading.
 *
 * The parsers moved out of the composer hook and into the API layer, so this is
 * where the shape rules are pinned: a legal answer is typed, partial answers are
 * cleaned rather than trusted, and a refused or unreadable answer is the agreed
 * typed failure (`ok:false` with its `code`/`httpStatus`/`requestId`) the
 * controller turns into a visible episode. Nothing here asserts UI behaviour —
 * only the transport reading.
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

    assert.deepEqual(result, { ok: true, result: { chips: ['答复一', '答复二'], draw: 7 } });
    assert.equal(fetchMock.mock.calls.length, 1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    assert.equal(url, '/api/reply-suggestions');
    assert.equal(init.method, 'POST');
  });

  it('drops non-string elements and trims the rest', async () => {
    respond({ chips: ['  答复一  ', 3, null, '', '   ', '答复二'], draw: 1 });

    const result = await api.replySuggestions.suggest({ sessionId: 'session-a' });

    assert.deepEqual(result, { ok: true, result: { chips: ['答复一', '答复二'], draw: 1 } });
  });

  it('caps the batch at maxChips', async () => {
    respond({ chips: ['一', '二', '三', '四'], draw: 1 });

    const result = await api.replySuggestions.suggest(
      { sessionId: 'session-a' },
      { maxChips: 2 },
    );

    assert.deepEqual(result, { ok: true, result: { chips: ['一', '二'], draw: 1 } });
  });

  it('reads a missing or mistyped draw as 0', async () => {
    respond({ chips: ['一'], draw: 'not-a-number' });

    const result = await api.replySuggestions.suggest({ sessionId: 'session-a' });

    assert.deepEqual(result, { ok: true, result: { chips: ['一'], draw: 0 } });
  });

  it('returns the typed failure for a non-2xx answer, preserving code/status/requestId', async () => {
    respond({
      success: false,
      error: {
        code: 'REPLY_SUGGESTIONS_UPSTREAM_FAILED',
        message: 'reply-suggestions upstream request failed (http)',
        details: { requestId: 'a1b2c3d4', httpStatus: 502, category: 'http', model: 'gateway-model' },
      },
    }, 502);

    const result = await api.replySuggestions.suggest({ sessionId: 'session-a' });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'REPLY_SUGGESTIONS_UPSTREAM_FAILED');
    assert.equal(result.failure.httpStatus, 502);
    assert.equal(result.failure.requestId, 'a1b2c3d4');
    assert.equal(result.failure.category, 'http');
    assert.equal(result.failure.model, 'gateway-model');
    assert.equal(result.failure.message, 'reply-suggestions upstream request failed (http)');
  });

  it('derives the category from code + status when the body carries no details', async () => {
    respond({ success: false, error: { code: 'REPLY_SUGGESTIONS_RATE_LIMITED', message: 'over the cap' } }, 429);
    const rateLimited = await api.replySuggestions.suggest({ sessionId: 'session-a' });
    assert.equal(rateLimited.ok, false);
    if (!rateLimited.ok) {
      assert.equal(rateLimited.failure.category, 'rate-limit');
      assert.equal(rateLimited.failure.httpStatus, null);
      assert.equal(rateLimited.failure.requestId, null);
    }

    respond({ success: false, error: { code: 'REPLY_SUGGESTIONS_UPSTREAM_FAILED', message: 'failed' } }, 502);
    const upstream = await api.replySuggestions.suggest({ sessionId: 'session-a' });
    assert.equal(upstream.ok, false);
    if (!upstream.ok) assert.equal(upstream.failure.category, 'unknown');
  });

  it('returns ok:false, code unknown when the body is not an object', async () => {
    respond('not-an-object');
    const text = await api.replySuggestions.suggest({ sessionId: 'session-a' });
    assert.equal(text.ok, false);
    if (!text.ok) assert.equal(text.failure.code, 'unknown');

    respond([]);
    const array = await api.replySuggestions.suggest({ sessionId: 'session-a' });
    assert.equal(array.ok, false);
    if (!array.ok) assert.equal(array.failure.code, 'unknown');
  });

  it('returns ok:false with a readable message when a 200 body is unreadable', async () => {
    respond('not-an-object');

    const result = await api.replySuggestions.suggest({ sessionId: 'session-a' });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.code, 'unknown');
      assert.equal(result.failure.message, 'unreadable reply-suggestions response');
    }
  });
});

describe('api.replySuggestions.status', () => {
  it('returns the typed reading for a legal answer', async () => {
    const fetchMock = respond({
      enabled: true,
      state: 'ready',
      problems: [],
      lastFailure: null,
      expansion: 'vary',
      maxChips: 5,
      maxChipChars: 80,
    });

    const result = await api.replySuggestions.status();

    assert.deepEqual(result, {
      enabled: true,
      state: 'ready',
      problems: [],
      lastFailure: null,
      expansion: 'vary',
      maxChips: 5,
      maxChipChars: 80,
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    assert.equal(url, '/api/reply-suggestions/status');
  });

  it('mirrors the state, problems and lastFailure', async () => {
    respond({
      enabled: true,
      state: 'ready',
      problems: ['`apiKeyFile` has mode 644; 600 is expected'],
      lastFailure: {
        at: '2026-11-18T10:00:00.000Z',
        requestId: 'a1b2c3d4',
        category: 'http',
        httpStatus: 502,
        durationMs: 41,
        model: 'gateway-model',
        protocol: 'openai',
      },
      expansion: 'off',
      maxChips: 3,
      maxChipChars: 120,
    });

    const result = await api.replySuggestions.status();

    assert.equal(result?.state, 'ready');
    assert.deepEqual(result?.problems, ['`apiKeyFile` has mode 644; 600 is expected']);
    assert.deepEqual(result?.lastFailure, {
      at: '2026-11-18T10:00:00.000Z',
      requestId: 'a1b2c3d4',
      category: 'http',
      httpStatus: 502,
      durationMs: 41,
      model: 'gateway-model',
      protocol: 'openai',
    });
  });

  it('falls back to the disabled/default reading for missing fields', async () => {
    respond({ enabled: true });

    assert.deepEqual(await api.replySuggestions.status(), {
      enabled: true,
      state: 'ready',
      problems: [],
      lastFailure: null,
      expansion: 'off',
      maxChips: 3,
      maxChipChars: 120,
    });
  });

  it('reads an explicitly disabled old-style answer as off', async () => {
    respond({ enabled: false });

    assert.equal((await api.replySuggestions.status())?.state, 'off');
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

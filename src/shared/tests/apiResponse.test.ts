import { describe, expect, it } from 'vitest';

import { getApiErrorMessage, toResponseJson } from '@/shared/apiResponse';

describe('getApiErrorMessage', () => {
  it('reads the message from a structured error object', () => {
    expect(getApiErrorMessage({ error: { message: 'structured boom' } }, 'fallback')).toBe('structured boom');
  });

  it('reads a legacy string error', () => {
    expect(getApiErrorMessage({ error: 'string boom' }, 'fallback')).toBe('string boom');
  });

  it('falls back to a top-level details string', () => {
    expect(getApiErrorMessage({ details: 'details boom' }, 'fallback')).toBe('details boom');
  });

  it('uses the fallback when the envelope carries no error field', () => {
    expect(getApiErrorMessage({ success: false }, 'fallback')).toBe('fallback');
  });

  it('uses the fallback for non-object payloads', () => {
    expect(getApiErrorMessage('boom', 'fallback')).toBe('fallback');
  });
});

describe('toResponseJson', () => {
  it('parses the response body as JSON', async () => {
    const response = new Response(JSON.stringify({ success: true, data: { ok: true } }), {
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(toResponseJson<{ success: boolean; data: { ok: boolean } }>(response)).resolves.toEqual({
      success: true,
      data: { ok: true },
    });
  });
});

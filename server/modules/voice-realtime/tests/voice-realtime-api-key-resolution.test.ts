/**
 * The Live Voice realtime credential's resolution, pinned as pure functions.
 *
 * WHY THIS EXISTS. The realtime transport used to be handed `process.env.DASHSCOPE_API_KEY` alone,
 * while the one-shot `dashscope-omni` path already preferred the user's saved `dashscopeApiKey`.
 * The two roads are now one: `resolveRealtimeApiKey` reads ONLY the user's saved key (the deployment
 * environment variable is deprecated, 2026-10-19), and `isMaskedDashscopeApiKey` names the
 * frontend's masked placeholder so the transport can report a misconfigured credential instead of
 * dialling with bullets and reading a 401.
 *
 * Pinned readings:
 *   · the user's key passes through, trimmed;
 *   · an unset or whitespace-only key resolves to `''` so the transport's `MISSING_API_KEY` guard
 *     fires rather than dialling with a blank header;
 *   · a masked placeholder (••••••••) is NOT "unset" — it is the one value the `MASKED_API_KEY`
 *     guard catches, so `isMaskedDashscopeApiKey` is true for it and false for a real key.
 *
 * The functions are imported through the module barrel, the same surface `server/index.ts` uses.
 *
 * Provenance (goal record gap-voice-realtime-per-user-key): one of the files the criterion names.
 * Run with THIS repo's runner (the server tree is TS-ESM and `.js` specifiers need tsx):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test <this file>
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isMaskedDashscopeApiKey, resolveRealtimeApiKey } from '../index.js';

const BULLET = '•';

test('the user key passes through, trimmed', () => {
  assert.equal(resolveRealtimeApiKey('  sk-abc  '), 'sk-abc');
});

test('an unset user key resolves to the empty string, not a fallback', () => {
  assert.equal(resolveRealtimeApiKey(undefined), '');
  assert.equal(resolveRealtimeApiKey(''), '');
});

test('a whitespace-only user key counts as unset', () => {
  assert.equal(resolveRealtimeApiKey('   '), '');
});

test('a masked placeholder is not unset: it is carried through and named', () => {
  const masked = BULLET.repeat(8);
  assert.equal(resolveRealtimeApiKey(masked), masked);
  assert.equal(isMaskedDashscopeApiKey(masked), true);
});

test('a real key is not masked; an empty or whitespace key is not masked either', () => {
  assert.equal(isMaskedDashscopeApiKey('sk-2c419a8aef9b'), false);
  assert.equal(isMaskedDashscopeApiKey(''), false);
  assert.equal(isMaskedDashscopeApiKey('   '), false);
});

test('a masked placeholder with surrounding whitespace is still masked', () => {
  assert.equal(isMaskedDashscopeApiKey(`  ${BULLET.repeat(8)}  `), true);
});

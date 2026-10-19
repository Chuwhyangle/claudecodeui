/**
 * The Live Voice realtime credential's precedence, pinned as a pure function.
 *
 * WHY THIS EXISTS. The realtime transport used to be handed only `process.env.DASHSCOPE_API_KEY`,
 * while the one-shot `dashscope-omni` path already preferred the user's saved
 * `dashscopeApiKey`. The same DashScope key was therefore configured in two places and only one
 * road honoured the settings page. `resolveRealtimeApiKey` is the one decision the shipped assembly
 * point now makes, so this criterion pins its four readings — a user key beats the environment, an
 * empty or whitespace-only user key falls back to it, and two empty keys stay empty so the
 * transport's own `MISSING_API_KEY` guard still fires rather than dialling with a blank header.
 *
 * The function is imported through the module barrel, the same surface `server/index.ts` uses.
 *
 * Provenance (goal record gap-voice-realtime-per-user-key): one of the files the criterion names.
 * Run with THIS repo's runner (the server tree is TS-ESM and `.js` specifiers need tsx):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test <this file>
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRealtimeApiKey } from '../index.js';

test('the user key wins over the deployment environment', () => {
  assert.equal(resolveRealtimeApiKey('u', 'e'), 'u');
});

test('an empty user key falls back to the deployment environment', () => {
  assert.equal(resolveRealtimeApiKey('', 'e'), 'e');
});

test('a whitespace-only user key counts as unset', () => {
  assert.equal(resolveRealtimeApiKey('  ', 'e'), 'e');
});

test('two unset keys resolve to the empty string, not a fallback', () => {
  assert.equal(resolveRealtimeApiKey('', ''), '');
});

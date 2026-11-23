import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { test } from 'vitest';

import { TokenUsageSummary } from '@/modules/chat-composer';
import enChat from '@/modules/i18n/locales/en/chat.json';

/**
 * The composer chip shows the session's context reading, and the turn block the
 * server now attaches beside it: how fast the model wrote, how long the turn
 * took, how much of its prompt came from cache, and what it cost at the
 * configured rates. A transcript that predates the field must keep rendering
 * exactly what it rendered before.
 *
 * Real translations and the real memoized chip: the numbers have to reach the
 * screen through the component the composer actually mounts.
 */

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const turnUsage = {
  totalTokens: 10_510_196,
  inputTokens: 48_566,
  outputTokens: 36_926,
  cacheReadTokens: 10_424_704,
  cacheWriteTokens: 0,
  cacheHitRatio: 0.99536,
  elapsedMs: 379_762,
  apiMs: 291_909,
  tps: 126.49,
  costUsd: 0.3642,
  calls: 77,
};

test('the composer chip shows the turn speed, duration, cache hit and cost', () => {
  const { container } = render(<TokenUsageSummary usage={{ used: 163_778, turn: turnUsage }} />);

  const text = container.textContent ?? '';
  assert.match(text, /126 t\/s/);
  assert.match(text, /6m20s/);
  assert.match(text, /cache 99\.5%/);
  assert.match(text, /\$0\.364/);
});

test('a transcript without a turn keeps the chip exactly as it was', () => {
  const { container } = render(<TokenUsageSummary usage={{ used: 163_778 }} />);

  const text = container.textContent ?? '';
  assert.match(text, /164K/);
  assert.doesNotMatch(text, /t\/s/);
  assert.doesNotMatch(text, /\$/);
  assert.doesNotMatch(text, /cache/);
});

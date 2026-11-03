import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { test } from 'vitest';

import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { CommandModalPayload, CostCommandData } from '@/shared/types';

/**
 * The composer chip shows the session's context reading, and the turn block
 * the server now attaches beside it: how fast the model wrote, how long the
 * turn took, how much of its prompt came from cache, and what it cost at the
 * gateway's rates. A transcript that predates the field must keep rendering
 * exactly what it rendered before.
 *
 * Real translations and the real components: the numbers have to reach the
 * screen through the memoized chip and through the `/cost` dialog.
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
  used: 10510196,
  inputTokens: 48566,
  outputTokens: 36926,
  cacheReadTokens: 10424704,
  cacheCreationTokens: 0,
  cacheHitRate: 0.99536,
  elapsedMs: 379762,
  apiMs: 291909,
  tps: 126.49,
  costUsd: 0.3642,
  calls: 77,
};

const costPayload = (data: CostCommandData): CommandModalPayload => ({ kind: 'cost', data });

const renderCostModal = (data: CostCommandData) =>
  render(
    <CommandResultModal
      payload={costPayload(data)}
      onClose={() => {}}
      providerModelCatalog={{}}
      providerModelActions={{} as never}
      activeProvider="claude"
      activeProviderModel="sonnet"
      currentSessionId="session-1"
      onSelectProviderModel={async () => ({ scope: 'default', model: 'sonnet' })}
    />,
  );

test('the composer chip shows the turn speed, duration, cache hit and cost', () => {
  const { container } = render(<TokenUsageSummary usage={{ used: 163778, turn: turnUsage }} />);

  const text = container.textContent ?? '';
  assert.match(text, /126 t\/s/);
  assert.match(text, /6m20s/);
  assert.match(text, /cache 99\.5%/);
  assert.match(text, /\$0\.364/);
});

test('a transcript without turn timing keeps the chip exactly as it was', () => {
  const { container } = render(<TokenUsageSummary usage={{ used: 163778 }} />);

  const text = container.textContent ?? '';
  assert.match(text, /164K/);
  assert.doesNotMatch(text, /t\/s/);
  assert.doesNotMatch(text, /\$/);
});

test('the cost dialog lists the turn as its own group', () => {
  renderCostModal({
    tokenUsage: { used: 163778, total: 200000, turn: turnUsage },
    provider: 'claude',
    model: 'deepseek-v4-flash-anthropic',
  });

  assert.ok(screen.getByText('This turn — speed'));
  assert.ok(screen.getByText('126 t/s'));
  assert.ok(screen.getByText('This turn — cache hit'));
  assert.ok(screen.getByText('99.5%'));
  assert.ok(screen.getByText('This turn — cost'));
  assert.ok(screen.getByText('$0.3642'));
});

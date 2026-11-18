import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import { DiagnosticsHealthList, type DiagnosticsApi } from '@/modules/diagnostics';
import DiagnosticsSettingsTab from '@/modules/settings/tabs/DiagnosticsSettingsTab';
import type { DiagnosticsFailure, DiagnosticsFeature } from '@/shared/types';

/**
 * Settings → Diagnostics & Logs criterion.
 *
 * Drives the real tab over an injected API and clipboard, so the readings are
 * what the page renders: loading → ready, a visible load error that does not
 * throw, the three health-card states, a recent-failure row, the copy
 * success/failure banner, and both `data-slot` surfaces the card and table own.
 * The copy hint also pins the "redacted on the server" contract in the UI.
 */

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal() as object),
  // The key is the readable label, so each case asserts the exact copy key rendered.
  useTranslation: () => ({ t: (key: string) => key }),
}));

const FEATURE: DiagnosticsFeature = {
  id: 'reply-suggestions',
  label: 'Reply suggestions',
  state: 'degraded',
  enabled: true,
  problems: ['`model` is required when `enabled` is true'],
  lastSuccessAt: '2026-11-18T08:00:00.000Z',
  lastFailure: null,
  configSource: 'file:/home/u/.config/claudecodeui/reply-suggestions.settings.json',
};

const FAILURE: DiagnosticsFailure = {
  at: '2026-11-18T10:00:00.000Z',
  featureId: 'reply-suggestions',
  feature: 'Reply suggestions',
  requestId: 'abcd1234',
  category: 'http',
  httpStatus: 502,
  durationMs: 42,
  model: 'gateway-model',
  protocol: 'anthropic',
};

function api(overrides: Partial<DiagnosticsApi> = {}): DiagnosticsApi {
  return {
    features: async () => ({ features: [FEATURE] }),
    recentFailures: async () => ({ failures: [FAILURE] }),
    bundle: async () => 'Cloudpit diagnostics bundle',
    ...overrides,
  };
}

test('(a) the tab goes loading -> ready and renders both data-slot surfaces with the failure row', async () => {
  const view = render(
    <DiagnosticsSettingsTab api={api()} writeClipboard={async () => {}} />,
  );

  // The first render has a load in flight and no data yet. `diagnostics.loading`
  // labels both the refresh control and the placeholder, so allow either/more.
  assert.ok(view.getAllByText('diagnostics.loading').length >= 1, 'the in-flight state is visible');

  await waitFor(() => {
    assert.ok(view.container.querySelector('[data-slot="diagnostics-health"]'), 'the health surface exists');
    assert.ok(view.container.querySelector('[data-slot="diagnostics-recent-failures"]'), 'the table surface exists');
  });

  // The health card: localized feature name, derived state, config source, problems.
  assert.ok(view.getByText('diagnostics.features.replySuggestions'), 'the feature name is the localized key');
  assert.equal(
    view.container.querySelector('[data-diagnostics-state]')?.getAttribute('data-diagnostics-state'),
    'degraded',
    'a ready feature whose latest attempt failed is drawn degraded',
  );
  assert.ok(view.getByText('diagnostics.enabled'), 'the enabled reading is shown');
  assert.ok(view.getByText('file:/home/u/.config/claudecodeui/reply-suggestions.settings.json'));
  assert.ok(view.getByText('`model` is required when `enabled` is true'), 'the problems list is readable');
  assert.ok(view.getByText('diagnostics.lastSuccessLabel'));

  // The recent-failures table row: request id, upstream status, duration. The
  // same facts are drawn twice — the desktop table and the narrow card — so
  // each query expects at least one of the two.
  assert.ok(view.getAllByText('abcd1234').length >= 1, 'the request id column is rendered');
  assert.ok(view.getAllByText('502').length >= 1, 'the upstream status is rendered');
  assert.ok(view.getAllByText('42 ms').length >= 1, 'the duration is rendered');
  assert.ok(view.getAllByText('diagnostics.table.requestId').length >= 1);

  // The redaction is a server guarantee stated in the UI; the page itself carries no key.
  assert.ok(view.getByText('diagnostics.copy.hint'));
  assert.ok(!(view.container.textContent ?? '').includes('sk-'), 'no key reaches the page');
});

test('(b) a failed load shows a visible error and does not throw', async () => {
  const view = render(
    <DiagnosticsSettingsTab
      api={api({ features: async () => { throw new Error('network down'); } })}
      writeClipboard={async () => {}}
    />,
  );

  await waitFor(() => assert.ok(view.getByRole('alert')));
  const alert = view.getByRole('alert');
  assert.ok(alert.textContent?.includes('diagnostics.error'));
  assert.ok(alert.textContent?.includes('network down'));
  assert.ok(view.getByText('diagnostics.retry'), 'the retry action is offered');
});

test('(c) the health list draws every state with its own pill', () => {
  const states: DiagnosticsFeature[] = [
    { ...FEATURE, id: 'a', state: 'off', enabled: false },
    { ...FEATURE, id: 'b', state: 'misconfigured', enabled: false },
    { ...FEATURE, id: 'c', state: 'ready', enabled: true },
    { ...FEATURE, id: 'd', state: 'degraded', enabled: true },
    { ...FEATURE, id: 'e', state: 'ok', enabled: true },
  ];
  const view = render(<DiagnosticsHealthList features={states} />);

  const pills = Array.from(view.container.querySelectorAll('[data-diagnostics-state]'))
    .map((pill) => pill.getAttribute('data-diagnostics-state'));
  assert.deepEqual(pills, ['off', 'misconfigured', 'ready', 'degraded', 'ok']);
  for (const key of [
    'diagnostics.state.off',
    'diagnostics.state.misconfigured',
    'diagnostics.state.ready',
    'diagnostics.state.degraded',
    'diagnostics.state.ok',
  ]) {
    assert.ok(view.getByText(key), `${key} is rendered`);
  }
  // Only the explicitly-off row states "disabled": a misconfigured feature is
  // named by its state pill (配置不完整), not by an "off" chip.
  assert.equal(view.getAllByText('diagnostics.disabled').length, 1);
});

test('(d) copy reports success, and a clipboard refusal reports failure', async () => {
  const copied = render(
    <DiagnosticsSettingsTab api={api()} writeClipboard={async () => {}} />,
  );
  await waitFor(() => assert.ok(copied.container.querySelector('[data-slot="diagnostics-health"]')));

  fireEvent.click(copied.getByText('diagnostics.copy.button'));
  await waitFor(() => {
    assert.ok(copied.container.querySelector('[data-diagnostics-copy="copied"]'), 'the success banner is shown');
  });
  assert.ok(copied.getByText('diagnostics.copy.copied'));

  // A second mount in the same case needs the first one unmounted, or a
  // document-wide query would match both.
  cleanup();

  const refused = render(
    <DiagnosticsSettingsTab
      api={api()}
      writeClipboard={async () => { throw new Error('clipboard denied'); }}
    />,
  );
  await waitFor(() => assert.ok(refused.container.querySelector('[data-slot="diagnostics-health"]')));
  fireEvent.click(within(refused.container).getByText('diagnostics.copy.button'));
  await waitFor(() => {
    assert.ok(refused.container.querySelector('[data-diagnostics-copy="failed"]'), 'the failure banner is shown');
  });
  assert.ok(within(refused.container).getByText('diagnostics.copy.failed'));
});

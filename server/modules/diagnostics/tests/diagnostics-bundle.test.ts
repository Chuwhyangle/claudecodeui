/**
 * The copyable bundle criterion.
 *
 * Pins the document's shape (the header facts, the per-feature block, the
 * failure rows) and the final redaction pass, including values the service never
 * saw — the meta block is composed by the module and must be scrubbed here too.
 * It also pins the empty states so a missing section cannot masquerade as a
 * clean one.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/diagnostics/tests/diagnostics-bundle.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderDiagnosticsBundle } from '../diagnostics-bundle.js';
import type { DiagnosticsBundleInput } from '../diagnostics.service.js';

const INPUT: DiagnosticsBundleInput = {
  meta: {
    version: '2.0.0',
    installForm: 'npm',
    platform: 'darwin',
    settingsSource: 'default',
    settingsPath: null,
  },
  features: [
    {
      id: 'reply-suggestions',
      label: 'Reply suggestions',
      state: 'ready',
      enabled: true,
      problems: [],
      lastSuccessAt: '2026-11-18T09:00:00.000Z',
      lastFailure: null,
      configSource: 'default',
    },
  ],
  failures: [],
  generatedAt: '2026-11-18T12:00:00.000Z',
};

test('(a) the bundle is a plain-text report with the header, feature and failure sections', () => {
  const text = renderDiagnosticsBundle(INPUT);
  const lines = text.split('\n');

  assert.equal(lines[0], 'Cloudpit diagnostics bundle');
  assert.ok(text.includes('generatedAt: 2026-11-18T12:00:00.000Z'));
  assert.ok(text.includes('version: 2.0.0'));
  assert.ok(text.includes('installForm: npm'));
  assert.ok(text.includes('platform: darwin'));
  assert.ok(text.includes('settingsSource: default'));
  assert.ok(text.includes('settingsPath: default'));
  assert.ok(text.includes('feature: reply-suggestions (Reply suggestions)'));
  assert.ok(text.includes('state: ready'));
  assert.ok(text.includes('enabled: yes'));
  assert.ok(text.includes('lastFailure: none'));
  assert.ok(text.includes('recent failures (0):'));
  assert.ok(text.includes('  none'));
});

test('(b) an empty reading still names both sections rather than omitting them', () => {
  const text = renderDiagnosticsBundle({
    ...INPUT,
    features: [],
    failures: [],
  });
  assert.ok(text.includes('features (0):'));
  assert.ok(text.includes('  none registered'));
  assert.ok(text.includes('recent failures (0):'));
});

test('(c) the final pass redacts secrets introduced by the meta block or a label', () => {
  const text = renderDiagnosticsBundle({
    ...INPUT,
    meta: {
      ...INPUT.meta,
      settingsPath: '/home/u/sk-live-secret/config.json LITELLM_API_KEY=abc Authorization: Bearer tok-123',
    },
    features: [{
      ...INPUT.features[0],
      label: 'upstream sk-another-secret',
    }],
  });

  assert.ok(!text.includes('sk-'), 'no sk- token survives');
  assert.ok(!text.includes('LITELLM_API_KEY='), 'no API-key assignment survives');
  assert.ok(!text.includes('Bearer '), 'no bearer header survives');
  assert.ok(text.includes('[redacted]'), 'the redaction is visible in the document');
});

/**
 * The diagnostics aggregation criterion.
 *
 * Drives `createDiagnosticsService` over literal feature readings, so the state
 * derivation, the failure trimming, the bundle's field completeness and the
 * server-side redaction are read end to end without a process, a file or a
 * gateway. The route's HTTP face is the sibling criterion.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/diagnostics/tests/diagnostics-service.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderDiagnosticsBundle } from '../diagnostics-bundle.js';
import {
  clampRecentFailuresLimit,
  createDiagnosticsService,
  redactDiagnosticsText,
  resolveDiagnosticsFeatureState,
  type DiagnosticsFailureRecord,
  type DiagnosticsFeatureProvider,
  type DiagnosticsFeatureReading,
  type DiagnosticsMeta,
} from '../diagnostics.service.js';

const META: DiagnosticsMeta = {
  version: '1.2.3',
  installForm: 'git',
  platform: 'linux',
  settingsSource: 'file',
  settingsPath: '/home/operator/.config/claudecodeui/reply-suggestions.settings.json',
};

function reading(overrides: Partial<DiagnosticsFeatureReading> = {}): DiagnosticsFeatureReading {
  return {
    state: 'ready',
    enabled: true,
    problems: [],
    lastSuccessAt: null,
    lastFailure: null,
    failures: [],
    configSource: 'file:/home/operator/.config/claudecodeui/reply-suggestions.settings.json',
    ...overrides,
  };
}

function failure(overrides: Partial<DiagnosticsFailureRecord> = {}): DiagnosticsFailureRecord {
  return {
    at: '2026-11-18T10:00:00.000Z',
    requestId: 'abcd1234',
    category: 'http',
    httpStatus: 502,
    durationMs: 42,
    model: 'gateway-model',
    protocol: 'anthropic',
    ...overrides,
  };
}

function provider(id: string, value: DiagnosticsFeatureReading): DiagnosticsFeatureProvider {
  return { id, label: id.toUpperCase(), read: () => value };
}

function service(providers: DiagnosticsFeatureProvider[]) {
  return createDiagnosticsService({ providers, meta: () => META, now: () => Date.parse('2026-11-18T12:00:00.000Z') });
}

test('(a) the health state maps off / misconfigured / ready / degraded', () => {
  assert.equal(resolveDiagnosticsFeatureState(reading({ state: 'off', enabled: false })), 'off');
  assert.equal(resolveDiagnosticsFeatureState(reading({ state: 'misconfigured', enabled: false })), 'misconfigured');
  assert.equal(resolveDiagnosticsFeatureState(reading({ state: 'ready' })), 'ready');
  // A ready feature whose latest attempt failed is degraded...
  assert.equal(
    resolveDiagnosticsFeatureState(reading({ state: 'ready', lastFailure: failure() })),
    'degraded',
  );
  // ...unless a later success moved past that failure.
  assert.equal(
    resolveDiagnosticsFeatureState(reading({
      state: 'ready',
      lastFailure: failure({ at: '2026-11-18T10:00:00.000Z' }),
      lastSuccessAt: '2026-11-18T11:00:00.000Z',
    })),
    'ready',
  );
  // A failure AFTER the last success is live again.
  assert.equal(
    resolveDiagnosticsFeatureState(reading({
      state: 'ready',
      lastFailure: failure({ at: '2026-11-18T11:30:00.000Z' }),
      lastSuccessAt: '2026-11-18T11:00:00.000Z',
    })),
    'degraded',
  );
});

test('(a2) the published feature rows carry the derived state, problems and timestamps', () => {
  const degraded = service([
    provider('reply-suggestions', reading({
      state: 'ready',
      problems: ['`model` is required when `enabled` is true'],
      lastFailure: failure(),
    })),
    provider('voice', reading({ state: 'off', enabled: false })),
    provider('observation', reading({ state: 'ok' })),
  ]).features();

  assert.deepEqual(degraded.map((feature) => [feature.id, feature.state]), [
    ['reply-suggestions', 'degraded'],
    ['voice', 'off'],
    ['observation', 'ok'],
  ]);
  assert.deepEqual(degraded[0]?.problems, ['`model` is required when `enabled` is true']);
  assert.equal(degraded[0]?.lastFailure?.httpStatus, 502);
  assert.equal(degraded[0]?.lastSuccessAt, null);
  assert.ok(degraded[0]?.configSource?.startsWith('file:'));
});

test('(b) recent failures are aggregated across features, newest first, and clamped', () => {
  const older = failure({ at: '2026-11-18T09:00:00.000Z', requestId: 'older' });
  const newer = failure({ at: '2026-11-18T11:00:00.000Z', requestId: 'newer' });
  const middle = failure({ at: '2026-11-18T10:00:00.000Z', requestId: 'middle' });
  const subject = service([
    provider('reply-suggestions', reading({ failures: [older, newer] })),
    provider('voice', reading({ failures: [middle] })),
  ]);

  assert.deepEqual(
    subject.recentFailures(50).map((entry) => entry.requestId),
    ['newer', 'middle', 'older'],
    'newest first across features',
  );
  assert.deepEqual(
    subject.recentFailures(2).map((entry) => entry.requestId),
    ['newer', 'middle'],
    'the limit keeps the newest rows',
  );
  assert.deepEqual(subject.recentFailures(0).map((entry) => entry.requestId), ['newer'], '0 clamps to 1');
  assert.equal(subject.recentFailures(9999).length, 3, 'a huge limit returns every row');
  assert.deepEqual(
    subject.recentFailures(50).map((entry) => entry.featureId).sort(),
    ['reply-suggestions', 'reply-suggestions', 'voice'],
    'each row is tagged with the feature that produced it',
  );
  assert.equal(clampRecentFailuresLimit(0), 1);
  assert.equal(clampRecentFailuresLimit(9999), 200);
  assert.equal(clampRecentFailuresLimit(Number.NaN), 50);
});

test('(c) the bundle states every required field, including the settings source and path', () => {
  const subject = service([
    provider('reply-suggestions', reading({
      state: 'ready',
      enabled: true,
      problems: ['`model` is required when `enabled` is true'],
      lastSuccessAt: '2026-11-18T08:00:00.000Z',
      lastFailure: failure(),
      failures: [failure()],
    })),
  ]);
  const bundle = renderDiagnosticsBundle(subject.bundleInput());

  for (const expected of [
    'Cloudpit diagnostics bundle',
    'version: 1.2.3',
    'installForm: git',
    'platform: linux',
    'settingsSource: file',
    `settingsPath: ${META.settingsPath}`,
    'feature: reply-suggestions (REPLY-SUGGESTIONS)',
    'state: degraded',
    'enabled: yes',
    'lastSuccessAt: 2026-11-18T08:00:00.000Z',
    '`model` is required when `enabled` is true',
    'lastFailure: at=2026-11-18T10:00:00.000Z',
    'httpStatus=502',
    'requestId=abcd1234',
    'model=gateway-model',
    'recent failures (1):',
  ]) {
    assert.ok(bundle.includes(expected), `the bundle must state ${JSON.stringify(expected)}`);
  }
  assert.ok(!bundle.includes('\nundefined'), 'no field renders as undefined');
});

test('(d) redaction removes key-shaped strings from features, failures and the bundle', () => {
  const secrets = 'sk-test-secret LITELLM_API_KEY=abc123 Authorization: Bearer eyJhbGciOi.xx-yy_zz';
  const subject = service([
    provider('reply-suggestions', reading({
      state: 'ready',
      problems: [`gateway rejected: ${secrets}`],
      lastFailure: failure({ model: 'sk-test-secret', protocol: 'openai' }),
      failures: [failure({ model: 'LITELLM_API_KEY=abc123' })],
    })),
  ]);

  const featuresText = JSON.stringify(subject.features());
  const failuresText = JSON.stringify(subject.recentFailures(50));
  const bundle = renderDiagnosticsBundle(subject.bundleInput());

  for (const [label, text] of [['features', featuresText], ['failures', failuresText], ['bundle', bundle]] as const) {
    assert.ok(!text.includes('sk-'), `${label} must not carry an sk- token`);
    assert.ok(!text.includes('LITELLM_API_KEY='), `${label} must not carry an API-key assignment`);
    assert.ok(!text.includes('Bearer '), `${label} must not carry a bearer header`);
    assert.ok(text.includes('[redacted]'), `${label} must show that something was redacted`);
  }

  // At least the lastFailure/failure rows survive as correlation facts.
  assert.equal(subject.recentFailures(50).length, 1);
  assert.equal(subject.recentFailures(50)[0]?.httpStatus, 502);
  assert.equal(subject.recentFailures(50)[0]?.requestId, 'abcd1234');
  assert.equal(redactDiagnosticsText('nothing secret here'), 'nothing secret here');
});

test('(e) a provider that throws is degraded, and its failure does not break the other rows', () => {
  const broken: DiagnosticsFeatureProvider = {
    id: 'broken',
    label: 'Broken',
    read: () => { throw new Error('boom'); },
  };
  const subject = service([broken, provider('reply-suggestions', reading())]);

  const features = subject.features();
  assert.equal(features[0]?.state, 'degraded');
  assert.ok(features[0]?.problems.some((problem) => problem.includes('boom')));
  assert.equal(features[1]?.state, 'ready');
  assert.deepEqual(subject.recentFailures(50), [], 'a broken provider contributes no history');
});

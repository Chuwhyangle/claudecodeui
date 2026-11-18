import assert from 'node:assert/strict';

import { describe, it, vi } from 'vitest';

import type { DiagnosticsFailure, DiagnosticsFeature } from '@/shared/types';

import { createDiagnosticsController, type DiagnosticsApi } from '@/modules/diagnostics/diagnosticsController';

/**
 * The diagnostics controller criterion.
 *
 * Reads the page's rules without React: the two reads settle as one load, a
 * failure is visible text that keeps the previous diagnosis, a superseded load
 * cannot overwrite a newer one, and the copy action reports success/failure
 * without throwing.
 */

const FEATURE: DiagnosticsFeature = {
  id: 'reply-suggestions',
  label: 'Reply suggestions',
  state: 'degraded',
  enabled: true,
  problems: ['`model` is required when `enabled` is true'],
  lastSuccessAt: '2026-11-18T08:00:00.000Z',
  lastFailure: null,
  configSource: 'file:/home/u/settings.json',
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

/** Lets the controller's fire-and-forget promise chain settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function healthyApi(overrides: Partial<DiagnosticsApi> = {}): DiagnosticsApi {
  return {
    features: async () => ({ features: [FEATURE] }),
    recentFailures: async () => ({ failures: [FAILURE] }),
    bundle: async () => 'Cloudpit diagnostics bundle',
    ...overrides,
  };
}

describe('diagnostics controller', () => {
  it('(a) one load fetches both readings in parallel and ends loading -> ready', async () => {
    const features = vi.fn(async () => ({ features: [FEATURE] }));
    const recentFailures = vi.fn(async () => ({ failures: [FAILURE] }));
    const controller = createDiagnosticsController({
      api: healthyApi({ features, recentFailures }),
      writeClipboard: async () => {},
    });

    assert.equal(controller.getSnapshot().loading, false, 'nothing is loading before the first read');
    controller.load();
    assert.equal(controller.getSnapshot().loading, true, 'the read is visible while it is in flight');

    await flush();
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.loading, false);
    assert.equal(snapshot.error, null);
    assert.deepEqual(snapshot.features, [FEATURE]);
    assert.deepEqual(snapshot.failures, [FAILURE]);
    assert.equal(features.mock.calls.length, 1);
    assert.equal(recentFailures.mock.calls.length, 1);
    assert.ok(snapshot.lastLoadedAt !== null, 'the load is timestamped');
    controller.dispose();
  });

  it('(b) a failed read is a visible error, never a throw', async () => {
    const controller = createDiagnosticsController({
      api: healthyApi({ features: async () => { throw new Error('features request failed'); } }),
      writeClipboard: async () => {},
    });

    assert.doesNotThrow(() => controller.load());
    await flush();

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.error, 'features request failed');
    assert.equal(snapshot.loading, false);
    assert.deepEqual(snapshot.features, []);
    controller.dispose();
  });

  it('(b2) a refresh failure keeps the data already on screen and shows the message', async () => {
    let failing = false;
    const controller = createDiagnosticsController({
      api: healthyApi({
        features: async () => {
          if (failing) throw new Error('network down');
          return { features: [FEATURE] };
        },
      }),
      writeClipboard: async () => {},
    });

    controller.load();
    await flush();
    failing = true;
    controller.load();
    await flush();

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.error, 'network down');
    assert.equal(snapshot.loading, false);
    assert.deepEqual(snapshot.features, [FEATURE], 'the diagnosis that was on screen is not erased');
    controller.dispose();
  });

  it('(c) a superseded load cannot overwrite the newer answer', async () => {
    const pending: Array<(value: { features: DiagnosticsFeature[] }) => void> = [];
    const controller = createDiagnosticsController({
      api: healthyApi({
        features: () => new Promise((resolve) => { pending.push(resolve); }),
      }),
      writeClipboard: async () => {},
    });

    controller.load();
    controller.load();
    assert.equal(pending.length, 2, 'both reads reached the API');

    const fresh = { features: [{ ...FEATURE, state: 'ready' as const }] };
    const stale = { features: [{ ...FEATURE, state: 'off' as const }] };
    pending[1](fresh);
    await flush();
    pending[0](stale);
    await flush();

    assert.deepEqual(controller.getSnapshot().features, fresh.features, 'the older answer is dropped');
    controller.dispose();
  });

  it('(d) copy reports copying -> copied, and a clipboard refusal -> failed, without throwing', async () => {
    const writeClipboard = vi.fn(async (_text: string) => {});
    const controller = createDiagnosticsController({
      api: healthyApi(),
      writeClipboard,
    });

    controller.copyBundle();
    assert.equal(controller.getSnapshot().copyState, 'copying');
    await flush();
    assert.equal(controller.getSnapshot().copyState, 'copied');
    assert.equal(writeClipboard.mock.calls[0]?.[0], 'Cloudpit diagnostics bundle');

    const refusing = createDiagnosticsController({
      api: healthyApi(),
      writeClipboard: async () => { throw new Error('clipboard denied'); },
    });
    refusing.copyBundle();
    await flush();
    assert.equal(refusing.getSnapshot().copyState, 'failed', 'the refusal is a visible state');
    assert.equal(refusing.getSnapshot().error, null, 'a copy failure is not a page-load error');

    refusing.resetCopyState();
    assert.equal(refusing.getSnapshot().copyState, 'idle');
    controller.dispose();
    refusing.dispose();
  });

  it('(e) dispose stops accepting results', async () => {
    let resolveFeatures!: (value: { features: DiagnosticsFeature[] }) => void;
    const controller = createDiagnosticsController({
      api: healthyApi({
        features: () => new Promise((resolve) => { resolveFeatures = resolve; }),
      }),
      writeClipboard: async () => {},
    });
    controller.load();
    controller.dispose();
    resolveFeatures({ features: [FEATURE] });
    await flush();
    assert.deepEqual(controller.getSnapshot().features, [], 'a disposed controller publishes nothing');
  });
});

import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test } from 'vitest';

import {
  attachScenarioSurface,
  detachScenarioSurface,
  isScenarioSurfaceRequested,
  scenarioWindow,
} from '@/modules/ui-scenario';
import { buildVoiceInputContextPack, readVoiceInputPackBuildCount } from '@/modules/chat';
import { QuayPanel } from '@/modules/quay';
import type { QuayPanelView } from '@/modules/quay';
import type { ScenarioSurface } from '@/modules/ui-scenario';
import type { QuayInFlightTask, QuaySnapshot } from '@/shared/types';

/**
 * The semantic surface's two criteria, read through the surface itself.
 *
 * AC1 reads the SAME declaration the In-flight tile draws: the view publishes its contract into
 * the surface's registry, and the test pins each `{uri,label,display}` triple literally — not by
 * calling the producer again, which would only prove the producer agrees with itself. The
 * utterance leg is the seam reading: `lastInputPack.text` must equal
 * `buildVoiceInputContextPack`'s output for the same inputs (byte for byte — that function is
 * what the real ASR upload calls with a recognised segment), and the builder's own counter must
 * advance by exactly one across the utterance, which is how 「the same seam」 is observed rather
 * than asserted by inspection.
 *
 * AC2 is the closed half of the two-lock gate: the runtime lock is the only lock this file can
 * flip (the other is `import.meta.env.DEV`, true under vitest and compiled out in production).
 */

const PROJECT_ID = 'project-1';

const IN_FLIGHT: QuayInFlightTask[] = [
  {
    taskId: 'gap-wall-a',
    phase: 'implementing',
    startedAt: '2026-10-01T23:50:00.000Z',
    lastHeartbeat: '2026-10-02T00:00:00.000Z',
    workerPid: 1,
  },
  {
    taskId: 'gap-wall-b',
    phase: 'fan-in',
    startedAt: '2026-10-01T23:40:00.000Z',
    lastHeartbeat: '2026-10-02T00:00:00.000Z',
    workerPid: 1,
  },
];

const SNAPSHOT: QuaySnapshot = {
  projectId: PROJECT_ID,
  projectPath: '/workspace/project-1',
  generatedAt: '2026-10-02T00:00:00.000Z',
  cached: false,
  driver: { state: 'running', alive: true, running: true, lastRecordAt: '2026-10-01T23:59:00.000Z' },
  tasks: { total: 2, byStatus: { ready: 2 }, ready: 2, needsHuman: 0, done: 0, recent: [] },
  goals: { total: 0, achieved: 0, breakdown: { byStatus: {}, recent: [] } },
  adrs: { total: 0, recent: [] },
  configIssues: { total: 0, errors: 0 },
  tests: { current: null, recentRounds: [] },
  fanIn: { recent: [] },
  inFlight: IN_FLIGHT,
  dashboardUrl: null,
  warnings: [],
};

/**
 * The In-flight tile's declaration for {@link IN_FLIGHT}, written out rather than derived.
 *
 * The URIs are the project-segmented task form, the labels are the visible circled ordinals, and
 * `display` is what a spoken referent resolves against (「①」/「第二个」/「左上那个」). Pinning
 * these values is what lets the assertion below fail when the view starts declaring something
 * else — deriving them from `buildQuayInFlightContract` would follow the view wherever it went.
 */
const DECLARED_FOCUSABLES = [
  {
    uri: 'quay://project-1/task/gap-wall-a',
    label: '①',
    display: { status: 'implementing', color: 'blue', ordinal: 1, pos: { row: 1, column: 1 } },
  },
  {
    uri: 'quay://project-1/task/gap-wall-b',
    label: '②',
    display: { status: 'fan-in', color: 'violet', ordinal: 2, pos: { row: 2, column: 1 } },
  },
];

const LOADED_VIEW: QuayPanelView = { status: 'loaded', snapshot: SNAPSHOT };

/**
 * Renders the real panel — the product view that publishes the contract.
 *
 * `createElement` rather than JSX because this criterion's file is `.test.ts` (its path is fixed
 * by the task's read surface); the element it builds is the same one the app mounts.
 */
const renderPanel = () =>
  render(React.createElement(QuayPanel, { projectId: PROJECT_ID, view: LOADED_VIEW, onRefresh: () => {} }));

beforeEach(() => {
  detachScenarioSurface();
  window.localStorage.setItem('ui-scenario', 'on');
});

afterEach(() => {
  detachScenarioSurface();
  window.localStorage.removeItem('ui-scenario');
});

/** Waits until the panel's effect has published its contract into the surface's registry. */
const waitForPublished = async (): Promise<ScenarioSurface> => {
  let surface: ScenarioSurface | null = null;
  await waitFor(() => {
    surface = scenarioWindow().__cloudcliScenario ?? null;
    assert.notEqual(surface, null, 'the surface must be attached once the runtime lock is open');
    assert.equal(
      surface!.read().focusables.length,
      IN_FLIGHT.length,
      'the In-flight tile must have published its contract',
    );
  });
  return surface!;
};

test('AC1: read/drive address the view contract, and utter builds the real ASR input pack', async () => {
  assert.equal(attachScenarioSurface(), true);
  renderPanel();
  const surface = await waitForPublished();

  // ── the registry is the view's declaration, item for item ────────────────────────────────
  assert.deepEqual(surface.read().focusables, DECLARED_FOCUSABLES);
  assert.deepEqual(surface.read().views, [`quay://${PROJECT_ID}/board`]);
  assert.equal(surface.read().activeView, `quay://${PROJECT_ID}/board`);

  // ── focus by the label a person says ────────────────────────────────────────────────────
  surface.drive({ focus: '②' });
  assert.equal(surface.read().focus, DECLARED_FOCUSABLES[1].uri);
  assert.equal(surface.read().focusLabel, '②');
  assert.deepEqual(surface.read().history, [DECLARED_FOCUSABLES[1].uri]);

  // ── move the focus by one spatial step (the two rows are one column, so up is backwards) ──
  surface.drive({ move: 'up' });
  assert.equal(surface.read().focus, DECLARED_FOCUSABLES[0].uri, 'moving up must reach ①');

  // ── pin the focused object into the tray ────────────────────────────────────────────────
  surface.drive({ pin: true });
  assert.deepEqual(surface.read().tray, [DECLARED_FOCUSABLES[0].uri]);

  // ── utter: the same builder the real ASR path uses, and the seam's counter proves it ────
  const buildsBefore = readVoiceInputPackBuildCount();
  surface.drive({ utter: '把这个的第三条 AC 改宽' });
  const buildsAfter = readVoiceInputPackBuildCount();

  const pack = surface.read().lastInputPack;
  assert.notEqual(pack, null);
  assert.equal(pack!.focus, DECLARED_FOCUSABLES[0].uri, 'the pack resolves the current focus');
  assert.equal(pack!.focusLabel, '①');
  assert.equal(pack!.utterance, '把这个的第三条 AC 改宽');
  assert.deepEqual(pack!.tray, [DECLARED_FOCUSABLES[0].uri]);
  assert.deepEqual(pack!.visible, DECLARED_FOCUSABLES);

  // Byte-for-byte equal to what the real ASR output path builds for the same (empty) context.
  const realPathText = buildVoiceInputContextPack({
    messages: [],
    draftBefore: '',
    draftAfter: '',
    voiceSoFar: '',
  }).text;
  assert.equal(pack!.text, realPathText, 'the utterance must use the product builder, byte for byte');

  // The injected counter: exactly one build, i.e. this utterance walked the seam itself rather
  // than assembling a lookalike pack beside it.
  assert.equal(buildsAfter - buildsBefore, 1);
  assert.equal(pack!.seamBuilds, 1);
});

test('AC2: the surface does not exist while the runtime lock is closed', () => {
  // Outside the runtime lock the surface is not attached even by an explicit attach request.
  window.localStorage.removeItem('ui-scenario');
  detachScenarioSurface();

  assert.equal(isScenarioSurfaceRequested(), false);
  assert.equal(attachScenarioSurface(), false);
  assert.equal(scenarioWindow().__cloudcliScenario, undefined);
});

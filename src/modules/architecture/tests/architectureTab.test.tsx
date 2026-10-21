import assert from 'node:assert/strict';

import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import type { AppTab, Project } from '@/shared/types';
import type * as SharedApiModule from '@/shared/api';
import enCommon from '@/modules/i18n/locales/en/common.json';
import { WorkspaceHeader } from '@/modules/project-workspace';
import {
  ArchitecturePanel,
  isArchitectureTabVisible,
  useEnsureArchitectureTabVisible,
} from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';

/**
 * The architecture tab's wiring, end to end at the component seam:
 *  · the Tier-1 gate turns `hasArchguardCache` into the presence of
 *    `data-workspace-tab="architecture"`, placed right of Quay;
 *  · a project that loses the gate snaps an active architecture tab back to chat;
 *  · activating the panel POSTs the graph once and renders the server's Mermaid
 *    document through the code-editor barrel;
 *  · the file/entity toggle only selects between the two already-fetched
 *    documents — it must never re-request;
 *  · the honesty bar carries generatedAt / unresolved / truncated, and an empty
 *    seed set renders the empty state instead of a blank diagram.
 */

// The whole network hop is stubbed; everything below that line (the hook's
// request-id accounting, the panel's render branches, the toggle) is real.
const apiMock = vi.hoisted(() => ({ architectureGraph: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApiModule>();
  return {
    ...actual,
    api: { ...actual.api, architectureGraph: apiMock.architectureGraph },
  };
});

// The panel must reach the diagram through `src/modules/code-editor/index.ts`.
// Mocking exactly that barrel is what makes this reading discriminating: a deep
// import (`.../markdown/MermaidDiagram`) would bypass this mock and render the
// real component, whose DOM carries no `data-testid` — the case below goes red.
vi.mock('@/modules/code-editor', () => ({
  MermaidDiagram: ({ code }: { code: string }) => <pre data-testid="mermaid-diagram">{code}</pre>,
}));

// WorkspaceHeader lists every plugin tab; this criterion is about the built-in
// architecture tab, so the plugin list is empty.
vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [], loading: false, pluginsError: null }),
  PluginIcon: () => null,
}));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

// jsdom ships no ResizeObserver; the desktop tab strip observes its own overflow.
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const GENERATED_AT = '2026-10-20T15:52:34.427Z';
const FILE_MMD = 'flowchart LR\n  A --> B';
const ENTITY_MMD = 'flowchart LR\n  X --> Y';

const RESULT: ArchitectureGraphResult = {
  mmd: { file: FILE_MMD, entity: ENTITY_MMD },
  stats: {
    entityNodes: 2,
    fileNodes: 2,
    entityEdges: 1,
    fileEdges: 1,
    truncated: true,
    seedFiles: 1,
    seedIdentifiers: 1,
    nodeCount: 4,
    edgeCount: 2,
    unresolved: { files: ['src/unknown.ts'], identifiers: ['NoSuchThing'] },
  },
  provenance: {
    generatedAt: GENERATED_AT,
    fingerprints: [{ scope: 'scope-src', archJsonHash: 'a'.repeat(64) }],
    cacheHit: false,
  },
};

const EMPTY_RESULT: ArchitectureGraphResult = {
  mmd: { file: 'flowchart LR\n', entity: 'flowchart LR\n' },
  stats: {
    entityNodes: 0,
    fileNodes: 0,
    entityEdges: 0,
    fileEdges: 0,
    truncated: false,
    seedFiles: 0,
    seedIdentifiers: 0,
    nodeCount: 0,
    edgeCount: 0,
    unresolved: { files: [], identifiers: [] },
  },
  provenance: { generatedAt: GENERATED_AT, fingerprints: [], cacheHit: false },
};

/** A Response stand-in: only `ok` and `json` are read by `readApiJson`. */
function jsonResponse(result: ArchitectureGraphResult): Response {
  return {
    ok: true,
    status: 200,
    json: async () => result,
  } as unknown as Response;
}

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
});

const projectWithArchguard = (hasArchguardCache: boolean): Project => ({
  projectId: 'project-1',
  displayName: 'probe',
  fullPath: '/tmp/probe',
  hasArchguardCache,
});

function renderHeader(project: Project, activeTab: AppTab = 'chat') {
  return render(
    <WorkspaceHeader
      activeTab={activeTab}
      setActiveTab={() => {}}
      selectedProject={project}
      selectedSession={null}
      shouldShowTasksTab={false}
      shouldShowQuayTab
      shouldShowArchitectureTab={isArchitectureTabVisible(project)}
      shouldShowBrowserTab={false}
      isMobile={false}
      onMenuClick={() => {}}
    />,
  );
}

test('hasArchguardCache=true renders the architecture tab right of Quay', () => {
  renderHeader(projectWithArchguard(true));

  const tabIds = screen.getAllByRole('tab').map((tab) => tab.getAttribute('data-workspace-tab'));
  const architectureIndex = tabIds.indexOf('architecture');
  const quayIndex = tabIds.indexOf('quay');

  assert.notEqual(
    architectureIndex,
    -1,
    `the architecture tab must be rendered; tab ids were ${JSON.stringify(tabIds)}`,
  );
  assert.ok(
    architectureIndex > quayIndex,
    `the architecture tab must sit right of Quay; tab ids were ${JSON.stringify(tabIds)}`,
  );
});

test('hasArchguardCache=false hides the architecture tab', () => {
  renderHeader(projectWithArchguard(false));

  assert.equal(
    document.querySelector('[data-workspace-tab="architecture"]'),
    null,
    'a project without .archguard/query/manifest.json must not offer the tab',
  );
});

test('a hidden architecture tab snaps the active view back to chat', () => {
  const setActiveTab = vi.fn();
  renderHook(() => useEnsureArchitectureTabVisible(false, 'architecture', setActiveTab));

  assert.equal(setActiveTab.mock.calls.length, 1);
  assert.equal(setActiveTab.mock.calls[0][0], 'chat');
});

test('a visible architecture tab is left untouched, and an unrelated tab never moves', () => {
  const visibleSetter = vi.fn();
  renderHook(() => useEnsureArchitectureTabVisible(true, 'architecture', visibleSetter));
  assert.equal(visibleSetter.mock.calls.length, 0);

  const otherTabSetter = vi.fn();
  renderHook(() => useEnsureArchitectureTabVisible(false, 'chat', otherTabSetter));
  assert.equal(otherTabSetter.mock.calls.length, 0);
});

test('activating the panel fetches once, renders MermaidDiagram, and the toggle never refetches', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);

  const diagram = await screen.findByTestId('mermaid-diagram');
  assert.equal(diagram.textContent, FILE_MMD, 'the file document is the initial view');
  assert.deepEqual(
    apiMock.architectureGraph.mock.calls,
    [['project-1', 'session-1']],
    'activation must POST exactly once for the selected project/session',
  );

  fireEvent.click(screen.getByRole('button', { name: 'Entity graph' }));
  assert.equal(screen.getByTestId('mermaid-diagram').textContent, ENTITY_MMD);
  assert.equal(
    apiMock.architectureGraph.mock.calls.length,
    1,
    'the entity toggle selects a document that is already in hand — it must not refetch',
  );

  fireEvent.click(screen.getByRole('button', { name: 'File graph' }));
  assert.equal(screen.getByTestId('mermaid-diagram').textContent, FILE_MMD);
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1);
});

test('the honesty bar shows generatedAt, unresolved seeds and the truncation notice', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await screen.findByTestId('mermaid-diagram');

  const generatedAt = document.querySelector('[data-architecture-generated-at]');
  assert.equal(generatedAt?.textContent, GENERATED_AT, 'the analysis time must be the manifest timestamp');

  const unresolved = document.querySelector('[data-architecture-unresolved]');
  assert.equal(
    unresolved?.textContent,
    '2 unresolved seed(s)',
    `both unresolved seeds (1 file + 1 identifier) must be counted; got ${unresolved?.textContent}`,
  );

  const truncated = document.querySelector('[data-architecture-truncated]');
  assert.ok(truncated, 'a truncated reading must say so');
  assert.match(truncated.textContent ?? '', /truncated/i);
});

test('an empty seed set renders the empty state, not a blank diagram', async () => {
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(EMPTY_RESULT));

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);

  await waitFor(() =>
    assert.ok(
      document.querySelector('[data-architecture-empty]'),
      'an empty seed set must render the empty state',
    ),
  );
  assert.equal(
    screen.queryByTestId('mermaid-diagram'),
    null,
    'no seeds means there is no diagram to draw',
  );
  // The honesty bar still describes the (empty) reading rather than disappearing.
  assert.equal(document.querySelector('[data-architecture-generated-at]')?.textContent, GENERATED_AT);
  assert.equal(
    document.querySelector('[data-architecture-unresolved]')?.textContent,
    '0 unresolved seed(s)',
  );
});

test('the fetch effect tears down cleanly when the panel unmounts mid-request', async () => {
  // A reply that arrives after unmount must not touch React state; React would
  // warn, and the request id makes the late result a no-op by construction.
  let resolveResponse: (response: Response) => void = () => {};
  apiMock.architectureGraph.mockReturnValue(new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  }));

  const { unmount } = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  unmount();
  resolveResponse(jsonResponse(RESULT));

  await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.length, 1));
});

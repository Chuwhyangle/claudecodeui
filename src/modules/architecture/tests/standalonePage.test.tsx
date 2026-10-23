import assert from 'node:assert/strict';

import type { ReactElement } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import { ArchitecturePanel } from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';
import { ARCHITECTURE_CHAT_CHANNEL } from '@/modules/architecture/architectureChatBridge';
import type { ArchitectureRendererProps } from '@/modules/architecture/rendererContract';
import enCommon from '@/modules/i18n/locales/en/common.json';
import type * as SharedApiModule from '@/shared/api';
import { resetChatDrafts } from '@/shared/chatDrafts';

/**
 * The standalone architecture page (`/session/:sessionId/architecture`).
 *
 * The route renders the real panel with no workspace shell around it. These
 * cases pin the behavior the page adds on top of the in-page tab:
 *
 *  · no sidebar / tab strip, and the drawing's viewport-sized geometry;
 *  · the deep link's `view`, `scope`, `detail`, `entity` and `mode` decide the
 *    FIRST paint (and are not written back afterwards);
 *  · another tab's pin / exclusion / filter write reaches this page through the
 *    `storage` event, updating the drawing request and the Adjusted count within
 *    a second;
 *  · "Put in chat input" broadcasts instead of writing a local draft — an
 *    acknowledgement means no clipboard copy, and 1.5 s without one falls back
 *    to the clipboard with a notice;
 *  · "Open in new tab" passes the current view's deep link to `window.open`.
 */

const apiMock = vi.hoisted(() => ({
  architectureGraph: vi.fn(),
  architectureMentions: vi.fn(),
  architectureSearch: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      architectureGraph: apiMock.architectureGraph,
      architectureMentions: apiMock.architectureMentions,
      architectureSearch: apiMock.architectureSearch,
    },
  };
});

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const PROJECT_ID = 'project-1';
const SESSION_ID = 'session-1';
const ALPHA = 's1/src/modules/alpha/A.ts.Alpha';
const BETA = 's1/src/modules/alpha/B.ts.Beta';
const GAMMA = 's1/src/modules/beta/C.ts.Gamma';
const CURATION_KEY = `architecture.curation.v1:${PROJECT_ID}:${SESSION_ID}`;
const FILTER_KEY = `architecture.filter.${PROJECT_ID}`;

const RESULT: ArchitectureGraphResult = {
  mmd: { file: '@startuml\nA --> B\n@enduml', entity: '@startuml\nX --> Y\n@enduml' },
  graph: {
    file: {
      nodes: [
        { id: 'src/modules/alpha/A.ts', label: 'A.ts', distance: 0 },
        { id: 'src/modules/alpha/B.ts', label: 'B.ts', distance: 1 },
      ],
      edges: [{ from: 'src/modules/alpha/B.ts', to: 'src/modules/alpha/A.ts', relationType: 'dependency' }],
    },
    entity: {
      nodes: [
        { id: ALPHA, label: 'Alpha', distance: 0, kind: 'class' },
        { id: BETA, label: 'Beta', distance: 1, kind: 'interface' },
        { id: GAMMA, label: 'Gamma', distance: 2, kind: 'class' },
      ],
      edges: [
        { from: BETA, to: ALPHA, relationType: 'dependency' },
        { from: GAMMA, to: BETA, relationType: 'call' },
      ],
    },
  },
  stats: {
    entityNodes: 3,
    fileNodes: 2,
    entityEdges: 2,
    fileEdges: 1,
    truncated: false,
    entityTotal: 3,
    fileTotal: 2,
    seedFiles: 1,
    seedIdentifiers: 1,
    nodeCount: 5,
    edgeCount: 3,
    unresolved: { files: [], identifiers: [] },
  },
  provenance: { generatedAt: '2026-10-22T00:00:00.000Z', fingerprints: [], cacheHit: false },
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** A substitute renderer: the deep-link cases read the panel's props, not ELK. */
type StandInProps = ArchitectureRendererProps & {
  readonly focusNodeId?: string | null;
  readonly focusDrill?: boolean;
};

function StandIn(props: StandInProps): ReactElement {
  return (
    <div
      data-stand-in-renderer="true"
      data-stand-in-nodes={props.graph.nodes.length}
      data-stand-in-focus={props.focusNodeId ?? ''}
      data-stand-in-drill={String(props.focusDrill ?? false)}
    />
  );
}

/**
 * A controllable `BroadcastChannel`.
 *
 * Messages go to every OTHER instance with the same name, which is the property
 * the page relies on (a channel never receives its own post). A case can play
 * the workspace tab by installing a responder that answers on a second
 * instance.
 */
type ChannelListener = (event: { readonly data: unknown }) => void;

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  static responder: ((data: unknown) => void) | null = null;
  readonly name: string;
  private readonly listeners = new Set<ChannelListener>();

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    for (const channel of FakeBroadcastChannel.instances) {
      if (channel === this || channel.name !== this.name) continue;
      queueMicrotask(() => channel.dispatch(data));
    }
    FakeBroadcastChannel.responder?.(data);
  }

  addEventListener(type: string, listener: ChannelListener): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: ChannelListener): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    FakeBroadcastChannel.instances = FakeBroadcastChannel.instances.filter((entry) => entry !== this);
  }

  private dispatch(data: unknown): void {
    for (const listener of [...this.listeners]) listener({ data });
  }
}

const originalBroadcastChannel = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
const originalOpen = window.open;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const clipboardWrite = vi.fn(async (_text: string) => {});

function installFakeChannel(): void {
  FakeBroadcastChannel.instances = [];
  FakeBroadcastChannel.responder = null;
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    writable: true,
    value: FakeBroadcastChannel,
  });
}

function renderStandalone(deepLinkSearch = ''): ReturnType<typeof render> {
  return render(
    <ArchitecturePanel
      projectId={PROJECT_ID}
      sessionId={SESSION_ID}
      standalone
      deepLinkSearch={deepLinkSearch}
      onBackToSession={() => {}}
      renderer={StandIn}
    />,
  );
}

function waitForPanel(): Promise<void> {
  return waitFor(() => {
    assert.ok(document.querySelector('[data-architecture-panel]'), 'the panel must render');
    assert.ok(document.querySelector('[data-stand-in-renderer]'), 'the drawing must be handed to the renderer');
  });
}

function curationCount(): string | null {
  return document
    .querySelector('[data-architecture-curation-manager-toggle]')
    ?.getAttribute('data-architecture-curation-count') ?? null;
}

function curatorMessage(): string {
  return document.querySelector('[data-architecture-curation-toast-message]')?.textContent ?? '';
}

beforeAll(async () => {
  // Warm the renderer contract's module graph once; the cases use a stand-in.
  await import('@yalehwang/plantuml-js/elk');
});

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  apiMock.architectureMentions.mockReset();
  apiMock.architectureMentions.mockResolvedValue(jsonResponse({ mentions: [], truncated: false }));
  apiMock.architectureSearch.mockReset();
  apiMock.architectureSearch.mockResolvedValue(jsonResponse({ resolved: [] }));
  localStorage.clear();
  resetChatDrafts();
  installFakeChannel();
  clipboardWrite.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
  Object.defineProperty(window, 'open', { configurable: true, writable: true, value: vi.fn(() => null) });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 768 });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalBroadcastChannel === undefined) {
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
  } else {
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: originalBroadcastChannel,
    });
  }
  Object.defineProperty(window, 'open', { configurable: true, writable: true, value: originalOpen });
  if (originalClipboard === undefined) {
    delete (navigator as { clipboard?: unknown }).clipboard;
  } else {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  }
});

test('the standalone page renders the architecture panel alone, with no sidebar or tab strip', async () => {
  const { container } = renderStandalone();
  await waitForPanel();
  assert.equal(document.querySelectorAll('[data-workspace-tab]').length, 0);
  assert.equal(document.querySelectorAll('[data-app-shell]').length, 0);
  const panel = container.querySelector('[data-architecture-panel]');
  assert.ok(panel instanceof HTMLElement);
  assert.equal(panel.getAttribute('data-architecture-standalone'), 'true');
  assert.equal(panel.getAttribute('data-architecture-viewport-fill'), 'true');
  assert.equal(document.querySelectorAll('[data-architecture-standalone-back]').length, 1);
});

test('the deep link decides the first view, scope and detail', async () => {
  renderStandalone('?view=file&scope=1&detail=core');
  await waitFor(() => {
    assert.equal(document.querySelector('[data-architecture-view-option="file"]')?.getAttribute('aria-checked'), 'true');
  });
  await waitFor(() => assert.ok(apiMock.architectureGraph.mock.calls.length >= 1));
  const [projectArg, sessionArg, hopsArg, queryArg] = apiMock.architectureGraph.mock.calls[0];
  assert.equal(projectArg, PROJECT_ID);
  assert.equal(sessionArg, SESSION_ID);
  assert.equal(hopsArg, 1, 'the link’s scope is the first request’s BFS depth');
  assert.equal(
    Object.prototype.hasOwnProperty.call(queryArg ?? {}, 'kinds'),
    false,
    'the file view never sends element kinds',
  );
  assert.equal(document.querySelector('[data-architecture-detail-option="core"]')?.getAttribute('aria-checked'), 'true');
});

test('the deep link selects and centres an entity, and drills only when mode says so', async () => {
  renderStandalone(`?entity=${encodeURIComponent(ALPHA)}&mode=neighbourhood`);
  await waitFor(() => {
    const renderer = document.querySelector('[data-stand-in-renderer]');
    assert.equal(renderer?.getAttribute('data-stand-in-focus'), ALPHA);
    assert.equal(renderer?.getAttribute('data-stand-in-drill'), 'true');
  });
  await waitFor(() => {
    assert.equal(
      document.querySelector('[data-architecture-tray-root]')?.getAttribute('data-architecture-tray-selected'),
      '1',
      'the linked entity is the current selection',
    );
  });
});

test('another tab’s pin reaches this page’s Adjusted count through the storage event', async () => {
  renderStandalone();
  await waitForPanel();
  assert.equal(curationCount(), '0');

  const otherTabState = JSON.stringify({
    pins: [{ id: ALPHA, name: 'Alpha', file: 'src/modules/alpha/A.ts', kind: 'class' }],
    excluded: [],
    hiddenEdges: [],
  });
  localStorage.setItem(CURATION_KEY, otherTabState);
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: CURATION_KEY, newValue: otherTabState }));
  });

  await waitFor(
    () => assert.equal(curationCount(), '1'),
    { timeout: 1000 },
  );
  assert.match(document.body.textContent ?? '', /Adjusted 1/);
});

test('another tab’s filter reaches this page’s next graph request within a second', async () => {
  renderStandalone();
  await waitForPanel();
  await waitFor(() => assert.ok(apiMock.architectureGraph.mock.calls.length >= 1));

  const storedFilter = JSON.stringify({
    kinds: ['class'],
    relations: 'call',
    hideIsolated: false,
    keepMentionedKinds: [],
  });
  localStorage.setItem(FILTER_KEY, storedFilter);
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: FILTER_KEY, newValue: storedFilter }));
  });

  await waitFor(
    () => assert.ok(apiMock.architectureGraph.mock.calls.length >= 2),
    { timeout: 1000 },
  );
  const issue = apiMock.architectureGraph.mock.calls[apiMock.architectureGraph.mock.calls.length - 1];
  assert.deepEqual(issue[3]?.kinds, ['class']);
});

test('a confirmed "Put in chat input" does not copy to the clipboard', async () => {
  FakeBroadcastChannel.responder = (data) => {
    const message = data as { type?: string; sessionId?: string; requestId?: number } | null;
    if (message?.type !== 'put-in-chat') return;
    const reply = new FakeBroadcastChannel(ARCHITECTURE_CHAT_CHANNEL);
    reply.postMessage({
      type: 'put-in-chat-ack',
      sessionId: message.sessionId,
      requestId: message.requestId,
    });
    reply.close();
  };

  renderStandalone(`?entity=${encodeURIComponent(ALPHA)}`);
  const put = await waitFor(() => {
    const button = document.querySelector('[data-architecture-inspector-put-in-chat]');
    assert.ok(button, 'the deep-linked selection opens the inspector’s action');
    return button;
  });
  await act(async () => {
    fireEvent.click(put);
    await Promise.resolve();
    await Promise.resolve();
  });

  await waitFor(() => assert.match(curatorMessage(), /Sent to the session/));
  assert.equal(clipboardWrite.mock.calls.length, 0, 'a confirmed tab must not trigger the clipboard fallback');
});

test('"1.5 s without a confirmation" falls back to the clipboard with a notice', async () => {
  renderStandalone(`?entity=${encodeURIComponent(ALPHA)}`);
  const put = await waitFor(() => {
    const button = document.querySelector('[data-architecture-inspector-put-in-chat]');
    assert.ok(button);
    return button;
  });

  vi.useFakeTimers();
  await act(async () => {
    fireEvent.click(put);
    await Promise.resolve();
    vi.advanceTimersByTime(1600);
    await Promise.resolve();
    await Promise.resolve();
  });
  vi.useRealTimers();

  await waitFor(() => assert.equal(clipboardWrite.mock.calls.length, 1));
  const copied = clipboardWrite.mock.calls[0][0] as string;
  assert.match(copied, /Alpha/, 'the composed selection text is what reaches the clipboard');
  assert.match(curatorMessage(), /copied to the clipboard/);
});

test('"Open in new tab" calls window.open with the current view’s deep link', async () => {
  renderStandalone();
  const button = await waitFor(() => {
    const candidate = document.querySelector('[data-architecture-open-in-new-tab]');
    assert.ok(candidate, 'the toolbar carries the entry');
    return candidate;
  });
  fireEvent.click(button);

  const open = window.open as unknown as ReturnType<typeof vi.fn>;
  assert.equal(open.mock.calls.length, 1);
  const [href, target] = open.mock.calls[0] as [string, string];
  assert.equal(target, '_blank');
  assert.match(href, /^\/session\/session-1\/architecture\?/);
  assert.match(href, /view=class/);
  assert.match(href, /scope=2/);
  assert.match(href, /detail=all/);
});

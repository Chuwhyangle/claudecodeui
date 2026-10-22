import assert from 'node:assert/strict';

import { act, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeAll, beforeEach, test, vi } from 'vitest';

import type * as SharedApiModule from '@/shared/api';
import enCommon from '@/modules/i18n/locales/en/common.json';
import { ArchitecturePanel } from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';

/**
 * The architecture canvas's layout contract, read structurally.
 *
 * jsdom performs no layout, so these cases pin the declarations that make the
 * browser lay the chain out — the same invariants a real browser measurement in
 * the task's DoD checks:
 *  · a `flex-1` element only absorbs the remaining height when its parent is a
 *    flex container, so every `flex-1` on the canvas's ancestor chain must sit
 *    in one (the bug: a block parent made the whole chain fall back to content
 *    height, leaving the lower half of the panel blank);
 *  · an `h-full` element only resolves against a definite parent height;
 *  · the one-line readout and the zoom tier share ONE in-flow row ABOVE the
 *    canvas (they used to float over the drawing's first row);
 *  · the minimap and the zoom cluster remain the absolute corner overlays.
 */

const apiMock = vi.hoisted(() => ({ architectureGraph: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApiModule>();
  return {
    ...actual,
    api: { ...actual.api, architectureGraph: apiMock.architectureGraph },
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

// jsdom ships no ResizeObserver; the diagram observes its scroll container to
// re-fit. Recording the callbacks lets a case deliver the resize a laid-out
// browser would.
const resizeCallbacks = new Set<ResizeObserverCallback>();
class RecordingResizeObserver {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(): void {
    resizeCallbacks.add(this.callback);
  }

  unobserve(): void {
    resizeCallbacks.delete(this.callback);
  }

  disconnect(): void {
    resizeCallbacks.delete(this.callback);
  }
}
globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;

function triggerResize(): void {
  act(() => {
    for (const callback of [...resizeCallbacks]) callback([], {} as ResizeObserver);
  });
}

const RESULT: ArchitectureGraphResult = {
  mmd: { file: '@startuml\nA --> B\n@enduml', entity: '@startuml\nX --> Y\n@enduml' },
  graph: {
    file: {
      nodes: [
        { id: 'src/modules/alpha/a.ts', label: 'src/modules/alpha/a.ts', distance: 0 },
        { id: 'src/modules/alpha/a2.ts', label: 'src/modules/alpha/a2.ts', distance: 1 },
        { id: 'src/modules/beta/b.ts', label: 'src/modules/beta/b.ts', distance: 2 },
      ],
      edges: [
        { from: 'src/modules/alpha/a2.ts', to: 'src/modules/alpha/a.ts', relationType: 'dependency' },
      ],
    },
    entity: { nodes: [], edges: [] },
  },
  stats: {
    entityNodes: 0,
    fileNodes: 3,
    entityEdges: 0,
    fileEdges: 1,
    truncated: false,
    seedFiles: 1,
    seedIdentifiers: 0,
    nodeCount: 3,
    edgeCount: 1,
    unresolved: { files: [], identifiers: [] },
  },
  provenance: { generatedAt: '2026-10-20T15:52:34.427Z', fingerprints: [], cacheHit: false },
};

function jsonResponse(result: ArchitectureGraphResult): Response {
  return {
    ok: true,
    status: 200,
    json: async () => result,
  } as unknown as Response;
}

async function waitForDiagram(): Promise<HTMLElement> {
  const host = await screen.findByTestId('plantuml-host');
  await waitFor(() => assert.ok(host.querySelector('svg'), 'the renderer must draw an SVG'));
  return host;
}

/** An element's identity for a failure message: tag + the classes that matter. */
function describeElement(element: Element): string {
  const classes = [...element.classList].join(' ');
  return `<${element.tagName.toLowerCase()}${classes === '' ? '' : ` class="${classes}"`}>`;
}

function isFlexContainer(element: Element): boolean {
  return element.classList.contains('flex') || element.classList.contains('inline-flex');
}

/** A definite height: a flex container lays its children out against its own
 *  resolved height, and an explicit `h-*` / inline height states one outright. */
function hasDefiniteHeight(element: Element): boolean {
  if (isFlexContainer(element)) return true;
  if ([...element.classList].some((name) => name === 'h-full' || /^h-\[/.test(name) || name === 'h-screen')) {
    return true;
  }
  return (element as HTMLElement).style.height !== '';
}

/** jsdom performs no layout, so the scroll container's content box is pinned. */
function sizeHost(host: HTMLElement, width: number, height: number): void {
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: height });
}

// Pay the one-off module compile in the hook budget, not inside the first
// case's waitFor window, the same discipline the client suite uses for cold
// module graphs.
beforeAll(async () => {
  await import('@yalehwang/plantuml-js/elk');
});

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  // jsdom has no canvas: answer `null` (the minimap's documented "cannot draw"
  // path) instead of logging a "Not implemented" error on every paint.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  for (const projectId of ['project-1']) {
    window.localStorage.removeItem(`architecture.scope.${projectId}`);
    window.localStorage.removeItem(`architecture.detail.${projectId}`);
  }
});

test('every flex-1 and h-full on the canvas chain resolves against its parent', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  const panel = document.querySelector('[data-architecture-panel]');
  assert.ok(panel instanceof HTMLElement, 'the architecture panel must be rendered');
  assert.ok(panel.classList.contains('flex'), 'the panel root is a flex container');
  assert.ok(panel.classList.contains('flex-col'), 'the panel root stacks its rows in a column');
  assert.ok(panel.classList.contains('h-full'), 'the panel fills the tab it is mounted in');

  // Walk from the drawing surface up to (and including) the panel root: the
  // chain the regression made block-level.
  let element: Element | null = host;
  const visited: string[] = [];
  while (element !== null && element !== panel) {
    const parent: Element | null = element.parentElement;
    assert.ok(parent !== null, `${describeElement(element)} must have a parent`);
    visited.push(describeElement(element));
    if (element.classList.contains('flex-1')) {
      assert.ok(
        isFlexContainer(parent),
        `${describeElement(element)} has flex-1 but its parent ${describeElement(parent)} is not a flex container`,
      );
    }
    if (element.classList.contains('h-full')) {
      assert.ok(
        hasDefiniteHeight(parent),
        `${describeElement(element)} has h-full but its parent ${describeElement(parent)} has no definite height`,
      );
    }
    element = parent;
  }
  assert.equal(element, panel, 'the walk must reach the panel root, not fall out of the tree');
  assert.ok(visited.length >= 4, `the chain must be non-trivial; visited ${JSON.stringify(visited)}`);

  // The canvas region itself absorbs the remaining panel height, and it is a
  // flex COLUMN — the two declarations the measured regression was missing.
  const canvas = document.querySelector('[data-architecture-canvas]');
  assert.ok(canvas instanceof Element, 'the canvas is rendered');
  const canvasRegion = [...panel.children].find((child) => child.contains(canvas));
  assert.ok(canvasRegion instanceof HTMLElement, 'the canvas region is a direct child of the panel');
  assert.ok(canvasRegion.classList.contains('flex-1'), 'the canvas region takes the remaining height');
  assert.ok(canvasRegion.classList.contains('flex'), 'the canvas region is a flex container');
  assert.ok(canvasRegion.classList.contains('flex-col'), 'the canvas region stacks its rows in a column');
});

test('the readout and the zoom tier share one in-flow row above the canvas', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const header = document.querySelector('[data-architecture-canvas-header]');
  const readout = document.querySelector('[data-architecture-readout]');
  const tier = document.querySelector('[data-architecture-zoom-tier]');
  const scale = document.querySelector('[data-architecture-zoom-level]');
  const canvas = document.querySelector('[data-architecture-canvas]');
  assert.ok(header instanceof HTMLElement, 'the canvas has one chrome row');
  assert.ok(readout instanceof HTMLElement, 'the one-line readout is rendered');
  assert.ok(tier instanceof HTMLElement, 'the zoom tier is rendered');
  assert.ok(scale instanceof HTMLElement, 'the scale reading is rendered');
  assert.ok(canvas instanceof HTMLElement, 'the canvas is rendered');

  // Same row, on both sides of it.
  assert.equal(readout.closest('[data-architecture-canvas-header]'), header, 'the readout sits in the row');
  assert.equal(tier.closest('[data-architecture-canvas-header]'), header, 'the zoom tier sits in the same row');
  assert.equal(scale.closest('[data-architecture-canvas-header]'), header, 'the scale reading sits in the row');
  assert.equal(header.contains(readout), true);
  assert.equal(header.contains(tier), true);

  // The row is BEFORE the canvas and outside the drawing surface, so it cannot
  // cover the graph's first row.
  assert.ok(
    (header.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    'the row must precede the canvas in document order',
  );
  assert.equal(header.closest('[data-architecture-plantuml]'), null, 'the row is not inside the drawing surface');

  // In normal flow: neither the row nor anything inside it is positioned.
  for (const element of [header, ...header.querySelectorAll('*')]) {
    assert.equal(
      element.classList.contains('absolute')
        || element.classList.contains('fixed')
        || element.classList.contains('sticky'),
      false,
      `${describeElement(element)} must stay in normal flow`,
    );
    const position = (element as HTMLElement).style.position;
    assert.ok(
      position !== 'absolute' && position !== 'fixed' && position !== 'sticky',
      `${describeElement(element)} must not be positioned (got "${position}")`,
    );
  }
});

test('the minimap and the zoom cluster remain absolute corner overlays', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();
  // A drawing larger than the canvas is what gives it a minimap.
  sizeHost(host, 160, 120);
  triggerResize();
  const minimap = await waitFor(() => {
    const node = document.querySelector('[data-architecture-minimap]');
    assert.ok(node instanceof HTMLElement, 'a drawing bigger than the canvas gets a minimap');
    return node;
  });

  const canvas = document.querySelector('[data-architecture-canvas]');
  const overlays = document.querySelector('[data-architecture-canvas-overlays]');
  const cluster = document.querySelector('[data-architecture-zoom-cluster]');
  const header = document.querySelector('[data-architecture-canvas-header]');
  assert.ok(canvas instanceof HTMLElement);
  assert.ok(overlays instanceof HTMLElement, 'the corner overlays share one column');
  assert.ok(cluster instanceof HTMLElement, 'the zoom cluster is rendered');

  assert.equal(overlays.style.position, 'absolute', 'the corner column is an absolute overlay');
  assert.ok(canvas.contains(overlays), 'the overlay column is anchored in the canvas');
  assert.ok(overlays.contains(minimap), 'the minimap is a corner overlay');
  assert.ok(overlays.contains(cluster), 'the zoom cluster is a corner overlay');
  assert.equal(header?.contains(minimap) ?? false, false, 'the minimap must not move into the in-flow row');
  assert.equal(header?.contains(cluster) ?? false, false, 'the cluster must not move into the in-flow row');
});

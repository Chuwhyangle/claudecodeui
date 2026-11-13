/**
 * The canvas POINTER interactions: reveal-the-selection scrolling plus the
 * delegated mouse/pointer listeners the drawing answers to (hover, click /
 * double click / right click, the pin-remove menu, long press, the marquee).
 *
 * Extracted from `PlantUmlGraph.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 * Nothing here owns state: the delegated listeners read the owners and the
 * handlers passed in `args` at FIRE time, exactly as the inline effects did.
 * The one value the rest of the component needs back is the selection-reveal
 * callback ref, because the auto-fit observer re-runs it after a re-fit.
 */
import { useEffect, useRef, type RefObject } from 'react';

import type {
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
  ArchitectureRendererHover,
  ArchitectureRendererNode,
} from '@/modules/architecture/dom/rendererContract';
import type { GraphGestureController } from '@/modules/architecture/dom/graphGestureController';
import type { GraphSelectionController } from '@/modules/architecture/dom/graphSelectionController';
import { GROUP_PREFIX, STUB_PREFIX } from '@/modules/architecture/dom/graphConstants';
import {
  announceSelection,
  clearHighlight,
  edgeElement,
  highlightEdge,
  highlightRelations,
  highlightSelection,
  nodeElement,
  relationsOf,
} from '@/modules/architecture/layout/graphDom';

/** Every reading the pointer interactions close over. */
export type CanvasPointerInteractionArgs = {
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly graphRef: { current: ArchitectureRendererGraph };
  readonly selectedNodeId: string | null;
  readonly drawnRevision: number;
  readonly bottomObscuredPx: number;
  readonly canCurate: boolean;
  readonly packageOnlyTier: () => boolean;
  readonly drillInto: (id: string) => void;
  readonly zoomToPackage: (packageId: string) => void;
  readonly gestureController: GraphGestureController;
  readonly selectionController: GraphSelectionController;
  readonly onNodeClick?: (node: ArchitectureRendererNode) => void;
  readonly onEdgeClick?: (edge: ArchitectureRendererEdge) => void;
  readonly onNodeHover?: (hover: ArchitectureRendererHover | null) => void;
  readonly onSelectionClear?: () => void;
  readonly onToggleNodeClick?: (node: ArchitectureRendererNode) => void;
  readonly onToggleEdgeClick?: (edge: ArchitectureRendererEdge) => void;
};

/**
 * Bind the reveal effect and the delegated listeners; returns the reveal ref
 * the fit observer calls after a settled re-fit.
 */
export function useCanvasPointerInteractions(
  args: CanvasPointerInteractionArgs,
): RefObject<(() => void) | null> {
  const {
    hostRef,
    graphRef,
    selectedNodeId,
    drawnRevision,
    bottomObscuredPx,
    canCurate,
    packageOnlyTier,
    drillInto,
    zoomToPackage,
    gestureController,
    selectionController,
  } = args;
  const revealSelectedRef = useRef<(() => void) | null>(null);

useEffect(() => {
  const host = hostRef.current;
  if (host === null || selectedNodeId === null) {
    revealSelectedRef.current = null;
    return;
  }
  const revealSelected = (): void => {
    const selected = nodeElement(host, selectedNodeId);
    if (selected === null) return;
    const hostRect = host.getBoundingClientRect();
    const nodeRect = selected.getBoundingClientRect();
    // The uncovered part of the host: the overlay drawer's band is not
    // visible ground for the selection.
    const visibleBottom = hostRect.bottom - Math.min(bottomObscuredPx, hostRect.height);
    const margin = 8;
    let dx = 0;
    let dy = 0;
    if (nodeRect.left < hostRect.left + margin) {
      dx = nodeRect.left - hostRect.left - margin;
    } else if (nodeRect.right > hostRect.right - margin) {
      dx = nodeRect.right - hostRect.right + margin;
    }
    if (nodeRect.top < hostRect.top + margin) {
      dy = nodeRect.top - hostRect.top - margin;
    } else if (nodeRect.bottom > visibleBottom - margin) {
      dy = nodeRect.bottom - visibleBottom + margin;
    }
    if (dx !== 0) host.scrollLeft += dx;
    if (dy !== 0) host.scrollTop += dy;
  };
  revealSelectedRef.current = revealSelected;
  const frame = requestAnimationFrame(revealSelected);
  const timers = [250, 600, 1000].map((delay) => setTimeout(revealSelected, delay));
  return () => {
    revealSelectedRef.current = null;
    cancelAnimationFrame(frame);
    for (const timer of timers) clearTimeout(timer);
  };
}, [bottomObscuredPx, selectedNodeId, drawnRevision]);


useEffect(() => {
  const host = hostRef.current;
  if (host === null) return;

  const nodeFrom = (target: EventTarget | null): Element | null =>
    target instanceof Element ? target.closest('[data-entity-id]') : null;

  const onMouseOver = (event: MouseEvent): void => {
    const node = nodeFrom(event.target);
    const id = node?.getAttribute('data-entity-id') ?? null;
    if (id === null) return;
    highlightRelations(host, id);
    // The contract's hovered node is the one the panel handed over. Group and
    // stub nodes are view scaffolding, not entities, so they have none and
    // report no hover (their highlight still works).
    const hoveredNode = graphRef.current.nodes.find((candidate) => candidate.id === id);
    if (hoveredNode !== undefined) {
      gestureController.getHandlers().onNodeHover?.({ node: hoveredNode, relations: relationsOf(host, id) });
    }
  };

  const onMouseOut = (event: MouseEvent): void => {
    const node = nodeFrom(event.target);
    if (node === null) return;
    const next = event.relatedTarget;
    if (next instanceof Node && node.contains(next)) return;
    // Hover is transient; a pinned selection is restored when the pointer leaves.
    highlightSelection(host, selectionController.getSnapshot().primaryNodeId);
    gestureController.getHandlers().onNodeHover?.(null);
  };

  // The pin/remove menu: right click on a fine pointer, a 500ms press on a
  // touch pointer. Coordinates are relative to the canvas's positioned
  // parent, which is where the menu element is rendered.
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelLongPress = (): void => {
    if (longPressTimer === null) return;
    clearTimeout(longPressTimer);
    longPressTimer = null;
  };
  const openMenuAt = (clientX: number, clientY: number, target: EventTarget | null): boolean => {
    const canvas = host.parentElement;
    if (canvas === null) return false;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, clientX - rect.left);
    const y = Math.max(0, clientY - rect.top);
    const edgeHit = target instanceof Element
      ? target.closest('[data-architecture-edge-hit]')
      : null;
    if (edgeHit !== null) {
      const from = edgeHit.getAttribute('data-architecture-edge-source');
      const to = edgeHit.getAttribute('data-architecture-edge-target');
      const relationType = edgeHit.getAttribute('data-architecture-edge-type') ?? '';
      if (from === null || to === null) return false;
      selectionController.openContextMenu({ x, y, edge: { from, to, relationType } });
      return true;
    }
    const id = nodeFrom(target)?.getAttribute('data-entity-id') ?? null;
    if (id === null || id.startsWith(GROUP_PREFIX) || id.startsWith(STUB_PREFIX)) return false;
    if (!graphRef.current.nodes.some((candidate) => candidate.id === id)) return false;
    selectionController.openContextMenu({ x, y, nodeId: id });
    return true;
  };

  // Record how the press that produces the next click was made. Mouse clicks
  // keep the original single-click navigation; a touch tap only selects.
  //
  // A 500ms press on a real entity enters the touch multi-select mode (the
  // panel turns the mode on and adds that node); a press on a relation or the
  // blank canvas keeps opening the curation menu. `navigator.vibrate` is the
  // optional acknowledgement — guarded because jsdom and some browsers lack it.
  const onPointerDown = (event: PointerEvent): void => {
    selectionController.recordPointerType(event.pointerType ?? null);
    cancelLongPress();
    if (event.pointerType !== 'touch') return;
    const target = event.target;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      const id = nodeFrom(target)?.getAttribute('data-entity-id') ?? null;
      const node = id === null
        ? null
        : graphRef.current.nodes.find((candidate) => candidate.id === id) ?? null;
      if (
        node !== null
        && !id?.startsWith(GROUP_PREFIX)
        && !id?.startsWith(STUB_PREFIX)
      ) {
        // The owner suppresses the click the browser sends on release, so it
        // cannot undo the toggle the long press just performed. False means
        // no multi-select handler is installed: keep the curation menu path.
        if (!gestureController.startMultiSelect(node)) {
          if (canCurate) openMenuAt(event.clientX, event.clientY, target);
          return;
        }
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate(10);
        }
        return;
      }
      if (canCurate) openMenuAt(event.clientX, event.clientY, target);
    }, 500);
  };
  const onPointerMove = (): void => cancelLongPress();
  const onPointerUp = (): void => cancelLongPress();
  const onContextMenu = (event: MouseEvent): void => {
    if (!canCurate) return;
    if (openMenuAt(event.clientX, event.clientY, event.target)) event.preventDefault();
    else selectionController.closeContextMenu();
  };

  /** Pin an entity's highlight and announce it to sibling panels. */
  const selectEntity = (id: string, isTouchTap: boolean): void => {
    selectionController.selectNode(id, isTouchTap);
    highlightRelations(host, id);
    const clickedNode = graphRef.current.nodes.find((candidate) => candidate.id === id);
    if (clickedNode === undefined) return;
    // The JSON lookup is what sibling panels receive, independent of the
    // hops the drill gesture expands.
    announceSelection(graphRef.current, id);
    gestureController.getHandlers().onNodeClick?.(clickedNode);
  };

  const onClick = (event: MouseEvent): void => {
    const isTouchTap = selectionController.consumePointerType() === 'touch';
    // A gesture already acted on release (long-press multi-select, marquee):
    // the browser's trailing click is not a second command.
    if (gestureController.consumeSuppressedClick()) return;
    // Additive = the platform's add-to-selection modifier, or any tap while
    // the touch multi-select mode is on.
    const additive = gestureController.isAdditiveClick(event);
    // Any ordinary click on the drawing closes the pin menu. A click on the
    // menu itself never reaches this listener (the menu is a sibling).
    selectionController.closeContextMenu();

    // At the package-only levels (`C`, and the folded `D` it deepens into)
    // the drawing is a map of frames, not selectable entities: a click on one
    // zooms into it — the "tap a package" gesture the too-small overview hint
    // offers, on every pointer tier. It runs before the background-clear
    // branch because a frame carries no `data-entity-id` of its own.
    if (packageOnlyTier()) {
      const frame = event.target instanceof Element
        ? event.target.closest('.uml-package[data-package-id]')
        : null;
      const packageId = frame?.getAttribute('data-package-id') ?? null;
      if (packageId !== null) {
        zoomToPackage(packageId);
        return;
      }
    }

    // On a coarse pointer a node's visible shape is far smaller than a
    // finger: the drawing scales with the zoom, so even a fitted overview can
    // paint a file box ~10px tall. Resolve the tap against the 44px hit
    // rectangles instead, and let the NEAREST centre win when a dense
    // drawing's rectangles overlap (the topmost rectangle would otherwise
    // hand the tap to a neighbour). The package-only tiers draw no entities,
    // so they keep their frame-zoom path untouched.
    const packageOnly = packageOnlyTier();
    const coarseNodeId = packageOnly
      ? null
      : gestureController.resolveCoarseNodeHit(event.clientX, event.clientY);

    // A relation's enlarged hit band sits ON TOP of the drawing, so it is
    // checked before the ordinary node lookup: clicking a line selects the
    // relation, not whatever box the line starts on. A coarse tap inside a
    // node's touch target is a node press (the finger aimed at the box, and
    // the band is wider than the visible line anyway).
    let id = coarseNodeId;
    if (id === null) {
      const edgeHit = event.target instanceof Element
        ? event.target.closest('[data-architecture-edge-hit]')
        : null;
      if (edgeHit !== null) {
        const from = edgeHit.getAttribute('data-architecture-edge-source');
        const to = edgeHit.getAttribute('data-architecture-edge-target');
        const relationType = edgeHit.getAttribute('data-architecture-edge-type') ?? '';
        if (from === null || to === null) return;
        const edge = { from, to, relationType };
        const toggleEdge = gestureController.getHandlers().onToggleEdgeClick;
        if (additive && toggleEdge !== undefined) {
          toggleEdge(edge);
          return;
        }
        selectionController.selectRelation(edge);
        highlightEdge(host, edgeElement(host, from, to));
        gestureController.getHandlers().onEdgeClick?.(edge);
        return;
      }
      id = nodeFrom(event.target)?.getAttribute('data-entity-id') ?? null;
    }
    if (id === null) {
      // Clicking the background is the "clear the pinned selection" gesture.
      selectionController.clearSelection();
      clearHighlight(host);
      gestureController.getHandlers().onNodeHover?.(null);
      gestureController.getHandlers().onSelectionClear?.();
      return;
    }
    if (id.startsWith(STUB_PREFIX)) return;

    if (id.startsWith(GROUP_PREFIX)) {
      // A group is view scaffolding: selecting it marks the node but does not
      // announce an entity to sibling panels.
      selectionController.selectNode(id, isTouchTap);
      highlightRelations(host, id);
    } else {
      const node = graphRef.current.nodes.find((candidate) => candidate.id === id);
      if (node === undefined) return;
      // Additive clicks toggle the member without touching the drill machinery
      // (a multi-select gesture is not a request to open the neighbourhood).
      const toggleNode = gestureController.getHandlers().onToggleNodeClick;
      if (additive && toggleNode !== undefined) {
        selectionController.addToSelection(id);
        highlightRelations(host, id);
        announceSelection(graphRef.current, id);
        toggleNode(node);
        return;
      }
      selectEntity(id, isTouchTap);
    }

    if (!isTouchTap) {
      // Desktop: a single click only SELECTS and opens the inspector. Drilling
      // one hop deeper is the double-click gesture below.
      return;
    }
    // Touch: the first tap only selects — the drawing must not re-lay out
    // under the finger. A second tap on the same node inside the double-tap
    // window is the explicit drill command.
    if (selectionController.registerTap(id)) drillInto(id);
  };

  // Desktop drill-down: two clicks on the same node. The click handler above
  // has already selected it (and opened the inspector); this only navigates.
  const onDoubleClick = (event: MouseEvent): void => {
    const id = nodeFrom(event.target)?.getAttribute('data-entity-id') ?? null;
    if (id === null || id.startsWith(STUB_PREFIX)) return;
    drillInto(id);
  };

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  host.addEventListener('mouseover', onMouseOver);
  host.addEventListener('mouseout', onMouseOut);
  host.addEventListener('click', onClick);
  host.addEventListener('dblclick', onDoubleClick);
  host.addEventListener('contextmenu', onContextMenu);
  return () => {
    cancelLongPress();
    host.removeEventListener('pointerdown', onPointerDown);
    host.removeEventListener('pointermove', onPointerMove);
    host.removeEventListener('pointerup', onPointerUp);
    host.removeEventListener('pointercancel', onPointerUp);
    host.removeEventListener('mouseover', onMouseOver);
    host.removeEventListener('mouseout', onMouseOut);
    host.removeEventListener('click', onClick);
    host.removeEventListener('dblclick', onDoubleClick);
    host.removeEventListener('contextmenu', onContextMenu);
  };
}, [canCurate, drillInto, gestureController, packageOnlyTier, zoomToPackage]);

  return revealSelectedRef;
}

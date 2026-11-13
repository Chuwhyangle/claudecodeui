/**
 * The canvas KEYBOARD navigation: entity navigation (arrow keys / Tab), the
 * announcement text a screen reader hears, the ring painting, and every
 * shortcut the focused canvas owns (Delete, Ctrl/Cmd+Z, the zoom keys, Escape).
 *
 * Extracted from `PlantUmlGraph.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 * The cursor itself lives in the selection owner (the DOM carries the ring);
 * this hook only translates keys into its commands and re-paints the ring after
 * a drawing is replaced.
 */
import { useEffect, type RefObject } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TFunction } from 'i18next';

import type {
  ArchitectureRendererGraph,
  ArchitectureRendererNode,
} from '@/modules/architecture/dom/rendererContract';
import type { GraphGestureController } from '@/modules/architecture/dom/graphGestureController';
import type { GraphSelectionController, GraphSelectionSnapshot } from '@/modules/architecture/dom/graphSelectionController';
import {
  moveEntityFocus,
  PACKAGE_NAV_PREFIX,
  type EntityNavigationDirection,
  type EntityNavigationItem,
} from '@/modules/architecture/dom/entityNavigation';
import {
  clearNavigationFocus,
  collectNavigationItems,
  farthestNavigationStart,
  normalizedPackageId,
  packageIdOfNodeId,
  keyboardA11yDefect,
  navigationDomId,
  navigationElementOf,
  paintNavigationFocus,
  pickNavigationStart,
  type NavigationPoint,
} from '@/modules/architecture/render/plantUmlNavigation';
import { nodeElement } from '@/modules/architecture/layout/graphDom';
import {
  centeredScrollForDrawingRect,
  clampZoomScale,
  MIN_ZOOM_SCALE,
  readSvgNaturalSize,
  ZOOM_STEP,
  centerElementInContainer,
} from '@/modules/architecture/layout/svgViewport';
import { GROUP_PREFIX, KEYBOARD_PAN_STEP } from '@/modules/architecture/dom/graphConstants';
import {
  announceSelection,
  highlightRelations,
  selectionOf,
} from '@/modules/architecture/layout/graphDom';

/** Every reading the keyboard navigation closes over. */
export type CanvasKeyboardNavigationArgs = {
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly graphRef: { current: ArchitectureRendererGraph };
  readonly t: TFunction;
  readonly selectionController: GraphSelectionController;
  readonly selectionSnapshot: GraphSelectionSnapshot;
  readonly gestureController: GraphGestureController;
  readonly pinnedSet: ReadonlySet<string>;
  readonly exitEntityNavigation: (host: HTMLElement) => void;
  readonly drillInto: (id: string) => void;
  readonly zoomToPackage: (packageId: string) => void;
  readonly zoomByStep: (factor: number) => void;
  readonly zoomToScale: (scale: number) => void;
  readonly fitDiagram: () => void;
  readonly onNodeClick?: (node: ArchitectureRendererNode) => void;
  readonly onToggleNodeClick?: (node: ArchitectureRendererNode) => void;
  readonly onEscapeSelection?: () => void;
  readonly onUndo?: () => void;
  readonly onPinNode?: (node: ArchitectureRendererNode) => void;
  readonly onUnpinNode?: (node: ArchitectureRendererNode) => void;
  readonly onRemoveNode?: (node: ArchitectureRendererNode) => void;
  readonly onHideRelation?: (edge: { readonly from: string; readonly to: string; readonly relationType: string }) => void;
  readonly drawn: { readonly view: unknown; readonly nodes: number; readonly edges: number } | null;
  readonly drawnRevision: number;
};

/** The canvas focus/blur handlers and the one key handler the host binds. */
export type CanvasKeyboardNavigation = {
  readonly onCanvasFocus: () => void;
  readonly onCanvasBlur: () => void;
  readonly onCanvasKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
};

/** Translate the canvas's keyboard events into the selection owner's commands. */
export function useCanvasKeyboardNavigation(
  args: CanvasKeyboardNavigationArgs,
): CanvasKeyboardNavigation {
  const {
    hostRef,
    graphRef,
    t,
    selectionController,
    selectionSnapshot,
    gestureController,
    pinnedSet,
    exitEntityNavigation,
    drillInto,
    zoomToPackage,
    zoomByStep,
    zoomToScale,
    fitDiagram,
    onNodeClick,
    onToggleNodeClick,
    onEscapeSelection,
    onUndo,
    onPinNode,
    onUnpinNode,
    onRemoveNode,
    onHideRelation,
    drawn,
    drawnRevision,
  } = args;

/**
 * The node a cursor id names, when it names an entity that is in the payload.
 * Package frames and overview group nodes have no payload node.
 */
const navigationNodeOf = (cursorId: string | null): ArchitectureRendererNode | null => {
  if (cursorId === null || cursorId.startsWith(PACKAGE_NAV_PREFIX)) return null;
  return graphRef.current.nodes.find((candidate) => candidate.id === cursorId) ?? null;
};

/** The spoken kind of an entity: the payload's kind, translated. */
const navigationKindLabel = (node: ArchitectureRendererNode | null): string => {
  switch (node?.kind) {
    case 'class':
      return t('architecture.nav.kindClass', { defaultValue: 'class' });
    case 'interface':
      return t('architecture.nav.kindInterface', { defaultValue: 'interface' });
    case 'enum':
      return t('architecture.nav.kindEnum', { defaultValue: 'enum' });
    case 'abstract':
      return t('architecture.nav.kindAbstract', { defaultValue: 'abstract class' });
    case 'function':
      return t('architecture.nav.kindFunction', { defaultValue: 'function' });
    default:
      return t('architecture.nav.kindEntity', { defaultValue: 'entity' });
  }
};

/** The label a cursor id reads as: the payload label, the drawn label, or the id. */
const navigationLabelOf = (host: HTMLElement, cursorId: string): string => {
  const node = navigationNodeOf(cursorId);
  if (node !== null) return node.label;
  const element = navigationElementOf(host, cursorId);
  const drawn = element?.querySelector('[data-architecture-label]')?.getAttribute('data-architecture-label');
  if (drawn !== undefined && drawn !== null && drawn !== '') return drawn;
  const text = element?.querySelector('text')?.textContent ?? '';
  return text === '' ? cursorId : text;
};

/**
 * The polite sentence for a cursor position: the entity's label, its kind,
 * and its position among the drawn items of that kind (`OrderService, class,
 * 3/55`). Deliberately SHORT — the inspector owns the package, the relations
 * and the members, and repeating them here made every arrow press read a
 * paragraph. The DEV control arm can restore the retired long reading.
 */
const navigationAnnouncementFor = (host: HTMLElement, cursorId: string): string => {
  const items = collectNavigationItems(host);
  if (keyboardA11yDefect() === 'verbose-announce') {
    // Control arm only: the retired whole-reading announcement.
    if (cursorId.startsWith(PACKAGE_NAV_PREFIX)) {
      const packageId = cursorId.slice(PACKAGE_NAV_PREFIX.length);
      const prefix = `${packageId}/`;
      const count = items
        .filter((item) => item.kind === 'entity'
          && (item.packageId === packageId || item.packageId.startsWith(prefix)))
        .length;
      return t('architecture.nav.announcePackage', {
        defaultValue: 'Package {{package}}, {{count}} entities',
        package: packageId,
        count,
      });
    }
    const node = navigationNodeOf(cursorId);
    const element = navigationElementOf(host, cursorId);
    const packageId = (element === null ? null : normalizedPackageId(element.getAttribute('data-package-id')))
      ?? packageIdOfNodeId(cursorId);
    const selection = selectionOf(graphRef.current, cursorId);
    return t('architecture.nav.announceEntity', {
      defaultValue: '{{label}}, {{kind}}, package {{package}}, {{outgoing}} outgoing, {{incoming}} incoming',
      label: navigationLabelOf(host, cursorId),
      kind: navigationKindLabel(node),
      package: packageId === ''
        ? t('architecture.nav.rootPackage', { defaultValue: 'the root package' })
        : packageId,
      outgoing: selection.outgoing.length,
      incoming: selection.incoming.length,
    });
  }
  const isFrame = cursorId.startsWith(PACKAGE_NAV_PREFIX);
  const ordered = [...items].sort(
    (left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id),
  );
  const kindKey = isFrame ? 'package' : 'entity';
  const sameKind = ordered.filter((item) => item.kind === kindKey);
  const index = sameKind.findIndex((item) => item.id === cursorId);
  const label = isFrame ? cursorId.slice(PACKAGE_NAV_PREFIX.length) : navigationLabelOf(host, cursorId);
  const kind = isFrame
    ? t('architecture.nav.kindPackage', { defaultValue: 'package' })
    : navigationKindLabel(navigationNodeOf(cursorId));
  return t('architecture.nav.announceItem', {
    defaultValue: '{{label}}, {{kind}}, {{position}}/{{total}}',
    label,
    kind,
    position: index === -1 ? 0 : index + 1,
    total: sameKind.length,
  });
};

/** Repaint the ring and scroll the current box into the viewport. */
const paintCurrentNavigationItem = (host: HTMLElement): void => {
  const cursorId = selectionController.getSnapshot().navigationCursorId;
  paintNavigationFocus(host, cursorId);
  if (cursorId === null) return;
  const element = navigationElementOf(host, cursorId);
  if (element === null) return;
  centerElementInContainer(host, element);
};

/**
 * The drawn items' boxes in CLIENT pixels — the space the viewport centre is
 * measured in. A drawing with no layout (jsdom) keeps the user-unit boxes,
 * where the distance rule is still deterministic.
 */
const navigationClientItems = (
  host: HTMLElement,
  items: readonly EntityNavigationItem[],
): EntityNavigationItem[] => items.map((item) => {
  const element = navigationElementOf(host, item.id);
  const rect = element === null ? null : element.getBoundingClientRect();
  return rect === null || (rect.width <= 0 && rect.height <= 0)
    ? item
    : { ...item, x: rect.left, y: rect.top, width: rect.width, height: rect.height };
});

/** The centre of the canvas's visible box, in client pixels. */
const navigationViewportCentre = (host: HTMLElement): NavigationPoint => {
  const rect = host.getBoundingClientRect();
  const width = host.clientWidth > 0 ? host.clientWidth : rect.width;
  const height = host.clientHeight > 0 ? host.clientHeight : rect.height;
  return { x: rect.left + width / 2, y: rect.top + height / 2 };
};

/**
 * Enter the entity-navigation state on the last entity the reader stood on
 * (or the current selection) when it is still drawn, otherwise on the entity
 * nearest the viewport centre. Paints the ring and announces the landing.
 * False when the drawing has nothing to stand on.
 */
const enterEntityNavigation = (host: HTMLElement): boolean => {
  const items = collectNavigationItems(host);
  const snapshot = selectionController.getSnapshot();
  const preferred = snapshot.primaryNodeId ?? snapshot.keyboardFocusId;
  const centre = navigationViewportCentre(host);
  const clientItems = navigationClientItems(host, items);
  const startId = keyboardA11yDefect() === 'farthest-start'
    ? farthestNavigationStart(clientItems, centre)
    : pickNavigationStart(clientItems, preferred, centre);
  if (startId === null) return false;
  selectionController.enterNavigation(startId, navigationAnnouncementFor(host, startId));
  paintCurrentNavigationItem(host);
  return true;
};

/**
 * The canvas's focus handler. Keyboard focus starts entity navigation on the
 * nearest entity; a pointer press focuses the host too (so click-then-arrow
 * panning keeps working) and must not paint a keyboard ring.
 */
const onCanvasFocus = (): void => {
  const host = hostRef.current;
  const snapshot = selectionController.getSnapshot();
  if (host === null || snapshot.navigationActive) return;
  if (snapshot.focusModality === 'pointer') return;
  enterEntityNavigation(host);
};

/** Leaving the canvas clears the keyboard ring and its active descendant. */
const onCanvasBlur = (): void => {
  const host = hostRef.current;
  if (host === null) return;
  // Control arm: keep the ring painted after focus leaves.
  if (keyboardA11yDefect() === 'keep-ring-on-blur') return;
  if (selectionController.getSnapshot().navigationActive) exitEntityNavigation(host);
};

/** Move the cursor one step and announce the landing (or "nothing there"). */
const moveNavigationCursor = (host: HTMLElement, direction: EntityNavigationDirection): void => {
  const currentId = selectionController.getSnapshot().navigationCursorId;
  const next = moveEntityFocus(collectNavigationItems(host), currentId, direction);
  if (next === null) return;
  if (next === currentId) {
    selectionController.moveNavigationCursor(currentId, t('architecture.nav.noNeighbour', {
      defaultValue: 'No entity in that direction',
    }), false);
    return;
  }
  selectionController.moveNavigationCursor(
    next,
    navigationAnnouncementFor(host, next),
    !next.startsWith(PACKAGE_NAV_PREFIX),
  );
  paintCurrentNavigationItem(host);
};

/**
 * Keyboard navigation once the canvas has focus: arrows pan, `+`/`-` zoom,
 * `0` fits and `1` returns to natural size.
 *
 * `Enter` enters the entity-navigation state on the current selection (or the
 * first drawn entity). In that state arrows move by screen position, Home/End
 * go to the top-left/bottom-right entity, PageUp/PageDown walk one package,
 * `[`/`]` walk to the enclosing frame and back to its first entity, `Enter`
 * selects (opening the inspector), `Shift+Enter`/Space toggles multi-select,
 * `A` pins and `X` removes through the same callbacks the context menu uses.
 * `Escape` leaves the state and calls `stopPropagation`, so the chat page's
 * global abort never sees it; outside the state Escape keeps its old
 * selection-clearing behaviour, and with no selection at all it is not
 * consumed.
 *
 * Modified presses are left to the browser and the app's shortcuts (Ctrl/Cmd
 * + key), except the curation undo.
 */
const onCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
  const host = hostRef.current;
  if (host === null) return;

  // Ctrl/Cmd+Z is the curation undo, but only while the canvas owns focus
  // (this is the canvas's own key handler).
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && onUndo !== undefined) {
    event.preventDefault();
    event.stopPropagation();
    onUndo();
    return;
  }
  if (event.ctrlKey || event.metaKey) return;

  if (event.key === 'Escape') {
    const snapshot = selectionController.getSnapshot();
    if (snapshot.contextMenu !== null) {
      event.preventDefault();
      event.stopPropagation();
      selectionController.closeContextMenu();
      return;
    }
    // In the entity-navigation state Escape leaves that state and nothing
    // else: `stopPropagation` keeps the chat page's global abort out of it.
    if (snapshot.navigationActive) {
      event.preventDefault();
      event.stopPropagation();
      exitEntityNavigation(host);
      return;
    }
    if (snapshot.primaryNodeId === null && snapshot.panel.relation === null) return;
    event.preventDefault();
    event.stopPropagation();
    gestureController.getHandlers().onEscapeSelection?.();
    return;
  }

  // Delete/Backspace removes the selected entity (or hides the selected
  // relation) through the panel's curation store. `stopPropagation` keeps the
  // key away from the chat page's global abort — the drawing owns it only
  // while a selection exists AND a curation callback can act on it.
  if (event.key === 'Delete' || event.key === 'Backspace') {
    const snapshot = selectionController.getSnapshot();
    const edge = snapshot.panel.relation;
    const nodeId = snapshot.primaryNodeId;
    if (edge === null && nodeId === null) return;
    if (edge !== null) {
      if (onHideRelation === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      onHideRelation({ from: edge.from, to: edge.to, relationType: edge.relationType });
      return;
    }
    if (onRemoveNode === undefined || nodeId === null) return;
    const node = graphRef.current.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    onRemoveNode(node);
    return;
  }

  /** The entity the cursor stands on, or null on a frame / nowhere. */
  const cursorNode = (): ArchitectureRendererNode | null =>
    navigationNodeOf(selectionController.getSnapshot().navigationCursorId);

  /** Enter's selection: an entity opens the inspector, a frame zooms into it. */
  const selectCursorItem = (): boolean => {
    const cursorId = selectionController.getSnapshot().navigationCursorId;
    if (cursorId === null) return false;
    if (cursorId.startsWith(PACKAGE_NAV_PREFIX)) {
      // A frame is a place, not an entity: the same gesture a tap gives it.
      zoomToPackage(cursorId.slice(PACKAGE_NAV_PREFIX.length));
      selectionController.announce(t('architecture.nav.enteredPackage', {
        defaultValue: 'Entered package {{package}}',
        package: cursorId.slice(PACKAGE_NAV_PREFIX.length),
      }));
      return true;
    }
    const node = cursorNode();
    if (node === null) return false;
    selectionController.addToSelection(cursorId);
    highlightRelations(host, cursorId);
    announceSelection(graphRef.current, cursorId);
    gestureController.getHandlers().onNodeClick?.(node);
    selectionController.announce(t('architecture.nav.selected', {
      defaultValue: '{{label}} selected',
      label: navigationLabelOf(host, cursorId),
    }));
    return true;
  };

  /** Shift+Enter / Space: toggle the cursor's entity in the multi-select set. */
  const toggleCursorSelection = (): boolean => {
    const node = cursorNode();
    const snapshot = selectionController.getSnapshot();
    const cursorId = snapshot.navigationCursorId;
    if (node === null || cursorId === null) return false;
    const wasSelected = snapshot.panel.nodeIds.includes(cursorId) || snapshot.primaryNodeId === cursorId;
    selectionController.addToSelection(cursorId);
    highlightRelations(host, cursorId);
    announceSelection(graphRef.current, cursorId);
    const toggleNode = gestureController.getHandlers().onToggleNodeClick;
    if (toggleNode !== undefined) toggleNode(node);
    else gestureController.getHandlers().onNodeClick?.(node);
    selectionController.announce(wasSelected
      ? t('architecture.nav.deselected', {
          defaultValue: '{{label}} removed from the selection',
          label: node.label,
        })
      : t('architecture.nav.selectedIntoSet', {
          defaultValue: '{{label}} added to the selection',
          label: node.label,
        }));
    return true;
  };

  if (selectionController.getSnapshot().navigationActive) {
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        moveNavigationCursor(host, 'up');
        return;
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        moveNavigationCursor(host, 'down');
        return;
      case 'ArrowLeft':
        event.preventDefault();
        event.stopPropagation();
        moveNavigationCursor(host, 'left');
        return;
      case 'ArrowRight':
        event.preventDefault();
        event.stopPropagation();
        moveNavigationCursor(host, 'right');
        return;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        moveNavigationCursor(host, 'home');
        return;
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        moveNavigationCursor(host, 'end');
        return;
      case 'PageUp':
        event.preventDefault();
        event.stopPropagation();
        moveNavigationCursor(host, 'pageUp');
        return;
      case 'PageDown':
        event.preventDefault();
        event.stopPropagation();
        moveNavigationCursor(host, 'pageDown');
        return;
      case '[':
        event.preventDefault();
        event.stopPropagation();
        moveNavigationCursor(host, 'parent');
        return;
      case ']':
        event.preventDefault();
        event.stopPropagation();
        moveNavigationCursor(host, 'child');
        return;
      case 'Enter':
        if (event.shiftKey) {
          if (!toggleCursorSelection()) return;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.altKey) {
          const drillId = selectionController.getSnapshot().navigationCursorId;
          if (drillId === null || drillId.startsWith(PACKAGE_NAV_PREFIX)) return;
          event.preventDefault();
          drillInto(drillId);
          return;
        }
        if (!selectCursorItem()) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      case ' ':
      case 'Spacebar':
        if (!toggleCursorSelection()) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      case 'a':
      case 'A': {
        const node = cursorNode();
        if (node === null) return;
        const action = pinnedSet.has(node.id) ? onUnpinNode : onPinNode;
        if (action === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        action(node);
        return;
      }
      case 'x':
      case 'X': {
        const node = cursorNode();
        if (node === null || onRemoveNode === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        onRemoveNode(node);
        return;
      }
      default:
        // `+`/`-`/`0`/`1` keep working below; everything else is default.
        break;
    }
  } else {
    // Enter enters the navigation state on the current selection or the first
    // drawn entity. Arrows keep panning until then (requirement 4).
    if (event.key === 'Enter') {
      if (enterEntityNavigation(host)) event.preventDefault();
      return;
    }
    if (event.key === '[' || event.key === ']') {
      if (!enterEntityNavigation(host)) return;
      event.preventDefault();
      moveNavigationCursor(host, event.key === '[' ? 'parent' : 'child');
      return;
    }
  }

  if (event.altKey) return;
  switch (event.key) {
    case 'ArrowLeft':
      if (selectionController.getSnapshot().navigationActive) return;
      host.scrollLeft -= KEYBOARD_PAN_STEP;
      break;
    case 'ArrowRight':
      if (selectionController.getSnapshot().navigationActive) return;
      host.scrollLeft += KEYBOARD_PAN_STEP;
      break;
    case 'ArrowUp':
      if (selectionController.getSnapshot().navigationActive) return;
      host.scrollTop -= KEYBOARD_PAN_STEP;
      break;
    case 'ArrowDown':
      if (selectionController.getSnapshot().navigationActive) return;
      host.scrollTop += KEYBOARD_PAN_STEP;
      break;
    case '+':
    case '=':
      zoomByStep(ZOOM_STEP);
      break;
    case '-':
    case '_':
      zoomByStep(1 / ZOOM_STEP);
      break;
    case '0':
      fitDiagram();
      break;
    case '1':
      zoomToScale(1);
      break;
    default:
      // Anything else keeps its default behaviour.
      return;
  }
  event.preventDefault();
};

// The keyboard cursor lives in the DOM (a class, an element id and a drawn
// ring), so a drawing that was replaced — a new view, or a semantic rewrite —
// loses it. Repaint it from the settled state; the cursor's own moves paint
// synchronously in the key handler, and this is the restoring half.
useEffect(() => {
  const host = hostRef.current;
  if (host === null) return;
  if (!selectionSnapshot.navigationActive) {
    clearNavigationFocus(host);
    return;
  }
  paintCurrentNavigationItem(host);
}, [drawn, drawnRevision, selectionSnapshot.navigationActive, selectionSnapshot.navigationCursorId]);

  return { onCanvasFocus, onCanvasBlur, onCanvasKeyDown };
}

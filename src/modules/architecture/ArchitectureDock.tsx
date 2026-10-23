import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import { TOUCH_TARGET_STYLE, useTouchLayout } from '@/modules/architecture/hooks/useTouchLayout';

/**
 * One page the dock can draw. The shell knows nothing about what a tab means:
 * the inspector registers itself now, and the text page (a sibling task)
 * registers a second entry on the same shell without this file changing.
 */
export type ArchitectureDockTab = {
  readonly id: string;
  /** The tab's visible label. */
  readonly label: string;
  /** The page's content; rendered only while its tab is active. */
  readonly content: ReactNode;
  /** Optional count drawn beside the label (the sessions page's hit count). */
  readonly count?: number;
};

type ArchitectureDockProps = {
  /** Whether the dock is on screen. The panel owns this state. */
  readonly open: boolean;
  readonly tabs: readonly ArchitectureDockTab[];
  readonly activeTabId: string;
  readonly onTabChange: (tabId: string) => void;
  /** Closes the dock. Also called by Escape when the canvas owns the key. */
  readonly onClose: () => void;
  /** The dock's accessible name. */
  readonly title: string;
  /** The close control's accessible name. */
  readonly closeLabel: string;
  /**
   * Where focus returns when the dock closes. The panel passes the canvas
   * region: the click that opened the dock was a gesture on the drawing, so the
   * drawing is where the reader resumes.
   */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  /**
   * The coarse tier's collapsed (96px) reading: the selected entity's name and
   * kind plus its actions. On the desktop tier the title bar already states
   * what the dock is, so this is unused there.
   */
  readonly collapsedSummary?: ReactNode;
  /** Labels for the three coarse-tier snap heights. */
  readonly snapLabels: {
    readonly collapsed: string;
    readonly half: string;
    readonly full: string;
  };
  /**
   * The coarse drawer's height in CSS pixels, reported whenever the snap (or
   * the drawer's open state) changes. The panel needs it because the drawer is
   * an overlay: the selection tray and the drawing have to stay above its top
   * edge, and only the drawer knows which of the three heights is in force.
   * Reports 0 while the drawer is closed.
   */
  readonly onTouchDrawerHeightChange?: (heightPx: number) => void;
};

/** The desktop dock width. Opening it squeezes the canvas instead of covering it. */
const DOCK_WIDTH_PX = 320;

/** The three snap heights of the coarse-tier drawer. */
const DRAWER_HEIGHTS = {
  collapsed: '96px',
  half: '45vh',
  full: '92vh',
} as const;

type DrawerSnap = keyof typeof DRAWER_HEIGHTS;

/**
 * The drawer's real height for one snap, in CSS pixels.
 *
 * The style states two of the three heights in `vh`; this conversion is what
 * lets the panel place the tray and the drawing against the same number the
 * browser paints. `viewportHeight` is `window.innerHeight`, the same basis
 * `vh` uses.
 */
export function touchDrawerHeightPx(snap: DrawerSnap, viewportHeight: number): number {
  if (snap === 'collapsed') return 96;
  const ratio = snap === 'half' ? 0.45 : 0.92;
  return Math.round(viewportHeight * ratio);
}

/**
 * The architecture tab's right-hand dock (desktop) and bottom drawer (coarse
 * pointer), plus the tab shell both tiers share.
 *
 * Used by `ArchitecturePanel` only. On a fine pointer the dock is an in-flow
 * `role="complementary"` column: opening it narrows the canvas (the panel locks
 * the aspect re-layout for the transition, see `relayoutLocked`), and it slides
 * in from the right in 160ms. On a coarse pointer the same tab content is drawn
 * in a bottom drawer with three snap heights — collapsed (96px: name, kind and
 * actions), half (45vh) and full — so the drawing is never covered entirely.
 *
 * The shell owns the tablist and focus return; the panel owns `open`, the
 * active tab and (through the inspector's props) the content.
 */
export function ArchitectureDock({
  open,
  tabs,
  activeTabId,
  onTabChange,
  onClose,
  title,
  closeLabel,
  returnFocusRef,
  collapsedSummary,
  snapLabels,
  onTouchDrawerHeightChange,
}: ArchitectureDockProps) {
  const { coarsePointer } = useTouchLayout();
  // A coarse pointer gets a real 44×44 target on every dock control; the size
  // is inline so the reading does not depend on a stylesheet.
  const targetStyle = coarsePointer ? TOUCH_TARGET_STYLE : undefined;
  const baseId = useId();
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // The coarse drawer's snap height. Local UI state: the panel does not need
  // to know how tall the drawer is, only whether it is open. It is state (not a
  // ref) because the snap buttons must re-render the drawer at their height.
  const [snap, setSnap] = useState<DrawerSnap>('half');

  // Focus returns to the drawing when the dock leaves the screen — the gesture
  // that opened it happened there. Capture on open, not on close, so the close
  // BUTTON does not become the restore target.
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      return;
    }
    const target = returnFocusRef?.current ?? previouslyFocusedRef.current;
    target?.focus();
  }, [open, returnFocusRef]);

  // The coarse drawer's own height, stated to the panel: it is an overlay, so
  // everything that must not sit underneath it (the selection tray, the
  // selected box) is placed against this number. Reported from the snap rather
  // than measured, so the reading is the height the drawer is about to paint
  // and does not wait for the slide-in animation.
  useEffect(() => {
    if (!coarsePointer) return;
    onTouchDrawerHeightChange?.(open ? touchDrawerHeightPx(snap, window.innerHeight) : 0);
  }, [coarsePointer, open, snap, onTouchDrawerHeightChange]);

  if (!open) return null;

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  if (activeTab === null) return null;

  const tabList = (
    <div
      role="tablist"
      aria-label={title}
      data-architecture-dock-tablist="true"
      className="flex items-center gap-1 border-b border-border/60 px-2 py-1"
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeTab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${baseId}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${baseId}-panel-${tab.id}`}
            data-architecture-dock-tab={tab.id}
            onClick={() => onTabChange(tab.id)}
            style={targetStyle}
            className={`rounded px-2 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
              selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                data-architecture-dock-tab-count={tab.count}
                className="ml-1 tabular-nums text-muted-foreground"
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
      <span className="flex-1" />
      <button
        type="button"
        aria-label={closeLabel}
        data-architecture-dock-close="true"
        onClick={onClose}
        style={targetStyle}
        className="rounded px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        ×
      </button>
    </div>
  );

  const tabPanel = (tab: ArchitectureDockTab): ReactNode => (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${tab.id}`}
      aria-labelledby={`${baseId}-tab-${tab.id}`}
      data-architecture-dock-panel={tab.id}
      // Content changes (a new selection, new hits) are announced without
      // moving focus away from the drawing.
      aria-live="polite"
      className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
    >
      {tab.content}
    </div>
  );

  // Reduced motion keeps the change of state but drops the slide: the media
  // query is the only place the animation duration can be overridden.
  const motionStyle = (
    <style>{`
      @keyframes architecture-dock-slide-in {
        from { transform: translateX(100%); }
        to { transform: translateX(0); }
      }
      @keyframes architecture-drawer-slide-up {
        from { transform: translateY(100%); }
        to { transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        [data-architecture-dock], [data-architecture-dock-touch] { animation: none !important; }
      }
    `}</style>
  );

  if (coarsePointer) {
    return (
      <>
        {motionStyle}
        <section
          role="region"
          aria-label={title}
          data-architecture-dock-touch="true"
          data-architecture-dock-height={snap}
          style={{
            height: DRAWER_HEIGHTS[snap],
            animation: 'architecture-drawer-slide-up 160ms ease-out',
          }}
          className="absolute bottom-0 left-0 right-0 z-40 flex flex-col rounded-t-xl border-t border-border bg-popover shadow-xl"
        >
          <div
            className="flex items-center gap-1 px-2 pt-1"
            data-architecture-dock-snap-controls="true"
          >
            {(Object.keys(DRAWER_HEIGHTS) as DrawerSnap[]).map((nextSnap) => (
              <button
                key={nextSnap}
                type="button"
                aria-pressed={snap === nextSnap}
                aria-label={snapLabels[nextSnap]}
                data-architecture-dock-snap={nextSnap}
                onClick={() => setSnap(nextSnap)}
                style={targetStyle}
                // Each button names ITS OWN snap; the pressed one is distinguished
                // by weight and fill, not by colour alone.
                className={`rounded px-2 py-0.5 text-[11px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
                  snap === nextSnap
                    ? 'bg-accent font-semibold text-foreground shadow-inner'
                    : 'font-medium text-muted-foreground'
                }`}
              >
                {snapLabels[nextSnap]}
              </button>
            ))}
            <span className="flex-1" />
          </div>
          {snap === 'collapsed' && collapsedSummary !== undefined && (
            <div data-architecture-dock-summary="true" className="px-3 pb-2 text-sm text-foreground">
              {collapsedSummary}
            </div>
          )}
          {tabList}
          {tabPanel(activeTab)}
        </section>
      </>
    );
  }

  return (
    <>
      {motionStyle}
      <aside
        role="complementary"
        aria-label={title}
        data-architecture-dock="true"
        data-architecture-dock-width={DOCK_WIDTH_PX}
        style={{
          width: DOCK_WIDTH_PX,
          animation: 'architecture-dock-slide-in 160ms ease-out',
        }}
        className="flex shrink-0 flex-col border-l border-border/60 bg-background"
      >
        {tabList}
        {tabPanel(activeTab)}
      </aside>
    </>
  );
}

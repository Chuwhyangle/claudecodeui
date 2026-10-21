import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import type { AppTab, Project, ProjectSession } from '@/shared/types';
import { cn } from '@/shared/utils';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceTabs, { CollapsedWorkspaceSelector } from '@/modules/project-workspace/WorkspaceTabs';
import WorkspaceMenu from '@/modules/project-workspace/WorkspaceMenu';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';

type WorkspaceHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  /** Optional so a caller that only knows about Tasks/Browser keeps compiling; absent means "no Quay tab". */
  shouldShowQuayTab?: boolean;
  /** Optional, absent means "no architecture tab", the same contract as `shouldShowQuayTab`. */
  shouldShowArchitectureTab?: boolean;
  shouldShowBrowserTab: boolean;
  /**
   * The selected session's stored lifecycle mode, resolved by WorkspaceMain.
   * Optional with `false` as the meaning of absent, so that a header rendered
   * without a mode reading keeps offering Shell rather than closing it by default.
   */
  isResidentSession?: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
};

/**
 * Rendered by WorkspaceMain. Desktop shows the workspace title beside the scrollable
 * tab bar; mobile keeps the same three elements on one row — menu, title, and a
 * selector for the active workspace — and moves the rest of the tab bar into that
 * selector's dialog.
 */
export default function WorkspaceHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  shouldShowQuayTab = false,
  shouldShowArchitectureTab = false,
  shouldShowBrowserTab,
  isResidentSession,
  isMobile,
  onMenuClick,
}: WorkspaceHeaderProps) {
  const { t } = useTranslation();
  // Read here rather than taken as a prop beside `isMobile`, which arrives threaded through
  // ProjectWorkspaceShell, ProjectMainRegion and WorkspaceMain: this header is the only consumer on
  // that path, so a prop would widen three signatures to carry one padding decision.
  const { isShortTouchViewport } = useDeviceSettings({ trackPWA: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const hasOverflow = canScrollLeft || canScrollRight;

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();

    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);

    return () => observer.disconnect();
  }, [updateScrollState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      const canMove = event.deltaY < 0 ? el.scrollLeft > 0 : el.scrollLeft < maxScrollLeft;
      if (!canMove) return;

      event.preventDefault();
      const lineMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1;
      el.scrollBy({ left: event.deltaY * lineMultiplier, behavior: 'auto' });
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const activeTabElement = scrollRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      activeTabElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      updateScrollState();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, updateScrollState]);

  const scrollTabs = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(180, el.clientWidth * 0.65), behavior: 'smooth' });
  };

  return (
    <header
      data-app-header
      className={cn(
        'pwa-header-safe flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-background/95 backdrop-blur-sm',
        // The short tier is a touch-only device with the width of a desktop and the height of a
        // phone, so `md:py-2` would spend 16px of a 330px screen on padding alone. It is read here
        // rather than threaded down as a prop, because the four components between the route and
        // this header have no other use for it.
        isShortTouchViewport ? 'px-2 py-1' : 'px-3 py-1.5 md:gap-3 md:px-4 md:py-2',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 md:max-w-[min(34%,24rem)] md:flex-[1_1_18rem]">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
        <WorkspaceTitle
          activeTab={activeTab}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          shouldShowTasksTab={shouldShowTasksTab}
          shouldShowQuayTab={shouldShowQuayTab}
          shouldShowArchitectureTab={shouldShowArchitectureTab}
        />
      </div>

      {isMobile ? (
        <div className="flex flex-shrink-0 items-center gap-1">
          <CollapsedWorkspaceSelector
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            shouldShowTasksTab={shouldShowTasksTab}
            shouldShowQuayTab={shouldShowQuayTab}
            shouldShowArchitectureTab={shouldShowArchitectureTab}
            shouldShowBrowserTab={shouldShowBrowserTab}
            isResidentSession={isResidentSession}
          />
          <WorkspaceMenu />
        </div>
      ) : (
        <>
        <div className="min-w-0 flex-1">
          <div className="relative ml-auto w-fit max-w-full">
            {canScrollLeft && (
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-background via-background/90 to-transparent" />
            )}
            <div
              ref={scrollRef}
              onScroll={updateScrollState}
              className={cn(
                'scrollbar-hide max-w-full scroll-smooth overflow-x-auto overscroll-x-contain px-3 [-webkit-overflow-scrolling:touch]',
                hasOverflow ? 'md:px-9' : 'md:pl-3 md:pr-0',
              )}
            >
              <WorkspaceTabs
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                shouldShowTasksTab={shouldShowTasksTab}
                shouldShowQuayTab={shouldShowQuayTab}
                shouldShowArchitectureTab={shouldShowArchitectureTab}
                shouldShowBrowserTab={shouldShowBrowserTab}
                isResidentSession={isResidentSession}
              />
            </div>
            {canScrollRight && (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-background via-background/90 to-transparent" />
            )}

            {canScrollLeft && (
              <button
                type="button"
                onClick={() => scrollTabs(-1)}
                aria-label={t('navigation.scrollTabsLeft', { defaultValue: 'Scroll tabs left' })}
                className="absolute left-1 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 md:flex"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            {canScrollRight && (
              <button
                type="button"
                onClick={() => scrollTabs(1)}
                aria-label={t('navigation.scrollTabsRight', { defaultValue: 'Scroll tabs right' })}
                className="absolute right-1 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 md:flex"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <WorkspaceMenu />
        </>
      )}
    </header>
  );
}

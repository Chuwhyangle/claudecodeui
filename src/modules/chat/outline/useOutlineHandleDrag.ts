import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';

// Its own key: the outline handle's place is not the retired quick-settings handle's.
const HANDLE_POSITION_STORAGE_KEY = 'inputOutlineHandlePosition';

const DEFAULT_HANDLE_POSITION = 50;
const HANDLE_POSITION_MIN = 10;
const HANDLE_POSITION_MAX = 90;
const DRAG_THRESHOLD_PX = 5;
// The handle is a 38px button (p-2 + h-5 icon + border); the clamp needs it to keep the whole button clear of the header.
const HANDLE_SIZE_PX = 38;
// Breathing room kept between the header's bottom rule and the handle.
const HEADER_GAP_PX = 12;
// The workspace header marks itself with this attribute so the handle can measure it without importing that module.
const APP_HEADER_SELECTOR = '[data-app-header]';
// ChatInterface marks the composer's wrapper with this attribute, likewise measured rather than imported.
const CHAT_COMPOSER_SELECTOR = '[data-chat-composer]';

type UseOutlineHandleDragProps = {
  isMobile: boolean;
};

type StartDragEvent = ReactMouseEvent<HTMLButtonElement> | ReactTouchEvent<HTMLButtonElement>;
type MoveDragEvent = MouseEvent | TouchEvent;
type EventWithClientY = StartDragEvent | MoveDragEvent;

const clampPosition = (value: number, min = HANDLE_POSITION_MIN, max = HANDLE_POSITION_MAX): number => (
  Math.max(min, Math.min(max, value))
);

// The percentage bounds are viewport-relative but the header is a fixed pixel height, so the
// header-safe limit is converted from pixels each time instead of being a constant percentage.
const readHeaderBottom = (): number => (
  typeof document === 'undefined'
    ? 0
    : document.querySelector(APP_HEADER_SELECTOR)?.getBoundingClientRect().bottom ?? 0
);

// 0 means "no composer on screen"; the bounds then fall back to the percentage limits.
const readComposerTop = (): number => (
  typeof document === 'undefined'
    ? 0
    : document.querySelector(CHAT_COMPOSER_SELECTOR)?.getBoundingClientRect().top ?? 0
);

const getPositionBounds = (
  isMobile: boolean,
  viewportHeight: number,
  headerBottom: number,
  composerTop: number,
): { min: number; max: number } => {
  const safeTopPx = headerBottom > 0 ? headerBottom + HEADER_GAP_PX : 0;
  const height = Math.max(viewportHeight, 1);
  // Lowest y the handle's bottom edge may reach: just above the composer.
  const safeBottomPx = composerTop > 0 && composerTop < height ? composerTop - HEADER_GAP_PX : height;

  if (isMobile) {
    // Mobile anchors the button's bottom edge at `position`% above the viewport bottom.
    const minPct = ((height - safeBottomPx) / height) * 100;
    const maxPct = ((height - safeTopPx - HANDLE_SIZE_PX) / height) * 100;
    const min = Math.min(HANDLE_POSITION_MAX, Math.max(HANDLE_POSITION_MIN, minPct));
    return { min, max: Math.max(min, Math.min(HANDLE_POSITION_MAX, maxPct)) };
  }

  // Desktop centres the button on the position (translateY(-50%)).
  const minPct = ((safeTopPx + HANDLE_SIZE_PX / 2) / height) * 100;
  const maxPct = ((safeBottomPx - HANDLE_SIZE_PX / 2) / height) * 100;
  const min = Math.min(HANDLE_POSITION_MAX, Math.max(HANDLE_POSITION_MIN, minPct));
  return { min, max: Math.max(min, Math.min(HANDLE_POSITION_MAX, maxPct)) };
};

const readHandlePosition = (): number => {
  if (typeof window === 'undefined') {
    return DEFAULT_HANDLE_POSITION;
  }

  const saved = localStorage.getItem(HANDLE_POSITION_STORAGE_KEY);
  if (!saved) {
    return DEFAULT_HANDLE_POSITION;
  }

  try {
    const parsed = JSON.parse(saved) as { y?: unknown };
    if (typeof parsed.y === 'number' && Number.isFinite(parsed.y)) {
      return clampPosition(parsed.y);
    }
  } catch {
    localStorage.removeItem(HANDLE_POSITION_STORAGE_KEY);
    return DEFAULT_HANDLE_POSITION;
  }

  return DEFAULT_HANDLE_POSITION;
};

const isTouchEvent = (event: { type: string }): boolean => event.type.includes('touch');

const getClientY = (event: EventWithClientY): number | null => {
  if ('touches' in event) {
    return event.touches[0]?.clientY ?? null;
  }

  return 'clientY' in event && typeof event.clientY === 'number'
    ? event.clientY
    : null;
};

export function useOutlineHandleDrag({ isMobile }: UseOutlineHandleDragProps) {
  const [handlePosition, setHandlePosition] = useState<number>(readHandlePosition);
  // Viewport height and the header's bottom edge drive the header-safe clamp, so a resize or a
  // late-mounting header re-derives the effective position without overwriting the saved preference.
  const [viewportHeight, setViewportHeight] = useState<number>(
    () => (typeof window === 'undefined' ? 0 : window.innerHeight),
  );
  const [headerBottom, setHeaderBottom] = useState(0);
  const [composerTop, setComposerTop] = useState(0);
  const [isPointerDown, setIsPointerDown] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // What is actually drawn: the saved preference limited to the header-safe range.
  const effectivePosition = useMemo(() => {
    const { min, max } = getPositionBounds(isMobile, viewportHeight, headerBottom, composerTop);
    return clampPosition(handlePosition, min, max);
  }, [composerTop, handlePosition, headerBottom, isMobile, viewportHeight]);

  useEffect(() => {
    const onResize = () => {
      setViewportHeight(window.innerHeight);
      setHeaderBottom(readHeaderBottom());
      setComposerTop(readComposerTop());
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The header and composer mount after this hook's first render and change height (wrapping,
  // multi-line input), so re-read them after every render; setState bails out when unchanged.
  useEffect(() => {
    setHeaderBottom(readHeaderBottom());
    setComposerTop(readComposerTop());
  });

  const dragStartYRef = useRef<number | null>(null);
  const dragStartPositionRef = useRef(DEFAULT_HANDLE_POSITION);
  const didDragRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const bodyStylesAppliedRef = useRef(false);

  const clearBodyDragStyles = useCallback(() => {
    if (!bodyStylesAppliedRef.current) {
      return;
    }

    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.width = '';
    bodyStylesAppliedRef.current = false;
  }, []);

  const applyBodyDragStyles = useCallback((isTouchDragging: boolean) => {
    if (bodyStylesAppliedRef.current) {
      return;
    }

    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    // Touch drag should lock body scroll so the handle movement stays smooth.
    if (isTouchDragging) {
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.width = '100%';
    }

    bodyStylesAppliedRef.current = true;
  }, []);

  const endDrag = useCallback(() => {
    if (!isPointerDown && dragStartYRef.current === null) {
      return;
    }

    suppressNextClickRef.current = didDragRef.current;
    didDragRef.current = false;
    dragStartYRef.current = null;
    setIsPointerDown(false);
    setIsDragging(false);
    clearBodyDragStyles();
  }, [clearBodyDragStyles, isPointerDown]);

  const handleMove = useCallback(
    (event: MoveDragEvent) => {
      if (!isPointerDown || dragStartYRef.current === null) {
        return;
      }

      const clientY = getClientY(event);
      if (clientY === null) {
        return;
      }

      const rawDelta = clientY - dragStartYRef.current;
      const movedPastThreshold = Math.abs(rawDelta) > DRAG_THRESHOLD_PX;

      if (!didDragRef.current && movedPastThreshold) {
        didDragRef.current = true;
        setIsDragging(true);
        applyBodyDragStyles(isTouchEvent(event));
      }

      if (!didDragRef.current) {
        return;
      }

      if (isTouchEvent(event)) {
        event.preventDefault();
      }

      const viewportHeight = Math.max(window.innerHeight, 1);
      const normalizedDelta = (rawDelta / viewportHeight) * 100;
      const positionDelta = isMobile ? -normalizedDelta : normalizedDelta;
      const { min, max } = getPositionBounds(isMobile, viewportHeight, headerBottom, composerTop);
      setHandlePosition(clampPosition(dragStartPositionRef.current + positionDelta, min, max));
    },
    [applyBodyDragStyles, composerTop, headerBottom, isMobile, isPointerDown, viewportHeight],
  );

  const startDrag = useCallback((event: StartDragEvent) => {
    event.stopPropagation();

    const clientY = getClientY(event);
    if (clientY === null) {
      return;
    }

    dragStartYRef.current = clientY;
    // Start from the drawn position so a clamped handle does not jump on the first move.
    dragStartPositionRef.current = effectivePosition;
    didDragRef.current = false;
    setIsDragging(false);
    setIsPointerDown(true);
  }, [effectivePosition]);

  // Persist drag-handle position so users keep their preferred quick-access location.
  useEffect(() => {
    localStorage.setItem(
      HANDLE_POSITION_STORAGE_KEY,
      JSON.stringify({ y: handlePosition }),
    );
  }, [handlePosition]);

  useEffect(() => {
    if (!isPointerDown) {
      return undefined;
    }

    const handleMouseMove = (event: MouseEvent) => {
      handleMove(event);
    };
    const handleMouseUp = () => {
      endDrag();
    };
    const handleTouchMove = (event: TouchEvent) => {
      handleMove(event);
    };
    const handleTouchEnd = () => {
      endDrag();
    };
    // A system gesture can cancel the stream; without this the body scroll lock would never be released.
    const handleTouchCancel = () => {
      endDrag();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchCancel);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, [endDrag, handleMove, isPointerDown]);

  useEffect(() => (
    () => {
      clearBodyDragStyles();
    }
  ), [clearBodyDragStyles]);

  const consumeSuppressedClick = useCallback((): boolean => {
    if (!suppressNextClickRef.current) {
      return false;
    }

    suppressNextClickRef.current = false;
    return true;
  }, []);

  const handleStyle = useMemo<CSSProperties>(() => {
    if (!isMobile || typeof window === 'undefined') {
      return {
        top: `${effectivePosition}%`,
        transform: 'translateY(-50%)',
      };
    }

    return {
      bottom: `${(window.innerHeight * effectivePosition) / 100}px`,
    };
  }, [effectivePosition, isMobile]);

  return {
    isDragging,
    handleStyle,
    startDrag,
    consumeSuppressedClick,
  };
}

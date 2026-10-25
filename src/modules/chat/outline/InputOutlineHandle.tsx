import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, GripVertical } from 'lucide-react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';

type InputOutlineHandleProps = {
  isOpen: boolean;
  isMobile: boolean;
  isDragging: boolean;
  style: CSSProperties;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onTouchStart: (event: ReactTouchEvent<HTMLButtonElement>) => void;
};

/** Rendered by InputOutlineDrawer as the draggable edge handle that opens and closes it. */
export default function InputOutlineHandle({
  isOpen,
  isMobile,
  isDragging,
  style,
  onClick,
  onMouseDown,
  onTouchStart,
}: InputOutlineHandleProps) {
  const { t } = useTranslation('chat');

  // Closed, the handle stands one native scrollbar's width (~15px) in from the
  // edge so it does not cover the transcript's scrollbar; open, it rides the
  // panel's left edge. On a narrow screen the panel is capped at 85vw, so the open handle
  // follows that edge; touch scrollbars overlay, so the closed handle sits flush instead.
  const openPlacement = isMobile ? 'right-[min(16rem,85vw)]' : 'right-64';
  const placementClass = isOpen ? openPlacement : isMobile ? 'right-0' : 'right-[15px]';
  const borderClass = isDragging
    ? 'border-blue-500 dark:border-blue-400'
    : 'border-gray-200 dark:border-gray-700';
  const transitionClass = isDragging
    ? ''
    : 'transition-all duration-150 ease-out';
  const cursorClass = isDragging ? 'cursor-grabbing' : 'cursor-pointer';
  const ariaLabel = isOpen ? t('inputOutline.close') : t('inputOutline.open');

  // The icons swap when a drag starts. A touch stream stays bound to the node it began on, so an icon
  // that is the touch target and then unmounts would drop every later touchmove/touchend;
  // pointer-events-none keeps the button, which stays mounted, as the target.
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      className={`fixed ${placementClass} z-50 ${transitionClass} border bg-white dark:bg-gray-800 ${borderClass} rounded-l-md p-2 shadow-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 ${cursorClass} touch-none`}
      style={{
        ...style,
        touchAction: 'none',
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
      }}
      aria-label={ariaLabel}
      aria-expanded={isOpen}
      title={t('inputOutline.handleTitle')}
      data-input-outline-handle
    >
      {isDragging ? (
        <GripVertical className="pointer-events-none h-5 w-5 text-blue-500 dark:text-blue-400" />
      ) : isOpen ? (
        <ChevronRight className="pointer-events-none h-5 w-5 text-gray-600 dark:text-gray-400" />
      ) : (
        <ChevronLeft className="pointer-events-none h-5 w-5 text-gray-600 dark:text-gray-400" />
      )}
    </button>
  );
}

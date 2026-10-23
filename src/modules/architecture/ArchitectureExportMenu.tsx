import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  TOUCH_CONTROL_GAP_PX,
  TOUCH_TARGET_STYLE,
  useTouchLayout,
} from '@/modules/architecture/hooks/useTouchLayout';

/** The five formats the export menu offers; `mmd` is the legacy Mermaid pair. */
type ArchitectureExportItemId = 'puml' | 'copy' | 'svg' | 'png' | 'mmd';

type ArchitectureExportMenuProps = {
  /** Whether the menu is drawn inside the compact toolbar's overflow panel. */
  readonly compact?: boolean;
  readonly onExportPlantUml: () => void;
  readonly onCopyPlantUml: () => void;
  readonly onExportSvg: () => void;
  readonly onExportPng: () => void;
  readonly onExportMermaid: () => void;
  /** Runs after an item is chosen, so the compact overflow panel can close. */
  readonly onAction: () => void;
};

/**
 * The `Export ▾` disclosure.
 *
 * Standard menu semantics: the trigger advertises `aria-haspopup="menu"`, the
 * list is a `role="menu"` of `menuitem` buttons, arrow keys move between them,
 * and Escape closes ONLY this menu — it calls `stopPropagation` so the chat
 * page's document-level Escape (abort the running turn) never sees the key.
 * The five formats are ordered PlantUML first and the legacy Mermaid pair last;
 * the item list is the same on every layout, only its position differs (the
 * compact tier draws it inside the panel's overflow sheet).
 *
 * Used by `ArchitecturePanel` only.
 */
export function ArchitectureExportMenu({
  compact = false,
  onExportPlantUml,
  onCopyPlantUml,
  onExportSvg,
  onExportPng,
  onExportMermaid,
  onAction,
}: ArchitectureExportMenuProps) {
  const { t } = useTranslation();
  // A coarse pointer needs a real 44px hit area on the disclosure AND on each
  // item; the size is inline so the reading does not depend on a stylesheet.
  const { coarsePointer } = useTouchLayout();
  const targetStyle = coarsePointer ? TOUCH_TARGET_STYLE : undefined;
  // Whether the list is expanded. Local to the disclosure: the panel does not
  // need to know (it only learns about the chosen format through the callbacks).
  const [open, setOpen] = useState(false);
  // Which item owns the roving tab stop while the menu is open.
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const items: readonly {
    readonly id: ArchitectureExportItemId;
    readonly label: string;
    readonly legacy: boolean;
    readonly run: () => void;
  }[] = [
    {
      id: 'puml',
      label: t('architecture.export.plantUml', { defaultValue: 'PlantUML (.puml)' }),
      legacy: false,
      run: onExportPlantUml,
    },
    {
      id: 'copy',
      label: t('architecture.export.copy', { defaultValue: 'Copy PlantUML' }),
      legacy: false,
      run: onCopyPlantUml,
    },
    { id: 'svg', label: t('architecture.export.svg', { defaultValue: 'SVG' }), legacy: false, run: onExportSvg },
    { id: 'png', label: t('architecture.export.png', { defaultValue: 'PNG' }), legacy: false, run: onExportPng },
    {
      id: 'mmd',
      label: t('architecture.export.mermaid', { defaultValue: 'Mermaid (.mmd, legacy)' }),
      legacy: true,
      run: onExportMermaid,
    },
  ];

  const itemCount = items.length;
  const focusItem = (index: number): void => {
    const next = ((index % itemCount) + itemCount) % itemCount;
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  };
  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  };
  // The toolbar scrolls horizontally, which would clip an absolutely positioned
  // dropdown. On the desktop tier the list is therefore `position: fixed`,
  // anchored under the trigger; the compact tier draws it inline in the sheet.
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number } | null>(null);
  const openMenu = (): void => {
    if (!compact) {
      const rect = toggleRef.current?.getBoundingClientRect();
      if (rect !== undefined) {
        setPopoverPosition({ left: Math.max(8, rect.right - 224), top: rect.bottom + 4 });
      }
    }
    setOpen(true);
  };

  // Opening moves focus into the list, the way a disclosure menu does.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  // A press outside the disclosure closes it without stealing the press.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape':
        // Escape belongs to this menu while it is open. Stopping propagation
        // is what keeps the chat page's global abort from also firing.
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'ArrowDown':
        event.preventDefault();
        focusItem(activeIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(activeIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(itemCount - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      className={compact ? 'flex flex-col' : 'relative'}
      style={compact ? { gap: TOUCH_CONTROL_GAP_PX } : undefined}
      data-architecture-export-menu-root="true"
    >
      <button
        ref={toggleRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) close(false);
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu();
          }
        }}
        data-architecture-export="true"
        style={targetStyle}
        className={`rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
          compact ? 'px-3 py-2 text-sm text-left' : 'px-2 py-0.5 text-xs'
        }`}
      >
        {t('architecture.export.menu', { defaultValue: 'Export ▾' })}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('architecture.export.menu', { defaultValue: 'Export ▾' })}
          data-architecture-export-menu="true"
          onKeyDown={handleMenuKeyDown}
          style={compact ? { gap: TOUCH_CONTROL_GAP_PX } : popoverPosition ?? { left: 8, top: 56 }}
          className={
            compact
              ? 'flex flex-col'
              : 'fixed z-50 flex w-56 flex-col rounded-lg border border-border bg-popover p-1 shadow-lg'
          }
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              data-architecture-export-item={item.id}
              data-architecture-export-legacy={item.legacy ? 'true' : undefined}
              style={targetStyle}
              onFocus={() => setActiveIndex(index)}
              onClick={() => {
                close(false);
                onAction();
                item.run();
              }}
              className={`rounded px-2 py-1 text-left text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
                compact ? 'py-2 text-sm' : ''
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

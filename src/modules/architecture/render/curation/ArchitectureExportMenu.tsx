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

/** One row of the disclosure's menu, export format or the legend door. */
type ArchitectureMenuEntry = {
  readonly key: string;
  readonly label: string;
  /** Only export entries carry the legacy marker (the Mermaid pair). */
  readonly legacy: boolean;
  readonly run: () => void;
  /** Export entries keep their long-standing `data-architecture-export-item` id. */
  readonly exportItem: boolean;
};

type ArchitectureExportHandlers = {
  readonly onExportPlantUml: () => void;
  readonly onCopyPlantUml: () => void;
  readonly onExportSvg: () => void;
  readonly onExportPng: () => void;
  readonly onExportMermaid: () => void;
};

type ArchitectureExportMenuProps = ArchitectureExportHandlers & {
  /** Whether the menu is drawn inside the compact toolbar's overflow panel. */
  readonly compact?: boolean;
  /**
   * `disclosure` is the `Export ▾` button the compact sheet hosts. `overflow`
   * is the desktop toolbar's single `⋯`: the same five formats plus the legend
   * door, so the toolbar row stays one line.
   */
  readonly variant?: 'disclosure' | 'overflow';
  /** Runs after an item is chosen, so the compact overflow panel can close. */
  readonly onAction?: () => void;
  /** The legend door (overflow variant only). */
  readonly onShowLegend?: () => void;
  /**
   * The overflowing trigger's own ref, so the legend's dismissal (Escape) can
   * return focus to the control that opened it.
   */
  readonly triggerRef?: { current: HTMLButtonElement | null };
  /** Called when the menu opens, e.g. to shut another toolbar popover. */
  readonly onOpen?: () => void;
};

/**
 * The toolbar's export disclosure, and the desktop toolbar's `⋯` overflow.
 *
 * Standard menu semantics: the trigger advertises `aria-haspopup="menu"`, the
 * list is a `role="menu"` of `menuitem` buttons, arrow keys move between them,
 * and Escape closes ONLY this menu — it calls `stopPropagation` so the chat
 * page's document-level Escape (abort the running turn) never sees the key.
 * The five formats are ordered PlantUML first and the legacy Mermaid pair last;
 * the `overflow` variant appends the legend door and is what the desktop row
 * renders, because `Export ▾` and `Legend` no longer each take a slot there.
 *
 * Used by `ArchitecturePanel` only.
 */
export function ArchitectureExportMenu({
  compact = false,
  variant = 'disclosure',
  onExportPlantUml,
  onCopyPlantUml,
  onExportSvg,
  onExportPng,
  onExportMermaid,
  onAction,
  onShowLegend,
  triggerRef,
  onOpen,
}: ArchitectureExportMenuProps) {
  const { t } = useTranslation();
  // A coarse pointer needs a real 44px hit area on the disclosure AND on each
  // item; the size is inline so the reading does not depend on a stylesheet.
  const { coarsePointer } = useTouchLayout();
  const targetStyle = coarsePointer ? TOUCH_TARGET_STYLE : undefined;
  const overflow = variant === 'overflow';
  // Whether the list is expanded. Local to the disclosure: the panel does not
  // need to know (it only learns about the chosen format through the callbacks).
  const [open, setOpen] = useState(false);
  // Which item owns the roving tab stop while the menu is open.
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const entries: readonly ArchitectureMenuEntry[] = [
    {
      key: 'puml',
      label: t('architecture.export.plantUml', { defaultValue: 'PlantUML (.puml)' }),
      legacy: false,
      run: onExportPlantUml,
      exportItem: true,
    },
    {
      key: 'copy',
      label: t('architecture.export.copy', { defaultValue: 'Copy PlantUML' }),
      legacy: false,
      run: onCopyPlantUml,
      exportItem: true,
    },
    { key: 'svg', label: t('architecture.export.svg', { defaultValue: 'SVG' }), legacy: false, run: onExportSvg, exportItem: true },
    { key: 'png', label: t('architecture.export.png', { defaultValue: 'PNG' }), legacy: false, run: onExportPng, exportItem: true },
    {
      key: 'mmd',
      label: t('architecture.export.mermaid', { defaultValue: 'Mermaid (.mmd, legacy)' }),
      legacy: true,
      run: onExportMermaid,
      exportItem: true,
    },
    // The legend used to be a `?` button of its own; the overflow menu is the
    // one place the desktop row still has room for it. Its popover body is
    // unchanged — this entry only opens it.
    ...(overflow
      ? [{
          key: 'legend',
          label: t('architecture.legend.title', { defaultValue: 'Legend' }),
          legacy: false,
          run: () => onShowLegend?.(),
          exportItem: false,
        }]
      : []),
  ];

  const entryCount = entries.length;
  const focusItem = (index: number): void => {
    const next = ((index % entryCount) + entryCount) % entryCount;
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
    onOpen?.();
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
        focusItem(entryCount - 1);
        break;
      default:
        break;
    }
  };

  const assignTriggerRef = (node: HTMLButtonElement | null): void => {
    toggleRef.current = node;
    if (triggerRef !== undefined) triggerRef.current = node;
  };

  const triggerLabel = overflow
    ? t('architecture.overflow.menu', { defaultValue: 'More actions' })
    : t('architecture.export.menu', { defaultValue: 'Export ▾' });

  return (
    <div
      ref={containerRef}
      className={compact ? 'flex flex-col' : 'relative'}
      style={compact ? { gap: TOUCH_CONTROL_GAP_PX } : undefined}
      data-architecture-export-menu-root="true"
    >
      <button
        ref={assignTriggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={overflow ? triggerLabel : undefined}
        title={overflow ? triggerLabel : undefined}
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
        {...(overflow
          ? { 'data-architecture-overflow-toggle': 'true' }
          : { 'data-architecture-export': 'true' })}
        style={targetStyle}
        // The overflow trigger is the SAME box as the toolbar's other actions
        // (16px line + 2×1px border + 2×3px padding = 22px). It is block-level
        // so its wrapper is exactly that box; an inline glyph would grow the
        // wrapper's line box and push this button below the row's shared top.
        className={`rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
          compact
            ? 'px-3 py-2 text-sm text-left'
            : overflow
              ? 'flex items-center px-2 py-[3px] text-sm leading-none'
              : 'px-2 py-0.5 text-xs'
        }`}
      >
        {overflow ? <span aria-hidden="true">⋯</span> : triggerLabel}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={triggerLabel}
          data-architecture-export-menu="true"
          onKeyDown={handleMenuKeyDown}
          style={compact ? { gap: TOUCH_CONTROL_GAP_PX } : popoverPosition ?? { left: 8, top: 56 }}
          className={
            compact
              ? 'flex flex-col'
              : 'fixed z-50 flex w-56 flex-col rounded-lg border border-border bg-popover p-1 shadow-lg'
          }
        >
          {entries.map((entry, index) => (
            <button
              key={entry.key}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              data-architecture-export-item={entry.exportItem ? entry.key : undefined}
              data-architecture-export-legacy={entry.exportItem && entry.legacy ? 'true' : undefined}
              data-architecture-legend-entry={entry.exportItem ? undefined : 'true'}
              style={targetStyle}
              onFocus={() => setActiveIndex(index)}
              onClick={() => {
                close(false);
                if (entry.exportItem) onAction?.();
                entry.run();
              }}
              className={`rounded px-2 py-1 text-left text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
                compact ? 'py-2 text-sm' : ''
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

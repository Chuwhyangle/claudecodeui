/**
 * The panel KNOB fragments: the granularity radios, the scope spinbutton and the
 * detail presets.
 *
 * Extracted from `ArchitecturePanel.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 */
import { ARCHITECTURE_DETAIL_TIERS, ARCHITECTURE_SCOPE_MAX, ARCHITECTURE_SCOPE_MIN, rankArchitectureDetail } from '@/modules/architecture/dom/readout/detailRanking';
import type { ArchitectureDetailTier } from '@/modules/architecture/dom/readout/detailRanking';

import { TOUCH_CONTROL_GAP_PX } from '@/modules/architecture/hooks/useTouchLayout';
import type { ArchitecturePanelActions } from '@/modules/architecture/render/useArchitecturePanelActions';
import type { ArchitecturePanelScope } from '@/modules/architecture/render/ArchitecturePanel';

/** The ready arm of the panel model: every field these fragments read. */
type ReadyScope = Extract<ArchitecturePanelScope, { branch: 'ready' }> & ArchitecturePanelActions;

/** Build the groups fragments from the panel model. */
export function panelGroupFragments(panel: ReadyScope): {
  readonly granularityGroup: React.ReactNode;
  readonly scopeGroup: React.ReactNode;
  readonly detailGroup: React.ReactNode;
} {
  const {
    changeDetail,
    changeGranularity,
    changeScope,
    coarsePointer,
    compactHeaderButtonClass,
    compactTargetStyle,
    compactToolbar,
    detail,
    displayNeighbourhood,
    granularity,
    headerButtonClass,
    scope,
    t,
  } = panel;

const granularityGroup = (
  <div
    role="radiogroup"
    aria-label={t('architecture.granularity', { defaultValue: 'Graph granularity' })}
    data-architecture-view-control="true"
    style={{ gap: compactToolbar ? TOUCH_CONTROL_GAP_PX : 4 }}
    className="flex items-center rounded-lg border border-border/60 p-0.5"
  >
    <button
      type="button"
      role="radio"
      aria-checked={granularity === 'entity'}
      onClick={() => changeGranularity('entity')}
      data-architecture-view-option="entity"
      style={compactTargetStyle}
      className={`${compactHeaderButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
        granularity === 'entity' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {t('architecture.controls.classView', { defaultValue: 'Class diagram' })}
    </button>
    <button
      type="button"
      role="radio"
      aria-checked={granularity === 'file'}
      onClick={() => changeGranularity('file')}
      data-architecture-view-option="file"
      style={compactTargetStyle}
      className={`${compactHeaderButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
        granularity === 'file' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {t('architecture.fileGraph', { defaultValue: 'File graph' })}
    </button>
  </div>
);

// Scope is the server-side generation parameter (the old Hops 1/2/3), so this
// control re-enters the fetch like the toggle it replaces. The readout is a
// real spinbutton: `＋2` is the value, and the arrow keys (or the two step
// buttons) move it, with the range clamped to 0..3 at both ends.
const scopeGroup = (
  <div
    role="group"
    aria-label={t('architecture.controls.scope', { defaultValue: 'Scope' })}
    data-architecture-scope-control="true"
    style={{ gap: compactToolbar ? TOUCH_CONTROL_GAP_PX : 4 }}
    className="flex items-center rounded-lg border border-border/60 p-0.5"
  >
    <button
      type="button"
      aria-label={t('architecture.controls.scopeDecrease', { defaultValue: 'Decrease scope' })}
      data-architecture-scope-decrease="true"
      onClick={() => changeScope(scope - 1)}
      disabled={scope <= ARCHITECTURE_SCOPE_MIN}
      style={compactTargetStyle}
      // A visible border is what makes the `−`/`+` read as buttons rather
      // than stray glyphs; the 44px box is the touch target.
      className={`${headerButtonClass} border border-border outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40`}
    >
      −
    </button>
    <span
      role="spinbutton"
      tabIndex={0}
      aria-label={t('architecture.controls.scope', { defaultValue: 'Scope' })}
      aria-valuenow={scope}
      aria-valuemin={ARCHITECTURE_SCOPE_MIN}
      aria-valuemax={ARCHITECTURE_SCOPE_MAX}
      aria-valuetext={`+${scope}`}
      data-architecture-scope-value={scope}
      style={compactTargetStyle}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
          event.preventDefault();
          changeScope(scope + 1);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
          event.preventDefault();
          changeScope(scope - 1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          changeScope(ARCHITECTURE_SCOPE_MIN);
        } else if (event.key === 'End') {
          event.preventDefault();
          changeScope(ARCHITECTURE_SCOPE_MAX);
        }
      }}
      // The reading is vertically centred in its own box: `+2` used to sit
      // higher than the `−`/`+` glyphs beside it.
      className={`inline-flex min-w-8 items-center justify-center rounded px-1 text-center tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
        coarsePointer ? 'text-sm' : 'text-xs'
      }`}
    >
      +{scope}
    </span>
    <button
      type="button"
      aria-label={t('architecture.controls.scopeIncrease', { defaultValue: 'Increase scope' })}
      data-architecture-scope-increase="true"
      onClick={() => changeScope(scope + 1)}
      disabled={scope >= ARCHITECTURE_SCOPE_MAX}
      style={compactTargetStyle}
      className={`${headerButtonClass} border border-border outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40`}
    >
      +
    </button>
  </div>
);

// Detail only re-ranks the payload already in hand: switching it must never
// re-enter the fetch. The three presets trade completeness for readability;
// the transcript's seeds survive every one of them. Each `t()` call names its
// key literally so the locale-completeness test extracts it from this source.
const detailButtonClass = (tier: ArchitectureDetailTier): string =>
  `${headerButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
    detail === tier ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
  }`;
// The detail knob only re-ranks what is already drawn, so on a graph where no
// tier can fold anything it is a dead control. Saying so on the buttons is
// better than the reader concluding the knob is broken.
const detailNothingToTrim = displayNeighbourhood !== null
  && ARCHITECTURE_DETAIL_TIERS.every((tier) =>
    rankArchitectureDetail(displayNeighbourhood.nodes, displayNeighbourhood.edges, tier)
      .retainedNodeIds.size >= displayNeighbourhood.nodes.length);
const detailNoChangeLabel = t('architecture.copyFix.detailNoChange', {
  defaultValue: 'No change: nothing more can be trimmed within the current scope',
});
const detailNoChangeProps = detailNothingToTrim
  ? { title: detailNoChangeLabel, 'data-architecture-detail-no-change': 'true' }
  : {};
const detailGroup = (
  <div
    role="radiogroup"
    aria-label={t('architecture.controls.detail', { defaultValue: 'Detail' })}
    data-architecture-detail-control="true"
    style={{ gap: compactToolbar ? TOUCH_CONTROL_GAP_PX : 4 }}
    className="flex items-center rounded-lg border border-border/60 p-0.5"
  >
    <button
      type="button"
      role="radio"
      aria-checked={detail === 'core'}
      aria-label={t('architecture.controls.detailCore', { defaultValue: 'Core' })}
      data-architecture-detail-option="core"
      onClick={() => changeDetail('core')}
      style={compactTargetStyle}
      className={detailButtonClass('core')}
      {...detailNoChangeProps}
    >
      {t('architecture.controls.detailCore', { defaultValue: 'Core' })}
    </button>
    <button
      type="button"
      role="radio"
      aria-checked={detail === 'common'}
      aria-label={t('architecture.controls.detailCommon', { defaultValue: 'Common' })}
      data-architecture-detail-option="common"
      onClick={() => changeDetail('common')}
      style={compactTargetStyle}
      className={detailButtonClass('common')}
      {...detailNoChangeProps}
    >
      {t('architecture.controls.detailCommon', { defaultValue: 'Common' })}
    </button>
    <button
      type="button"
      role="radio"
      aria-checked={detail === 'all'}
      aria-label={t('architecture.controls.detailAll', { defaultValue: 'All' })}
      data-architecture-detail-option="all"
      onClick={() => changeDetail('all')}
      style={compactTargetStyle}
      className={detailButtonClass('all')}
      {...detailNoChangeProps}
    >
      {t('architecture.controls.detailAll', { defaultValue: 'All' })}
    </button>
  </div>
);


  return {
    granularityGroup,
    scopeGroup,
    detailGroup,
  };
}

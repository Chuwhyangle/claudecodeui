// The drawing's inline stylesheets and palette. The rules are injected into
// the canvas once per drawing; the palette is what the semantic rewrite paints
// with. Nothing here reads or writes the DOM.

/**
 * The dim strength applied to everything that is NOT part of a highlight.
 * Kept at 0.4 (not the old 0.15): the unselected boxes stay readable, which is
 * what the interaction review asked for after a dimmed drawing looked blank.
 */
const DIM_OPACITY = 0.4;

/** Diagram chrome: dim everything not on the hovered node's edges. */
export const HIGHLIGHT_STYLE = `
  [data-architecture-plantuml] .arch-dim { opacity: ${DIM_OPACITY}; }
  [data-architecture-plantuml] .arch-hl-in rect,
  [data-architecture-plantuml] .arch-hl-out rect { stroke: #2563eb; stroke-width: 2.5; }
  [data-architecture-plantuml] .arch-hl-in polyline,
  [data-architecture-plantuml] .arch-hl-out polyline { stroke: #2563eb; }
  [data-architecture-plantuml] .arch-hl-in .uml-arrow,
  [data-architecture-plantuml] .arch-hl-out .uml-arrow { fill: #2563eb; stroke: #2563eb; }
  [data-architecture-plantuml] .arch-center rect { fill: #dbeafe; stroke: #1d4ed8; }
  /* A session seed (distance 0) is marked by WEIGHT, not only colour: the frame
     is drawn twice as thick, which survives a greyscale print and colour-blind
     reading. */
  [data-architecture-plantuml] .arch-seed > rect { stroke: #b45309; stroke-width: 3; }
  /* When seeds are half the drawn entities or more the thick frame would mark
     most of the drawing and stop discriminating, so the marker degrades to a
     thin frame plus a small dot. The dot is drawn into the box itself (see
     annotateNodes), so the reading is never colour alone. */
  [data-architecture-plantuml] .arch-seed-light > rect { stroke: #b45309; stroke-width: 1; }
  [data-architecture-plantuml] .arch-seed-light .arch-seed-dot { fill: #b45309; pointer-events: none; }
  /* A hand-pinned entity: its own frame plus the pin glyph annotationNodes
     inserts, so the reading is a shape/symbol and never colour alone. */
  [data-architecture-plantuml] .arch-pinned > rect { stroke: #1d4ed8; stroke-width: 3; }
  [data-architecture-plantuml] .arch-pinned-badge { pointer-events: none; }
  /* Edge relation labels are hidden by default (a dense drawing turns the
     relation stereotypes into a wall of overlapping text); hovering or
     selecting a node reveals the labels of its own edges. The DOM helpers
     hideEdgeLabels/showHighlightedEdgeLabels toggle the SVG display
     presentation attribute on the labels the renderer already drew, so this is
     a visibility toggle, never a re-layout. */
  /* Directory groups are scaffolding, not entities: same dashed, grey frame the
     renderer's own overview stubs use, so a collapsed overview reads as a map. */
  [data-architecture-plantuml] [data-entity-id^="grp::"] rect { fill: #f6f8fa; stroke-dasharray: 5,3; }
  /* At the collapsed LOD levels a package frame whose interior shows nothing
     (no visible entity box, no visible subpackage frame) is background, not
     content: the fill fades and the border halves, so the packages that DO
     carry something keep the reader's attention. The class is toggled with the
     level by applyExplosionLod, never baked into the drawing. */
  [data-architecture-plantuml] .arch-lod-empty-frame > rect { fill-opacity: 0.4; stroke-width: 0.5; }
  /* The inspector's selection: a heavier frame plus the check badge the helper
     appends, so the reading never depends on colour alone. */
  [data-architecture-plantuml] .arch-selected > rect { stroke: #1d4ed8; stroke-width: 2.5; }
  [data-architecture-plantuml] .arch-selected polygon { stroke: #1d4ed8; }
  [data-architecture-plantuml] .arch-selected-check { fill: #1d4ed8; font-weight: 700; }
  /* A selected relation: a bolder line and its type label made visible. */
  [data-architecture-plantuml] .arch-edge-selected path { stroke-width: 2.5; }
  [data-architecture-plantuml] .arch-edge-selected text { display: block; }
  /* The keyboard focus cursor ([ / ] while the canvas is focused). */
  [data-architecture-plantuml] .arch-keyboard-focus > rect { stroke: #1d4ed8; stroke-dasharray: 3,2; }
  /* The invisible hit band laid over each relation. It is a separate path, so
     the renderer's data-edge-* contract is untouched; 12 CSS px on a fine
     pointer, 44 on a coarse one, written by the helper. */
  [data-architecture-plantuml] .arch-edge-hit { fill: none; stroke: transparent; pointer-events: stroke; }
  [data-architecture-plantuml] svg { display: block; margin: 0 auto; }
`;

/**
 * The drawing is something to LOOK AT and OPERATE, not text to copy (copying a
 * diagram goes through the Text page and the export menu). Every element a
 * drag can cross — the scroll host, the injected `svg` and its `text`/`tspan`
 * labels — is declared unselectable, and `-webkit-touch-callout` keeps a phone
 * long-press from opening the select/share bubble over the drawing.
 *
 * The rule and the inline declarations written by `markDrawingUnselectable`
 * say the same thing on purpose: the rule covers every label the renderer adds
 * later, the inline marks are readable without a laid-out browser (the
 * component tests read them), and a browser that ignores the rule on SVG text
 * still honours the inline declaration.
 */
export const CANVAS_UNSELECTABLE_STYLE = `
  [data-architecture-plantuml],
  [data-architecture-plantuml] svg,
  [data-architecture-plantuml] text,
  [data-architecture-plantuml] tspan {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
`;

/** The fill/stroke palette the semantic renderer draws class boxes with. */
export const SEMANTIC_NODE_STYLE: Record<string, readonly [string, string]> = {
  class: ['#ffffff', '#64748b'],
  interface: ['#e0f2fe', '#0284c7'],
  enum: ['#fef3c7', '#d97706'],
  function: ['#f1f5f9', '#64748b'],
};
/** Nested package fills, pale so the tab text stays readable. */
export const SEMANTIC_PACKAGE_FILLS = ['#f1f5f9', '#e7edf5', '#dde6f1', '#d3deec', '#c9d7e7'];
export const SEMANTIC_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const SEMANTIC_SANS = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif';
/** The accent the design uses for a session-mentioned entity and its ★N badge. */
export const SEMANTIC_SEED_COLOR = '#ea580c';

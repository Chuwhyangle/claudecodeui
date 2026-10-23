// The renderer's literal contract values: the id prefixes PlantUML aliases
// carry, the touch/geometry thresholds, and the cross-panel event names.

/** The alias marker the renderer prefixes on overview group nodes (`grp::<path prefix>`). */
export const GROUP_PREFIX = 'grp::';
/** Stub nodes in a view (external neighbours) are not real entities; clicks ignore them. */
export const STUB_PREFIX = 'stub::';

/**
 * How close two taps on the same node must be to count as the explicit drill
 * gesture. A touch tap cannot double as both "select" and "drill", so the
 * second tap is the user saying "yes, open this one".
 */
export const DOUBLE_TAP_MS = 350;

/** The shared look of the diagram toolbar's buttons. */
export const TOOLBAR_BUTTON_CLASS =
  'rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60';

/** How far one arrow-key press pans a focused canvas, in CSS pixels. */
export const KEYBOARD_PAN_STEP = 40;

/**
 * The cross-panel linkage channel. The SVG is the shared surface: a click on an
 * entity announces it on `window` together with the in/out neighbours read from
 * the neighbourhood JSON, and a sibling panel (the chat, when a file is
 * referenced) can select an entity by its stable `data-entity-id` through the
 * second event. Both names are part of the renderer's documented contract, so a
 * consumer listens for the literal names rather than importing this module.
 */
export const ENTITY_SELECTED_EVENT = 'architecture:entity-selected';
export const ENTITY_HIGHLIGHT_EVENT = 'architecture:highlight-entity';

/** The selection announced to sibling panels: one entity and its JSON neighbours. */
export type EntitySelection = {
  readonly id: string;
  readonly incoming: readonly string[];
  readonly outgoing: readonly string[];
};

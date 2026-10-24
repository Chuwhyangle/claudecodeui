import {
  buildVoiceReferencePack,
  readVoiceInputPackBuildCount,
} from '@/modules/chat';
import type { VoiceReferencePack } from '@/modules/chat';
import type { QuayFocusableObject, QuayObjectUri, QuayViewContract } from '@/shared/types';

/**
 * The in-page semantic surface a scenario driver reads and drives.
 *
 * WHY IT EXISTS. A business scenario (「焦点移到 ② → 钉进托盘 → 说一句话 → 检查输入包」)
 * is 15–20 steps, and MCP-browser driving pays a round trip — often a multi-thousand-token
 * snapshot — for each one. Worse, most of the state a scenario asserts is NOT in the DOM:
 * focus, the visible set, the tray, the input pack, the per-step latency. Reconstructing that
 * from snapshots and screenshots is both slow and unreliable.
 *
 * SO THE TEST SURFACE IS THE PRODUCT SURFACE. `read().focusables` is not a test-id vocabulary
 * maintained beside the wall: a mounted view publishes the very `{uri,label,display}` contract
 * it renders with ({@link publishScenarioViewContract}), so a focusable a person can say 「②」 to
 * and a focusable the scenario can address are the same object by construction — they cannot drift.
 *
 * AND `utter` REACHES THE PRODUCT'S OWN BUILDER. It skips audio, then calls the same
 * `buildVoiceReferencePack` the wall-aware voice path builds with; that builder's text half is
 * `buildVoiceInputContextPack`, the function the real ASR upload calls with a recognised
 * segment's words. The module-level build counter is read around one utterance, so the scenario
 * can assert it walked that seam exactly once rather than hand-assembling a lookalike pack.
 *
 * THE COCKPIT PUBLISHES ONTO ITS OWN ATTRIBUTES. The cockpit page must not import this dev-only
 * module (a production bundle may not carry it), so its reading comes from the `data-cockpit-*`
 * attributes its renderer already draws — the same declaration, read rather than re-derived. See
 * {@link readCockpitReading}.
 *
 * THE GATE IS TWO LOCKS. The import into the page is a build-time constant only
 * (`import.meta.env.DEV` at the call sites in `main.tsx` / `QuayPanel.tsx`, so a production bundle
 * never reaches this module at all), and this module additionally refuses to attach or register
 * unless an operator asked for it at runtime ({@link isScenarioSurfaceRequested}). Both must be on
 * for `window.__cloudcliScenario` to exist.
 */

/** The localStorage key an operator sets to `on` to request the surface in a dev build. */
export const SCENARIO_SWITCH_KEY = 'ui-scenario';

/** The query parameter that requests it too, so one URL can turn it on without touching storage. */
export const SCENARIO_SWITCH_QUERY = 'ui-scenario';

/** One step a scenario can drive. Each carries exactly one action. */
export type ScenarioDriveStep =
  | { focus: string }
  | { move: 'up' | 'down' | 'left' | 'right' }
  | { zoom: 'in' | 'out' }
  | { confirm: true }
  | { cancel: true }
  | { pin: true | string }
  | { utter: string };

/** One focusable's identity, kept beside the contract for assertions that name a label. */
export type ScenarioFocusReading = {
  /** The current focus URI, or `null` when nothing is focused. */
  focus: QuayObjectUri | null;
  /** The current focus's spoken label (`②`, …), or `null`. */
  focusLabel: string | null;
};

/**
 * The input pack `utter` produced, projected for a scenario.
 *
 * The pack itself ({@link VoiceReferencePack}) represents focus as the focusable OBJECT; a
 * scenario names it by URI. Everything else is carried verbatim, and `text` is the builder's
 * output byte for byte — the half the real ASR upload sends.
 */
export type ScenarioInputPack = {
  utterance: string;
  /** The focused object's URI — the identity the next hop resolves content from. */
  focus: QuayObjectUri | null;
  /** The focused object's spoken label, when one is focused. */
  focusLabel: string | null;
  visible: QuayFocusableObject[];
  history: QuayObjectUri[];
  tray: QuayObjectUri[];
  /** `buildVoiceInputContextPack`'s output, byte for byte — the real ASR path's own pack. */
  text: string;
  /**
   * How many times the input-pack seam was built while this utterance ran. Always 1 when the
   * utterance reached the product builder; 0 would mean a lookalike was assembled elsewhere and
   * >1 would mean the utterance paid for more than one pack.
   */
  seamBuilds: number;
};

/** One drive step's latency, recorded so a scenario report can show where time went. */
export type ScenarioStepTiming = {
  /** 1-based index of the drive call on this surface. */
  index: number;
  /** The action name (`focus`, `move`, `pin`, `utter`, …). */
  action: string;
  ms: number;
};

/** One cockpit data-contract reading, taken from the attributes the page already draws. */
export type ScenarioCockpitReading = {
  /** The cockpit stage's view type (`fleet` / `board`), or `null` when the cockpit is not mounted. */
  view: string | null;
  /** The object the cockpit's own status bar names as focused, or `null`. */
  focus: QuayObjectUri | null;
  /** The focused object's spoken label, looked up in the wall's declared objects. */
  focusLabel: string | null;
  /**
   * The objects the cockpit stage declares for the active view, exactly as it drew them.
   *
   * WHY THE DOM AND NOT A PUBLISHED CONTRACT: unlike a mounted Quay panel, the cockpit does not
   * import this dev-only module. Its stage already writes the same declaration onto the grid/rail
   * (`data-cockpit-focusables`) for exactly this reading, so the scenario reads one declaration
   * rather than re-deriving a lookalike from class names. An absent attribute is `[]`, never a
   * fabricated object.
   */
  wallObjects: QuayFocusableObject[];
  /** The last echo sentence the cockpit rendered, or `null` when it shows none. */
  echo: string | null;
};

/** The structured state a scenario reads. Everything here is a READING, never a screenshot. */
export type ScenarioReading = {
  /** `location.pathname` + `location.search` at read time. */
  route: string;
  /** What the cockpit page is showing, or an all-null reading when it is not mounted. */
  cockpit: ScenarioCockpitReading;
  /** The view whose contract is active (the last one published), or `null`. */
  activeView: string | null;
  /** Every view URI that has published a contract, in publication order. */
  views: string[];
  /** The active view's focusable objects, exactly as the view declared them. */
  focusables: QuayFocusableObject[];
  /** The current focus URI, or `null`. */
  focus: QuayObjectUri | null;
  /** The current focus's spoken label, or `null`. */
  focusLabel: string | null;
  /** Objects pinned into the input tray, in pin order. */
  tray: QuayObjectUri[];
  /** Recently focused object URIs, oldest first. */
  history: QuayObjectUri[];
  /** Zoomed-into object URIs, outermost first. Empty when the parent view is showing. */
  zoomStack: QuayObjectUri[];
  /** The last object confirmed with `confirm`, or `null`. */
  lastConfirmed: QuayObjectUri | null;
  /** The pack the last `utter` built, or `null` before any utterance. */
  lastInputPack: ScenarioInputPack | null;
  /** The input-pack seam's own build counter at read time. */
  inputPackSeamBuilds: number;
  /** Per-drive latencies for this page's scenario run. */
  timings: {
    totalMs: number;
    steps: ScenarioStepTiming[];
  };
};

/** The surface installed on `window.__cloudcliScenario`. */
export type ScenarioSurface = {
  read: () => ScenarioReading;
  drive: (step: ScenarioDriveStep) => ScenarioReading;
};

/**
 * `Window` as this module sees it.
 *
 * A local intersection rather than a `declare global { interface Window }` augmentation: the
 * frontend's type-definition rule requires `type` aliases, and a global augmentation cannot be
 * one (a type alias does not merge with lib.dom's `Window`). Readers reach the property through
 * {@link scenarioWindow}, so there is still exactly one declaration of its shape.
 */
export type ScenarioWindow = Window & {
  /** The dev-only semantic surface; absent unless both gate locks are open. */
  __cloudcliScenario?: ScenarioSurface;
};

/** The page's `window`, typed with the dev-only property this module installs. */
export function scenarioWindow(): ScenarioWindow {
  return window as ScenarioWindow;
}

type RegisteredView = {
  uri: string;
  contract: QuayViewContract;
  publishedAt: number;
};

/** Every view contract a mounted view has published in this page. */
const registeredViews = new Map<string, RegisteredView>();
/** Publication order, used to name the active view deterministically. */
let publicationClock = 0;
/** The view whose contract was published most recently. */
let activeViewUri: string | null = null;
/** The one surface attached to this page (attach is idempotent). */
let attachedSurface: ScenarioSurface | null = null;

/**
 * Whether an operator asked for the surface at runtime.
 *
 * The runtime half of the two-lock gate. It is deliberately permissive about HOW it is asked
 * (storage survives navigation; the query parameter turns one URL — a playwright navigation, a
 * share link — into a scenario run without a prior storage write) and strict about the VALUE:
 * only an explicit `on` / `1` opens it, so a stray key can never mount the surface.
 */
export function isScenarioSurfaceRequested(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    if (window.localStorage.getItem(SCENARIO_SWITCH_KEY) === 'on') {
      return true;
    }
  } catch {
    // Storage can be denied (a sandboxed iframe); the query parameter below is still readable.
  }
  try {
    const value = new URLSearchParams(window.location.search).get(SCENARIO_SWITCH_QUERY);
    return value === '1' || value === 'on';
  } catch {
    return false;
  }
}

/**
 * Publishes one mounted view's contract for the scenario surface to read.
 *
 * WHY THE VIEW PUSHES, NOT THE SURFACE PULLS FROM THE DOM. The DOM carries the contract as a JSON
 * attribute for the voice pack; re-parsing it here would make a second reading of the same
 * declaration. A view that renders focusable children calls this with the SAME object it draws,
 * so the scenario and the renderer read one declaration. A no-op when the runtime lock is closed,
 * which is why a dev build can leave the call site in place unconditionally.
 */
export function publishScenarioViewContract(viewUri: string, contract: QuayViewContract): void {
  if (!isScenarioSurfaceRequested()) {
    return;
  }
  publicationClock += 1;
  registeredViews.set(viewUri, {
    uri: viewUri,
    contract: { focusables: cloneFocusables(contract.focusables) },
    publishedAt: publicationClock,
  });
  activeViewUri = viewUri;
}

/** Drops every registered contract. Exposed for tests and for a full page teardown. */
export function clearScenarioRegistry(): void {
  registeredViews.clear();
  activeViewUri = null;
  publicationClock = 0;
}

/** Deep-copies the focusable triples so a caller cannot mutate the view's own declaration. */
function cloneFocusables(focusables: readonly QuayFocusableObject[]): QuayFocusableObject[] {
  return focusables.map((object) => ({
    uri: object.uri,
    label: object.label,
    display: {
      status: object.display.status,
      color: object.display.color,
      ordinal: object.display.ordinal,
      pos: { row: object.display.pos.row, column: object.display.pos.column },
    },
  }));
}

/** The active view's focusables, or `[]` when no view has published. */
function activeFocusables(): QuayFocusableObject[] {
  const view = activeViewUri === null ? null : registeredViews.get(activeViewUri) ?? null;
  return view === null ? [] : cloneFocusables(view.contract.focusables);
}

/**
 * Resolves a scenario's focus target against the active contract, accepting either the exact
 * `quay://` URI or the spoken label the view draws (`②`). A bare ordinal (`2`) is accepted too
 * because a report or a JSON scenario often carries the number rather than the glyph — and it
 * names the same object, since `label` is the circled form of `display.ordinal`.
 *
 * Returns `null` for a target the view never declared: a focus the wall cannot address must not
 * be fabricated, or a scenario would "pass" by focusing something no person could reach.
 */
function resolveFocusTarget(
  target: string,
  focusables: readonly QuayFocusableObject[],
): QuayFocusableObject | null {
  const exact = focusables.find((object) => object.uri === target);
  if (exact !== undefined) {
    return exact;
  }
  const byLabel = focusables.find((object) => object.label === target);
  if (byLabel !== undefined) {
    return byLabel;
  }
  if (/^\d+$/.test(target)) {
    const ordinal = Number(target);
    return focusables.find((object) => object.display.ordinal === ordinal) ?? null;
  }
  return null;
}

/** Spatial order: top-to-bottom, then left-to-right, exactly as ordinals are assigned. */
function spatialOrder(focusables: readonly QuayFocusableObject[]): QuayFocusableObject[] {
  return [...focusables].sort(
    (a, b) =>
      a.display.pos.row - b.display.pos.row
      || a.display.pos.column - b.display.pos.column
      || a.display.ordinal - b.display.ordinal,
  );
}

/**
 * The next focus for a directional move, from the ACTIVE VIEW'S OWN SPATIAL ORDER.
 *
 * `up`/`left` step towards the beginning of that order, `down`/`right` towards the end, and a
 * move with no object beyond the current one keeps the focus where it is rather than wrapping:
 * a scenario that asserts 「moving down from the last object stays on it」 is describing a wall
 * where the gesture has nothing to reach, not a carousel.
 */
function moveFocus(
  current: QuayObjectUri | null,
  direction: 'up' | 'down' | 'left' | 'right',
  focusables: readonly QuayFocusableObject[],
): QuayObjectUri | null {
  const ordered = spatialOrder(focusables);
  if (ordered.length === 0) {
    return null;
  }
  const index = current === null ? -1 : ordered.findIndex((object) => object.uri === current);
  if (index === -1) {
    return ordered[0]?.uri ?? null;
  }
  const forward = direction === 'down' || direction === 'right';
  const next = forward ? ordered[index + 1] : ordered[index - 1];
  return next === undefined ? ordered[index]?.uri ?? null : next.uri;
}

/** The reading returned when the cockpit page is not mounted: every field is honestly absent. */
const EMPTY_COCKPIT_READING: ScenarioCockpitReading = {
  view: null,
  focus: null,
  focusLabel: null,
  wallObjects: [],
  echo: null,
};

/** Parses a `data-cockpit-focusables` attribute; anything malformed reads as no declaration. */
function parseWallObjects(raw: string | null): QuayFocusableObject[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QuayFocusableObject[]) : [];
  } catch {
    return [];
  }
}

/**
 * Reads the cockpit's own data-contract attributes.
 *
 * The cockpit deliberately does not import this module (a production bundle must not carry the
 * dev-only surface), so the reading is the attributes the page publishes for its renderer's
 * consumers: the root's `data-cockpit-view`, the stage's `data-cockpit-focusables`, the status
 * bar's `data-cockpit-focus`, and an optional echo node. A page that is not the cockpit answers
 * an all-null reading rather than throwing, which is what lets one scenario step assert the
 * cockpit did unmount after switching back to a session.
 */
function readCockpitReading(): ScenarioCockpitReading {
  if (typeof document === 'undefined') {
    return { ...EMPTY_COCKPIT_READING };
  }
  const page = document.querySelector('[data-testid="cockpit-page"]');
  if (!(page instanceof HTMLElement)) {
    return { ...EMPTY_COCKPIT_READING };
  }
  const stage = document.querySelector('[data-cockpit-focusables]');
  const wallObjects = stage instanceof HTMLElement
    ? parseWallObjects(stage.getAttribute('data-cockpit-focusables'))
    : [];
  const focusNode = document.querySelector('[data-testid="cockpit-focus"]');
  const focusRaw = focusNode instanceof HTMLElement ? focusNode.getAttribute('data-cockpit-focus') : null;
  // The status bar writes the same `quay://` address it read from the view contract; anything
  // else is not an address this surface will claim as a focus.
  const focus = focusRaw !== null && focusRaw.startsWith('quay://')
    ? (focusRaw as QuayObjectUri)
    : null;
  const focused = focus === null ? null : wallObjects.find((object) => object.uri === focus) ?? null;
  const echoNode = document.querySelector('[data-testid="cockpit-echo"]');
  const echoText = echoNode instanceof HTMLElement ? echoNode.textContent?.trim() ?? '' : '';
  return {
    view: page.getAttribute('data-cockpit-view'),
    focus,
    focusLabel: focused?.label ?? null,
    wallObjects,
    echo: echoText === '' ? null : echoText,
  };
}

/** Builds one page-bound surface with its own focus/tray/zoom state. */
function createScenarioSurface(): ScenarioSurface {
  let focus: QuayObjectUri | null = null;
  let tray: QuayObjectUri[] = [];
  let history: QuayObjectUri[] = [];
  let zoomStack: QuayObjectUri[] = [];
  let lastConfirmed: QuayObjectUri | null = null;
  let lastInputPack: ScenarioInputPack | null = null;
  let driveCount = 0;
  const startedAt = nowMs();
  const stepTimings: ScenarioStepTiming[] = [];

  /** Records the focus change and its history entry; `null` clears the focus but adds no history. */
  const setFocus = (uri: QuayObjectUri | null): void => {
    focus = uri;
    if (uri !== null) {
      history = [...history, uri];
    }
  };

  const read = (): ScenarioReading => {
    const focusables = activeFocusables();
    const focused = focus === null ? null : focusables.find((object) => object.uri === focus) ?? null;
    return {
      route: `${window.location.pathname}${window.location.search}`,
      cockpit: readCockpitReading(),
      activeView: activeViewUri,
      views: [...registeredViews.keys()],
      focusables,
      focus,
      focusLabel: focused?.label ?? null,
      tray: [...tray],
      history: [...history],
      zoomStack: [...zoomStack],
      lastConfirmed,
      lastInputPack: lastInputPack === null ? null : cloneInputPack(lastInputPack),
      inputPackSeamBuilds: readVoiceInputPackBuildCount(),
      timings: {
        totalMs: nowMs() - startedAt,
        steps: stepTimings.map((timing) => ({ ...timing })),
      },
    };
  };

  /**
   * Builds the input pack for one utterance through the product's own builder.
   *
   * THE COUNTER IS THE PROOF. `seamBuilds` is the delta of the shared builder's count across this
   * one call; a scenario (and the unit criterion) asserts it is exactly 1, which is what makes
   * 「the same seam」 a reading rather than a claim about which function was called.
   */
  const utter = (text: string): void => {
    const focusables = activeFocusables();
    const before = readVoiceInputPackBuildCount();
    const pack: VoiceReferencePack = buildVoiceReferencePack({
      utterance: text,
      focusables,
      focusUri: focus,
      history,
      tray,
      messages: [],
      draftBefore: '',
      draftAfter: '',
      voiceSoFar: '',
    });
    lastInputPack = {
      utterance: pack.utterance,
      focus: pack.focus?.uri ?? null,
      focusLabel: pack.focus?.label ?? null,
      visible: pack.visible,
      history: [...pack.history],
      tray: [...pack.tray],
      text: pack.text,
      seamBuilds: readVoiceInputPackBuildCount() - before,
    };
  };

  const drive = (step: ScenarioDriveStep): ScenarioReading => {
    driveCount += 1;
    const started = nowMs();
    let action = 'unknown';

    if ('focus' in step) {
      action = 'focus';
      const target = resolveFocusTarget(step.focus, activeFocusables());
      setFocus(target?.uri ?? null);
    } else if ('move' in step) {
      action = 'move';
      setFocus(moveFocus(focus, step.move, activeFocusables()));
    } else if ('zoom' in step) {
      action = 'zoom';
      if (step.zoom === 'in') {
        // A view contract published by a zoomed-into object does not exist yet (the wall's zoom
        // navigation is later work); the stack records the intent so a scenario can read that it
        // happened, and `read().focusables` keeps reporting the active view's own contract.
        if (focus !== null) {
          zoomStack = [...zoomStack, focus];
        }
      } else {
        zoomStack = zoomStack.slice(0, -1);
      }
    } else if ('confirm' in step) {
      action = 'confirm';
      lastConfirmed = focus;
    } else if ('cancel' in step) {
      action = 'cancel';
      setFocus(null);
      zoomStack = [];
    } else if ('pin' in step) {
      action = 'pin';
      const target = step.pin === true ? focus : step.pin;
      if (target !== null && !tray.includes(target as QuayObjectUri)) {
        tray = [...tray, target as QuayObjectUri];
      }
    } else if ('utter' in step) {
      action = 'utter';
      utter(step.utter);
    }

    stepTimings.push({ index: driveCount, action, ms: nowMs() - started });
    return read();
  };

  return { read, drive };
}

/** The monotonic-ish clock a timing reading uses; `performance.now` when the page has one. */
function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** Copies an input-pack reading so a caller cannot mutate the surface's recorded one. */
function cloneInputPack(pack: ScenarioInputPack): ScenarioInputPack {
  return {
    ...pack,
    visible: cloneFocusables(pack.visible),
    history: [...pack.history],
    tray: [...pack.tray],
  };
}

/**
 * Installs the surface on `window.__cloudcliScenario`, if and only if the runtime lock is open.
 *
 * Idempotent: a second call returns the surface already attached, so the app entry point and any
 * later boot path cannot end up with two surfaces whose focus state disagrees. The return value
 * is the reading a caller needs — `false` means the lock was closed and nothing was installed.
 */
export function attachScenarioSurface(): boolean {
  if (typeof window === 'undefined' || !isScenarioSurfaceRequested()) {
    return false;
  }
  if (attachedSurface === null) {
    attachedSurface = createScenarioSurface();
    scenarioWindow().__cloudcliScenario = attachedSurface;
  }
  return true;
}

/** Removes the surface and its state. Exposed for tests and for a page teardown. */
export function detachScenarioSurface(): void {
  if (typeof window !== 'undefined') {
    delete scenarioWindow().__cloudcliScenario;
  }
  attachedSurface = null;
  registeredViews.clear();
  activeViewUri = null;
  publicationClock = 0;
}

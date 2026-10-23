/**
 * The cockpit's state transitions, as one pure function.
 *
 * WHY PURE AND SERVER-SIDE. The cockpit is driven from more than one device: a display shows
 * the stage, an input device (a phone, later a desktop background process) sends direction
 * keys and phrases. If the focus/view/tray state lived in the page, two devices could not
 * share it and a reconnect would lose it. So the state is a value, every change is a
 * serializable event, and {@link reduceCockpit} is the only place a change happens.
 *
 * PURITY IS A CONTRACT, NOT A HABIT. The reducer never reads the DOM, never reads the clock,
 * never performs I/O and never mutates its arguments: the same `(state, event)` pair always
 * produces the same next state. Everything that needs the outside world (resolving a target
 * conversation) is resolved by the hub and carried as a field on the event. That is what makes
 * this module testable without a socket and replayable from a log.
 *
 * EVENTS THAT NEED THE DISPLAY. `move` snaps over the focusable objects the DISPLAY last
 * reported (`visible`), by their grid position — the server has no DOM to measure, and the
 * device holding the microphone may be looking at a different page than the one displaying.
 */

// --------------------------- STATE ------------

/** The two roles a cockpit connection can announce. */
export type CockpitRole = 'display' | 'input';

/**
 * Which device produced an event, and in which role.
 *
 * `deviceName` is what the status bar echoes (「来自手机」); it is the name the browser
 * announced in its hello, not a server-invented label.
 */
export type CockpitEventSource = {
  deviceId: string;
  deviceName?: string;
  role: CockpitRole;
};

/** The stage's serializable view description. The project segment is the fleet registry id. */
export type CockpitView = { type: 'fleet' } | { type: 'board'; project: string };

/** One focusable object exactly as the display reported it. */
export type CockpitFocusable = {
  uri: string;
  label: string;
  display: {
    status: string;
    color: string;
    ordinal: number;
    pos: { row: number; column: number };
  };
};

/** The display's report of what it is showing: the view address and its declared objects. */
export type CockpitVisibleSet = {
  viewUri: string | null;
  focusables: CockpitFocusable[];
  /**
   * The project roster the display can address, so the hub can map a `quay://` project
   * segment back to the CloudCLI project id the fleet registry is keyed by. Optional: a
   * report without it still contributes focusables; target resolution then fails honestly.
   */
  projects: CockpitVisibleProject[];
};

/** One project the display can name, with both identities the target rules need. */
export type CockpitVisibleProject = {
  projectId: string;
  fleetProjectId: string | null;
  name: string;
  projectPath: string;
};

/** The conversation an unmatched phrase would be sent to, and why that conversation. */
export type CockpitSendTarget = {
  sessionId: string;
  projectId: string | null;
  projectName: string | null;
  sessionTitle: string | null;
  /** `pinned` = the fleet registry's per-project field; `recent` = the last-opened fallback. */
  source: 'pinned' | 'recent';
  fleetUnavailableReason: string | null;
};

/**
 * The confirmation card's state: what would be sent, to whom, and whether a target exists.
 *
 * `visible` is the DISPLAY's last reported set (never the input device's), so the references
 * that ride along describe what the person is looking at. `target === null` means nothing
 * will be sent; `reason` says whether the phrase had no focused project (`no-focus`) or the
 * project has no target conversation (`no-session`).
 */
export type CockpitPendingSend = {
  text: string;
  visible: CockpitFocusable[];
  viewUri: string | null;
  focusUri: string | null;
  target: CockpitSendTarget | null;
  reason: 'no-focus' | 'no-session' | null;
};

/** Everything the cockpit knows, as one serializable value. */
export type CockpitState = {
  /** Increments on every applied event; two devices compare it to tell whose state is newer. */
  rev: number;
  view: CockpitView;
  /** The views left behind by zoom-in / set-view, newest last. `back` pops it. */
  viewStack: CockpitView[];
  focusUri: string | null;
  /** The input tray's pinned references, newest last. */
  tray: string[];
  /** Recently focused references, oldest first, bounded by {@link COCKPIT_HISTORY_LIMIT}. */
  history: string[];
  visible: CockpitVisibleSet;
  pendingSend: CockpitPendingSend | null;
  lastEventSource: CockpitEventSource | null;
};

/** The oldest history entries fall off beyond this bound. */
export const COCKPIT_HISTORY_LIMIT = 20;

// --------------------------- EVENTS ------------

/** A direction key, in the same vocabulary the stage's keyboard handler produces. */
export type CockpitDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Every event the hub accepts. Each carries its `source`; the hub overwrites it with the
 * connection's own identity, so a client cannot claim to be another device.
 *
 * `utterance` may carry a `target`/`reason` that the hub resolved before reducing — the
 * reducer itself never performs the lookup. `pinTarget` carries no payload because the write
 * to the fleet registry is the page's REST call; the event only records that it succeeded.
 */
export type CockpitEvent =
  | { type: 'move'; direction: CockpitDirection; source: CockpitEventSource }
  | { type: 'zoom'; direction: 'in' | 'out'; source: CockpitEventSource }
  | { type: 'back'; source: CockpitEventSource }
  | { type: 'focus'; uri: string; source: CockpitEventSource }
  | { type: 'pin'; source: CockpitEventSource }
  | { type: 'unpin'; uri: string; source: CockpitEventSource }
  | { type: 'setView'; view: CockpitView; source: CockpitEventSource }
  | {
      type: 'utterance';
      text: string;
      source: CockpitEventSource;
      target?: CockpitSendTarget | null;
      reason?: CockpitPendingSend['reason'];
    }
  | { type: 'confirm'; source: CockpitEventSource }
  | { type: 'cancel'; source: CockpitEventSource }
  | { type: 'pinTarget'; source: CockpitEventSource }
  | {
      type: 'visible';
      viewUri: string | null;
      focusables: CockpitFocusable[];
      projects?: CockpitVisibleProject[];
      source: CockpitEventSource;
    };

// --------------------------- UTTERANCE GRAMMAR ------------

/** What one phrase asks for, before any target conversation is considered. */
export type CockpitUtteranceIntent =
  | { kind: 'view'; view: CockpitView }
  | { kind: 'back' }
  | { kind: 'zoom-in' }
  | { kind: 'focus'; uri: string }
  | { kind: 'unmatched' };

/** 「返回」 — reachable without Escape, which aborts a running session turn elsewhere. */
const BACK_PATTERN = /(返回|回去|上一(个|页)?视图|后退|\bback\b)/;
/** 「全部项目」 — `^fleet$` rather than `\bfleet\b`, so `quay-fleet` does not match. */
const ALL_PROJECTS_PATTERN = /(全部项目|所有项目|全部|项目总览|整个舰队|\ball projects\b|^fleet$)/;
/** 「放大」 — Enter's semantic twin. */
const ZOOM_PATTERN = /(放大|进入|\bzoom\b|\benter\b)/;
/** The verbs that make "看 <project>" a view request rather than chatter. */
const VIEW_VERB_PATTERN = /(看|打开|显示|切到|去|\bview\b|\bopen\b|\bshow\b|\bgo to\b)/;
/** The noun that makes "<project> 任务板" a view request even without a verb. */
const BOARD_NOUN_PATTERN = /(任务板|看板|board)/;

/** Circled ordinals ①…⑳, the spoken label a focusable carries. */
const CIRCLED_ORDINALS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/** The `<project>/<type>[/<id>]` halves of one `quay://` address, or null when malformed. */
function parseQuayUri(uri: string | null): { project: string; objectType: string } | null {
  if (uri === null) return null;
  const match = /^quay:\/\/([^/]+)\/([^/]+)(?:\/.*)?$/.exec(uri);
  return match === null ? null : { project: match[1], objectType: match[2] };
}

/** The ordinal a phrase names (`②`, `第二个`, `2`), or null. */
function readSpokenOrdinal(text: string): number | null {
  const circled = [...text].findIndex((character) => CIRCLED_ORDINALS.includes(character));
  if (circled >= 0) return circled + 1;
  const match = /第\s*(\d+)\s*(个|项)?/.exec(text) ?? /^(\d+)$/.exec(text.trim());
  if (match === null) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Classifies one phrase against the current visible set.
 *
 * ORDER IS LOAD-BEARING: the whole-view commands come first (「全部项目」 would otherwise be
 * read as a project named 全部), the project-name match next, and the referent resolver last
 * because it only claims phrases naming a display attribute. An unmatched phrase is NOT an
 * error: it becomes speech addressed to the focused project (see {@link reduceCockpit}).
 */
export function classifyCockpitUtterance(state: CockpitState, text: string): CockpitUtteranceIntent {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'unmatched' };
  const normalized = trimmed.toLowerCase();

  if (BACK_PATTERN.test(normalized)) return { kind: 'back' };
  if (ALL_PROJECTS_PATTERN.test(normalized)) return { kind: 'view', view: { type: 'fleet' } };
  if (ZOOM_PATTERN.test(normalized)) return { kind: 'zoom-in' };

  // Project names are not carried in the state; the visible set's board addresses are. The
  // fleet registry id inside `quay://<id>/board` is the same segment a person says, so a
  // longest-match over those segments is the server-side equivalent of the display parser.
  if (VIEW_VERB_PATTERN.test(normalized) || BOARD_NOUN_PATTERN.test(normalized)) {
    const candidates = state.visible.focusables
      .map((object) => parseQuayUri(object.uri))
      .filter((parsed): parsed is { project: string; objectType: string } => parsed?.objectType === 'board')
      .map((parsed) => parsed.project)
      .filter((project) => project !== '' && normalized.includes(project.toLowerCase()))
      .sort((left, right) => right.length - left.length);
    if (candidates.length > 0) {
      return { kind: 'view', view: { type: 'board', project: candidates[0] } };
    }
  }

  const ordinal = readSpokenOrdinal(trimmed);
  if (ordinal !== null) {
    const ordered = orderFocusables(state.visible.focusables);
    const object = ordered.find((candidate) => candidate.display.ordinal === ordinal);
    if (object !== undefined) return { kind: 'focus', uri: object.uri };
  }

  return { kind: 'unmatched' };
}

// --------------------------- PURE HELPERS ------------

/** The initial state: the fleet view, nothing focused, nothing waiting to be sent. */
export function createCockpitState(): CockpitState {
  return {
    rev: 0,
    view: { type: 'fleet' },
    viewStack: [],
    focusUri: null,
    tray: [],
    history: [],
    visible: { viewUri: null, focusables: [], projects: [] },
    pendingSend: null,
    lastEventSource: null,
  };
}

/** Spatial (reading) order: top-left first, then row by row, column by column. */
function orderFocusables(objects: readonly CockpitFocusable[]): CockpitFocusable[] {
  return [...objects].sort(
    (left, right) =>
      left.display.pos.row - right.display.pos.row ||
      left.display.pos.column - right.display.pos.column,
  );
}

/**
 * The next object in one direction, or null at the edge.
 *
 * The space is the grid the DISPLAY reported: `row` is the vertical axis and `column` the
 * horizontal one. The axes are independent, which is the whole point — a grid is not a linear
 * list. `right`/`left` move to the adjacent cell IN THE SAME ROW; `down`/`up` move to the
 * adjacent ROW (the nearest one that exists, so a missing row does not trap focus) and land on
 * the cell whose column is closest to the current one. A last row that is not full therefore
 * takes the nearest remaining column instead of jumping to the leftmost cell, which is what a
 * person looking at the grid expects.
 *
 * Moving past the last row/column stays put (returns null) rather than wrapping.
 */
function nextInDirection(
  current: CockpitFocusable,
  direction: CockpitDirection,
  objects: readonly CockpitFocusable[],
): CockpitFocusable | null {
  const { row, column } = current.display.pos;

  /** The object in `row` whose column is closest to `column`; ties go to the lower column. */
  const nearestColumnIn = (candidates: readonly CockpitFocusable[]): CockpitFocusable | null => {
    let best: CockpitFocusable | null = null;
    for (const candidate of candidates) {
      if (best === null) {
        best = candidate;
        continue;
      }
      const distance = Math.abs(candidate.display.pos.column - column);
      const bestDistance = Math.abs(best.display.pos.column - column);
      if (
        distance < bestDistance ||
        // Deterministic tie-break: the lower column, so two equidistant cells never flip
        // between runs on array order.
        (distance === bestDistance && candidate.display.pos.column < best.display.pos.column)
      ) {
        best = candidate;
      }
    }
    return best;
  };

  switch (direction) {
    case 'down': {
      const lower = objects.filter((object) => object.display.pos.row > row);
      if (lower.length === 0) return null;
      const targetRow = Math.min(...lower.map((object) => object.display.pos.row));
      return nearestColumnIn(lower.filter((object) => object.display.pos.row === targetRow));
    }
    case 'up': {
      const upper = objects.filter((object) => object.display.pos.row < row);
      if (upper.length === 0) return null;
      const targetRow = Math.max(...upper.map((object) => object.display.pos.row));
      return nearestColumnIn(upper.filter((object) => object.display.pos.row === targetRow));
    }
    case 'right':
      return (
        objects
          .filter(
            (object) =>
              object.display.pos.row === row && object.display.pos.column > column,
          )
          .sort((left, right) => left.display.pos.column - right.display.pos.column)[0] ?? null
      );
    case 'left':
      return (
        objects
          .filter(
            (object) =>
              object.display.pos.row === row && object.display.pos.column < column,
          )
          .sort((left, right) => right.display.pos.column - left.display.pos.column)[0] ?? null
      );
  }
}

/** Keeps at most {@link COCKPIT_HISTORY_LIMIT} entries, dropping the oldest. */
function boundedHistory(entries: readonly string[]): string[] {
  return entries.length <= COCKPIT_HISTORY_LIMIT
    ? [...entries]
    : entries.slice(entries.length - COCKPIT_HISTORY_LIMIT);
}

/** Appends `uri` to the history, moving an older occurrence to the end instead of repeating it. */
function rememberFocus(history: readonly string[], uri: string | null): string[] {
  if (uri === null) return [...history];
  return boundedHistory([...history.filter((entry) => entry !== uri), uri]);
}

/**
 * Re-derives `focusUri` against a declared set.
 *
 * Focus is always one of the declared objects or nothing: an address that disappeared (a view
 * switch, a display whose snapshot failed) snaps to the set's first object, which is the same
 * rule the stage shipped with. Nothing here can leave focus outside the page.
 */
function normalizeFocus(focusables: readonly CockpitFocusable[], focusUri: string | null): string | null {
  if (focusUri !== null && focusables.some((object) => object.uri === focusUri)) {
    return focusUri;
  }
  return orderFocusables(focusables)[0]?.uri ?? null;
}

/** A state with its focus/pending fields re-derived after an event changed the declared set. */
function withFocus(state: CockpitState, focusables: readonly CockpitFocusable[]): CockpitState {
  return { ...state, focusUri: normalizeFocus(focusables, state.focusUri) };
}

/** Applies a view change: the old view is stacked and the visible set cleared (the display re-reports). */
function applyView(state: CockpitState, view: CockpitView): CockpitState {
  const changed = view.type !== state.view.type ||
    (view.type === 'board' && state.view.type === 'board' && view.project !== state.view.project);
  if (!changed) return state;
  return {
    ...state,
    view,
    viewStack: [...state.viewStack, state.view],
    // The old view's objects do not describe the new one; the display's next report fills it.
    visible: { viewUri: null, focusables: [], projects: state.visible.projects },
    focusUri: null,
  };
}

/** Pops the view stack; with an empty stack a board view falls back to the fleet. */
function applyBack(state: CockpitState): CockpitState {
  const stack = [...state.viewStack];
  const previous = stack.pop();
  const next = previous ?? (state.view.type === 'board' ? { type: 'fleet' as const } : null);
  if (next === null) return state;
  return {
    ...state,
    view: next,
    viewStack: stack,
    visible: { viewUri: null, focusables: [], projects: state.visible.projects },
    focusUri: null,
  };
}

/** Enter's semantic twin: a board address opens its project; anything else is a stated no-op. */
function applyZoomIn(state: CockpitState): CockpitState {
  const parsed = parseQuayUri(state.focusUri);
  if (parsed === null || parsed.objectType !== 'board') return state;
  return applyView(state, { type: 'board', project: parsed.project });
}

/**
 * The message body a confirmed send carries: the person's words, then the references it was
 * said about — focus first, then the display's visible set, then the tray, de-duplicated.
 *
 * THE URI LIST IS THE POINT. Downstream resolves a reference by dereferencing the address, so
 * a message that named an object without carrying its URI would be unreadable to anyone but a
 * human looking at the stage (「送引用不送内容」).
 */
export function buildCockpitMessageBody(pending: CockpitPendingSend): string {
  const seen = new Set<string>();
  const references: string[] = [];
  const add = (uri: string | null): void => {
    if (uri === null || seen.has(uri)) return;
    seen.add(uri);
    references.push(uri);
  };
  add(pending.focusUri);
  for (const object of pending.visible) add(object.uri);
  const body = pending.text.trim();
  if (references.length === 0) return body;
  return `${body}\n\n引用：\n${references.map((uri) => `- ${uri}`).join('\n')}`;
}

// --------------------------- THE REDUCER ------------

/**
 * Applies one event. The only state transition in the cockpit; see the module comment for the
 * purity contract.
 *
 * `confirm` deliberately does NOT send: sending is the hub's side effect, performed before
 * this function is called so a second `confirm` finds `pendingSend === null` and cannot send
 * twice. The reducer's half is only "the confirmation is closed".
 */
export function reduceCockpit(state: CockpitState, event: CockpitEvent): CockpitState {
  const base: CockpitState = {
    ...state,
    rev: state.rev + 1,
    // A `visible` frame is a REPORT, not something a person did: the status bar's 「来自手机」
    // must name the device that last acted, not the display that keeps re-reporting the stage.
    lastEventSource:
      event.type === 'visible'
        ? state.lastEventSource
        : { ...event.source },
  };

  switch (event.type) {
    case 'visible': {
      // A REPORT, not an instruction: it replaces the declared set and re-derives focus.
      const visible: CockpitVisibleSet = {
        viewUri: event.viewUri,
        focusables: event.focusables.map((object) => ({
          ...object,
          display: { ...object.display, pos: { ...object.display.pos } },
        })),
        projects: (event.projects ?? state.visible.projects).map((project) => ({ ...project })),
      };
      const next = withFocus({ ...base, visible }, visible.focusables);
      return next.focusUri === state.focusUri
        ? next
        : { ...next, history: rememberFocus(base.history, state.focusUri) };
    }

    case 'move': {
      const ordered = orderFocusables(state.visible.focusables);
      if (ordered.length === 0) return base;
      const current =
        ordered.find((object) => object.uri === state.focusUri) ?? ordered[0];
      const next = nextInDirection(current, event.direction, ordered) ?? current;
      if (next.uri === state.focusUri) return base;
      return {
        ...base,
        focusUri: next.uri,
        history: rememberFocus(base.history, state.focusUri),
      };
    }

    case 'focus': {
      if (!state.visible.focusables.some((object) => object.uri === event.uri)) return base;
      if (event.uri === state.focusUri) return base;
      return { ...base, focusUri: event.uri, history: rememberFocus(base.history, state.focusUri) };
    }

    case 'zoom':
      return event.direction === 'in' ? applyZoomIn(base) : applyBack(base);

    case 'back':
      return applyBack(base);

    case 'setView':
      return applyView(base, event.view);

    case 'pin': {
      if (state.focusUri === null || state.tray.includes(state.focusUri)) return base;
      return { ...base, tray: [...base.tray, state.focusUri] };
    }

    case 'unpin':
      return { ...base, tray: base.tray.filter((uri) => uri !== event.uri) };

    case 'utterance': {
      const intent = classifyCockpitUtterance(state, event.text);
      switch (intent.kind) {
        case 'view':
          return applyView(base, intent.view);
        case 'back':
          return applyBack(base);
        case 'zoom-in':
          return applyZoomIn(base);
        case 'focus':
          return { ...base, focusUri: intent.uri, history: rememberFocus(base.history, state.focusUri) };
        case 'unmatched': {
          // The display's set, copied — the input device's own view is irrelevant (and the hub
          // refuses a `visible` frame from an input-only connection).
          const pendingSend: CockpitPendingSend = {
            text: event.text.trim(),
            visible: state.visible.focusables.map((object) => ({
              ...object,
              display: { ...object.display, pos: { ...object.display.pos } },
            })),
            viewUri: state.visible.viewUri,
            focusUri: state.focusUri,
            target: event.target ?? null,
            reason: event.reason ?? (state.focusUri === null ? 'no-focus' : 'no-session'),
          };
          return { ...base, pendingSend };
        }
      }
    }

    case 'confirm':
      return state.pendingSend === null ? base : { ...base, pendingSend: null };

    case 'cancel':
      return state.pendingSend === null ? base : { ...base, pendingSend: null };

    case 'pinTarget': {
      if (state.pendingSend?.target == null) return base;
      return {
        ...base,
        pendingSend: {
          ...state.pendingSend,
          target: {
            ...state.pendingSend.target,
            source: 'pinned',
            fleetUnavailableReason: null,
          },
        },
      };
    }
  }
}

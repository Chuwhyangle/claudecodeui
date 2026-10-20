/**
 * The PURE execution surface of the unified scenario runner.
 *
 * THE CLAIM. The transcript's reduction — a busy send that must not vanish, a
 * queued command's residue, the idempotence of repeated or reordered events, and
 * the order-stability of a refresh merged with live rows — is ONE property set
 * that must hold for the SAME timeline whatever surface drives it. This file is
 * the pure half: it replays the committed timeline (imported, never copied, from
 * {@link SESSION_LIFECYCLE_TIMELINE}) through the store's OWN exported pure
 * transitions, so a failure here is a statement about the production reduction
 * rather than about a second implementation of it.
 *
 * WHY PROPERTIES, NOT A CASE PER SHAPE. The four families each carry one
 * invariant and one falsifying "broken transition": the assertion is run twice,
 * once through the real transitions (must hold) and once through a deliberately
 * broken one (must throw). A family that no longer pins anything — because the
 * invariant went vacuous, or the broken transition stopped breaking it — fails
 * on the second run. This is the property-testing mandate the streaming
 * architecture proposal asks for in place of enumerating shapes.
 *
 * WHERE THE OTHER SURFACE IS. The browser half of the runner is
 * `gap-scenario-runner-playwright-executor-same-timeline`, which imports this
 * same module path from an e2e spec. §AC1's "two execution surfaces" is therefore
 * one surface delivered here and one delivered there; what is asserted here is
 * the property both depend on — the timeline is defined exactly once and every
 * reference to it goes through this module's path, never a copy.
 *
 * Run: npx vitest run src/modules/chat/hooks/tests/sessionLifecycleScenario.test.tsx
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import {
  applyCommandLifecycleToRows,
  mergeSessionRows,
  residentPendingRow,
} from '@/modules/chat/hooks/useSessionStore';
import { voiceTranscriptRows } from '@/modules/chat/voice-realtime/placeCaptions';
import type { VoiceRealtimeCaption, VoiceRealtimeDelivery } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';
import { isLiveRowId } from '@/modules/chat/utils/transcript/liveRowIdentity';
import {
  SESSION_LIFECYCLE_TIMELINE,
  SESSION_LIFECYCLE_TIMELINE_ID,
} from '@/shared/scenarios/sessionLifecycle.timeline';
import type {
  SessionLifecycleFamily,
  SessionLifecycleFamilyId,
  TimelineDelivery,
  TimelineEvent,
  TimelineRow,
  TimelineUtterance,
} from '@/shared/scenarios/sessionLifecycle.timeline';
import type { ChatMessage, CommandLifecycleState, NormalizedMessage } from '@/shared/types';

// ── The store's pure transitions, and the harness that runs them ─────────────

/**
 * The three reductions a family's events exercise. Production passes these; a
 * family's falsifying test passes one broken.
 */
type Transitions = {
  addPending(realtime: readonly NormalizedMessage[], row: TimelineRow): NormalizedMessage[];
  applyLifecycle(
    realtime: readonly NormalizedMessage[],
    event: { commandUuid: string; state: CommandLifecycleState },
  ): NormalizedMessage[];
  merge(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[];
  refresh(rows: NormalizedMessage[], state: ScenarioState): ScenarioState;
};

const REAL: Transitions = {
  addPending: (realtime, row) => [
    ...realtime,
    residentPendingRow(row.sessionId, row.content ?? '', row.timestamp),
  ],
  applyLifecycle: (realtime, event) => applyCommandLifecycleToRows(realtime, event),
  merge: (server, realtime) => mergeSessionRows(server, realtime),
  refresh: (rows, state) => ({ ...state, server: rows }),
};

type ScenarioState = {
  server: NormalizedMessage[];
  realtime: NormalizedMessage[];
  utterances: TimelineUtterance[];
  deliveries: TimelineDelivery[];
  visible: TimelineRow[];
};

const toNormalized = (row: TimelineRow): NormalizedMessage => ({
  id: row.id,
  sessionId: row.sessionId,
  timestamp: row.timestamp,
  provider: row.provider,
  kind: row.kind,
  role: row.role,
  content: row.content,
  commandUuid: row.commandUuid,
  commandState: row.commandState,
} as NormalizedMessage);

const initialState = (family: SessionLifecycleFamily): ScenarioState => ({
  server: family.server.map(toNormalized),
  realtime: family.realtime.map(toNormalized),
  utterances: [...family.utterances],
  deliveries: [...family.deliveries],
  visible: [...family.visible],
});

const step = (state: ScenarioState, event: TimelineEvent, t: Transitions): ScenarioState => {
  switch (event.kind) {
    case 'load-history':
    case 'refresh-history':
      return t.refresh(event.rows.map(toNormalized), state);
    case 'send-busy':
      return { ...state, realtime: t.addPending(state.realtime, event.row) };
    case 'command-lifecycle':
      return {
        ...state,
        realtime: t.applyLifecycle(state.realtime, {
          commandUuid: event.commandUuid,
          state: event.state,
        }),
      };
    case 'append-realtime':
      return { ...state, realtime: [...state.realtime, toNormalized(event.row)] };
    case 'voice-utterance':
      return { ...state, utterances: [...state.utterances, event.utterance] };
    case 'voice-delivery':
      return { ...state, deliveries: [...state.deliveries, event.delivery] };
    case 'voice-visible-turn':
      return { ...state, visible: [...state.visible, event.row] };
  }
};

/** Folds a family, keeping every intermediate state so a violation is locatable. */
const run = (family: SessionLifecycleFamily, t: Transitions): ScenarioState[] => {
  const states = [initialState(family)];
  for (const event of family.events) {
    states.push(step(states[states.length - 1]!, event, t));
  }
  return states;
};

const family = (id: SessionLifecycleFamilyId): SessionLifecycleFamily => {
  const found = SESSION_LIFECYCLE_TIMELINE.families.find((f) => f.id === id);
  assert.ok(found, `the timeline must declare family ${id}`);
  return found;
};

const liveLifecycleRows = (rows: readonly NormalizedMessage[]): NormalizedMessage[] =>
  rows.filter((row) => row.kind === 'command_lifecycle' && isLiveRowId(row.id));

/**
 * A row sequence's identity+content, the shape equality is read on. A live row's
 * id carries this client's per-mint sequence, which two independently built arms
 * cannot share, so it is normalised to a stable token — the row still counts, its
 * volatile suffix does not.
 */
const stableId = (row: NormalizedMessage): string =>
  isLiveRowId(row.id) ? 'live:pending' : row.id;

const signature = (rows: readonly NormalizedMessage[]): string[] =>
  rows.map((row) => `${stableId(row)}|${row.kind}|${row.content ?? ''}|${row.commandState ?? ''}`);

const toCaption = (utterance: TimelineUtterance): VoiceRealtimeCaption => ({
  itemId: utterance.itemId,
  text: utterance.text,
  final: true,
  at: utterance.at,
  seq: utterance.seq ?? null,
});

const toDelivery = (delivery: TimelineDelivery): VoiceRealtimeDelivery => ({
  message: delivery.message,
  at: delivery.at,
  heard: [...delivery.heard],
  itemIds: [...delivery.itemIds],
  queuedMessageUuid: delivery.queuedMessageUuid ?? null,
});

const toChatMessage = (row: TimelineRow): ChatMessage => ({
  type: row.role === 'user' ? 'user' : 'assistant',
  content: row.content,
  timestamp: row.timestamp,
  id: row.id,
});

// ── §AC1 — one artifact, imported and not copied ─────────────────────────────

const TIMELINE_MODULE_BASENAME = 'sessionLifecycle.timeline';
const TIMELINE_MODULE_SUFFIX = `shared/scenarios/${TIMELINE_MODULE_BASENAME}`;

type Source = { path: string; text: string };

const listSources = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
};

/** Every file under the given roots that re-DEFINES the timeline. */
const timelineDefinitions = (sources: Source[]): string[] =>
  sources
    .filter((source) => /(?:const|let|var)\s+SESSION_LIFECYCLE_TIMELINE\b/.test(source.text))
    .map((source) => source.path);

/** Every file that imports the timeline, with the specifier it imported it by. */
const timelineImports = (sources: Source[]): { path: string; specifier: string }[] => {
  const pattern = new RegExp(`from\\s+['"]([^'"]*${TIMELINE_MODULE_BASENAME})['"]`);
  return sources.flatMap((source) => {
    const match = source.text.match(pattern);
    return match ? [{ path: source.path, specifier: match[1]! }] : [];
  });
};

/** Files holding the artifact's unique id literal — a second copy would repeat it. */
const timelineIdCopies = (sources: Source[]): string[] =>
  sources
    .filter((source) => source.text.includes(`'${SESSION_LIFECYCLE_TIMELINE_ID}'`))
    .map((source) => source.path);

describe('§AC1 the timeline is one module, imported and never copied', () => {
  // Vitest's root is the workspace it was launched in (the banner above names
  // it), so the scan is anchored there rather than on `import.meta.url`, which
  // Vite rewrites to a dev-server URL that is not a filesystem path.
  const root = process.cwd();
  const sources: Source[] = [...listSources(join(root, 'src')), ...listSources(join(root, 'e2e'))]
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('defines the timeline exactly once, at the declared path', () => {
    const definitions = timelineDefinitions(sources);
    assert.equal(definitions.length, 1, 'the timeline must have exactly one definition');
    assert.ok(
      definitions[0]!.includes(TIMELINE_MODULE_SUFFIX),
      `the one definition must be the shared artifact, got ${definitions[0]}`,
    );
  });

  it('carries the artifact id in exactly one file', () => {
    const copies = timelineIdCopies(sources);
    assert.equal(copies.length, 1, `the id literal must appear once, found in ${copies.join(', ')}`);
  });

  it('resolves every import to the shared artifact, not a private copy', () => {
    const imports = timelineImports(sources);
    assert.ok(
      imports.some((entry) => entry.path.endsWith('sessionLifecycleScenario.test.tsx')),
      'the pure execution surface must import the timeline',
    );
    // Each surface reaches the artifact by its own idiom (`@/shared/...` in the
    // app, a relative path from the e2e tree), but every one of them must end at
    // the same `shared/scenarios/sessionLifecycle.timeline` module — an import of
    // any other file is a private copy under another name.
    for (const entry of imports) {
      assert.ok(
        entry.specifier.endsWith(TIMELINE_MODULE_SUFFIX),
        `every surface must import the shared artifact, saw ${entry.specifier}`,
      );
    }
  });

  it('reds when the timeline is copied into a second file (the false form)', () => {
    // The marker is assembled at runtime so THIS file's own source does not read
    // as a second definition to the scanner above.
    const copySource = `export const ${['SESSION_LIFECYCLE', 'TIMELINE'].join('_')} = { id: '${SESSION_LIFECYCLE_TIMELINE_ID}' };`;
    const copied: Source[] = [
      ...sources,
      { path: join(root, 'e2e', 'copied.timeline.spec.ts'), text: copySource },
    ];
    assert.equal(timelineDefinitions(copied).length, 2, 'a copy is a second definition');
    assert.equal(timelineIdCopies(copied).length, 2, 'a copy repeats the id literal');
  });
});

// ── §AC3 — family ①: a busy send survives `started` ──────────────────────────

/**
 * The row must still carry the user's text after `started`, because `started`
 * says the process dequeued the command, not that the turn's rows are visible.
 */
const assertBusySendSurvivesStarted = (t: Transitions): void => {
  const states = run(family('busy-send'), t);
  const last = states[states.length - 1]!;
  const merged = t.merge(last.server, last.realtime);
  const pending = merged.find((row) => row.kind === 'command_lifecycle');
  assert.ok(pending, 'the pending row must still be in the transcript');
  assert.equal(
    pending!.content,
    'ship it while the answer is still streaming',
    'the message text must survive started',
  );
  assert.equal(pending!.commandState, 'started');
};

describe('§AC3 family ① — a busy send survives command_lifecycle:started', () => {
  it('keeps the text through the real transitions', () => {
    assertBusySendSurvivesStarted(REAL);
  });

  it('reds when started blanks the text (the false form)', () => {
    const blanksOnStarted: Transitions = {
      ...REAL,
      applyLifecycle: (realtime, event) =>
        event.state === 'started'
          ? realtime.map((row) =>
              liveLifecycleRows([row]).length === 1 ? { ...row, content: '' } : row,
            )
          : REAL.applyLifecycle(realtime, event),
    };
    assert.throws(() => assertBusySendSurvivesStarted(blanksOnStarted));
  });
});

// ── §AC4 — family ②: queued → running → completed leaves no residue ──────────

/**
 * The voice side's residue read: the rows the pane puts on screen OF ITS OWN for the utterances.
 *
 * The pane's row algebra (`voiceTranscriptRows`) carries the real transcript rows plus the honest
 * state rows, so the utterances' own contribution is what is left once the visible rows are
 * subtracted. Since `gap-live-voice-remove-transcript-caption-rows` a spoken utterance is never a
 * row of the client's own: the pane adds one only for a segment the transcript cannot account for,
 * and this family delivers its utterance and shows its turn, so the reading must be empty.
 */
const paneOwnVoiceRows = (
  utterances: readonly TimelineUtterance[],
  deliveries: readonly TimelineDelivery[],
  visible: readonly TimelineRow[],
) =>
  voiceTranscriptRows({
    captions: utterances.map(toCaption),
    deliveries: deliveries.map(toDelivery),
    visibleMessages: visible.map(toChatMessage),
  }).filter((row) => !visible.some((candidate) => candidate.id === row.id));

/**
 * A reader of the pane's own voice rows. Only its LENGTH is read (the residue this family is about),
 * so the row shape is left open — the production read returns `ChatMessage[]` and the falsifier below
 * returns its own row shape, and both must satisfy this.
 */
type PaneOwnVoiceRows = (
  utterances: readonly TimelineUtterance[],
  deliveries: readonly TimelineDelivery[],
  visible: readonly TimelineRow[],
) => readonly unknown[];

const assertNoResidue = (
  t: Transitions,
  voicePending: PaneOwnVoiceRows = paneOwnVoiceRows,
): void => {
  const states = run(family('queued-command'), t);
  const last = states[states.length - 1]!;
  const merged = t.merge(last.server, last.realtime);
  assert.equal(
    merged.filter((row) => row.kind === 'command_lifecycle' && isLiveRowId(row.id)).length,
    0,
    'a completed command leaves no command_lifecycle row',
  );

  const pendingVoice = voicePending(last.utterances, last.deliveries, last.visible);
  assert.equal(
    pendingVoice.length,
    0,
    "a delivered utterance leaves no row of the pane's own",
  );
};

describe('§AC4 family ② — queued → running → completed leaves no residue', () => {
  it('clears both the socket row and the voice pending row', () => {
    assertNoResidue(REAL);
  });

  it('reds when completed does not remove the row (the false form)', () => {
    const ignoresCompleted: Transitions = {
      ...REAL,
      applyLifecycle: (realtime, event) =>
        event.state === 'completed' ? [...realtime] : REAL.applyLifecycle(realtime, event),
    };
    assert.throws(() => assertNoResidue(ignoresCompleted));
  });

  it('reds when the voice layer still puts a row of its own on screen for the utterance (the false form)', () => {
    // The row kind this task removed, reintroduced on purpose as the falsifier: one row of the
    // person's own per spoken utterance, keyed `voice-caption-<itemId>` (a production id no longer).
    // A surface that still emitted it would leave the row in the transcript after the command
    // completed — exactly the residue this family's voice half is about. Without this arm the zero
    // above would be vacuous: the pane's algebra returns no such row for ANY input here.
    const keepsUtteranceRows: PaneOwnVoiceRows = (utterances) =>
      utterances.map((utterance) => ({
        id: `voice-caption-${utterance.itemId}`,
        sessionId: 'scenario-session',
        timestamp: new Date(utterance.at).toISOString(),
        provider: 'claude',
        kind: 'text' as const,
        role: 'user' as const,
        content: utterance.text,
      }));
    assert.throws(() => assertNoResidue(REAL, keepsUtteranceRows));
  });
});

// ── §AC5 — family ③: repeated / reordered / late events are idempotent ───────

const assertIdempotent = (t: Transitions): void => {
  const states = run(family('event-ordering'), t);
  for (const state of states) {
    assert.ok(
      liveLifecycleRows(state.realtime).length <= 1,
      'there must never be a second live row for one command',
    );
  }
  const last = states[states.length - 1]!;
  assert.equal(liveLifecycleRows(last.realtime).length, 0, 'completed clears the row outright');
  const repeated = step(last, { kind: 'command-lifecycle', commandUuid: 'cmd-order', state: 'queued' }, t);
  assert.deepEqual(
    signature(repeated.realtime),
    signature(last.realtime),
    'a repeated late event must not change the terminal state',
  );
};

describe('§AC5 family ③ — repeated / reordered / late events are idempotent', () => {
  it('holds through the real transitions', () => {
    assertIdempotent(REAL);
  });

  it('reds when a repeated event appends a second row (the false form)', () => {
    const alwaysAppends: Transitions = {
      ...REAL,
      applyLifecycle: (realtime) => [
        ...realtime,
        residentPendingRow('scenario-session', 'retry the build', '2026-03-01T00:00:02.000Z'),
      ],
    };
    assert.throws(() => assertIdempotent(alwaysAppends));
  });
});

// ── §AC6 — family ④: refresh merged with live rows equals never-refreshed ────

type RefreshEvent = { kind: 'refresh-history'; rows: readonly TimelineRow[] };

const REFRESH_MERGE = family('refresh-merge');
const refreshEvents = REFRESH_MERGE.events.filter(
  (event): event is RefreshEvent => event.kind === 'refresh-history',
);
const LAST_REFRESH_ROWS = refreshEvents[refreshEvents.length - 1]!.rows;

/**
 * The reference the refreshed arm is compared against: a store that had every
 * persisted row from its first load and never refreshed. It receives the SAME
 * send (so the live row is identical) but no refresh events — built through the
 * honest transitions, since it is the reference, not the arm under test.
 */
const neverRefreshedState = (): ScenarioState => {
  const loadEvent = REFRESH_MERGE.events.filter((event) => event.kind === 'send-busy');
  const never: SessionLifecycleFamily = {
    ...REFRESH_MERGE,
    realtime: [],
    server: LAST_REFRESH_ROWS,
    events: [
      ...loadEvent,
      { kind: 'load-history', rows: LAST_REFRESH_ROWS },
    ],
  };
  const states = run(never, REAL);
  return states[states.length - 1]!;
};

const assertRefreshMatchesNeverRefreshed = (t: Transitions): void => {
  const f = family('refresh-merge');
  const states = run(f, t);
  const refreshed = states[states.length - 1]!;
  const neverRefreshed = neverRefreshedState();

  assert.deepEqual(
    signature(t.merge(refreshed.server, refreshed.realtime)),
    signature(t.merge(neverRefreshed.server, neverRefreshed.realtime)),
    'a refresh merged with live rows must equal the same rows never refreshed',
  );

  // A repeated refresh must not duplicate the persisted transcript.
  const ids = refreshed.server.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, 'a repeated refresh must not duplicate rows');
};

describe('§AC6 family ④ — a refresh merged with live rows equals never refreshed', () => {
  it('holds through the real transitions', () => {
    assertRefreshMatchesNeverRefreshed(REAL);
  });

  it('reds when a refresh clears the live rows (the false form)', () => {
    const clearsLiveRows: Transitions = {
      ...REAL,
      refresh: (rows, state) => ({ ...state, server: rows, realtime: [] }),
    };
    assert.throws(() => assertRefreshMatchesNeverRefreshed(clearsLiveRows));
  });

  it('reds when a refresh appends instead of replacing (the false form)', () => {
    const appendsOnRefresh: Transitions = {
      ...REAL,
      refresh: (rows, state) => ({ ...state, server: [...state.server, ...rows] }),
    };
    assert.throws(() => assertRefreshMatchesNeverRefreshed(appendsOnRefresh));
  });
});

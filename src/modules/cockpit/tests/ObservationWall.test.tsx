import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuayFleetSummary, QuaySnapshot } from '@/shared/types';
import { i18n } from '@/modules/i18n';
import CockpitPage from '@/modules/cockpit/CockpitPage';
import type { ObservationWall as ObservationWallData } from '@/modules/cockpit/hooks/useObservationWall';

/**
 * The observation wall: the cockpit's home.
 *
 * WHAT THIS FILE PROVES. The wall's own readings are the product (references: 读数三态 /
 * 每盏绿灯带活性时间 / 只有 attention 与 red 用强调色), so the cases are written against the
 * rendered DOM rather than a component's internals:
 *
 *   - three kinds of tile, four states, a liveness timestamp on each, and `unevaluated` showing
 *     its reason instead of a healthy colour;
 *   - the twelve-tile cap, the folded count, and the 「观察层自身」 tile that never consumes a slot;
 *   - the seen cursor: opening the preview writes it exactly once, 「稍后再看」 does not;
 *   - pin/unpin writes the same route the sidebar does, and an automatic tile carries 「临时」;
 *   - view switches are browser navigations (back returns), the URL carries the fleet id rather
 *     than a stored UUID, and a repeat of the same view adds no history entry;
 *   - the three input echoes, and the two that disappear;
 *   - the status bar is human-only by default and carries the machine handles behind `?debug=1`,
 *     with no READ-ONLY badge and no QR until the remote button is asked for.
 *
 * The observation HTTP surface is the only thing stubbed below `authenticatedFetch`; the page,
 * the wall components, the focus contract and the i18n bundle all run for real.
 */

// ── the fake hub ────────────────────────────────────────────────────────────
// The page renders the hub's broadcast state; this double implements the server-side reducer's
// transitions the wall needs (visible / move / zoom / back / setView / utterance / confirm).

type HubFrame = Record<string, unknown>;
type FakeView = { type: 'fleet' } | { type: 'board'; project: string };
type FakeFocusable = {
  uri: string;
  label: string;
  display: { status: string; color: string; ordinal: number; pos: { row: number; column: number } };
};
type FakeState = {
  rev: number;
  view: FakeView;
  viewStack: FakeView[];
  focusUri: string | null;
  tray: string[];
  history: string[];
  visible: { viewUri: string | null; focusables: FakeFocusable[]; projects: Array<Record<string, unknown>> };
  pendingSend: Record<string, unknown> | null;
  lastEventSource: Record<string, unknown> | null;
};

const hubMock = vi.hoisted(() => {
  const initialState = (): FakeState => ({
    rev: 0,
    view: { type: 'fleet' },
    viewStack: [],
    focusUri: null,
    tray: [],
    history: [],
    visible: { viewUri: null, focusables: [], projects: [] },
    pendingSend: null,
    lastEventSource: null,
  });

  let state: FakeState = initialState();
  let echo = true;
  const listeners = new Set<(event: unknown) => void>();
  const sent: HubFrame[] = [];
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const emit = () => {
    for (const listener of [...listeners]) {
      listener({ kind: 'cockpit.state', state: clone(state) });
    }
  };

  const ordered = (objects: FakeFocusable[]) =>
    [...objects].sort(
      (left, right) =>
        left.display.pos.row - right.display.pos.row ||
        left.display.pos.column - right.display.pos.column,
    );

  const setView = (view: FakeView) => {
    const unchanged =
      view.type === state.view.type &&
      (view.type === 'fleet' ||
        (state.view.type === 'board' && state.view.project === view.project));
    if (unchanged) return;
    state.viewStack.push(state.view);
    state.view = view;
    state.visible = { viewUri: null, focusables: [], projects: state.visible.projects };
    state.focusUri = null;
  };

  const back = () => {
    const previous = state.viewStack.pop() as FakeView | undefined;
    const next = previous ?? (state.view.type === 'board' ? ({ type: 'fleet' } as FakeView) : null);
    if (next === null) return;
    state.view = next;
    state.visible = { viewUri: null, focusables: [], projects: state.visible.projects };
    state.focusUri = null;
  };

  const apply = (event: Record<string, unknown>) => {
    state.rev += 1;
    if (event.type !== 'visible') {
      state.lastEventSource = (event.source as Record<string, unknown> | undefined) ?? null;
    }
    switch (event.type) {
      case 'visible': {
        state.visible = {
          viewUri: (event.viewUri as string | null) ?? null,
          focusables: clone((event.focusables as FakeFocusable[] | undefined) ?? []),
          projects: clone((event.projects as Array<Record<string, unknown>> | undefined) ?? []),
        };
        const next = state.visible.focusables;
        if (state.focusUri === null || !next.some((object) => object.uri === state.focusUri)) {
          state.focusUri = ordered(next)[0]?.uri ?? null;
        }
        return;
      }
      case 'move': {
        const set = ordered(state.visible.focusables);
        if (set.length === 0) return;
        const current = set.findIndex((object) => object.uri === state.focusUri);
        const step = event.direction === 'left' || event.direction === 'up' ? -1 : 1;
        const next = set[Math.max(0, Math.min(set.length - 1, current + step))];
        state.focusUri = next?.uri ?? state.focusUri;
        return;
      }
      case 'focus':
        if (state.visible.focusables.some((object) => object.uri === event.uri)) {
          state.focusUri = event.uri as string;
        }
        return;
      case 'zoom': {
        if (event.direction === 'out') {
          back();
          return;
        }
        const match = /^quay:\/\/([^/]+)\/board/.exec(state.focusUri ?? '');
        if (match !== null) setView({ type: 'board', project: match[1]! });
        return;
      }
      case 'back':
        back();
        return;
      case 'setView':
        setView(event.view as FakeView);
        return;
      case 'utterance': {
        const text = String(event.text ?? '').trim();
        if (/全部项目/.test(text)) {
          setView({ type: 'fleet' });
          return;
        }
        if (/返回/.test(text)) {
          back();
          return;
        }
        state.pendingSend = {
          text,
          visible: clone(state.visible.focusables),
          viewUri: state.visible.viewUri,
          focusUri: state.focusUri,
          target: null,
          reason: state.focusUri === null ? 'no-focus' : 'no-session',
        };
        return;
      }
      case 'confirm':
      case 'cancel':
        state.pendingSend = null;
        return;
      case 'pinTarget':
        return;
      default:
        return;
    }
  };

  const socket = {
    ws: null as unknown,
    isConnected: true,
    sendMessage(frame: HubFrame) {
      sent.push(clone(frame));
      if (!echo) return;
      if (frame.type === 'cockpit.event') apply(frame.event as Record<string, unknown>);
      emit();
    },
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    socket,
    sent,
    reset() {
      state = initialState();
      sent.length = 0;
      listeners.clear();
      echo = true;
    },
    setEcho(value: boolean) {
      echo = value;
    },
    pushState(next: FakeState) {
      state = clone(next);
      emit();
    },
    getState() {
      return clone(state);
    },
  };
});

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocketOptional: () => hubMock.socket,
  useWebSocket: () => hubMock.socket,
}));

// ── the observation HTTP surface ────────────────────────────────────────────

const httpMock = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  quayFleetSummary: vi.fn(),
  quaySnapshot: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: {
    quayFleetSummary: httpMock.quayFleetSummary,
    quaySnapshot: httpMock.quaySnapshot,
    quayInterfaceSession: vi.fn(),
    pinQuayInterfaceSession: vi.fn(),
    clearQuayInterfaceSession: vi.fn(),
  },
  authenticatedFetch: httpMock.authenticatedFetch,
}));

/** The CloudCLI project id an older cockpit URL stored (a UUID). The URL must not keep it. */
const PROJECT_UUID = 'c5a57036-de6c-4f0a-9d3e-123456789abc';

const FLEET: QuayFleetSummary = {
  projects: [
    {
      projectId: PROJECT_UUID,
      fleetProjectId: 'claudecodeui',
      projectPath: '/work/claudecodeui',
      driver: { state: 'running' },
      tasks: { total: 2, todo: 0, ready: 1, needsHuman: 1, done: 0 },
      cached: false,
      error: null,
    },
  ],
  generatedAt: '2026-10-24T00:00:00.000Z',
  ttlPerProjectMs: 30000,
  cached: false,
};

const SNAPSHOT: QuaySnapshot = {
  projectId: PROJECT_UUID,
  projectPath: '/work/claudecodeui',
  fleetProjectId: 'claudecodeui',
  generatedAt: '2026-10-24T00:00:00.000Z',
  cached: false,
  driver: { state: 'running', alive: true, running: true, lastRecordAt: '2026-10-23T23:59:00.000Z' },
  tasks: { total: 1, byStatus: { ready: 1 }, ready: 1, needsHuman: 0, done: 0, recent: [] },
  goals: { total: 0, achieved: 0, breakdown: { byStatus: {}, recent: [] } },
  adrs: { total: 0, recent: [] },
  configIssues: { total: 0, errors: 0 },
  tests: { current: null, recentRounds: [] },
  fanIn: { recent: [] },
  inFlight: [],
  dashboardUrl: null,
  warnings: [],
};

const NOW = Date.now();
const MINUTE = 60_000;

const provenance = { producer: 'session-digest', tier: 'deterministic' as const, evaluatedAt: NOW };

type WallEntry = {
  object: {
    uri: string;
    kind: 'session' | 'project' | 'architecture';
    title: string;
    status: { state: 'ok' | 'attention' | 'red' | 'unevaluated'; reason?: string };
    digest: Record<string, unknown>;
    /** Every observed object declares what its projection drops; always non-empty. */
    blindSpots: string[];
    revision: number;
    updatedAt: number;
    provenance: typeof provenance;
  };
  pinned: boolean;
  seenRevision: number;
  deltaItems: string[];
};

/** Kind-appropriate fixture declarations; the server fills these defaults at write time. */
const BLIND_SPOTS_BY_KIND: Record<WallEntry['object']['kind'], string[]> = {
  session: ['看不见会话是否偏离意图', '看不见未进入 transcript 的副作用'],
  project: ['看不见未登记到 quay-fleet 的项目'],
  architecture: ['看不见运行时依赖与动态 import'],
};

const entry = (
  uri: string,
  kind: WallEntry['object']['kind'],
  title: string,
  state: WallEntry['object']['status']['state'],
  overrides: Partial<WallEntry> & {
    reason?: string;
    digest?: Record<string, unknown>;
    blindSpots?: string[];
    updatedAt?: number;
  } = {},
): WallEntry => ({
  object: {
    uri,
    kind,
    title,
    status: overrides.reason === undefined ? { state } : { state, reason: overrides.reason },
    digest: overrides.digest ?? { summary: `${title} summary` },
    blindSpots: overrides.blindSpots ?? BLIND_SPOTS_BY_KIND[kind],
    revision: 3,
    updatedAt: overrides.updatedAt ?? NOW - 5 * MINUTE,
    provenance,
  },
  pinned: overrides.pinned ?? false,
  seenRevision: overrides.seenRevision ?? 2,
  deltaItems: overrides.deltaItems ?? [],
});

/** Five tiles covering all three kinds and all four states, one pinned and one automatic. */
const WALL: ObservationWallData = {
  entries: [
    entry('cloudcli://session/s1', 'session', 'Fix login', 'attention', {
      pinned: true,
      deltaItems: ['one', 'two'],
      digest: { summary: 'Login fails on refresh', recentTurn: 'The token refresh loop', changes: ['auth.ts'], tests: ['login.spec: pass'] },
    }),
    entry('quay://claudecodeui/board', 'project', 'claudecodeui', 'attention', {
      digest: { summary: '2 tasks ready', layers: { tests: 'green', fanIn: 'idle' } },
    }),
    entry('cloudcli://architecture/p1', 'architecture', 'claudecodeui architecture', 'unevaluated', {
      reason: 'graph not built yet',
      digest: { diffs: ['pkg::auth +2'], sessionId: 's-arch', entityId: 'pkg::auth' },
    }),
    entry('cloudcli://session/s2', 'session', 'Release notes', 'ok', { pinned: true }),
    entry('quay://quay-fleet/board', 'project', 'quay-fleet', 'red', {
      digest: { summary: 'driver crashed' },
    }),
  ],
  collapsedCount: 0,
  producers: [
    {
      producer: 'session-digest',
      state: 'ok' as const,
      stale: false,
      reason: null,
      lastAttemptAt: NOW - MINUTE,
      lastWriteAt: NOW - MINUTE,
      expectedIntervalMs: 15 * MINUTE,
    },
  ],
  self: null,
};

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** The live observation state the fetch mock serves; `watch` and `seen` mutate it. */
let wallState: ObservationWallData = WALL;
const seenCalls: Array<{ uri: string; revision: number }> = [];
const watchCalls: Array<{ method: string; uri: string }> = [];

function resetHttp() {
  wallState = JSON.parse(JSON.stringify(WALL)) as ObservationWallData;
  seenCalls.length = 0;
  watchCalls.length = 0;
  httpMock.authenticatedFetch.mockReset();
  httpMock.quayFleetSummary.mockReset();
  httpMock.quaySnapshot.mockReset();
  httpMock.quayFleetSummary.mockResolvedValue(okResponse(FLEET));
  httpMock.quaySnapshot.mockResolvedValue(okResponse(SNAPSHOT));
  httpMock.authenticatedFetch.mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if (url.endsWith('/api/observation/wall')) return okResponse(wallState);
    if (url.endsWith('/api/observation/seen')) {
      const body = JSON.parse(init?.body ?? '{}') as { uri: string; revision: number };
      seenCalls.push(body);
      return okResponse({ advanced: true });
    }
    if (url.includes('/api/observation/watch/')) {
      const uri = decodeURIComponent(url.slice(url.indexOf('/watch/') + '/watch/'.length));
      const method = init?.method ?? 'GET';
      watchCalls.push({ method, uri });
      const target = wallState.entries.find((candidate) => candidate.object.uri === uri);
      if (target !== undefined) target.pinned = method === 'PUT';
      return okResponse({});
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

/** Counts PUSH navigations, so "a view switch is a history entry" is a reading, not a claim. */
function NavigationProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [pushes, setPushes] = useState(0);
  useEffect(() => {
    if (navigationType === 'PUSH') setPushes((count) => count + 1);
  }, [location.key, navigationType]);
  return (
    <div
      data-testid="navigation-probe"
      data-path={`${location.pathname}${location.search}`}
      data-pushes={pushes}
    />
  );
}

function renderCockpit(path = '/cockpit') {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[path]}>
        <CockpitPage />
        <NavigationProbe />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

const path = () => screen.getByTestId('navigation-probe').getAttribute('data-path') ?? '';
const pushes = () => Number(screen.getByTestId('navigation-probe').getAttribute('data-pushes') ?? '0');
const tileByUri = (uri: string) =>
  document.querySelector(`[data-testid="observation-tile"][data-observation-uri="${uri}"]`) as HTMLElement;

beforeEach(() => {
  hubMock.reset();
  resetHttp();
});

describe('the wall draws every kind and every state honestly', () => {
  it('renders session, project and architecture tiles with all four states and a liveness time', async () => {
    renderCockpit();

    await screen.findByTestId('observation-wall-tiles');
    const tiles = screen.getAllByTestId('observation-tile');
    expect(tiles).toHaveLength(5);

    // Three kinds are present, each on its own tile.
    expect(tiles.map((tile) => tile.getAttribute('data-observation-kind'))).toEqual([
      'session',
      'project',
      'architecture',
      'session',
      'project',
    ]);
    // All four states are represented — including `ok` and `red`, so "three-state" is not a
    // two-colour wall with a green default.
    expect(new Set(tiles.map((tile) => tile.getAttribute('data-observation-state')))).toEqual(
      new Set(['attention', 'ok', 'red', 'unevaluated']),
    );

    // Every tile carries a reading time. A green light with no timestamp is not a reading.
    for (const tile of tiles) {
      const liveness = within(tile).getByTestId('observation-tile-liveness');
      expect(liveness.getAttribute('data-updated-at')).not.toBeNull();
      expect((liveness.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('shows the reason for an unevaluated object instead of a healthy colour', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    const unevaluated = tileByUri('cloudcli://architecture/p1');
    expect(unevaluated.getAttribute('data-observation-state')).toBe('unevaluated');
    expect(within(unevaluated).getByTestId('observation-tile-reason').textContent).toContain(
      'graph not built yet',
    );
    // …and it is not the ok/attention/red treatment.
    expect(unevaluated.className).not.toContain('amber-500');
  });

  it('marks only automatically surfaced tiles as temporary', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    // The attention project is unpinned, so the wall surfaced it for the person.
    const automatic = tileByUri('quay://claudecodeui/board');
    expect(automatic.getAttribute('data-observation-temporary')).toBe('true');
    expect(within(automatic).getByTestId('observation-tile-temporary')).toBeTruthy();

    // The pinned attention session is resident: it is not temporary.
    const pinned = tileByUri('cloudcli://session/s1');
    expect(pinned.getAttribute('data-observation-pinned')).toBe('true');
    expect(pinned.getAttribute('data-observation-temporary')).toBe('false');
  });

  it('folds past twelve tiles and shows the folded count', async () => {
    const entries = Array.from({ length: 13 }, (_, index) =>
      entry(`cloudcli://session/s${index}`, 'session', `Session ${index}`, 'ok'),
    );
    wallState = { ...WALL, entries, collapsedCount: 0 };

    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    expect(screen.getAllByTestId('observation-tile')).toHaveLength(12);
    const collapsed = screen.getByTestId('observation-wall-collapsed');
    expect(collapsed.getAttribute('data-collapsed')).toBe('1');
    expect(collapsed.textContent).toContain('1');
  });
});

describe('the observation layer itself', () => {
  it('puts a 「观察层自身」 tile at the head when a producer is stale, outside the twelve slots', async () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      entry(`cloudcli://session/s${index}`, 'session', `Session ${index}`, 'ok'),
    );
    wallState = {
      ...WALL,
      entries,
      collapsedCount: 2,
      producers: [
        {
          producer: 'session-digest',
          state: 'attention',
          stale: true,
          reason: 'no attempt for 4000000ms (expected every 900000ms)',
          lastAttemptAt: NOW - 40 * MINUTE,
          lastWriteAt: NOW - 40 * MINUTE,
          expectedIntervalMs: 15 * MINUTE,
        },
      ],
    };

    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    const self = screen.getByTestId('observation-self-tile');
    expect(self.getAttribute('data-state')).toBe('attention');
    expect(within(self).getByTestId('observation-self-reason').textContent).toContain(
      'no attempt for 4000000ms',
    );
    expect(within(self).getByTestId('observation-self-last-run').textContent).toContain('40');
    // The twelve-entry cap is unchanged by the notice: it is not an entry and consumes no slot.
    expect(screen.getAllByTestId('observation-tile')).toHaveLength(12);
    expect(screen.getByTestId('observation-wall-collapsed').getAttribute('data-collapsed')).toBe('2');
  });

  it('omits the tile when every producer is ok, and shows the quiet header timestamp', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    expect(screen.queryByTestId('observation-self-tile')).toBeNull();
    expect(screen.getByTestId('cockpit-producers-ok')).toBeTruthy();
  });
});

describe('seen and pins', () => {
  it('writes the seen cursor exactly once when the preview opens, and not on 「稍后再看」', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    const tile = tileByUri('cloudcli://session/s1');
    fireEvent.click(within(tile).getByTestId('observation-tile-open'));

    const preview = await screen.findByTestId('cockpit-observation-preview');
    expect(preview.getAttribute('data-observation-uri')).toBe('cloudcli://session/s1');
    // The latest turn and its changes/tests are on the stage.
    expect(within(preview).getByTestId('observation-preview-recent-turn').textContent).toContain(
      'The token refresh loop',
    );

    await waitFor(() => expect(seenCalls).toHaveLength(1));
    expect(seenCalls[0]).toEqual({ uri: 'cloudcli://session/s1', revision: 3 });

    // 「稍后再看」 closes without moving the cursor.
    fireEvent.click(within(preview).getByTestId('observation-preview-later'));
    await waitFor(() => expect(screen.queryByTestId('cockpit-observation-preview')).toBeNull());
    expect(seenCalls).toHaveLength(1);
  });

  it('pins and unpins through the observation watch route', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    // The unpinned attention tile → PUT.
    fireEvent.click(within(tileByUri('quay://claudecodeui/board')).getByTestId('observation-tile-pin'));
    await waitFor(() => expect(watchCalls).toHaveLength(1));
    expect(watchCalls[0]).toEqual({ method: 'PUT', uri: 'quay://claudecodeui/board' });

    // The pinned session → DELETE.
    fireEvent.click(within(tileByUri('cloudcli://session/s1')).getByTestId('observation-tile-pin'));
    await waitFor(() => expect(watchCalls).toHaveLength(2));
    expect(watchCalls[1]).toEqual({ method: 'DELETE', uri: 'cloudcli://session/s1' });
  });
});

describe('the LLM digest tier', () => {
  it('renders the model options as buttons, asks for confirmation, and sends exactly once', async () => {
    // Give the watched session a second-tier reading: one conclusion, two reply options and a
    // drift note that already carries the advisory marker the producer appends.
    wallState.entries[0]!.object.digest.llm = {
      state: 'evaluated',
      conclusion: '登录刷新循环已修复。',
      options: ['继续跑全量测试', '先补一条回归'],
      driftNote: '偏离会话目标（语义判断，仅作建议）',
      advisory: '语义判断，仅作建议',
    };
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    fireEvent.click(within(tileByUri('cloudcli://session/s1')).getByTestId('observation-tile-open'));
    const preview = await screen.findByTestId('cockpit-observation-preview');

    const options = within(preview).getAllByTestId('observation-preview-llm-option');
    expect(options.map((button) => button.textContent)).toEqual(['继续跑全量测试', '先补一条回归']);
    expect(within(preview).getByTestId('observation-preview-llm-conclusion').textContent).toContain(
      '登录刷新循环已修复',
    );
    expect(within(preview).getByTestId('observation-preview-llm-drift').textContent).toContain('仅作建议');

    // A click only ASKS: no confirmation card yet, and nothing has been sent.
    expect(within(preview).queryByTestId('observation-preview-llm-confirm')).toBeNull();
    expect(hubMock.sent.filter((frame) => frame.type === 'chat.send')).toHaveLength(0);

    fireEvent.click(options[1]!);
    const confirm = await within(preview).findByTestId('observation-preview-llm-confirm');
    // The confirmation sentence names the exact option text that will be sent.
    expect(within(preview).getByTestId('observation-preview-llm-confirm-text').textContent).toContain(
      '先补一条回归',
    );
    expect(hubMock.sent.filter((frame) => frame.type === 'chat.send')).toHaveLength(0);

    fireEvent.click(confirm);

    await waitFor(() => expect(hubMock.sent.filter((frame) => frame.type === 'chat.send')).toHaveLength(1));
    const sent = hubMock.sent.filter((frame) => frame.type === 'chat.send')[0]!;
    expect(sent).toMatchObject({ type: 'chat.send', sessionId: 's1', content: '先补一条回归' });

    // The card closes. Confirming the same option again cannot deliver it twice.
    expect(within(preview).queryByTestId('observation-preview-llm-confirm')).toBeNull();
    fireEvent.click(options[1]!);
    await within(preview).findByTestId('observation-preview-llm-confirm');
    fireEvent.click(within(preview).getByTestId('observation-preview-llm-confirm'));
    expect(hubMock.sent.filter((frame) => frame.type === 'chat.send')).toHaveLength(1);
  });

  it('shows the limit reason instead of options when the tier was skipped', async () => {
    wallState.entries[0]!.object.digest.llm = { state: 'skipped', reason: '本轮未生成（限额）' };
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    fireEvent.click(within(tileByUri('cloudcli://session/s1')).getByTestId('observation-tile-open'));
    const preview = await screen.findByTestId('cockpit-observation-preview');

    expect(within(preview).queryByTestId('observation-preview-llm-option')).toBeNull();
    const note = within(preview).getByTestId('observation-preview-llm-note');
    expect(note.getAttribute('data-llm-state')).toBe('skipped');
    expect(note.textContent).toContain('限额');
  });
});

describe('blind spots and the raw material', () => {
  it('ends every preview with its declaration and the door back, and keeps the tiles quiet', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    const cases: Array<{ uri: string; kind: WallEntry['object']['kind']; phrase: string }> = [
      { uri: 'cloudcli://session/s1', kind: 'session', phrase: '看不见会话是否偏离意图' },
      { uri: 'quay://claudecodeui/board', kind: 'project', phrase: '看不见未登记到 quay-fleet 的项目' },
      {
        uri: 'cloudcli://architecture/p1',
        kind: 'architecture',
        phrase: '看不见运行时依赖与动态 import',
      },
    ];

    for (const testCase of cases) {
      const tile = tileByUri(testCase.uri);
      // A tile is the projection, not the declaration: the blind spots belong to the preview,
      // where the reader has already chosen to look closer.
      expect(within(tile).queryByTestId('observation-preview-blind-spot')).toBeNull();
      expect(tile.textContent ?? '').not.toContain(testCase.phrase);

      fireEvent.click(within(tile).getByTestId('observation-tile-open'));
      const preview = await screen.findByTestId('cockpit-observation-preview');

      const list = within(preview).getByTestId('observation-preview-blind-spot-list');
      expect(list.textContent ?? '').toContain(testCase.phrase);
      const items = within(preview).getAllByTestId('observation-preview-blind-spot');
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect((item.textContent ?? '').trim().length).toBeGreaterThan(0);
      }

      const raw = within(preview).getByTestId('observation-preview-raw-material');
      expect(raw.getAttribute('data-raw-material-kind')).toBe(testCase.kind);
      expect((raw.textContent ?? '').trim().length).toBeGreaterThan(0);

      fireEvent.click(within(preview).getByTestId('observation-preview-later'));
      await waitFor(() => expect(screen.queryByTestId('cockpit-observation-preview')).toBeNull());
    }

    // The declaration is the object's, not the preview's: every wall entry carries a non-empty one.
    for (const wallEntry of wallState.entries) {
      expect(wallEntry.object.blindSpots.length).toBeGreaterThan(0);
    }
  });

  it('opens the conversation from a session preview', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    fireEvent.click(within(tileByUri('cloudcli://session/s1')).getByTestId('observation-tile-open'));
    const preview = await screen.findByTestId('cockpit-observation-preview');
    fireEvent.click(within(preview).getByTestId('observation-preview-raw-material'));

    await waitFor(() => expect(path()).toBe('/session/s1'));
  });

  it('opens the Quay panel for the project a project preview addresses', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    fireEvent.click(within(tileByUri('quay://claudecodeui/board')).getByTestId('observation-tile-open'));
    const preview = await screen.findByTestId('cockpit-observation-preview');
    fireEvent.click(within(preview).getByTestId('observation-preview-raw-material'));

    await waitFor(() => expect(path()).toBe('/cockpit?view=board&project=claudecodeui'));
  });

  it('opens the architecture tab on the entity an architecture preview names', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    fireEvent.click(within(tileByUri('cloudcli://architecture/p1')).getByTestId('observation-tile-open'));
    const preview = await screen.findByTestId('cockpit-observation-preview');
    fireEvent.click(within(preview).getByTestId('observation-preview-raw-material'));

    await waitFor(() => expect(path()).toBe('/session/s-arch/architecture?entity=pkg%3A%3Aauth'));
  });
});

describe('views are browser history', () => {
  it('a view switch adds one history entry and a repeat of the same view adds none', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');
    expect(pushes()).toBe(0);

    fireEvent.click(screen.getByTestId('cockpit-nav-fleet'));
    await waitFor(() => expect(path()).toBe('/cockpit?view=fleet'));
    await waitFor(() => expect(pushes()).toBe(1));

    // The same view again is not a navigation.
    fireEvent.click(screen.getByTestId('cockpit-nav-fleet'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushes()).toBe(1);

    fireEvent.click(screen.getByTestId('cockpit-nav-wall'));
    await waitFor(() => expect(path()).toBe('/cockpit?view=wall'));
    await waitFor(() => expect(pushes()).toBe(2));
  });

  it('writes the fleet registry id into the URL and replaces a stored UUID link', async () => {
    // `p1` is the CloudCLI project id an older link carried; `claudecodeui` is the fleet id.
    renderCockpit(`/cockpit?view=board&project=${PROJECT_UUID}`);

    await waitFor(() => expect(path()).toBe('/cockpit?view=board&project=claudecodeui'));
    // The replacement is not a new history entry (REPLACE, not PUSH).
    expect(pushes()).toBe(0);
  });
});

describe('the status bar and the header', () => {
  it('shows only human-readable state by default, and the machine handles behind ?debug=1', async () => {
    renderCockpit('/cockpit?view=board&project=claudecodeui');
    await screen.findByTestId('cockpit-board');

    const status = screen.getByTestId('cockpit-status');
    expect(status.textContent ?? '').not.toContain('quay://');
    expect(status.textContent ?? '').not.toContain('first frame');
    expect(screen.queryByTestId('cockpit-timing')).toBeNull();
    expect(screen.queryByTestId('cockpit-event-source')).toBeNull();
    expect(screen.queryByTestId('cockpit-debug')).toBeNull();

    cleanup();
    renderCockpit('/cockpit?view=board&project=claudecodeui&debug=1');
    await screen.findByTestId('cockpit-board');

    hubMock.pushState({
      ...hubMock.getState(),
      rev: 9,
      view: { type: 'board', project: 'claudecodeui' },
      focusUri: 'quay://claudecodeui/board',
      lastEventSource: { deviceId: 'device-123456', deviceName: 'Phone', role: 'input' },
    });

    const debug = await screen.findByTestId('cockpit-debug');
    expect(debug.textContent ?? '').toContain('quay://claudecodeui/board');
    expect(within(debug).getByTestId('cockpit-timing')).toBeTruthy();
    expect(within(debug).getByTestId('cockpit-event-source').getAttribute('data-cockpit-source-device')).toBe(
      'device-123456',
    );
  });

  it('has no READ-ONLY badge and renders no QR until 「手机遥控」 is asked for', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    expect((document.body.textContent ?? '').toLowerCase()).not.toContain('read-only');
    expect(screen.queryByTestId('cockpit-remote-qr')).toBeNull();

    fireEvent.click(screen.getByTestId('cockpit-remote-toggle'));
    await screen.findByTestId('cockpit-remote-panel');
    expect(screen.getByTestId('cockpit-remote-qr')).toBeTruthy();
  });
});

describe('every input gets an echo', () => {
  it('echoes a done action and fades it after a few seconds', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    const textarea = screen
      .getByTestId('cockpit-input')
      .querySelector('[data-slot="prompt-input-textarea"]') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '全部项目' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const echo = await screen.findByTestId('cockpit-echo');
    expect(echo.getAttribute('data-echo-kind')).toBe('done');
    expect(within(echo).getByTestId('cockpit-echo-text').textContent).toContain('全部项目');

    await waitFor(() => expect(screen.queryByTestId('cockpit-echo')).toBeNull(), { timeout: 4_500 });
  }, 15_000);

  it('echoes a refusal with the reason and the next step, then fades it', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    hubMock.pushState({
      ...hubMock.getState(),
      rev: 12,
      pendingSend: {
        text: '改一下登录',
        visible: [],
        viewUri: null,
        focusUri: null,
        target: null,
        reason: 'no-focus',
      },
    });

    const echo = await screen.findByTestId('cockpit-echo');
    expect(echo.getAttribute('data-echo-kind')).toBe('refused');
    expect(within(echo).getByTestId('cockpit-echo-reason').textContent).toContain('改一下登录');
    expect(within(echo).getByTestId('cockpit-echo-next').textContent).toBeTruthy();

    await waitFor(() => expect(screen.queryByTestId('cockpit-echo')).toBeNull(), { timeout: 4_500 });
  }, 15_000);

  it('echoes a confirmation until the person answers it', async () => {
    renderCockpit();
    await screen.findByTestId('observation-wall-tiles');

    hubMock.pushState({
      ...hubMock.getState(),
      rev: 13,
      pendingSend: {
        text: '看看这个',
        visible: [],
        viewUri: null,
        focusUri: 'cloudcli://session/s1',
        target: {
          sessionId: 's1',
          projectId: 'p1',
          projectName: 'claudecodeui',
          sessionTitle: 'Fix login',
          source: 'pinned',
          fleetUnavailableReason: null,
        },
        reason: null,
      },
    });

    const echo = await screen.findByTestId('cockpit-echo');
    expect(echo.getAttribute('data-echo-kind')).toBe('confirm');
    expect(within(echo).getByTestId('cockpit-echo-text').textContent).toContain('看看这个');

    // Answering it replaces the confirmation with the done echo.
    fireEvent.click(screen.getByTestId('cockpit-send-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('cockpit-echo').getAttribute('data-echo-kind')).toBe('done');
    });
  });
});

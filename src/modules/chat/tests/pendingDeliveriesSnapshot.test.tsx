/**
 * A resident send's pending row is derived from the session's activity snapshot
 * and keyed by the delivery the host named.
 *
 * THE CLAIM, IN ONE SENTENCE. The row a reader sees while a busy resident process
 * holds their message is drawn from the session's `activity.snapshot` /
 * `activity.upsert` frame — from its `deliveries[]`, keyed by `deliveryId` — with
 * its state taken from the snapshot entry: `queued` draws the words plus the
 * "will be handled once this answer finishes" annotation, `started` keeps the
 * words (the turn's own rows have not arrived yet), `cancelled` keeps the row
 * with no words, `completed` leaves the screen.
 *
 * WHY THE KEY IS THE WHOLE POINT. A `DeliveryView` also carries the `turnId` the
 * command was bound to, and that is the tempting key: it is stable, it is on the
 * frame, and it is what "the run this command is part of" would be called. But one
 * turn carries SEVERAL deliveries — a busy process queues one command per send,
 * and a long-lived turn can have both a running command and one the user already
 * withdrew. A row set keyed by the turn collapses those into one row, so the
 * first case below (two queued sends in one session) reads back one row where
 * four are owed, and a withdrawal would take back a row it never named.
 *
 * FALSIFIABLE, AND HOW. The recorded false form replaces the `deliveryId` key in
 * `deliveryRowsFromSnapshot` with the delivery's `turnId` — the run/turn key —
 * and this file's first case reds on the row count. The mutation and its verbatim
 * failure are recorded with the task.
 *
 * WHAT IS REAL HERE. The frames are dispatched through the shipped
 * `useChatRealtimeHandlers` into the shipped `useSessionStore`, and what comes
 * out of the store is rendered by the shipped `PendingResidentMessage`. Nothing
 * about the state machine is mocked, and the copy asserted is the shipped
 * English locale's, read from the tree rather than transcribed.
 *
 * Run: npx vitest run src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { describe, it } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { normalizedToChatMessages, RESIDENT_PENDING_MESSAGE_TYPE } from '@/modules/chat/hooks/useChatMessages';
import { mergeSessionRows, useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import PendingResidentMessage from '@/modules/chat/transcript/PendingResidentMessage';
import type {
  ChatMessage,
  ChatReplayCursorMap,
  DeliveryView,
  NormalizedMessage,
  ProjectSession,
  ServerEvent,
} from '@/shared/types';

/* ─── The shipped copy, read from the tree rather than listed ─────────────── */

// `process.cwd()` rather than `import.meta.url`: under vitest's jsdom
// environment `import.meta.url` is not a `file:` URL. The suite runs from the
// repository root.
const CHAT_LOCALE = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales', 'en', 'chat.json'), 'utf8'),
) as Record<string, unknown>;

/** The shipped English copy of a dotted `chat` locale key. */
const chatCopy = (path: string): string => {
  let node: unknown = CHAT_LOCALE;
  for (const segment of path.split('.')) {
    node = (node as Record<string, unknown> | undefined)?.[segment];
  }
  assert.equal(typeof node, 'string', `the shipped chat locale has no string at ${path}`);
  return node as string;
};

await i18next.use(initReactI18next).init({
  lng: 'en',
  // Off on purpose: with a fallback left on, a key that never reached the locale
  // would render the English copy and this file's readings would hold over a
  // missing translation instead of reddening.
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: CHAT_LOCALE } },
  interpolation: { escapeValue: false },
});

/* ─── The session, and the frames a resident session sends ────────────────── */

const SESSION_ID = 'session-busy-deliveries';
const SESSION: ProjectSession = { id: SESSION_ID, name: 'Busy resident', provider: 'claude' } as ProjectSession;

const ENQUEUED_AT = Date.parse('2026-10-16T10:00:00.000Z');

/** One delivery as the activity snapshot carries it; `deliveryId` is the only required half. */
const delivery = (over: Partial<DeliveryView> & { deliveryId: string }): DeliveryView => ({
  state: 'queued',
  source: 'user',
  priority: null,
  enqueuedAt: ENQUEUED_AT,
  startedAt: null,
  endedAt: null,
  turnId: null,
  reason: null,
  text: null,
  ...over,
});

/** A whole-snapshot frame, the shape `activity.snapshot` and `activity.upsert` both carry. */
const activityFrame = (deliveries: DeliveryView[], kind: 'activity.snapshot' | 'activity.upsert' = 'activity.upsert'): ServerEvent => ({
  kind,
  sessionId: SESSION_ID,
  bootId: 'boot-1',
  rev: 7,
  asOf: ENQUEUED_AT + 1_000,
  turn: { phase: 'busy' },
  tasks: [],
  schedules: [],
  deliveries,
} as unknown as ServerEvent);

/**
 * The shipped realtime handler over the shipped store, with the frames it is
 * handed dispatched into it.
 *
 * `sessionStore` is the store's own API object rather than a stub: the point of
 * these cases is that a real frame, routed by the real handler, drives the real
 * reduction and the real component.
 */
function mountChat() {
  const storeView = renderHook(() => useSessionStore());
  const store = storeView.result.current;
  const lastSeqRef = { current: new Map<string, unknown>() as ChatReplayCursorMap };
  let listener: ((event: ServerEvent) => void) | null = null;

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    provider: 'claude',
    selectedSession: SESSION,
    currentSessionId: SESSION_ID,
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef,
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: store,
  }));

  return {
    store,
    // Wrapped in `act`: a dispatched frame reaches the store, which notifies its
    // subscribers and re-renders them — exactly what the socket does, and what
    // React has to be told about here.
    dispatch: (event: ServerEvent) => act(() => {
      listener?.(event);
    }),
    cursorFor: () => lastSeqRef.current.get(SESSION_ID),
  };
}

/* ─── The pending rows, read from the store and then from the DOM ─────────── */

/** The resident-pending rows the store hands the transcript, projected as the pane projects them. */
const pendingRows = (store: SessionStore): ChatMessage[] =>
  normalizedToChatMessages(store.getMessages(SESSION_ID))
    .filter((message) => message.type === RESIDENT_PENDING_MESSAGE_TYPE);

/** Renders those rows with the shipped component and returns the container they landed in. */
const renderPendingRows = (store: SessionStore): HTMLElement => {
  const rows = pendingRows(store);
  const { container } = render(
    <>
      {rows.map((message, index) => (
        <PendingResidentMessage key={`${message.residentDeliveryId ?? 'none'}-${index}`} message={message} />
      ))}
    </>,
  );
  return container;
};

/** Every drawn row's identity, in render order. */
const drawnDeliveryIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-delivery-id]')]
    .map((node) => node.getAttribute('data-delivery-id') ?? '');

/** The drawn row whose identity is `deliveryId`. */
const rowFor = (container: HTMLElement, deliveryId: string): HTMLElement => {
  const node = [...container.querySelectorAll<HTMLElement>('[data-delivery-id]')]
    .find((candidate) => candidate.getAttribute('data-delivery-id') === deliveryId);
  assert.ok(node, `expected a pending row drawn for delivery ${deliveryId}`);
  return node;
};

/** The bubble's words for one row, or `null` when the row draws no bubble at all. */
const bubbleText = (row: HTMLElement): string | null => {
  const bubble = row.querySelector('[data-resident-pending-message]');
  return bubble === null ? null : (bubble.textContent ?? '').trim();
};

/** The annotation one row shows, as the locale key it names and the copy it renders. */
const annotation = (row: HTMLElement): { key: string; text: string } => {
  const node = row.querySelector('[data-resident-annotation]');
  assert.ok(node, 'expected the pending row to draw an annotation');
  return { key: node.getAttribute('data-resident-annotation') ?? '', text: (node.textContent ?? '').trim() };
};

/** Renders are cleaned by vitest.setup.ts's shared `afterEach(cleanup)`. */

/* ─── (a) the four states, keyed by deliveryId ────────────────────────────── */

describe('(a) the pending row is keyed by deliveryId and its state comes from the snapshot', () => {
  it('draws one row per delivery, and reads queued/started/cancelled/completed off the snapshot', () => {
    const { store, dispatch } = mountChat();

    dispatch(activityFrame([
      delivery({ deliveryId: 'd-1', text: 'first waiting message' }),
      delivery({
        deliveryId: 'd-2',
        text: 'second waiting message',
        enqueuedAt: ENQUEUED_AT + 1_000,
      }),
      delivery({
        deliveryId: 'd-3',
        state: 'started',
        text: 'running message',
        turnId: 'turn-1',
        startedAt: ENQUEUED_AT + 2_000,
        enqueuedAt: ENQUEUED_AT + 2_000,
      }),
      // A command the user withdrew after the process had started it: it keeps
      // the turn it was bound to, which is what makes it the case a turn-keyed
      // row set would lose.
      delivery({
        deliveryId: 'd-4',
        state: 'cancelled',
        turnId: 'turn-1',
        reason: 'interrupt',
        startedAt: ENQUEUED_AT + 2_000,
        endedAt: ENQUEUED_AT + 3_000,
        enqueuedAt: ENQUEUED_AT + 2_500,
      }),
      delivery({
        deliveryId: 'd-5',
        state: 'completed',
        turnId: 'turn-1',
        startedAt: ENQUEUED_AT + 3_000,
        endedAt: ENQUEUED_AT + 4_000,
        enqueuedAt: ENQUEUED_AT + 3_500,
      }),
    ]));

    const container = renderPendingRows(store);

    assert.deepEqual(
      drawnDeliveryIds(container).sort(),
      ['d-1', 'd-2', 'd-3', 'd-4'],
      'one row per live-or-cancelled delivery: `completed` leaves the screen, and no delivery is '
        + 'merged with another — a row set keyed by the turn would draw two rows here',
    );

    // `queued` — the words, plus the "handled after this answer" annotation.
    const queued = rowFor(container, 'd-1');
    assert.equal(bubbleText(queued), 'first waiting message');
    assert.deepEqual(annotation(queued), {
      key: 'resident.pending.annotation',
      text: chatCopy('resident.pending.annotation'),
    });

    // Two queued sends are two rows, each with its own words: one turn, two
    // deliveries, and the row set must not fold them together.
    assert.equal(bubbleText(rowFor(container, 'd-2')), 'second waiting message');

    // `started` — the words stay, because the turn's own rows have not arrived.
    const started = rowFor(container, 'd-3');
    assert.equal(bubbleText(started), 'running message', '`started` must not empty the row');
    assert.deepEqual(annotation(started), {
      key: 'resident.pending.started',
      text: chatCopy('resident.pending.started'),
    });

    // `cancelled` — the row stays with no words, and says it was taken back.
    const cancelled = rowFor(container, 'd-4');
    assert.equal(cancelled.getAttribute('data-resident-withdrawn'), 'true');
    assert.equal(bubbleText(cancelled), null, 'a withdrawn command leaves no message to draw');
    assert.ok(
      (cancelled.textContent ?? '').includes(chatCopy('resident.pending.withdrawn')),
      'the withdrawn row must say the message was taken back',
    );

    // `completed` — off screen, and the message is not drawn anywhere else either.
    assert.equal(drawnDeliveryIds(container).includes('d-5'), false);
  });
});

/* ─── (b) a reconnect restores the row from the snapshot alone ────────────── */

describe('(b) a reconnect mid-queue restores the row from the snapshot', () => {
  it('draws the queued row from `activity.snapshot` with no run stream fed at all', () => {
    const { store, dispatch } = mountChat();

    // The joiner's frame, and nothing else: no `chat.subscribe` ack, no
    // `stream_delta`, no `command_lifecycle`. The row is the snapshot's.
    dispatch(activityFrame([delivery({ deliveryId: 'd-reconnect', text: 'sent while reconnecting' })], 'activity.snapshot'));

    const container = renderPendingRows(store);
    const row = rowFor(container, 'd-reconnect');
    assert.equal(bubbleText(row), 'sent while reconnecting');

    // And the store reading behind it: the row is not a realtime append that the
    // reconnect happened to replay — nothing has been appended at all.
    assert.equal(
      store.getSessionSlot(SESSION_ID)?.realtimeMessages.length,
      0,
      'the restored row must come from the snapshot, not from a replayed stream',
    );
  });
});

/* ─── (c) the snapshot and a legacy frame are one delivery, one row ───────── */

describe('(c) a snapshot and a legacy command_lifecycle frame name one delivery between them', () => {
  it('keeps one row when the frame for the same deliveryId arrives after the snapshot', () => {
    const { store, dispatch } = mountChat();

    dispatch(activityFrame([delivery({ deliveryId: 'd-shared', text: 'held by the process' })]));
    assert.equal(drawnDeliveryIds(renderPendingRows(store)).length, 1);

    // The transition period's frame, about the same command — the host's
    // `commandUuid` IS the delivery id — and it arrives with no `runId` and no
    // `seq`, as the degraded session-level lifecycle frames do.
    dispatch({
      kind: 'command_lifecycle',
      sessionId: SESSION_ID,
      commandUuid: 'd-shared',
      commandState: 'cancelled',
    } as unknown as ServerEvent);

    const container = renderPendingRows(store);
    assert.deepEqual(
      drawnDeliveryIds(container),
      ['d-shared'],
      'the frame is a statement about the delivery the snapshot named, not a second row',
    );
    const row = rowFor(container, 'd-shared');
    assert.equal(row.getAttribute('data-resident-withdrawn'), 'true');
    assert.equal(bubbleText(row), null, 'the withdrawal empties the words');
  });
});

/* ─── (d) seq-less frames never move the replay cursor ───────────────────── */

describe('(d) a session-level frame with no seq does not enter the replay cursor', () => {
  it('leaves the {runId, seq} rule untouched when frames carry no seq', () => {
    const { dispatch, cursorFor } = mountChat();

    dispatch(activityFrame([delivery({ deliveryId: 'd-1', text: 'queued while nothing is running' })]));
    dispatch({
      kind: 'command_lifecycle',
      sessionId: SESSION_ID,
      commandUuid: 'd-1',
      commandState: 'started',
    } as unknown as ServerEvent);

    assert.equal(
      cursorFor(),
      undefined,
      'a frame with no seq records no cursor at all — the activity channel and the degraded '
        + 'lifecycle frames are not part of the run’s seq stream',
    );

    // The sequenced path is unchanged: a frame from a run records {runId, seq}.
    dispatch({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'chunk', seq: 3, runId: 'run-1' } as unknown as ServerEvent);
    assert.deepEqual(cursorFor(), { runId: 'run-1', seq: 3 });

    // And a later seq-less snapshot frame does not disturb it.
    dispatch(activityFrame([delivery({ deliveryId: 'd-1', state: 'started', text: 'queued while nothing is running' })]));
    assert.deepEqual(cursorFor(), { runId: 'run-1', seq: 3 });
  });
});

/* ─── (e) one message, one representative ────────────────────────────────── */

/**
 * A send the process was NOT busy for: the composer mints its own optimistic
 * `local_…` turn, and the host's ledger still reports the accepted send as a
 * delivery. The transcript must draw the message once — the client's turn —
 * and the delivery row must draw nothing at all (no bubble, no annotation,
 * no withdraw): its state is a fact about a message the page already shows.
 *
 * The counterpart is the busy send, which has no optimistic turn and whose
 * delivery row IS the message's only representative; the control below keeps
 * that reading alive so suppressing the duplicate cannot silently kill it.
 */
describe('(e) a delivery already represented by the client’s own optimistic turn draws nothing', () => {
  const clientTurn = (id: string, text: string, at: number): NormalizedMessage => ({
    id,
    sessionId: SESSION_ID,
    timestamp: new Date(at).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: text,
  } as NormalizedMessage);

  const deliveryTurn = (deliveryId: string, text: string, at: number): NormalizedMessage => ({
    id: `live:delivery:${deliveryId}`,
    sessionId: SESSION_ID,
    timestamp: new Date(at).toISOString(),
    provider: 'claude',
    kind: 'command_lifecycle',
    role: 'user',
    content: text,
    commandUuid: deliveryId,
    commandState: 'queued',
    deliveryId,
  } as NormalizedMessage);

  it('draws the client’s row once and no pending row for its delivery', () => {
    const { store, dispatch } = mountChat();
    const text = 'sent while the process was idle';
    const sentAt = ENQUEUED_AT - 55;

    store.appendRealtime(SESSION_ID, clientTurn('local_idle', text, sentAt));
    dispatch(activityFrame([delivery({ deliveryId: 'd-idle', text })], 'activity.snapshot'));

    const drawn = store.getMessages(SESSION_ID).filter((message) => (message.content ?? '').trim() === text);
    assert.equal(drawn.length, 1, 'one message must not draw two rows');
    assert.equal(drawn[0]?.id, 'local_idle', 'the client’s own turn is the surviving representative');
    assert.deepEqual(pendingRows(store), [], 'the represented delivery draws no pending row at all');
  });

  it('keeps the delivery row when no client turn represents it (a busy send)', () => {
    const { store, dispatch } = mountChat();

    dispatch(activityFrame([
      delivery({ deliveryId: 'd-busy', text: 'sent during a running turn' }),
    ], 'activity.snapshot'));

    const container = renderPendingRows(store);
    assert.equal(bubbleText(rowFor(container, 'd-busy')), 'sent during a running turn');
    assert.equal(annotation(rowFor(container, 'd-busy')).key, 'resident.pending.annotation');
  });

  it('claims one client turn per delivery, and one delivery per client turn', () => {
    const text = 'same words, two sends';

    const bothRepresented = mountChat();
    bothRepresented.store.appendRealtime(SESSION_ID, clientTurn('local_a', text, ENQUEUED_AT - 20));
    bothRepresented.store.appendRealtime(SESSION_ID, clientTurn('local_b', text, ENQUEUED_AT - 10));
    bothRepresented.dispatch(activityFrame([
      delivery({ deliveryId: 'd-a', text, enqueuedAt: ENQUEUED_AT - 19 }),
      delivery({ deliveryId: 'd-b', text, enqueuedAt: ENQUEUED_AT - 9 }),
    ]));
    assert.deepEqual(pendingRows(bothRepresented.store), [], 'two sends, two client rows, zero pending rows');

    const oneRepresented = mountChat();
    oneRepresented.store.appendRealtime(SESSION_ID, clientTurn('local_c', text, ENQUEUED_AT - 20));
    oneRepresented.dispatch(activityFrame([
      delivery({ deliveryId: 'd-c', text, enqueuedAt: ENQUEUED_AT - 19 }),
      delivery({ deliveryId: 'd-unclaimed', text, enqueuedAt: ENQUEUED_AT - 9 }),
    ]));
    assert.equal(
      pendingRows(oneRepresented.store).length,
      1,
      'a delivery no client turn claims must still draw its own row',
    );
  });

  it('recognizes a capped delivery text as the prefix of the client’s full message', () => {
    const { store, dispatch } = mountChat();
    const fullText = '长'.repeat(500);

    store.appendRealtime(SESSION_ID, clientTurn('local_long', fullText, ENQUEUED_AT - 30));
    dispatch(activityFrame([
      delivery({ deliveryId: 'd-long', text: fullText.slice(0, 400) }),
    ], 'activity.snapshot'));

    const drawn = store.getMessages(SESSION_ID).filter((message) => message.kind === 'text' && message.role === 'user');
    assert.equal(drawn.length, 1);
    assert.equal(drawn[0]?.content, fullText, 'the client row keeps the words the capped delivery lost');
    assert.deepEqual(pendingRows(store), []);
  });

  it('does not let an older identical delivery claim a freshly sent turn', () => {
    const { store, dispatch } = mountChat();
    const text = 'yes';

    dispatch(activityFrame([
      delivery({ deliveryId: 'd-old', text, enqueuedAt: ENQUEUED_AT - 5 * 60_000 }),
    ], 'activity.snapshot'));
    store.appendRealtime(SESSION_ID, clientTurn('local_new', text, ENQUEUED_AT));

    assert.equal(
      pendingRows(store).length,
      1,
      'the old send and the new one are two messages; only a delivery at the new send’s clock may be claimed',
    );
  });

  it('hands over to the persisted turn without a gap or a second bubble', () => {
    const text = 'delivered once';
    const merged = mergeSessionRows(
      [clientTurn('srv-persisted', text, ENQUEUED_AT + 120)],
      [
        clientTurn('local_handover', text, ENQUEUED_AT - 40),
        deliveryTurn('d-handover', text, ENQUEUED_AT),
      ],
    );
    const drawn = merged.filter((message) => (message.content ?? '').trim() === text);
    assert.equal(drawn.length, 1, 'the persisted copy replaces the pair, it does not add to it');
    assert.equal(drawn[0]?.id, 'srv-persisted');
  });
});

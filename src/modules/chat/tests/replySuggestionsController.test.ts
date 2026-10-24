import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH,
  createReplySuggestionsBatchCache,
  createReplySuggestionsController,
} from '@/modules/chat/utils/replySuggestionsController';
import type {
  ReplySuggestionsApi,
  ReplySuggestionsBatchCache,
  ReplySuggestionsClock,
  ReplySuggestionsContext,
} from '@/modules/chat/utils/replySuggestionsController';
import type {
  ReplySuggestionsEventInput,
  ReplySuggestionsRequest,
  ReplySuggestionsResult,
  ReplySuggestionsStatus,
} from '@/shared/types';

/**
 * The reply-chip controller, one leg per rule the task names — with no React
 * render, no network and no wall clock. The endpoint functions, the scheduler and
 * the batch table are all injected, so every assertion below is about the
 * controller's own decisions: when it asks, when it must NOT ask again, which
 * late answer is dropped, and how the expansion chain orders itself.
 */

const STATUS_ON: ReplySuggestionsStatus = {
  enabled: true, expansion: 'off', maxChips: 3, maxChipChars: 120,
};
const STATUS_OFF: ReplySuggestionsStatus = {
  enabled: false, expansion: 'off', maxChips: 3, maxChipChars: 120,
};
const STATUS_VARY: ReplySuggestionsStatus = {
  enabled: true, expansion: 'vary', maxChips: 3, maxChipChars: 120,
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Lets every pending microtask chain (status -> draw -> apply) settle. */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
};

/** A scheduler the test drives by hand: no 120 ms wait in the suite. */
const makeClock = (): { clock: ReplySuggestionsClock; runAll: () => void; pending: () => number } => {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  const clock: ReplySuggestionsClock = {
    setTimeout: (callback) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    runAll: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    pending: () => timers.size,
  };
};

type ApiStub = {
  api: ReplySuggestionsApi;
  statusCalls: () => number;
  suggestCalls: () => ReplySuggestionsRequest[];
  expansionCalls: () => ReplySuggestionsRequest[];
  eventCalls: () => ReplySuggestionsEventInput[];
  setStatus: (reading: ReplySuggestionsStatus | null) => void;
  setSuggest: (
    impl: (request: ReplySuggestionsRequest) => Promise<ReplySuggestionsResult | null>,
  ) => void;
  setEvent: (impl: (event: ReplySuggestionsEventInput) => Promise<boolean>) => void;
};

const makeApi = (
  initial: { status?: ReplySuggestionsStatus | null } = {},
): ApiStub => {
  let statusReading: ReplySuggestionsStatus | null = initial.status === undefined
    ? STATUS_ON
    : initial.status;
  let suggestImpl: (
    request: ReplySuggestionsRequest,
  ) => Promise<ReplySuggestionsResult | null> = async () => ({
    chips: ['答复一', '答复二'],
    draw: 7,
  });
  let eventImpl: (event: ReplySuggestionsEventInput) => Promise<boolean> = async () => true;
  let statusCount = 0;
  const suggestRequests: ReplySuggestionsRequest[] = [];
  const events: ReplySuggestionsEventInput[] = [];
  const api: ReplySuggestionsApi = {
    status: async () => {
      statusCount += 1;
      return statusReading;
    },
    suggest: async (request) => {
      suggestRequests.push(request);
      return suggestImpl(request);
    },
    event: async (event) => {
      events.push(event);
      return eventImpl(event);
    },
  };
  return {
    api,
    statusCalls: () => statusCount,
    suggestCalls: () => suggestRequests,
    expansionCalls: () => suggestRequests.filter((request) => request.expand === true),
    eventCalls: () => events,
    setStatus: (reading) => {
      statusReading = reading;
    },
    setSuggest: (impl) => {
      suggestImpl = impl;
    },
    setEvent: (impl) => {
      eventImpl = impl;
    },
  };
};

const context = (overrides: Partial<ReplySuggestionsContext> = {}): ReplySuggestionsContext => ({
  sessionId: 'session-a',
  lastAssistantMessageId: 'assistant-1',
  active: true,
  focus: null,
  ...overrides,
});

const createHarness = (options: {
  status?: ReplySuggestionsStatus | null;
  cache?: ReplySuggestionsBatchCache;
} = {}) => {
  const api = makeApi({ status: options.status });
  const clock = makeClock();
  const cache = options.cache ?? createReplySuggestionsBatchCache();
  const controller = createReplySuggestionsController({ api: api.api, clock: clock.clock, cache });
  return { controller, api, clock, cache };
};

describe('replySuggestionsController', () => {
  it('(a) asks once for one session + assistant message', async () => {
    const { controller, api, clock } = createHarness();
    controller.setContext(context());
    await flush();
    assert.equal(api.suggestCalls().length, 1);

    controller.setContext(context());
    // Any draw this re-render might have held would fire here; a correct controller
    // never schedules one for a key it has already answered.
    clock.runAll();
    await flush();
    assert.equal(api.suggestCalls().length, 1, 'the same key must not be requested again');
    assert.deepEqual(controller.getSnapshot().chips, ['答复一', '答复二']);
  });

  it('(b) asks again when the assistant message id changes', async () => {
    const { controller, api, clock } = createHarness();
    controller.setContext(context());
    await flush();
    assert.equal(api.suggestCalls().length, 1);

    api.setSuggest(async () => ({ chips: ['新答复'], draw: 8 }));
    controller.setContext(context({ lastAssistantMessageId: 'assistant-2' }));
    assert.equal(clock.pending(), 1, 'a message-id change is held one beat for the session to settle');
    clock.runAll();
    await flush();

    assert.equal(api.suggestCalls().length, 2);
    assert.deepEqual(controller.getSnapshot().chips, ['新答复']);
  });

  it('(c) switching to another conversation and back restores the batch without a request', async () => {
    const { controller, api } = createHarness();
    api.setSuggest(async (request) => ({
      chips: [`${request.sessionId ?? ''}-一`, `${request.sessionId ?? ''}-二`],
      draw: 7,
    }));

    controller.setContext(context());
    await flush();
    assert.deepEqual(controller.getSnapshot().chips, ['session-a-一', 'session-a-二']);

    controller.setContext(context({ sessionId: 'session-b', lastAssistantMessageId: 'assistant-b' }));
    await flush();
    assert.deepEqual(controller.getSnapshot().chips, ['session-b-一', 'session-b-二']);
    assert.equal(api.suggestCalls().length, 2);

    controller.setContext(context());
    await flush();
    assert.deepEqual(controller.getSnapshot().chips, ['session-a-一', 'session-a-二']);
    assert.equal(api.suggestCalls().length, 2, 'the restore is the only thing that happened');
  });

  it('(d) drops a response whose session was left while the request was in flight', async () => {
    const { controller, api } = createHarness();
    const draw = deferred<ReplySuggestionsResult | null>();
    api.setSuggest(() => draw.promise);

    controller.setContext(context());
    await flush();
    assert.equal(api.suggestCalls().length, 1);

    // The other conversation has no answer to draw from, so nothing else is asked.
    controller.setContext(context({ sessionId: 'session-b', lastAssistantMessageId: null }));
    await flush();
    assert.equal(controller.getSnapshot().enabled, false);

    draw.resolve({ chips: ['旧会话的答复'], draw: 9 });
    await flush();

    assert.deepEqual(controller.getSnapshot().chips, [], 'the stale token must discard the answer');
    assert.equal(controller.getSnapshot().draw, null);
  });

  it('(e) redraw replaces the batch and the remembered one', async () => {
    const { controller, api } = createHarness();
    api.setSuggest(async (request) => (request.redraw === true
      ? { chips: ['重抽一', '重抽二'], draw: 9 }
      : { chips: ['初抽一', '初抽二'], draw: 7 }));

    controller.setContext(context());
    await flush();
    assert.equal(await controller.redraw(), true);
    await flush();
    assert.deepEqual(controller.getSnapshot().chips, ['重抽一', '重抽二'], 'replaced, not appended');
    assert.equal(controller.getSnapshot().draw, 9);

    controller.setContext(context({ sessionId: 'session-b', lastAssistantMessageId: 'assistant-b' }));
    await flush();
    controller.setContext(context());
    await flush();
    assert.deepEqual(
      controller.getSnapshot().chips,
      ['重抽一', '重抽二'],
      'the redrawn batch is what a switch back restores',
    );
    assert.equal(api.suggestCalls().length, 3);
  });

  it('(f) evicts the oldest remembered key past the capacity', async () => {
    const { controller, api } = createHarness({ cache: createReplySuggestionsBatchCache(20) });
    api.setSuggest(async (request) => ({ chips: [`chip-${request.sessionId ?? ''}`], draw: 1 }));

    controller.setContext(context({ sessionId: 's-0', lastAssistantMessageId: 'm-0' }));
    await flush();
    assert.deepEqual(controller.getSnapshot().chips, ['chip-s-0']);

    for (let index = 1; index <= 20; index += 1) {
      controller.setContext(context({ sessionId: `s-${index}`, lastAssistantMessageId: `m-${index}` }));
      await flush();
      assert.deepEqual(controller.getSnapshot().chips, [`chip-s-${index}`]);
    }
    assert.equal(api.suggestCalls().length, 21);

    // 21 keys for a 20-key table: the first one has been evicted.
    controller.setContext(context({ sessionId: 's-0', lastAssistantMessageId: 'm-0' }));
    await flush();
    assert.equal(api.suggestCalls().length, 22);
    assert.deepEqual(controller.getSnapshot().chips, ['chip-s-0']);
  });

  it('(g) stops the expansion chain at the depth cap', async () => {
    const { controller, api } = createHarness({ status: STATUS_VARY });
    api.setSuggest(async (request) => ({
      chips: [`变体-${String(request.seed ?? '')}`, '另一条'],
      draw: 20,
    }));

    controller.setContext(context());
    await flush();

    for (let depth = 1; depth <= REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH; depth += 1) {
      controller.requestExpansion({ seed: `seed-${depth}` });
      await flush();
      assert.equal(controller.getSnapshot().expansionDepth, depth);
    }
    assert.equal(controller.getSnapshot().canExpand, false);
    assert.equal(api.expansionCalls().length, REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH);

    controller.requestExpansion({ seed: 'seed-6' });
    await flush();
    assert.equal(api.expansionCalls().length, REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH, 'the cap holds');
  });

  it('(h) drops an older expansion answer that lands after a newer one', async () => {
    const { controller, api } = createHarness({ status: STATUS_VARY });
    const older = deferred<ReplySuggestionsResult | null>();
    const newer = deferred<ReplySuggestionsResult | null>();
    let expansionIndex = 0;
    api.setSuggest((request) => {
      if (request.expand !== true) return Promise.resolve({ chips: ['模型'], draw: 1 });
      expansionIndex += 1;
      return expansionIndex === 1 ? older.promise : newer.promise;
    });

    controller.setContext(context());
    await flush();

    controller.requestExpansion({ seed: '第一条' });
    // The chain this request belongs to is abandoned, then a new one starts.
    controller.clearExpansion();
    controller.requestExpansion({ seed: '第二条' });

    newer.resolve({ chips: ['新的变体'], draw: 3 });
    await flush();
    assert.deepEqual(controller.getSnapshot().expansionChips, ['新的变体']);
    assert.equal(controller.getSnapshot().draw, 3);

    older.resolve({ chips: ['旧的变体'], draw: 2 });
    await flush();
    assert.deepEqual(
      controller.getSnapshot().expansionChips,
      ['新的变体'],
      'the late answer from the abandoned chain is discarded',
    );
    assert.equal(controller.getSnapshot().draw, 3);
  });

  it('(i) falls back silently when a draw fails', async () => {
    const { controller, api } = createHarness();
    api.setSuggest(() => Promise.reject(new Error('gateway down')));

    controller.setContext(context());
    await flush();

    const snapshot = controller.getSnapshot();
    assert.deepEqual(snapshot.chips, []);
    assert.equal(snapshot.enabled, true, 'the button stays available for a retry');
    assert.equal('error' in snapshot, false, 'a failed draw publishes no error');
  });

  it('(j) swallows a refused ledger write', async () => {
    const { controller, api } = createHarness();
    api.setEvent(() => Promise.reject(new Error('ledger refused')));

    controller.setContext(context());
    await flush();
    assert.doesNotThrow(() => controller.reportEvent('picked', 0));
    await flush();
    assert.equal(api.eventCalls().length, 1);
  });

  it('(k) stops notifying after unsubscribe', async () => {
    const { controller } = createHarness();
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });

    controller.setContext(context());
    await flush();
    assert.ok(notifications > 0, 'a draw notifies the subscriber');

    const seen = notifications;
    unsubscribe();
    controller.setContext(context({ sessionId: 'session-b', lastAssistantMessageId: 'assistant-b' }));
    await flush();
    assert.equal(notifications, seen, 'an unsubscribed listener is never called again');
  });

  it('(l) keeps two controller instances independent', async () => {
    const first = createHarness();
    const second = createHarness();
    const secondNotifications: number[] = [];
    second.controller.subscribe(() => secondNotifications.push(1));

    first.controller.setContext(context());
    await flush();

    assert.deepEqual(first.controller.getSnapshot().chips, ['答复一', '答复二']);
    assert.deepEqual(second.controller.getSnapshot().chips, [], 'another instance owns another reading');
    assert.equal(secondNotifications.length, 0, 'and another set of subscribers');
    assert.equal(second.api.suggestCalls().length, 0);
  });

  it('(m) asks nothing when /status says the feature is off', async () => {
    const { controller, api } = createHarness({ status: STATUS_OFF });
    controller.setContext(context());
    await flush();

    assert.equal(api.suggestCalls().length, 0, 'a disabled feature must not draw');
    assert.equal(controller.getSnapshot().enabled, false);
    assert.deepEqual(controller.getSnapshot().chips, []);
  });
});

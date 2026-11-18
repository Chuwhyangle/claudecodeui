import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH,
  createReplySuggestionsBatchCache,
  createReplySuggestionsController,
} from '@/modules/chat-support';
import type {
  ReplySuggestionsApi,
  ReplySuggestionsBatchCache,
  ReplySuggestionsClock,
  ReplySuggestionsContext,
} from '@/modules/chat-support';
import type {
  ReplySuggestionsEventInput,
  ReplySuggestionsFailure,
  ReplySuggestionsRequest,
  ReplySuggestionsResult,
  ReplySuggestionsStatus,
  ReplySuggestionsSuggestResponse,
} from '@/shared/types';

/**
 * The reply-chip controller, one leg per rule the task names — with no React
 * render, no network and no wall clock. The endpoint functions, the scheduler and
 * the batch table are all injected, so every assertion below is about the
 * controller's own decisions: when it asks, when it must NOT ask again, which
 * late answer is dropped, and how the expansion chain orders itself.
 */

const STATUS_ON: ReplySuggestionsStatus = {
  enabled: true, state: 'ready', problems: [], lastFailure: null,
  expansion: 'off', maxChips: 3, maxChipChars: 120,
};
const STATUS_OFF: ReplySuggestionsStatus = {
  enabled: false, state: 'off', problems: [], lastFailure: null,
  expansion: 'off', maxChips: 3, maxChipChars: 120,
};
const STATUS_VARY: ReplySuggestionsStatus = {
  enabled: true, state: 'ready', problems: [], lastFailure: null,
  expansion: 'vary', maxChips: 3, maxChipChars: 120,
};
const STATUS_MISCONFIGURED: ReplySuggestionsStatus = {
  enabled: false, state: 'misconfigured', problems: ['`model` is required when `enabled` is true'],
  lastFailure: null, expansion: 'off', maxChips: 3, maxChipChars: 120,
};

/** One typed failure the API layer would produce for a refused draw. */
const failure = (overrides: Partial<ReplySuggestionsFailure> = {}): ReplySuggestionsFailure => ({
  at: '2026-11-18T10:00:00.000Z',
  code: 'REPLY_SUGGESTIONS_UPSTREAM_FAILED',
  category: 'http',
  httpStatus: 502,
  requestId: 'req-1',
  model: 'test-model',
  message: 'reply-suggestions upstream request failed (http)',
  ...overrides,
});

/** A successful draw answer in the typed shape the API layer returns. */
const ok = (result: ReplySuggestionsResult): ReplySuggestionsSuggestResponse => ({ ok: true, result });

/** A refused draw answer in the typed shape the API layer returns. */
const refused = (value: Partial<ReplySuggestionsFailure> = {}): ReplySuggestionsSuggestResponse => ({
  ok: false,
  failure: failure(value),
});

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
    now: () => 1_800_000_000_000,
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
    impl: (request: ReplySuggestionsRequest) => Promise<ReplySuggestionsSuggestResponse>,
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
  ) => Promise<ReplySuggestionsSuggestResponse> = async () => ({
    ok: true,
    result: { chips: ['答复一', '答复二'], draw: 7 },
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

    api.setSuggest(async () => ok({ chips: ['新答复'], draw: 8 }));
    controller.setContext(context({ lastAssistantMessageId: 'assistant-2' }));
    assert.equal(clock.pending(), 1, 'a message-id change is held one beat for the session to settle');
    clock.runAll();
    await flush();

    assert.equal(api.suggestCalls().length, 2);
    assert.deepEqual(controller.getSnapshot().chips, ['新答复']);
  });

  it('(c) switching to another conversation and back restores the batch without a request', async () => {
    const { controller, api } = createHarness();
    api.setSuggest(async (request) => ok({
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
    const draw = deferred<ReplySuggestionsSuggestResponse>();
    api.setSuggest(() => draw.promise);

    controller.setContext(context());
    await flush();
    assert.equal(api.suggestCalls().length, 1);

    // The other conversation has no answer to draw from, so nothing else is asked.
    controller.setContext(context({ sessionId: 'session-b', lastAssistantMessageId: null }));
    await flush();
    assert.equal(controller.getSnapshot().enabled, false);

    draw.resolve(ok({ chips: ['旧会话的答复'], draw: 9 }));
    await flush();

    assert.deepEqual(controller.getSnapshot().chips, [], 'the stale token must discard the answer');
    assert.equal(controller.getSnapshot().draw, null);
  });

  it('(e) redraw replaces the batch and the remembered one', async () => {
    const { controller, api } = createHarness();
    api.setSuggest(async (request) => ok(request.redraw === true
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
    api.setSuggest(async (request) => ok({ chips: [`chip-${request.sessionId ?? ''}`], draw: 1 }));

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
    api.setSuggest(async (request) => ok({
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
    const older = deferred<ReplySuggestionsSuggestResponse>();
    const newer = deferred<ReplySuggestionsSuggestResponse>();
    let expansionIndex = 0;
    api.setSuggest((request) => {
      if (request.expand !== true) return Promise.resolve(ok({ chips: ['模型'], draw: 1 }));
      expansionIndex += 1;
      return expansionIndex === 1 ? older.promise : newer.promise;
    });

    controller.setContext(context());
    await flush();

    controller.requestExpansion({ seed: '第一条' });
    // The chain this request belongs to is abandoned, then a new one starts.
    controller.clearExpansion();
    controller.requestExpansion({ seed: '第二条' });

    newer.resolve(ok({ chips: ['新的变体'], draw: 3 }));
    await flush();
    assert.deepEqual(controller.getSnapshot().expansionChips, ['新的变体']);
    assert.equal(controller.getSnapshot().draw, 3);

    older.resolve(ok({ chips: ['旧的变体'], draw: 2 }));
    await flush();
    assert.deepEqual(
      controller.getSnapshot().expansionChips,
      ['新的变体'],
      'the late answer from the abandoned chain is discarded',
    );
    assert.equal(controller.getSnapshot().draw, 3);
  });

  it('(i) a failed automatic draw becomes a visible failure episode, not a silent fallback', async () => {
    const { controller, api } = createHarness();
    api.setSuggest(async () => refused());

    controller.setContext(context());
    await flush();

    const snapshot = controller.getSnapshot();
    assert.deepEqual(snapshot.chips, []);
    assert.equal(snapshot.enabled, true, 'the button stays available for a retry');
    assert.equal(snapshot.failure?.code, 'REPLY_SUGGESTIONS_UPSTREAM_FAILED');
    assert.equal(snapshot.failure?.httpStatus, 502);
    assert.equal(snapshot.failure?.requestId, 'req-1');
    assert.equal(snapshot.failureCount, 1);
    assert.equal(snapshot.failureDismissed, false);
    assert.equal('error' in snapshot, false, 'the episode is a reading, never a thrown error');
  });

  it('(i2) the same requestId arriving again only advances the count', async () => {
    const { controller, api, clock } = createHarness();
    api.setSuggest(async () => refused());

    controller.setContext(context());
    await flush();
    assert.equal(controller.getSnapshot().failureCount, 1);

    // A new assistant message draws again; the same correlation facts arrive.
    controller.setContext(context({ lastAssistantMessageId: 'assistant-2' }));
    clock.runAll();
    await flush();

    assert.equal(controller.getSnapshot().failureCount, 2, 'the same episode is counted, not re-announced');
    assert.equal(controller.getSnapshot().failure?.requestId, 'req-1');

    // A different requestId (another POST) starts a new episode at 1.
    api.setSuggest(async () => refused({ requestId: 'req-2' }));
    controller.setContext(context({ lastAssistantMessageId: 'assistant-3' }));
    clock.runAll();
    await flush();
    assert.equal(controller.getSnapshot().failureCount, 1);
    assert.equal(controller.getSnapshot().failure?.requestId, 'req-2');
  });

  it('(i3) any success clears the episode while the terminology stays stable', async () => {
    const { controller, api, clock } = createHarness();
    api.setSuggest(async () => refused());
    controller.setContext(context());
    await flush();
    assert.ok(controller.getSnapshot().failure);

    api.setSuggest(async () => ok({ chips: ['恢复一', '恢复二'], draw: 9 }));
    controller.setContext(context({ lastAssistantMessageId: 'assistant-2' }));
    clock.runAll();
    await flush();

    assert.equal(controller.getSnapshot().failure, null);
    assert.equal(controller.getSnapshot().failureCount, 0);
    assert.deepEqual(controller.getSnapshot().chips, ['恢复一', '恢复二']);
  });

  it('(i4) dismiss hides the notice for the session while a manual redraw still updates the episode', async () => {
    const { controller, api } = createHarness();
    api.setSuggest(async () => refused());
    controller.setContext(context());
    await flush();
    assert.equal(controller.getSnapshot().failureDismissed, false);

    controller.dismissFailure();
    assert.equal(controller.getSnapshot().failureDismissed, true);
    assert.ok(controller.getSnapshot().failure, 'dismissing hides the notice; it does not erase the episode');

    api.setSuggest(async () => refused({ requestId: 'req-manual' }));
    assert.equal(await controller.redraw(), false);
    await flush();

    assert.equal(controller.getSnapshot().failureDismissed, true, 'a manual retry does not un-dismiss');
    assert.equal(controller.getSnapshot().failure?.requestId, 'req-manual', 'but the episode is updated');
  });

  it('(i5) a conversation switch resets the episode and its dismissal', async () => {
    const { controller, api } = createHarness();
    api.setSuggest(async () => refused());
    controller.setContext(context());
    await flush();
    controller.dismissFailure();
    assert.equal(controller.getSnapshot().failureDismissed, true);

    // The next conversation draws successfully; the reset must not depend on it.
    api.setSuggest(async () => ok({ chips: ['另一个会话'], draw: 1 }));
    controller.setContext(context({ sessionId: 'session-b', lastAssistantMessageId: 'assistant-b' }));
    await flush();

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.failure, null);
    assert.equal(snapshot.failureCount, 0);
    assert.equal(snapshot.failureDismissed, false, 'the next conversation may show its own failures');
  });

  it('(i6) a misconfigured /status is the same visible episode, naming the missing setting', async () => {
    const { controller, api } = createHarness({ status: STATUS_MISCONFIGURED });
    controller.setContext(context());
    await flush();

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.failure?.category, 'misconfigured');
    assert.equal(snapshot.failure?.code, 'REPLY_SUGGESTIONS_MISCONFIGURED');
    assert.ok(snapshot.failure?.message.includes('`model`'), 'the missing item travels with the episode');
    assert.equal(snapshot.chips.length, 0);
    assert.equal(api.suggestCalls().length, 0, 'a misconfigured feature never asks upstream');
  });

  it('(i7) a thrown transport failure is also an episode, with the network category', async () => {
    const { controller, api } = createHarness();
    api.setSuggest(() => Promise.reject(new Error('fetch failed')));

    controller.setContext(context());
    await flush();

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.failure?.category, 'network');
    assert.equal(snapshot.failure?.code, 'unknown');
    assert.equal(snapshot.failure?.message, 'fetch failed');
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

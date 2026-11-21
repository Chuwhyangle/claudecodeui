import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  createDraftRewriteController,
  type DraftRewriteContext,
} from '@/modules/chat-composer/utils/draftRewriteController';
import type {
  DraftRewriteFailure,
  DraftRewriteRequest,
  DraftRewriteResponse,
} from '@/shared/replySuggestionsType';

/**
 * The draft-rewrite controller's rules, driven without React or the network.
 *
 * WHAT THIS PINS. One request per open, the collapsed candidate cache, retry de-duplication,
 * the exact draft/scope snapshot a late answer is valid for, apply-only-through-the-writer, and
 * the reset points (edit, clear, scope switch, dispose). Each case reads the published snapshot;
 * none of them touches a component.
 */

const DRAFT = '明天十点见吧，把文档带上';
const POLISHED = '明天十点见，请把文档带上。';

type Harness = {
  controller: ReturnType<typeof createDraftRewriteController>;
  calls: DraftRewriteRequest[];
  written: string[];
  resolveNext: (response: DraftRewriteResponse) => void;
  rejectNext: (reason: unknown) => void;
  respond: (response: DraftRewriteResponse) => void;
  failNext: (failure: DraftRewriteFailure) => void;
  context: DraftRewriteContext;
  set: (patch: Partial<DraftRewriteContext>) => void;
};

const contextOf = (patch: Partial<DraftRewriteContext> = {}): DraftRewriteContext => ({
  sessionId: 'session-a',
  draftScope: 'session-a',
  draft: DRAFT,
  enabled: true,
  ...patch,
});

function createHarness(initial: Partial<DraftRewriteContext> = {}): Harness {
  const calls: DraftRewriteRequest[] = [];
  const written: string[] = [];
  let pending: {
    resolve: (response: DraftRewriteResponse) => void;
    reject: (reason: unknown) => void;
  } | null = null;
  let context = contextOf(initial);

  const controller = createDraftRewriteController({
    api: {
      rewrite: (request) => new Promise<DraftRewriteResponse>((resolve, reject) => {
        calls.push(request);
        pending = { resolve, reject };
      }),
    },
    writeDraft: (text) => written.push(text),
    now: () => 1_700_000_000_000,
  });
  controller.setContext(context);

  return {
    controller,
    calls,
    written,
    context,
    set(patch) {
      context = { ...context, ...patch };
      this.context = context;
      controller.setContext(context);
    },
    resolveNext(response) {
      assert.ok(pending, 'a request must be in flight');
      pending.resolve(response);
      pending = null;
    },
    rejectNext(reason) {
      assert.ok(pending, 'a request must be in flight');
      pending.reject(reason);
      pending = null;
    },
    respond: (response) => {
      assert.ok(pending, 'a request must be in flight');
      pending.resolve(response);
      pending = null;
    },
    failNext: (failure) => {
      assert.ok(pending, 'a request must be in flight');
      pending.resolve({ ok: false, failure });
      pending = null;
    },
  };
}

const failureOf = (category: DraftRewriteFailure['category']): DraftRewriteFailure => ({
  at: '2026-01-01T00:00:00.000Z',
  code: category === 'output-too-long' || category === 'truncated' || category === 'empty-output'
    ? 'DRAFT_REWRITE_REJECTED'
    : 'REPLY_SUGGESTIONS_UPSTREAM_FAILED',
  category,
  httpStatus: 502,
  requestId: 'req-1',
  model: 'settings-model',
  message: 'safe message',
});

/** Lets the transport promise's continuation run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('draft rewrite controller', () => {
  it('opening sends exactly one request with the draft and never writes the original draft', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    let snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.expanded, true);
    assert.equal(snapshot.loading, true);
    assert.equal(harness.calls.length, 1);
    assert.deepEqual(harness.calls[0], { text: DRAFT });
    assert.deepEqual(harness.written, [], 'requesting never writes the draft');

    // A second open while in flight must not become a second request.
    harness.controller.openOrRequest();
    assert.equal(harness.calls.length, 1);

    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();
    snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.loading, false);
    assert.equal(snapshot.candidate, POLISHED);
    assert.equal(snapshot.expanded, true);
    assert.deepEqual(harness.written, []);
  });

  it('collapse keeps the candidate; re-opening restores it without another call', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();

    harness.controller.collapse();
    assert.equal(harness.controller.getSnapshot().expanded, false);
    assert.equal(harness.controller.getSnapshot().candidate, POLISHED);

    harness.controller.openOrRequest();
    assert.equal(harness.controller.getSnapshot().expanded, true);
    assert.equal(harness.controller.getSnapshot().candidate, POLISHED);
    assert.equal(harness.calls.length, 1, 'the cached candidate spends no second call');
  });

  it('two duplicate retries while one is in flight produce a single request', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();

    harness.controller.retry();
    harness.controller.retry();
    harness.controller.retry();
    assert.equal(harness.calls.length, 2, 'one retry, not three');
  });

  it('a retry after a failure asks again', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.failNext(failureOf('http'));
    await flush();
    assert.equal(harness.controller.getSnapshot().failure?.category, 'http');
    harness.controller.retry();
    assert.equal(harness.calls.length, 2);
  });

  it('an edit while a request is in flight discards the late answer', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.set({ draft: `${DRAFT}（补充）` });
    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();
    const snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.candidate, null);
    assert.equal(snapshot.expanded, false);
    assert.deepEqual(harness.written, []);
  });

  it('a clear while in flight discards the late answer', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.set({ draft: '' });
    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();
    assert.equal(harness.controller.getSnapshot().candidate, null);
  });

  it('a scope/session switch discards the candidate and the late answer', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();
    assert.equal(harness.controller.getSnapshot().candidate, POLISHED);

    harness.set({ sessionId: 'session-b', draftScope: 'session-b', draft: 'another draft' });
    assert.equal(harness.controller.getSnapshot().candidate, null);

    harness.controller.openOrRequest();
    harness.set({ sessionId: 'session-c', draftScope: 'session-c' });
    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();
    assert.equal(harness.controller.getSnapshot().candidate, null);
  });

  it('dispose discards the late answer and stops notifications', async () => {
    const harness = createHarness();
    let notifications = 0;
    harness.controller.subscribe(() => {
      notifications += 1;
    });
    harness.controller.openOrRequest();
    const beforeDispose = notifications;
    harness.controller.dispose();
    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();
    assert.equal(harness.controller.getSnapshot().candidate, null);
    assert.equal(notifications, beforeDispose, 'a disposed controller publishes nothing');
  });

  it('apply writes the candidate through the injected writer, collapses, and never submits', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();

    harness.controller.apply();
    assert.deepEqual(harness.written, [POLISHED]);
    const snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.candidate, null);
    assert.equal(snapshot.expanded, false);
  });

  it('apply is a no-op when the live draft is no longer the exact snapshot', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();

    // A programmatic write that bypassed setContext: the candidate must not replace those bytes.
    harness.controller.apply();
    assert.deepEqual(harness.written, [POLISHED]);

    const second = createHarness();
    second.controller.openOrRequest();
    second.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();
    // Simulate the draft changing under the controller without its context update.
    const snapshot = second.controller.getSnapshot();
    assert.equal(snapshot.candidate, POLISHED);
    second.set({ draft: 'something else' });
    second.controller.apply();
    assert.deepEqual(second.written, [], 'a stale candidate never overwrites a newer draft');
  });

  it('a candidate identical to the draft still applies cleanly', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.respond({ ok: true, result: { rewrittenText: DRAFT } });
    await flush();
    harness.controller.apply();
    assert.deepEqual(harness.written, [DRAFT]);
    assert.equal(harness.controller.getSnapshot().candidate, null);
  });

  it('loading is collapsible and stays in flight; the answer lands into the cached slot', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.controller.collapse();
    let snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.expanded, false);
    assert.equal(snapshot.loading, true);

    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();
    snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.expanded, false, 'a collapsed request stays collapsed');
    assert.equal(snapshot.candidate, POLISHED, 'the candidate is cached for the chip');
    assert.equal(harness.calls.length, 1);
  });

  it('a failure keeps the draft, is collapsible, and re-opening shows the error without a new call', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.failNext(failureOf('rate-limit'));
    await flush();
    let snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.failure?.category, 'rate-limit');
    assert.equal(snapshot.candidate, null);
    assert.deepEqual(harness.written, [], 'the draft is never written on failure');

    harness.controller.collapse();
    harness.controller.openOrRequest();
    snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.expanded, true);
    assert.equal(snapshot.failure?.category, 'rate-limit');
    assert.equal(harness.calls.length, 1, 're-opening an error asks again only via retry');
  });

  it('a transport throw becomes a typed retryable failure', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.rejectNext(new Error('connection reset'));
    await flush();
    const snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.loading, false);
    assert.equal(snapshot.failure?.category, 'network');
    assert.equal(snapshot.candidate, null);
    assert.ok(!snapshot.failure?.message.includes(DRAFT));
  });

  it('over-budget and truncated refusals never become candidates', async () => {
    for (const category of ['output-too-long', 'truncated', 'empty-output', 'non-text'] as const) {
      const harness = createHarness();
      harness.controller.openOrRequest();
      harness.failNext(failureOf(category));
      await flush();
      assert.equal(harness.controller.getSnapshot().candidate, null, category);
      assert.equal(harness.controller.getSnapshot().failure?.category, category);
    }
  });

  it('invalidate drops the candidate and the error (user edit / clear)', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();
    harness.controller.invalidate();
    const snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.candidate, null);
    assert.equal(snapshot.failure, null);
    assert.equal(snapshot.expanded, false);
  });

  it('the chip is unavailable on a blank draft or a disabled feature', () => {
    const blank = createHarness({ draft: '   ' });
    assert.equal(blank.controller.getSnapshot().available, false);
    blank.controller.openOrRequest();
    assert.equal(blank.calls.length, 0);

    const disabled = createHarness({ enabled: false });
    assert.equal(disabled.controller.getSnapshot().available, false);
    disabled.controller.openOrRequest();
    assert.equal(disabled.calls.length, 0);
  });

  it('a disabled feature or blank draft clears an open panel', async () => {
    const harness = createHarness();
    harness.controller.openOrRequest();
    harness.respond({ ok: true, result: { rewrittenText: POLISHED } });
    await flush();
    harness.set({ enabled: false });
    assert.equal(harness.controller.getSnapshot().expanded, false);
    assert.equal(harness.controller.getSnapshot().candidate, null);
  });

  it('publishes only when a drawn field changed', async () => {
    const harness = createHarness();
    let notifications = 0;
    harness.controller.subscribe(() => {
      notifications += 1;
    });
    // Re-setting the identical context is not a change.
    harness.set({});
    assert.equal(notifications, 0);
    harness.controller.openOrRequest();
    assert.ok(notifications > 0);
    const settled = notifications;
    harness.controller.collapse();
    harness.controller.collapse();
    assert.equal(notifications, settled + 1, 'a redundant collapse publishes nothing');
  });
});

import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { useReplySuggestions } from '@/modules/chat/hooks/useReplySuggestions';
import { resetReplySuggestionsBatchCache } from '@/modules/chat/utils/replySuggestionsController';

/**
 * The model-chip hook, one leg per rule the proposal states.
 *
 * The network is doubled at the API boundary, so every assertion below is about
 * this hook's decisions: when it asks, when it must NOT ask again, what a failed
 * or disabled answer does, and which ledger events a draw/pick/send produces.
 * The three endpoint functions are the only transport the hook knows.
 */

const apiMocks = vi.hoisted(() => ({
  status: vi.fn(),
  suggest: vi.fn(),
  event: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: {
    replySuggestions: {
      status: apiMocks.status,
      suggest: apiMocks.suggest,
      event: apiMocks.event,
    },
  },
}));

/** The API layer owns parsing; these mocks hand the controller its typed readings. */
const respond = (value: unknown) => Promise.resolve(value);

const STATUS_ON = { enabled: true, expansion: 'off', maxChips: 3, maxChipChars: 120 };
const STATUS_OFF = { enabled: false, expansion: 'off', maxChips: 3, maxChipChars: 120 };
const STATUS_VARY = { enabled: true, expansion: 'vary', maxChips: 3, maxChipChars: 120 };

type Args = {
  sessionId: string | null;
  lastAssistantMessageId: string | null;
  active: boolean;
  focus?: string | null;
};

const baseArgs = (overrides: Partial<Args> = {}): Args => ({
  sessionId: 'session-a',
  lastAssistantMessageId: 'assistant-1',
  active: true,
  focus: null,
  ...overrides,
});

const renderReply = (overrides: Partial<Args> = {}) => renderHook(
  (props: Args) => useReplySuggestions(props),
  { initialProps: baseArgs(overrides) },
);

/** Lets the status read (and any draw it triggers) settle. */
const settle = async (result: { current: { enabled: boolean } }) => {
  await waitFor(() => assert.equal(result.current.enabled, true));
};
const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  // The batch table lives at module scope so it survives a remount; every test
  // must start with an empty page.
  resetReplySuggestionsBatchCache();
  apiMocks.status.mockReset().mockImplementation(() => Promise.resolve(STATUS_ON));
  apiMocks.suggest.mockReset().mockImplementation(() => Promise.resolve({
    chips: ['答复一', '答复二'],
    draw: 7,
  }));
  apiMocks.event.mockReset().mockImplementation(() => Promise.resolve(true));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useReplySuggestions', () => {
  it('(a) sends no draw and reports the feature off when /status says disabled', async () => {
    apiMocks.status.mockImplementation(() => respond(STATUS_OFF));
    const { result } = renderReply();

    await flush();

    assert.equal(result.current.enabled, false, 'the button must not be drawn');
    assert.equal(result.current.firstDraw.chips.length, 0);
    assert.equal(apiMocks.suggest.mock.calls.length, 0, 'a disabled feature must not draw');
  });

  it('(b) draws once for one assistant message, across re-renders and an empty<->draft cycle', async () => {
    const { result, rerender } = renderReply();
    await settle(result);
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['答复一', '答复二']));
    assert.equal(apiMocks.suggest.mock.calls.length, 1);

    // A re-render with the same message id: not a second draw.
    rerender(baseArgs());
    await flush();
    assert.equal(apiMocks.suggest.mock.calls.length, 1, 'a re-render must not draw again');

    // The person types (active false) and clears the box again (active true).
    rerender(baseArgs({ active: false }));
    await flush();
    rerender(baseArgs({ active: true }));
    await flush();
    assert.equal(apiMocks.suggest.mock.calls.length, 1, 'clearing the box must not draw again');
    assert.deepEqual(result.current.firstDraw.chips, ['答复一', '答复二']);
  });

  it('(c) draws again when the assistant message id changes', async () => {
    const { result, rerender } = renderReply();
    await settle(result);
    await waitFor(() => assert.equal(apiMocks.suggest.mock.calls.length, 1));

    apiMocks.suggest.mockImplementation(() => respond({ chips: ['新答复'], draw: 8 }));
    rerender(baseArgs({ lastAssistantMessageId: 'assistant-2' }));
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['新答复']));
    assert.equal(apiMocks.suggest.mock.calls.length, 2, 'a new answer is a new draw');
  });

  it('(d) falls back silently when the draw fails', async () => {
    apiMocks.suggest.mockImplementation(() => Promise.reject(new Error('gateway down')));
    const { result } = renderReply();
    await settle(result);
    await flush();

    assert.deepEqual(result.current.firstDraw.chips, [], 'a failed draw leaves only the habit chips to the strip');
    assert.equal(result.current.enabled, true, 'the button stays available for a retry');
  });

  it('(e) the Suggest action sends redraw:true and replaces the batch instead of appending', async () => {
    const { result } = renderReply();
    await settle(result);
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['答复一', '答复二']));

    apiMocks.suggest.mockImplementation(() => respond({ chips: ['新一', '新二', '新三'], draw: 9 }));
    act(() => {
      result.current.firstDraw.redraw();
    });
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['新一', '新二', '新三']));

    const redrawCall = apiMocks.suggest.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    assert.equal(redrawCall.redraw, true);
    assert.equal(result.current.firstDraw.draw, 9);
  });

  it('(f) carries the quoted selection as focus on a redraw', async () => {
    const { result } = renderReply({ focus: '  选中的原文  ' });
    await settle(result);

    act(() => {
      result.current.firstDraw.redraw();
    });
    await waitFor(() => assert.equal(apiMocks.suggest.mock.calls.length, 2));
    const body = apiMocks.suggest.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    assert.equal(body.focus, '选中的原文', 'the selection is trimmed and sent as focus');
  });

  it('(g) disables during a redraw and restores afterwards', async () => {
    const { result } = renderReply();
    await settle(result);

    let resolveDraw: ((value: unknown) => void) | null = null;
    apiMocks.suggest.mockImplementation(() => new Promise((resolve) => {
      resolveDraw = resolve;
    }));

    act(() => {
      result.current.firstDraw.redraw();
    });
    assert.equal(result.current.firstDraw.loading, true, 'the button is disabled while the draw is in flight');

    await act(async () => {
      resolveDraw?.(await respond({ chips: ['答复'], draw: 10 }));
    });
    await waitFor(() => assert.equal(result.current.firstDraw.loading, false));
  });

  it('(h) reports picked, redrawn and sent once each, and swallows a refused ledger write', async () => {
    const { result } = renderReply();
    await settle(result);
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['答复一', '答复二']));

    apiMocks.event.mockImplementation(() => Promise.reject(new Error('ledger refused')));

    act(() => {
      result.current.reportEvent('picked', 1);
      result.current.firstDraw.redraw();
    });
    await waitFor(() => assert.equal(apiMocks.event.mock.calls.length, 2));
    act(() => {
      result.current.reportEvent('sent');
    });
    await flush();

    const names = apiMocks.event.mock.calls.map(([body]) => (body as { event: string }).event);
    assert.deepEqual(names, ['picked', 'redrawn', 'sent'], 'one event each, in that order');
    const picked = apiMocks.event.mock.calls[0][0] as Record<string, unknown>;
    assert.equal(picked.index, 1);
    assert.equal(picked.draw, 7);
    const redrawn = apiMocks.event.mock.calls[1][0] as Record<string, unknown>;
    assert.equal(redrawn.draw, 7);
    const sent = apiMocks.event.mock.calls[2][0] as Record<string, unknown>;
    assert.equal(sent.draw, 7);
  });

  it('(i) is off while the conversation has no assistant message to draw from', async () => {
    const { result } = renderReply({ lastAssistantMessageId: null });

    await flush();

    assert.equal(result.current.enabled, false, 'no assistant message means no Suggest control');
    assert.equal(apiMocks.suggest.mock.calls.length, 0, 'there is nothing to draw from');
  });

  it('(j) redraw resolves true on a fresh batch and false on a failed draw', async () => {
    const { result } = renderReply();
    await settle(result);
    await waitFor(() => assert.equal(apiMocks.suggest.mock.calls.length, 1));

    apiMocks.suggest.mockImplementationOnce(() => Promise.resolve(null));
    let refused: boolean | undefined;
    await act(async () => {
      refused = await result.current.firstDraw.redraw();
    });
    assert.equal(refused, false, 'a non-ok answer is a failed draw');

    apiMocks.suggest.mockImplementationOnce(() => Promise.reject(new Error('gateway down')));
    let thrown: boolean | undefined;
    await act(async () => {
      thrown = await result.current.firstDraw.redraw();
    });
    assert.equal(thrown, false, 'a thrown request is a failed draw');

    apiMocks.suggest.mockImplementationOnce(() => respond({ chips: ['新答复'], draw: 11 }));
    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current.firstDraw.redraw();
    });
    assert.equal(applied, true, 'an applied batch is a success');
    assert.deepEqual(result.current.firstDraw.chips, ['新答复']);
  });
});

// ---------------------------------------------------------------------------
// The expansion experiment: a second draw anchored on the draft
// ---------------------------------------------------------------------------

const expansionCalls = () => apiMocks.suggest.mock.calls
  .map(([body]) => body as Record<string, unknown>)
  .filter((body) => body.expand === true);

describe('useReplySuggestions expansion', () => {
  beforeEach(() => {
    apiMocks.status.mockImplementation(() => respond(STATUS_VARY));
  });

  it('(a) has no expansion request while the settings say expansion off', async () => {
    apiMocks.status.mockImplementation(() => respond(STATUS_ON));
    const { result } = renderReply();
    await settle(result);

    act(() => {
      result.current.expansion.request({ seed: '一条已选定的回复' });
    });
    await flush();

    assert.equal(result.current.expansion.enabled, false);
    assert.equal(result.current.expansion.chips.length, 0);
    assert.equal(expansionCalls().length, 0, 'expansion off must not reach the server');
  });

  it('(b) sends one expand request with the seed and exposes the variants', async () => {
    const { result } = renderReply();
    await settle(result);
    await waitFor(() => assert.equal(apiMocks.suggest.mock.calls.length, 1));

    apiMocks.suggest.mockImplementation(() => respond({ chips: ['变体一', '变体二'], draw: 12 }));
    act(() => {
      result.current.expansion.request({ seed: '  已选定的回复  ' });
    });
    await waitFor(() => assert.deepEqual(result.current.expansion.chips, ['变体一', '变体二']));

    const calls = expansionCalls();
    assert.equal(calls.length, 1, 'one pick is one request');
    assert.equal(calls[0].seed, '已选定的回复', 'the seed is trimmed');
    assert.equal(result.current.expansion.source, 'seed');
    assert.equal(result.current.expansion.depth, 1);
    assert.equal(result.current.firstDraw.draw, 12, 'the chips carry the expansion draw id');
  });

  it('(c) sends a focus-anchored request when the seed is empty', async () => {
    const { result } = renderReply();
    await settle(result);
    apiMocks.suggest.mockImplementation(() => respond({ chips: ['回应一'], draw: 13 }));

    act(() => {
      result.current.expansion.request({ focus: '  被引用的原文  ', seed: '' });
    });
    await waitFor(() => assert.deepEqual(result.current.expansion.chips, ['回应一']));

    const calls = expansionCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].focus, '被引用的原文');
    assert.equal('seed' in calls[0], false, 'an empty seed is not sent');
    assert.equal(result.current.expansion.source, 'focus');
  });

  it('(d) stops at five expansion requests in one chain', async () => {
    const { result } = renderReply();
    await settle(result);
    apiMocks.suggest.mockImplementation((body: Record<string, unknown>) => respond({
      chips: [`变体-${String(body.seed ?? '')}`, '另一条'],
      draw: 20,
    }));

    for (let depth = 1; depth <= 5; depth += 1) {
      act(() => {
        result.current.expansion.request({ seed: `seed-${depth}` });
      });
      await waitFor(() => assert.equal(result.current.expansion.depth, depth));
    }
    assert.equal(expansionCalls().length, 5);
    assert.equal(result.current.expansion.canExpand, false);

    act(() => {
      result.current.expansion.request({ seed: 'seed-6' });
    });
    await flush();
    assert.equal(expansionCalls().length, 5, 'depth 5 is the cap');
  });

  it('(e) clearExpansion drops the chips and resets the chain', async () => {
    const { result } = renderReply();
    await settle(result);
    act(() => {
      result.current.expansion.request({ seed: '已选定的回复' });
    });
    await waitFor(() => assert.equal(result.current.expansion.chips.length, 2));

    act(() => {
      result.current.expansion.clear();
    });
    await flush();

    assert.deepEqual(result.current.expansion.chips, []);
    assert.equal(result.current.expansion.source, null);
    assert.equal(result.current.expansion.depth, 0);
  });

  it('(f) a session switch drops an expansion chain, and picked events carry the source', async () => {
    const { result, rerender } = renderReply();
    await settle(result);
    act(() => {
      result.current.expansion.request({ seed: '已选定的回复' });
    });
    await waitFor(() => assert.equal(result.current.expansion.chips.length, 2));

    act(() => {
      result.current.reportEvent('picked', 0, 'seed');
    });
    await flush();
    const picked = apiMocks.event.mock.calls[0][0] as Record<string, unknown>;
    assert.equal(picked.source, 'seed');

    rerender(baseArgs({ sessionId: 'session-b' }));
    await flush();
    assert.deepEqual(result.current.expansion.chips, [], 'another conversation owns another draft');
    assert.equal(result.current.expansion.depth, 0);
  });
});

// ---------------------------------------------------------------------------
// One batch per assistant message: switching back or remounting is free
// ---------------------------------------------------------------------------

const drawnSessions = () => apiMocks.suggest.mock.calls
  .map(([body]) => (body as Record<string, unknown>).sessionId);

describe('useReplySuggestions batch cache', () => {
  /** A distinct batch per session, so a restore can be told from a fresh draw. */
  const perSession = () => apiMocks.suggest.mockImplementation((body: Record<string, unknown>) => {
    const session = String(body.sessionId);
    if (body.redraw === true) {
      return respond({ chips: [`${session}-重抽一`, `${session}-重抽二`], draw: 9 });
    }
    return respond({ chips: [`${session}-一`, `${session}-二`], draw: 7 });
  });

  it('(a) switching to another conversation and back restores the batch without a request', async () => {
    perSession();
    const { result, rerender } = renderReply();
    await settle(result);
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['session-a-一', 'session-a-二']));
    assert.equal(apiMocks.suggest.mock.calls.length, 1);

    rerender(baseArgs({ sessionId: 'session-b', lastAssistantMessageId: 'assistant-b' }));
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['session-b-一', 'session-b-二']));
    assert.equal(apiMocks.suggest.mock.calls.length, 2);

    rerender(baseArgs({ sessionId: 'session-a', lastAssistantMessageId: 'assistant-1' }));
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['session-a-一', 'session-a-二']));
    assert.equal(apiMocks.suggest.mock.calls.length, 2, 'switching back must not draw again');
    assert.deepEqual(drawnSessions(), ['session-a', 'session-b']);
  });

  it('(b) a redrawn batch replaces the remembered one, and a switch back restores the new batch', async () => {
    perSession();
    const { result, rerender } = renderReply();
    await settle(result);
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['session-a-一', 'session-a-二']));

    await act(async () => {
      assert.equal(await result.current.firstDraw.redraw(), true);
    });
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['session-a-重抽一', 'session-a-重抽二']));
    assert.equal(apiMocks.suggest.mock.calls.length, 2);

    rerender(baseArgs({ sessionId: 'session-b', lastAssistantMessageId: 'assistant-b' }));
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['session-b-一', 'session-b-二']));

    rerender(baseArgs({ sessionId: 'session-a', lastAssistantMessageId: 'assistant-1' }));
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['session-a-重抽一', 'session-a-重抽二']));
    assert.equal(apiMocks.suggest.mock.calls.length, 3, 'the restore is the only thing that happened');
  });

  it('(c) a new assistant message id is a new draw, not a restore', async () => {
    perSession();
    const { result, rerender } = renderReply();
    await settle(result);
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['session-a-一', 'session-a-二']));

    rerender(baseArgs({ lastAssistantMessageId: 'assistant-2' }));
    await waitFor(() => assert.equal(apiMocks.suggest.mock.calls.length, 2));
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['session-a-一', 'session-a-二']));
  });

  it('(d) unmounting and remounting the same conversation makes no request', async () => {
    perSession();
    const first = renderReply();
    await settle(first.result);
    await waitFor(() => assert.deepEqual(first.result.current.firstDraw.chips, ['session-a-一', 'session-a-二']));
    assert.equal(apiMocks.suggest.mock.calls.length, 1);

    first.unmount();

    const second = renderReply();
    await settle(second.result);
    await waitFor(() => assert.deepEqual(second.result.current.firstDraw.chips, ['session-a-一', 'session-a-二']));
    assert.equal(apiMocks.suggest.mock.calls.length, 1, 'the remount restores the remembered batch');
  });

  it('(e) the table keeps 20 keys; the least-recently-used one is drawn again when returned to', async () => {
    apiMocks.suggest.mockImplementation((body: Record<string, unknown>) => respond({
      chips: [`chip-${String(body.sessionId)}`],
      draw: 1,
    }));
    const { result, rerender } = renderReply({ sessionId: 's-0', lastAssistantMessageId: 'm-0' });
    await settle(result);
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['chip-s-0']));

    for (let index = 1; index <= 20; index += 1) {
      rerender(baseArgs({ sessionId: `s-${index}`, lastAssistantMessageId: `m-${index}` }));
      await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, [`chip-s-${index}`]));
    }
    assert.equal(apiMocks.suggest.mock.calls.length, 21);

    // 21 keys for a 20-key table: the first one has been evicted.
    rerender(baseArgs({ sessionId: 's-0', lastAssistantMessageId: 'm-0' }));
    await waitFor(() => assert.equal(apiMocks.suggest.mock.calls.length, 22));
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['chip-s-0']));
  });

  it('(f) a conversation switch whose message id arrives one render early draws nothing', async () => {
    perSession();
    const { result, rerender } = renderReply();
    await settle(result);
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['session-a-一', 'session-a-二']));
    assert.equal(apiMocks.suggest.mock.calls.length, 1);

    // The real page hands the incoming conversation's message id to the composer
    // one render before the session id follows. That pair must not be mistaken
    // for "the assistant answered again".
    rerender(baseArgs({ sessionId: 'session-a', lastAssistantMessageId: 'assistant-b' }));
    rerender(baseArgs({ sessionId: 'session-b', lastAssistantMessageId: 'assistant-b' }));
    await waitFor(() => assert.deepEqual(result.current.firstDraw.chips, ['session-b-一', 'session-b-二']));
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(apiMocks.suggest.mock.calls.length, 2, 'only the two real first draws, no outgoing-session request');
    assert.deepEqual(drawnSessions(), ['session-a', 'session-b']);
  });
});

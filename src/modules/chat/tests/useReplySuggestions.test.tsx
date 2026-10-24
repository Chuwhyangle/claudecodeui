import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { useReplySuggestions } from '@/modules/chat/hooks/useReplySuggestions';

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

const okJson = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => data });

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
  apiMocks.status.mockReset().mockImplementation(() => okJson(STATUS_ON));
  apiMocks.suggest.mockReset().mockImplementation(() => okJson({ chips: ['答复一', '答复二'], draw: 7 }));
  apiMocks.event.mockReset().mockImplementation(() => Promise.resolve({ ok: true, status: 204 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useReplySuggestions', () => {
  it('(a) sends no draw and reports the feature off when /status says disabled', async () => {
    apiMocks.status.mockImplementation(() => okJson(STATUS_OFF));
    const { result } = renderReply();

    await flush();

    assert.equal(result.current.enabled, false, 'the button must not be drawn');
    assert.equal(result.current.chips.length, 0);
    assert.equal(apiMocks.suggest.mock.calls.length, 0, 'a disabled feature must not draw');
  });

  it('(b) draws once for one assistant message, across re-renders and an empty<->draft cycle', async () => {
    const { result, rerender } = renderReply();
    await settle(result);
    await waitFor(() => assert.deepEqual(result.current.chips, ['答复一', '答复二']));
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
    assert.deepEqual(result.current.chips, ['答复一', '答复二']);
  });

  it('(c) draws again when the assistant message id changes', async () => {
    const { result, rerender } = renderReply();
    await settle(result);
    await waitFor(() => assert.equal(apiMocks.suggest.mock.calls.length, 1));

    apiMocks.suggest.mockImplementation(() => okJson({ chips: ['新答复'], draw: 8 }));
    rerender(baseArgs({ lastAssistantMessageId: 'assistant-2' }));
    await waitFor(() => assert.deepEqual(result.current.chips, ['新答复']));
    assert.equal(apiMocks.suggest.mock.calls.length, 2, 'a new answer is a new draw');
  });

  it('(d) falls back silently when the draw fails', async () => {
    apiMocks.suggest.mockImplementation(() => Promise.reject(new Error('gateway down')));
    const { result } = renderReply();
    await settle(result);
    await flush();

    assert.deepEqual(result.current.chips, [], 'a failed draw leaves only the habit chips to the strip');
    assert.equal(result.current.enabled, true, 'the button stays available for a retry');
  });

  it('(e) the Suggest action sends redraw:true and replaces the batch instead of appending', async () => {
    const { result } = renderReply();
    await settle(result);
    await waitFor(() => assert.deepEqual(result.current.chips, ['答复一', '答复二']));

    apiMocks.suggest.mockImplementation(() => okJson({ chips: ['新一', '新二', '新三'], draw: 9 }));
    act(() => {
      result.current.redraw();
    });
    await waitFor(() => assert.deepEqual(result.current.chips, ['新一', '新二', '新三']));

    const redrawCall = apiMocks.suggest.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    assert.equal(redrawCall.redraw, true);
    assert.equal(result.current.draw, 9);
  });

  it('(f) carries the quoted selection as focus on a redraw', async () => {
    const { result } = renderReply({ focus: '  选中的原文  ' });
    await settle(result);

    act(() => {
      result.current.redraw();
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
      result.current.redraw();
    });
    assert.equal(result.current.loading, true, 'the button is disabled while the draw is in flight');

    await act(async () => {
      resolveDraw?.(await okJson({ chips: ['答复'], draw: 10 }));
    });
    await waitFor(() => assert.equal(result.current.loading, false));
  });

  it('(h) reports picked, redrawn and sent once each, and swallows a refused ledger write', async () => {
    const { result } = renderReply();
    await settle(result);
    await waitFor(() => assert.deepEqual(result.current.chips, ['答复一', '答复二']));

    apiMocks.event.mockImplementation(() => Promise.reject(new Error('ledger refused')));

    act(() => {
      result.current.reportEvent('picked', 1);
      result.current.redraw();
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

    apiMocks.suggest.mockImplementationOnce(
      () => Promise.resolve({ ok: false, status: 502, json: async () => ({}) }),
    );
    let refused: boolean | undefined;
    await act(async () => {
      refused = await result.current.redraw();
    });
    assert.equal(refused, false, 'a non-ok answer is a failed draw');

    apiMocks.suggest.mockImplementationOnce(() => Promise.reject(new Error('gateway down')));
    let thrown: boolean | undefined;
    await act(async () => {
      thrown = await result.current.redraw();
    });
    assert.equal(thrown, false, 'a thrown request is a failed draw');

    apiMocks.suggest.mockImplementationOnce(() => okJson({ chips: ['新答复'], draw: 11 }));
    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current.redraw();
    });
    assert.equal(applied, true, 'an applied batch is a success');
    assert.deepEqual(result.current.chips, ['新答复']);
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
    apiMocks.status.mockImplementation(() => okJson(STATUS_VARY));
  });

  it('(a) has no expansion request while the settings say expansion off', async () => {
    apiMocks.status.mockImplementation(() => okJson(STATUS_ON));
    const { result } = renderReply();
    await settle(result);

    act(() => {
      result.current.requestExpansion({ seed: '一条已选定的回复' });
    });
    await flush();

    assert.equal(result.current.expansionEnabled, false);
    assert.equal(result.current.expansionChips.length, 0);
    assert.equal(expansionCalls().length, 0, 'expansion off must not reach the server');
  });

  it('(b) sends one expand request with the seed and exposes the variants', async () => {
    const { result } = renderReply();
    await settle(result);
    await waitFor(() => assert.equal(apiMocks.suggest.mock.calls.length, 1));

    apiMocks.suggest.mockImplementation(() => okJson({ chips: ['变体一', '变体二'], draw: 12 }));
    act(() => {
      result.current.requestExpansion({ seed: '  已选定的回复  ' });
    });
    await waitFor(() => assert.deepEqual(result.current.expansionChips, ['变体一', '变体二']));

    const calls = expansionCalls();
    assert.equal(calls.length, 1, 'one pick is one request');
    assert.equal(calls[0].seed, '已选定的回复', 'the seed is trimmed');
    assert.equal(result.current.expansionSource, 'seed');
    assert.equal(result.current.expansionDepth, 1);
    assert.equal(result.current.draw, 12, 'the chips carry the expansion draw id');
  });

  it('(c) sends a focus-anchored request when the seed is empty', async () => {
    const { result } = renderReply();
    await settle(result);
    apiMocks.suggest.mockImplementation(() => okJson({ chips: ['回应一'], draw: 13 }));

    act(() => {
      result.current.requestExpansion({ focus: '  被引用的原文  ', seed: '' });
    });
    await waitFor(() => assert.deepEqual(result.current.expansionChips, ['回应一']));

    const calls = expansionCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].focus, '被引用的原文');
    assert.equal('seed' in calls[0], false, 'an empty seed is not sent');
    assert.equal(result.current.expansionSource, 'focus');
  });

  it('(d) stops at five expansion requests in one chain', async () => {
    const { result } = renderReply();
    await settle(result);
    apiMocks.suggest.mockImplementation((body: Record<string, unknown>) => okJson({
      chips: [`变体-${String(body.seed ?? '')}`, '另一条'],
      draw: 20,
    }));

    for (let depth = 1; depth <= 5; depth += 1) {
      act(() => {
        result.current.requestExpansion({ seed: `seed-${depth}` });
      });
      await waitFor(() => assert.equal(result.current.expansionDepth, depth));
    }
    assert.equal(expansionCalls().length, 5);
    assert.equal(result.current.canExpand, false);

    act(() => {
      result.current.requestExpansion({ seed: 'seed-6' });
    });
    await flush();
    assert.equal(expansionCalls().length, 5, 'depth 5 is the cap');
  });

  it('(e) clearExpansion drops the chips and resets the chain', async () => {
    const { result } = renderReply();
    await settle(result);
    act(() => {
      result.current.requestExpansion({ seed: '已选定的回复' });
    });
    await waitFor(() => assert.equal(result.current.expansionChips.length, 2));

    act(() => {
      result.current.clearExpansion();
    });
    await flush();

    assert.deepEqual(result.current.expansionChips, []);
    assert.equal(result.current.expansionSource, null);
    assert.equal(result.current.expansionDepth, 0);
  });

  it('(f) a session switch drops an expansion chain, and picked events carry the source', async () => {
    const { result, rerender } = renderReply();
    await settle(result);
    act(() => {
      result.current.requestExpansion({ seed: '已选定的回复' });
    });
    await waitFor(() => assert.equal(result.current.expansionChips.length, 2));

    act(() => {
      result.current.reportEvent('picked', 0, 'seed');
    });
    await flush();
    const picked = apiMocks.event.mock.calls[0][0] as Record<string, unknown>;
    assert.equal(picked.source, 'seed');

    rerender(baseArgs({ sessionId: 'session-b' }));
    await flush();
    assert.deepEqual(result.current.expansionChips, [], 'another conversation owns another draft');
    assert.equal(result.current.expansionDepth, 0);
  });
});

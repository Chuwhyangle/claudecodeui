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
});

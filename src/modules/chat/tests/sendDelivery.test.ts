import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { createSendDelivery, readSendDeliveryTimeoutMs } from '@/modules/chat/utils/session/sendDelivery';
import type { LLMProvider, PermissionMode, Project, ProjectSession, ServerEvent } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * The send path's delivery reading, at the two levels the dock depends on.
 *
 * The pure machine is driven with injected timers so every boundary is exact;
 * the composer is driven through its real submit path so the wiring is covered
 * too — a closed socket fails the send at once (no local "processing" mark, the
 * draft untouched), an open socket that never answers fails at the deadline,
 * and an acknowledged send is the positive control that clears the draft: the
 * "failed sends keep the draft" claim is only meaningful if a delivered one
 * still clears it.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-1' };

const baseProps = () => ({
  selectedProject: PROJECT,
  selectedSession: SESSION,
  currentSessionId: SESSION.id,
  provider: 'claude' as LLMProvider,
  permissionMode: 'default' as PermissionMode,
  cyclePermissionMode: () => undefined,
  resolvePermissionModeForProvider: () => 'default' as PermissionMode,
  currentProviderModel: 'test-model',
  currentProviderEffort: 'medium',
  isLoading: false,
  canAbortSession: false,
  tokenBudget: null,
  sendMessage: () => undefined,
  scrollToBottom: () => undefined,
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
});

const THE_DEADLINE_MS = 1_234;

const injectedDeps = (extra: { timeoutMs?: number; onSettle?: (phase: 'delivered' | 'failed') => void } = {}) => ({
  now: () => Date.now(),
  setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  ...extra,
});

beforeEach(() => {
  // The composer's slash-command hook fetches commands and skills on mount.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })),
  );
  resetUserPreferences();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetUserPreferences();
  localStorage.clear();
});

describe('the send-delivery machine', () => {
  test('stays sending one millisecond before the deadline and fails at it', () => {
    vi.useFakeTimers();
    const delivery = createSendDelivery(injectedDeps({ timeoutMs: THE_DEADLINE_MS }));

    delivery.begin();
    assert.equal(delivery.getPhase(), 'sending', 'a begun send is sending');

    act(() => {
      vi.advanceTimersByTime(THE_DEADLINE_MS - 1);
    });
    assert.equal(
      delivery.getPhase(),
      'sending',
      'one millisecond before the deadline nothing has failed yet',
    );

    act(() => {
      vi.advanceTimersByTime(1);
    });
    assert.equal(delivery.getPhase(), 'failed', 'the deadline itself fails the send');
  });

  test('an acknowledgement settles delivered and disarms the deadline', () => {
    vi.useFakeTimers();
    const settled: string[] = [];
    const delivery = createSendDelivery(injectedDeps({
      timeoutMs: THE_DEADLINE_MS,
      onSettle: (phase) => settled.push(phase),
    }));

    delivery.begin();
    delivery.ack();
    assert.equal(delivery.getPhase(), 'delivered');

    act(() => {
      vi.advanceTimersByTime(THE_DEADLINE_MS * 3);
    });
    assert.equal(delivery.getPhase(), 'delivered', 'a delivered send is never re-failed by its deadline');
    assert.deepEqual(settled, ['delivered'], 'the machine settles exactly once');
  });

  test('the shipped deadline is the default when nothing overrides it', () => {
    vi.useFakeTimers();
    const deadline = readSendDeliveryTimeoutMs();
    assert.ok(deadline > 0, 'the shipped deadline must be a positive duration');

    const delivery = createSendDelivery(injectedDeps());
    delivery.begin();
    act(() => {
      vi.advanceTimersByTime(deadline - 1);
    });
    assert.equal(delivery.getPhase(), 'sending', 'the default deadline is not shortened by anything in this run');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    assert.equal(delivery.getPhase(), 'failed');
  });
});

describe('the composer send path', () => {
  test('a closed socket fails at once, makes no processing mark, and leaves the draft', async () => {
    const onSessionProcessing = vi.fn();
    const sendMessage = vi.fn();
    const view = renderHook(() => useChatComposerState({
      ...baseProps(),
      isConnected: false,
      onSessionProcessing,
      sendMessage,
      addMessage: () => 'local_1',
    }));

    act(() => {
      view.result.current.setInput('the draft that must survive');
    });
    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });

    assert.equal(view.result.current.sendFailed, true, 'a closed socket means the send failed');
    assert.equal(onSessionProcessing.mock.calls.length, 0, 'no local turn is claimed for a send that cannot leave');
    assert.equal(sendMessage.mock.calls.length, 0, 'nothing is handed to a socket that is not open');
    assert.equal(
      view.result.current.input,
      'the draft that must survive',
      'the draft is exactly what the user typed, not cleared and not rewritten',
    );
  });

  test('an open socket that never answers fails at the deadline and keeps the draft', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_SEND_DELIVERY_TIMEOUT_MS', String(THE_DEADLINE_MS));
    const markUserTurnUndelivered = vi.fn();
    const onSessionIdle = vi.fn();
    const view = renderHook(() => useChatComposerState({
      ...baseProps(),
      isConnected: true,
      subscribe: () => () => undefined,
      onSessionIdle,
      markUserTurnUndelivered,
      addMessage: () => 'local_1',
    }));

    act(() => {
      view.result.current.setInput('still here after the deadline');
    });
    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });

    assert.equal(view.result.current.sendFailed, false, 'the send is still open before its deadline');
    act(() => {
      vi.advanceTimersByTime(THE_DEADLINE_MS - 1);
    });
    assert.equal(view.result.current.sendFailed, false, 'one millisecond before the deadline, still sending');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    assert.equal(view.result.current.sendFailed, true, 'the deadline with no answer fails the send');
    assert.equal(
      view.result.current.input,
      'still here after the deadline',
      'a failed send leaves the draft in the box',
    );
    assert.equal(onSessionIdle.mock.calls.length, 1, 'the local turn mark is taken back');
    assert.deepEqual(
      markUserTurnUndelivered.mock.calls.map((call) => call[0]),
      ['local_1'],
      'the optimistic row the failed send added is withdrawn',
    );
  });

  test('an acknowledged send clears the draft (positive control)', async () => {
    const listeners = new Set<(event: ServerEvent) => void>();
    const subscribe = (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const markUserTurnUndelivered = vi.fn();
    const view = renderHook(() => useChatComposerState({
      ...baseProps(),
      isConnected: true,
      subscribe,
      onSessionIdle: vi.fn(),
      markUserTurnUndelivered,
      addMessage: () => 'local_1',
    }));

    act(() => {
      view.result.current.setInput('acknowledged by the server');
    });
    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });

    assert.equal(
      view.result.current.input,
      'acknowledged by the server',
      'the draft waits until the server has taken the message',
    );
    assert.ok(listeners.size > 0, 'the send path must be listening for the answer it awaits');

    act(() => {
      for (const listener of [...listeners]) {
        listener({ kind: 'status', sessionId: SESSION.id, text: 'working', timestamp: new Date().toISOString() });
      }
    });

    assert.equal(
      view.result.current.input,
      '',
      'a delivered send clears the draft — the control that keeps "failed sends keep it" from being "nothing clears it"',
    );
    assert.equal(view.result.current.sendFailed, false, 'a delivered send is not a failed one');
    assert.equal(markUserTurnUndelivered.mock.calls.length, 0, 'a delivered send never withdraws its row');
  });
});

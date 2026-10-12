/**
 * AC-351 (GOAL-041 / SPEC §0.3 D-11) — taking back ONE spoken sentence from the CLI's queue.
 *
 * THE CLAIM. A voice delivery that JOINED the run in flight carries the command's own queue id
 * (`queuedMessageUuid`); the page used to drop it, which left every spoken sentence unwithdrawable.
 * With the id kept, the Live Voice surface can offer exactly one action per held sentence — take
 * that sentence back — and the ONE thing it must never do is stop the run the sentence is waiting
 * behind.
 *
 * WHAT THE HOST DECIDES. Which state a sentence is in is not this client's call: the host's
 * `command_lifecycle` events say it (`started` ⇒ the sentence is a turn now, the button goes;
 * `cancelled` ⇒ it left the queue; `completed` ⇒ the row goes), and the `already-started` verdict on
 * a withdrawal the person actually made is the honest "too late" line. The tests below drive those
 * frames and read the DOM, because "the row says X" is a claim about what a reader sees.
 *
 * FALSIFIABLE FIRST. The file leads with the NEGATIVE form — the withdraw path does NOT call
 * `cancelQueued` where it must not (no queue id; a sentence that already started) — so a green run
 * cannot be reached by a button that fires regardless. The false forms come first on purpose: if the
 * guard this task adds were removed, they red before the positive cases pass.
 *
 * Run: npx vitest run src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { describe, expect, test, vi } from 'vitest';

import {
  useVoicePendingWithdraw,
  VoicePendingUtteranceList,
  type VoiceRealtimeDelivery,
} from '@/modules/chat/voice-realtime';
import type { ServerEvent } from '@/shared/types';

const EN_CHAT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales', 'en', 'chat.json'), 'utf8'),
) as Record<string, unknown>;

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: EN_CHAT } },
  interpolation: { escapeValue: false },
});

const SESSION = 'sess-voice-1';
const UUID = 'cmd-7f3a';

/** The chat websocket's frame stream, as a test can drive it: subscribe, then emit one frame. */
function makeBus() {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (event: ServerEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

/** A delivery the relay confirmed; `queuedMessageUuid` is the one field a withdrawal can use. */
const delivery = (overrides: Partial<VoiceRealtimeDelivery> = {}): VoiceRealtimeDelivery => ({
  message: '把 server 放到 server',
  at: 1_000,
  heard: ['把 server'],
  itemIds: ['a'],
  queuedMessageUuid: UUID,
  ...overrides,
});

type Bus = ReturnType<typeof makeBus>;

/**
 * The pane's shape, minus the pane: the hook owns the state, the list draws the rows, and a raw
 * `withdraw` trigger stands in for a click on a row the DOM no longer draws. `onAbort` is the spy
 * the run's own Stop would use — passed to prove the withdrawal path never reaches it.
 */
function Harness({
  deliveries,
  bus,
  cancelQueued,
  onAbort,
}: {
  deliveries: readonly VoiceRealtimeDelivery[];
  bus: Bus;
  cancelQueued: (sessionId: string, queuedMessageUuid: string) => void;
  onAbort: () => void;
}) {
  const { utterances, withdraw } = useVoicePendingWithdraw({
    sessionId: SESSION,
    deliveries,
    subscribe: bus.subscribe,
    cancelQueued,
  });
  return (
    <div>
      <button type="button" data-testid="run-stop" onClick={onAbort}>
        stop the turn
      </button>
      <button type="button" data-testid="raw-withdraw" onClick={() => withdraw(UUID)}>
        raw withdraw
      </button>
      <VoicePendingUtteranceList utterances={utterances} onWithdraw={withdraw} />
    </div>
  );
}

function renderHarness(deliveries: readonly VoiceRealtimeDelivery[]) {
  const bus = makeBus();
  const cancelQueued = vi.fn();
  const onAbort = vi.fn();
  const utils = render(
    <Harness deliveries={deliveries} bus={bus} cancelQueued={cancelQueued} onAbort={onAbort} />,
  );
  return { ...utils, bus, cancelQueued, onAbort };
}

const withdrawButton = (container: HTMLElement) => container.querySelector('[data-voice-withdraw="true"]');

// ── the false forms, first: where the withdraw path must NOT call cancelQueued ──────────────────

describe('the withdraw path calls cancelQueued only where it must (false forms)', () => {
  test('a delivery with no queue id offers no button, and nothing can call cancelQueued', () => {
    // A send that OPENED a run rather than joining the queue carries no uuid: there is no command to
    // take back. If the row drew a button anyway, this reds on the missing-id delivery — which is
    // exactly the regression the guard exists to catch.
    const { container, cancelQueued } = renderHarness([delivery({ queuedMessageUuid: null })]);
    expect(withdrawButton(container)).toBeNull();
    // Nothing to say about a delivery the queue never took, so not even an empty stack is drawn.
    expect(container.querySelector('[data-testid="voice-pending-utterances"]')).toBeNull();
    expect(cancelQueued).not.toHaveBeenCalled();
  });

  test('withdraw() on a sentence that already started sends nothing', () => {
    const { container, bus, cancelQueued } = renderHarness([delivery()]);
    act(() => bus.emit({ kind: 'command_lifecycle', sessionId: SESSION, commandUuid: UUID, commandState: 'started' }));
    // The row is gone, so no button click is possible — and the raw path must refuse too, or a click
    // that raced the queue would address a command that is no longer held.
    expect(withdrawButton(container)).toBeNull();
    act(() => {
      (container.querySelector('[data-testid="raw-withdraw"]') as HTMLButtonElement).click();
    });
    expect(cancelQueued).not.toHaveBeenCalled();
  });
});

// ── AC2: the button is on a queued sentence and gone once it starts ─────────────────────────────

describe('a queued sentence is offered back; a started one is not', () => {
  test('a queued spoken sentence has a withdraw button', () => {
    const { container } = renderHarness([delivery()]);
    const button = withdrawButton(container);
    expect(button).not.toBeNull();
    // The row is the withdrawable one, and the sentence it is offering back is on it.
    expect(container.querySelector('[data-voice-withdrawable="true"]')?.getAttribute('data-voice-pending-uuid')).toBe(UUID);
    expect(container.textContent).toContain('把 server 放到 server');
  });

  test('once the sentence starts, the button is gone', () => {
    const { container, bus } = renderHarness([delivery()]);
    expect(withdrawButton(container)).not.toBeNull();
    act(() => bus.emit({ kind: 'command_lifecycle', sessionId: SESSION, commandUuid: UUID, commandState: 'started' }));
    expect(withdrawButton(container)).toBeNull();
  });
});

// ── AC3: the click, the two outcomes, and never an abort ────────────────────────────────────────

describe('withdrawing one sentence', () => {
  test('a click calls cancelQueued once with the session and the command id — and never aborts', () => {
    const { container, cancelQueued, onAbort } = renderHarness([delivery()]);
    // Exactly one action is on the row: the withdrawal. A second control (a stop, a clear) is the
    // thing this task must not ship, and its absence is asserted, not assumed.
    expect(container.querySelectorAll('[data-testid="voice-pending-utterance"] button').length).toBe(1);
    act(() => {
      (withdrawButton(container) as HTMLButtonElement).click();
    });
    expect(cancelQueued).toHaveBeenCalledTimes(1);
    expect(cancelQueued).toHaveBeenCalledWith(SESSION, UUID);
    expect(onAbort).not.toHaveBeenCalled();
  });

  test("the host's cancelled event marks the row withdrawn", () => {
    const { container, bus } = renderHarness([delivery()]);
    act(() => bus.emit({ kind: 'command_lifecycle', sessionId: SESSION, commandUuid: UUID, commandState: 'cancelled' }));
    const row = container.querySelector('[data-voice-withdrawn="true"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-voice-pending-uuid')).toBe(UUID);
    expect(withdrawButton(container)).toBeNull();
  });

  test('an already-started verdict is an honest notice, not a button', () => {
    const { container, bus, onAbort } = renderHarness([delivery()]);
    act(() =>
      bus.emit({
        kind: 'queued_input_cancel_result',
        sessionId: SESSION,
        messageUuid: UUID,
        result: 'already-started',
      }),
    );
    const notice = container.querySelector('[data-voice-withdraw-unavailable="already-started"]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('data-voice-pending-uuid')).toBe(UUID);
    // The sentence is a turn now, so there is no longer a button to press.
    expect(withdrawButton(container)).toBeNull();
    expect(onAbort).not.toHaveBeenCalled();
  });

  test('a frame about another session moves nothing', () => {
    const { container, bus } = renderHarness([delivery()]);
    act(() => bus.emit({ kind: 'command_lifecycle', sessionId: 'some-other-session', commandUuid: UUID, commandState: 'cancelled' }));
    // Still queued and withdrawable: the lifecycle was not ours to apply.
    expect(withdrawButton(container)).not.toBeNull();
    expect(container.querySelector('[data-voice-withdrawn="true"]')).toBeNull();
  });

  test('a completed command drops the row entirely', () => {
    const { container, bus } = renderHarness([delivery()]);
    act(() => bus.emit({ kind: 'command_lifecycle', sessionId: SESSION, commandUuid: UUID, commandState: 'completed' }));
    expect(container.querySelector('[data-testid="voice-pending-utterances"]')).toBeNull();
  });
});

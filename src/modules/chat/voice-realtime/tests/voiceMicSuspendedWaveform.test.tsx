import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { describe, expect, test } from 'vitest';

import { VoiceRealtimeBar } from '@/modules/chat/voice-realtime';
import type { VoiceRealtimePhase, VoiceRealtimeSession } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';

/**
 * (this task) AC3 — a microphone suspension greys the waveform, WITHOUT the red error line and
 * WITHOUT moving the Mute state.
 *
 * THE CLAIM. A browser-forced `AudioContext` suspension makes the microphone go silent with no
 * page-visible sign. The operator ruled that this must NOT be the red `error` notice and must NOT
 * read as Mute (Mute is the user's own button, whose `aria-pressed` and label must not move on its
 * own). What it DOES do is grey the level meter's columns, driven by the hook's own `micSuspended`
 * reading — a state machine deliberately separate from `phase === 'muted'`, even though the two
 * greys look the same.
 *
 * This renders the shipping `VoiceRealtimeBar` directly with a constructed `voice` prop — the bar
 * is the unit under test and it needs no live connection to be read. Run:
 *   npx vitest run src/modules/chat/voice-realtime/tests/voiceMicSuspendedWaveform.test.tsx
 */

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: {
    en: {
      chat: JSON.parse(
        readFileSync(resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales', 'en', 'chat.json'), 'utf8'),
      ) as Record<string, unknown>,
    },
  },
  interpolation: { escapeValue: false },
});

/** A bar over a session in `phase`, with `error`/`micSuspended` set as the case needs. */
const renderBar = (phase: VoiceRealtimePhase, micSuspended: boolean) => {
  const voice = {
    phase,
    error: null,
    unansweredSeconds: null,
    captions: [],
    deliveries: [],
    delivering: false,
    queuedDepth: 0,
    queuedBytes: 0,
    refusal: null,
    undelivered: [],
    stopped: null,
    levelRef: { current: 0 },
    connectedAt: Date.now(),
    disconnected: false,
    closedUnshown: 0,
    micSuspended,
    start: () => {},
    startWithFile: () => {},
    mute: () => {},
    unmute: () => {},
    end: () => {},
  } as unknown as VoiceRealtimeSession;
  return render(<VoiceRealtimeBar voice={voice} onExit={() => {}} />);
};

const waveBars = (container: HTMLElement): Element[] =>
  Array.from(container.querySelectorAll('[data-testid="voice-realtime-wave"] > span'));

describe('AC3: a suspended microphone greys the waveform without error or Mute', () => {
  test('listening and unsuspended: every column is the primary tone and no error node exists', () => {
    const { container } = renderBar('listening', false);
    const bars = waveBars(container);
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.className).toContain('bg-primary/70');
      expect(bar.className).not.toContain('bg-muted-foreground/50');
    }
    expect(container.querySelector('[data-testid="voice-realtime-error"]')).toBeNull();
  });

  test('suspended: every column switches to the grey tone, no error node, and aria-pressed stays false', () => {
    const { container } = renderBar('listening', true);
    const bars = waveBars(container);
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.className).toContain('bg-muted-foreground/50');
      expect(bar.className).not.toContain('bg-primary/70');
    }
    // No red line: the suspension is console-only, not an error.
    expect(container.querySelector('[data-testid="voice-realtime-error"]')).toBeNull();
    // The phase is still `listening` — a suspension is not the user's Mute...
    expect(container.querySelector('[data-testid="voice-realtime-phase"]')?.textContent).toBe('listening');
    // ...and the Mute control is not flipped on for a suspension the user never asked for.
    expect(container.querySelector('[data-testid="voice-realtime-mute"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  test('Mute (no suspension) is a different state machine: the waveform stays primary-toned', () => {
    const { container } = renderBar('muted', false);
    const bars = waveBars(container);
    for (const bar of bars) {
      // Grey here comes ONLY from `micSuspended`; the `muted` phase greys the state icon instead,
      // which is what keeps the two states machine-separate even though their greys look alike.
      expect(bar.className).toContain('bg-primary/70');
      expect(bar.className).not.toContain('bg-muted-foreground/50');
    }
    expect(container.querySelector('[data-testid="voice-realtime-mute"]')?.getAttribute('aria-pressed')).toBe('true');
  });
});

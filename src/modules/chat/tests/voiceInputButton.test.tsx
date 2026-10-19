import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { test } from 'vitest';

import VoiceInputButton from '@/modules/chat/composer/VoiceInputButton';
import enChat from '@/modules/i18n/locales/en/chat.json';

/**
 * The in-flight dot on the microphone button.
 *
 * The composer shows that a transcription request is out with a small pulsing dot inside the mic
 * button — no new control, no copy. These readings are the two things that makes true and the one
 * that makes it accessible: the dot exists exactly when `inFlight` is set, and the pulse is gated
 * behind `motion-safe:` so a reader with reduced motion gets a still dot.
 *
 * The class assertion is deliberate and load-bearing: the `motion-safe:` prefix is a real
 * requirement (a constant animation is the thing the accessibility rule forbids), and a rendered
 * element's class list is the only place it can be read without a real browser's media query.
 */

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const renderButton = (state: 'idle' | 'recording' | 'transcribing', inFlight?: boolean) =>
  render(React.createElement(VoiceInputButton, { state, onToggle: () => {}, inFlight }));

test('the dot is drawn while a request is in flight', () => {
  const { getByTestId } = renderButton('recording', true);

  const dot = getByTestId('voice-inflight-dot');
  assert.ok(dot, 'a recording listen with a request out must paint the in-flight dot');
  assert.ok(
    dot.className.includes('motion-safe:animate-pulse'),
    `the dot's pulse must be gated behind motion-safe (class was ${JSON.stringify(dot.className)})`,
  );
});

test('no dot is drawn when nothing is in flight', () => {
  const { queryByTestId } = renderButton('recording', false);
  assert.equal(queryByTestId('voice-inflight-dot'), null, 'the dot must not be painted with no request out');
});

test('an idle button reads its default and draws no dot', () => {
  const { queryByTestId } = renderButton('idle');
  assert.equal(queryByTestId('voice-inflight-dot'), null, 'the default state must not carry a dot');
});

/**
 * The mic's shell in the composer's right group.
 *
 * The mic sits beside the model and permission selectors, whose triggers are bordered muted chips.
 * A bare ghost icon there reads as a missing container, so the mic carries the same chip tokens —
 * a border, the chip radius and the muted fill — rather than the ghost icon it used in the tools
 * group. The one thing it must NOT keep is the ghost hover, whose accent flash would set it apart
 * from the neighbours it is meant to match.
 */
test('the mic renders as a bordered chip like the permission menu trigger', () => {
  const { getByTestId } = renderButton('idle');

  const classes = getByTestId('voice-input-button').className;

  assert.ok(classes.includes('border'), 'the mic must carry a border');
  assert.ok(classes.includes('rounded-lg'), 'the mic must use the chip radius');
  assert.ok(classes.includes('bg-muted/50'), 'the mic must carry the muted chip fill');
  assert.ok(!classes.includes('hover:bg-accent'), 'the mic must not keep the ghost hover');
});

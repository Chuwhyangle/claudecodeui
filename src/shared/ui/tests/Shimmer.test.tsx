import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import { Shimmer } from '@/shared/ui/Shimmer';

/**
 * The working-state label animates opacity and nothing else.
 *
 * `Shimmer` is on screen for the whole length of a turn — the activity dock's
 * `Thinking…`, a streaming plan title, a reasoning placeholder — so any
 * per-frame style or paint work it asks for is a permanent cost. The old
 * implementation swept `background-position` across `bg-clip-text` glyphs,
 * which recalculated style and repainted the text on every frame (measured at
 * ~60 recalcs/s in the running-session CPU criterion). Opacity is the one
 * property the compositor can animate alone.
 *
 * The reading is printed before the assertions so a failure names what the
 * element actually carries, not only what this test wanted it to carry.
 */
test('Shimmer animates opacity, not a background-position sweep', () => {
  const view = render(React.createElement(Shimmer, null, 'Thinking…'));
  const label = view.container.firstElementChild as HTMLElement | null;
  assert.ok(label, 'Shimmer must render an element');

  const className = label.getAttribute('class') ?? '';
  const reading = {
    animation: className.includes('animate-pulse') ? 'opacity-pulse' : 'other',
    hasBackgroundPosition: className.includes('animate-shimmer') || className.includes('background-position'),
    hasClipText: className.includes('bg-clip-text') || className.includes('text-transparent'),
  };
  console.log(
    `animation=${reading.animation} hasBackgroundPosition=${reading.hasBackgroundPosition} hasClipText=${reading.hasClipText}`,
  );

  assert.equal(reading.animation, 'opacity-pulse', `the label must animate opacity; it carried: ${className}`);
  assert.equal(reading.hasBackgroundPosition, false, `no background-position animation is allowed; it carried: ${className}`);
  assert.equal(reading.hasClipText, false, `no gradient-clipped text is allowed; it carried: ${className}`);
  assert.equal(label.textContent, 'Thinking…', 'the label must still carry its text');
});

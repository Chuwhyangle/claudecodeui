/**
 * A transcript row the server marked as machine-authored is drawn as one, on the row itself.
 *
 * THE CLAIM, IN ONE SENTENCE. `ChatMessage.origin` is the server's own statement that nobody at a
 * browser started this turn (a scheduled task firing, a background task reporting back, another
 * conversation writing in); a row carrying it carries the machine-origin mark, and a row without it
 * is drawn exactly as it always was.
 *
 * WHY THE ROW AND NOT ONLY THE DIVIDER. An unattended turn is already introduced by a divider naming
 * its trigger, and that divider is the only thing on screen that says the turn is not a person's. A
 * divider scrolls away, is not drawn for every machine-marked row (a `<task-notification>` row has
 * none), and is absent from a single row read on its own — so "who wrote this" has to be readable off
 * the row. The mark is that statement, placed where it cannot be left behind.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT A STYLE SNAPSHOT. Every reading below is a property of the
 * rendered DOM that a *different* implementation would have to reproduce on purpose: the authorship
 * attribute, the presence of the mark, the mark's accessible name, and — the one that matters most —
 * that the mark contributes no words to the row. The last is not decoration: this row's text content
 * is the sender's own words (that is the whole point of the row, and both the transcript export and
 * the e2e walk read it back as the message), so a badge *label* here would be read as part of what
 * the automation said. The mark is an icon with an accessible name and no text, and this file pins
 * that.
 *
 * THE UNMARKED ARM IS THE REGRESSION HALF. A person's turn must be byte-identical to what it was:
 * no mark, no authorship attribute, and its own bubble. Without this arm the marked arm would also
 * pass against a product that stamped every row machine-authored.
 *
 * WHAT THIS FILE DOES NOT CLAIM. That `session_send` messages arrive carrying the marker. They do
 * not today — the MCP gateway records the run's origin as `source: 'mcp'` on the run registry, and
 * nothing carries it onto the transcript row, so such a message surfaces as an ordinary user turn.
 * That is the protocol half, and it is upstream of this renderer; this file is the render-layer half
 * the task scoped: a row that *is* marked renders as machine-authored. The marked fixture below is
 * the shape the server already publishes today for a message another conversation sent.
 *
 * Run: npx vitest run src/modules/chat/tests/machineOriginRow.test.tsx
 */

import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { test } from 'vitest';

import { UNATTENDED_TURN_MESSAGE_TYPE } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { ChatMessage } from '@/shared/types';

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } } as unknown as Record<string, Record<string, string>>,
  interpolation: { escapeValue: false },
});

/** Epoch base for the two fixture rows' timestamps. */
const T0 = Date.parse('2026-10-13T09:30:00.000Z');

/** The words the automation sent — the row's content, and the whole of its text. */
const MACHINE_TEXT = 'quay-fleet: session acme is blocked on an unlanded prerequisite';

/** The words the person typed. */
const HUMAN_TEXT = 'what did the fleet say about acme?';

/**
 * A row carrying the machine-origin marker, as the server publishes one today: the trigger is the
 * closed-set vocabulary's cross-session member and the sender is the address the sending
 * conversation answers to.
 */
const MACHINE_ROW: ChatMessage = {
  type: UNATTENDED_TURN_MESSAGE_TYPE,
  content: MACHINE_TEXT,
  timestamp: T0,
  origin: { trigger: 'cross-session', sender: 'quay-fleet' },
};

/** The control: the same transcript, one turn a person typed. No `origin`, so nothing to read. */
const HUMAN_ROW: ChatMessage = {
  type: 'user',
  content: HUMAN_TEXT,
  timestamp: T0,
};

/** Render one row through the real `MessageComponent` and hand back its rendered root. */
function renderRow(message: ChatMessage): HTMLElement {
  const { container } = render(
    <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />,
  );
  const row = container.querySelector<HTMLElement>('[data-message-style]');
  assert.ok(row, 'the row must render');
  return row;
}

test('a message the server marked machine-authored carries the marker on the row', () => {
  const row = renderRow(MACHINE_ROW);

  assert.equal(
    row.getAttribute('data-message-origin'),
    'machine',
    'the row states its own authorship rather than leaving it to the divider beside it',
  );
  assert.notEqual(
    row.getAttribute('data-message-style'),
    'user',
    'a machine-marked turn must not wear the reader\'s own bubble style',
  );
});

test('the machine-origin mark states itself to a screen reader and adds no words to the message', () => {
  const row = renderRow(MACHINE_ROW);

  const mark = row.querySelector('[data-machine-origin-mark]');
  assert.ok(mark, 'a machine-marked row draws the mark');

  // Read off the accessible name rather than the attribute, so "the mark is named" is a fact about
  // what a reader is told and not about which prop was passed: an aria-hidden icon, or one whose
  // label never reached the tree, fails here.
  const labelled = row.querySelector('[role="img"]');
  assert.ok(labelled, 'the mark is exposed as an image, so its label is not decoration');
  const name = labelled.getAttribute('aria-label') ?? '';
  assert.match(name, /automated/i, `the mark names what it means (got ${JSON.stringify(name)})`);

  // The half that keeps the mark honest: the row's text is the sender's own words, all of them and
  // nothing else. A badge that spelled "Automated" here would be read back as part of the message by
  // the export and by the e2e walk — both of which read this row's text and expect the turn's words.
  assert.equal(
    row.textContent?.trim(),
    MACHINE_TEXT,
    'the mark must not become a word in the message it marks',
  );
});

test('a message without the marker renders unchanged: no mark, no authorship, its own bubble', () => {
  const row = renderRow(HUMAN_ROW);

  assert.equal(
    row.getAttribute('data-message-origin'),
    null,
    'a person\'s turn is not marked machine-authored',
  );
  assert.equal(
    row.querySelector('[data-machine-origin-mark]'),
    null,
    'a person\'s turn draws no machine mark',
  );
  assert.equal(
    row.getAttribute('data-message-style'),
    'user',
    'a person\'s turn still renders in the user\'s own bubble',
  );
  assert.ok(
    row.textContent?.includes(HUMAN_TEXT),
    'and still shows what the person said',
  );
});

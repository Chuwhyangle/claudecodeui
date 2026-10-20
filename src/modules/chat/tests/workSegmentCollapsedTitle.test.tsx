import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { ChatMessage, WorkSegment } from '@/shared/types';
import WorkSegmentRecord from '@/modules/chat/transcript/WorkSegmentRecord';
import { formatToolDisplayName, getToolConfig } from '@/modules/chat/tools/configs/toolConfigs';
import { getMemberActionLabel } from '@/modules/chat/utils/transcript/workSegmentTitle';

/**
 * AC-208: the collapsed work-segment header carries three readings — the run's
 * current action, its member count, and its elapsed span — and all three are
 * derived from the segment, track it as it grows, and freeze when it stops.
 *
 * The readings are taken off the collapsed header's DOM, so "the title carries
 * them" is a rendered fact rather than an internal call tally. The expected
 * action is derived from the same source the member's own row renders from
 * (`getToolConfig` / the agent type / the reasoning trigger's word), never from
 * the row's prose — so a title that guessed an action from `content` or
 * `displayText` shows up as a mismatch, and a title that hardcoded one shows up
 * as equal for two different last members.
 */

/** Epoch base for the fixture's row timestamps. */
const T0 = Date.parse('2026-10-02T12:00:00.000Z');

/** Prose that must never reach the title: an action guessed from a row's text fails against it. */
const POISON = 'SENTINEL-PROSE-DO-NOT-NAME-ME';

const row = (id: string, timestamp: number, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  // Both prose fields carry the poison: a title that reads either to guess an
  // action renders it and is caught.
  content: POISON,
  displayText: POISON,
  timestamp,
  id,
  blockKey: `block-${id}`,
  ...overrides,
});

const thinkingRow = (id: string, timestamp: number): ChatMessage =>
  row(id, timestamp, { isThinking: true });

const toolRow = (id: string, timestamp: number, toolName: string): ChatMessage =>
  row(id, timestamp, { isToolUse: true, toolName });

const subagentRow = (id: string, timestamp: number): ChatMessage =>
  row(id, timestamp, {
    isSubagentContainer: true,
    subagent: { id: `sub-${id}`, type: 'Explore', status: 'completed' },
  });

const segmentOf = (messages: ChatMessage[]): WorkSegment => ({
  _isWorkSegment: true,
  key: messages[0]?.id ?? null,
  messages,
});

/** Renders a member's id into the DOM so a mounted row can be collected by query. */
const renderMember = (message: ChatMessage, index: number) => (
  <div data-message-key={message.id ?? `row-${index}`}>{message.content ?? ''}</div>
);

/** The collapsed header's toggle — the one button the record draws. */
const headerButton = (container: HTMLElement): HTMLButtonElement => {
  const button = container.querySelector('button[aria-expanded]');
  assert.ok(button, 'the record must draw one header button');
  return button as HTMLButtonElement;
};

const actionOf = (container: HTMLElement): string =>
  container.querySelector('[data-work-segment-action]')?.textContent?.trim() ?? '';

const countOf = (container: HTMLElement): number =>
  Number(container.querySelector('[data-work-segment-count]')?.getAttribute('data-work-segment-count'));

const elapsedOf = (container: HTMLElement): number =>
  Number(
    container.querySelector('[data-work-segment-elapsed-ms]')?.getAttribute('data-work-segment-elapsed-ms'),
  );

/** The action the member's own row shows, from the same source the row renders from. */
const rowAction = (message: ChatMessage): string => {
  if (message.isToolUse) {
    const toolName = message.toolName || 'UnknownTool';
    return getToolConfig(toolName).input.label || formatToolDisplayName(toolName);
  }
  return getMemberActionLabel(message);
};

test('collapsed title carries action, count and elapsed', () => {
  // Four members spanning all three kinds the segment absorbs, with the last
  // member a tool call so the title's action is that member's label.
  const thinking = thinkingRow('m1', T0);
  const read = toolRow('m2', T0 + 1000, 'Read');
  const explore = subagentRow('m3', T0 + 2000);
  const bash = toolRow('m4', T0 + 5000, 'Bash');
  const segment = segmentOf([thinking, read, explore, bash]);

  const { container } = render(
    <WorkSegmentRecord segment={segment} expanded={false} renderMember={renderMember} />,
  );

  const action = actionOf(container);
  assert.equal(action, rowAction(bash), 'the title action must be the last member’s own label');
  assert.ok(!action.includes(POISON), 'the title must not derive the action from the row’s prose');
  assert.equal(countOf(container), 4, 'the title count must be the segment’s member count');
  assert.equal(elapsedOf(container), 5000, 'the elapsed span must run from the first member to the last');

  // Not a constant: a different last member must yield a different action.
  const other = render(
    <WorkSegmentRecord segment={segmentOf([thinking, read, explore])} expanded={false} renderMember={renderMember} />,
  );
  assert.equal(actionOf(other.container), 'Explore', 'the title action must follow the last member');
  assert.notEqual(actionOf(other.container), action, 'two different last members must not share one action');

  // Each member kind is named the way its own row names it, so the title's action
  // shares the member renderer's source rather than inventing a vocabulary.
  assert.equal(getMemberActionLabel(thinking), 'Thinking');
  assert.equal(getMemberActionLabel(read), rowAction(read));
  assert.equal(getMemberActionLabel(explore), 'Explore');
});

test('title tracks the growing segment while collapsed', () => {
  // The run as it streams: one member, then three appends. Each step keeps the
  // header collapsed and must move the count, the last member's action and the
  // elapsed span.
  const steps: ChatMessage[][] = [
    [thinkingRow('m1', T0)],
    [thinkingRow('m1', T0), toolRow('m2', T0 + 1000, 'Read')],
    [thinkingRow('m1', T0), toolRow('m2', T0 + 1000, 'Read'), toolRow('m3', T0 + 2000, 'Bash')],
    [
      thinkingRow('m1', T0),
      toolRow('m2', T0 + 1000, 'Read'),
      toolRow('m3', T0 + 2000, 'Bash'),
      subagentRow('m4', T0 + 4000),
    ],
  ];

  const { container, rerender } = render(
    <WorkSegmentRecord segment={segmentOf(steps[0])} expanded={false} renderMember={renderMember} />,
  );
  assert.equal(countOf(container), 1, 'the run starts with one member');
  let previousElapsed = elapsedOf(container);

  for (let step = 1; step < steps.length; step += 1) {
    const members = steps[step];
    const last = members[members.length - 1];

    // Rerender the SAME record with the grown segment — not a remount — so a
    // title computed once at mount cannot pass by being recomputed from scratch.
    rerender(
      <WorkSegmentRecord segment={segmentOf(members)} expanded={false} renderMember={renderMember} />,
    );

    assert.equal(countOf(container), step + 1, `count must grow to ${step + 1} on append ${step}`);
    assert.equal(actionOf(container), rowAction(last), `the action must follow the new last member on append ${step}`);
    assert.equal(
      headerButton(container).getAttribute('aria-expanded'),
      'false',
      'the header must stay collapsed as the run grows',
    );

    const elapsed = elapsedOf(container);
    assert.ok(elapsed >= previousElapsed, `the elapsed span must not decrease (append ${step})`);
    previousElapsed = elapsed;
  }

  assert.equal(countOf(container), 4, 'three appends must bring the run to four members');
  assert.equal(actionOf(container), 'Explore', 'the title must end on the segment’s last member');
  assert.ok(previousElapsed >= 4000, 'the elapsed span must reach the grown run’s last timestamp');
});

test('title freezes and stays collapsed at end of run', () => {
  vi.useFakeTimers();
  try {
    // The run has settled: the last member is no longer streaming.
    const members = [
      thinkingRow('m1', T0),
      toolRow('m2', T0 + 1000, 'Read'),
      row('m3', T0 + 3000, {
        isSubagentContainer: true,
        isStreaming: false,
        subagent: { id: 'sub-m3', type: 'Explore', status: 'completed' },
      }),
    ];
    const segment = segmentOf(members);

    const { container, rerender } = render(
      <WorkSegmentRecord segment={segment} expanded={false} renderMember={renderMember} />,
    );
    const frozenElapsed = elapsedOf(container);
    assert.equal(frozenElapsed, 3000, 'the settled run’s span must be its members’ span');
    assert.equal(actionOf(container), 'Explore', 'the settled run’s action must be its last member’s');

    // Re-render several times with the clock moving: the title is a function of
    // the segment, so nothing about it may drift, and the header may not expand
    // itself just because the run stopped growing.
    for (let round = 0; round < 3; round += 1) {
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      rerender(
        <WorkSegmentRecord segment={segment} expanded={false} renderMember={renderMember} />,
      );

      assert.equal(elapsedOf(container), frozenElapsed, `the elapsed span must stay frozen (round ${round})`);
      assert.equal(actionOf(container), 'Explore', `the action must stay frozen (round ${round})`);
      assert.equal(countOf(container), 3, `the count must stay frozen (round ${round})`);
      assert.equal(
        headerButton(container).getAttribute('aria-expanded'),
        'false',
        `a settled run must not auto-expand (round ${round})`,
      );
    }
  } finally {
    vi.useRealTimers();
  }
});

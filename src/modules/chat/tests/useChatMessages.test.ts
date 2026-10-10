import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';

function message(
  id: string,
  overrides: Partial<NormalizedMessage>,
): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1',
    timestamp: '2026-08-19T12:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: id,
    ...overrides,
  };
}

test('preserves historical UI message identity when only the stream record changes', () => {
  const first = message('first', { content: 'First answer' });
  const second = message('second', { content: 'Second answer' });
  // A live shape, because that is the only shape the store ever mints for a
  // `stream_delta` row (`useSessionStore.updateStreaming`). The id is the one
  // field of the row that survives a delta re-mint, so it is what the row is
  // keyed by; a server-shaped id here would be a fixture the product cannot
  // produce.
  const firstStream = message('live:session-1:1', {
    kind: 'stream_delta',
    content: 'Part one',
  });

  const initial = normalizedToChatMessages([first, second, firstStream]);
  const nextStream = { ...firstStream, content: 'Part one and two' };
  const updated = normalizedToChatMessages([first, second, nextStream]);

  assert.notStrictEqual(updated, initial);
  assert.strictEqual(updated[0], initial[0]);
  assert.strictEqual(updated[1], initial[1]);
  assert.notStrictEqual(updated[2], initial[2]);
  assert.equal(updated[2]?.content, 'Part one and two');
});

test('draws no row for a stream_delta this client did not mint', () => {
  // The negative half of the pair below. The only producer of a `stream_delta`
  // row is this client's own streaming update, which always stamps a live id,
  // so a row carrying any other id is one this client cannot key as its own.
  // Drawing it would leave a fragment in the transcript that nothing can
  // supersede — both pruning passes compare full text, and a fragment never
  // equals the finished reply — so it is refused here instead.
  const foreign = message('server-shaped-id', {
    kind: 'stream_delta',
    content: 'a fragment nobody can retire',
  });

  const converted = normalizedToChatMessages([foreign]);

  assert.deepEqual(converted, []);
});

test('still draws — and updates in place — a stream_delta carrying a live row id', () => {
  // The positive half. The guard narrows the `stream_delta` case, it does not
  // disable it: delete the `isLiveRowId` check and the test above goes red while
  // this one stays green, which is what makes the pair a control rather than a
  // tautology.
  const live = message('live:session-1:3', {
    kind: 'stream_delta',
    content: 'Part one',
  });

  const initial = normalizedToChatMessages([live]);
  assert.equal(initial.length, 1);
  assert.equal(initial[0]?.type, 'assistant');
  assert.equal(initial[0]?.isStreaming, true);
  assert.equal(initial[0]?.id, 'live:session-1:3');
  assert.equal(initial[0]?.content, 'Part one');

  // A delta re-mints the row with fresh text and a fresh timestamp but keeps the
  // id, so the row is rebuilt rather than appended to.
  const updated = normalizedToChatMessages([
    { ...live, content: 'Part one and two', timestamp: '2026-08-19T12:00:01.000Z' },
  ]);
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.id, 'live:session-1:3');
  assert.equal(updated[0]?.content, 'Part one and two');
});

test('rebuilds a tool-use UI message when its separately received result changes', () => {
  const toolUse = message('tool-use', {
    kind: 'tool_use',
    toolId: 'tool-1',
    toolName: 'Read',
    toolInput: { file_path: 'README.md' },
  });

  const withoutResult = normalizedToChatMessages([toolUse]);
  assert.equal(withoutResult[0]?.toolResult, null);

  const toolResult = message('tool-result', {
    kind: 'tool_result',
    toolId: 'tool-1',
    content: 'file contents',
  });
  const withResult = normalizedToChatMessages([toolUse, toolResult]);

  assert.equal(withResult.length, 1);
  assert.notStrictEqual(withResult[0], withoutResult[0]);
  assert.deepEqual(withResult[0]?.toolResult, {
    content: 'file contents',
    isError: false,
    toolUseResult: undefined,
  });

  const unrelatedStream = message('live:session-1:2', {
    kind: 'stream_delta',
    content: 'Still working',
  });
  const afterUnrelatedUpdate = normalizedToChatMessages([
    toolUse,
    toolResult,
    unrelatedStream,
  ]);
  assert.strictEqual(afterUnrelatedUpdate[0], withResult[0]);

  const changedToolResult = {
    ...toolResult,
    content: 'updated file contents',
  };
  const afterResultChange = normalizedToChatMessages([
    toolUse,
    changedToolResult,
    unrelatedStream,
  ]);

  assert.notStrictEqual(afterResultChange[0], afterUnrelatedUpdate[0]);
  assert.strictEqual(afterResultChange[1], afterUnrelatedUpdate[1]);
  assert.equal(afterResultChange[0]?.toolResult?.content, 'updated file contents');
});

test('preserves existing UI objects when an older message is prepended', () => {
  const first = message('first', { content: 'First loaded message' });
  const second = message('second', { content: 'Second loaded message' });
  const initial = normalizedToChatMessages([first, second]);

  const older = message('older', {
    content: 'Older paginated message',
    timestamp: '2026-08-18T12:00:00.000Z',
  });
  const withOlderHistory = normalizedToChatMessages([older, first, second]);

  assert.strictEqual(withOlderHistory[1], initial[0]);
  assert.strictEqual(withOlderHistory[2], initial[1]);
});

test('preserves both UI objects produced by an unchanged task notification', () => {
  const notification = message('task-notification', {
    role: 'user',
    content: [
      '<task-notification>',
      '<status>completed</status>',
      '<summary>Background task finished</summary>',
      '<result>Detailed result</result>',
      '</task-notification>',
    ].join('\n'),
  });

  const initial = normalizedToChatMessages([notification]);
  assert.equal(initial.length, 2);

  const unrelated = message('unrelated', { content: 'A later message' });
  const updated = normalizedToChatMessages([notification, unrelated]);

  assert.strictEqual(updated[0], initial[0]);
  assert.strictEqual(updated[1], initial[1]);
  assert.equal(updated[0]?.isTaskNotification, true);
  assert.equal(updated[1]?.content, 'Detailed result');
});

test('a task-notification carrying an origin still projects as a notification, never as an unattended turn', () => {
  // The provider stamps `origin: { trigger: 'background-task', sender: null }`
  // on every `<task-notification>` row it normalizes, because the host layer
  // opened that row and no person typed it. The projection must still read it
  // as the notification it is: if the origin branch ran first, the row would
  // become an unattended turn whose `content` is the raw XML, and the whole
  // `<task-notification>…` block would be painted as the body.
  const notification = message('task-notification-with-origin', {
    role: 'user',
    origin: { trigger: 'background-task', sender: null },
    content: [
      '<task-notification>',
      '<task-id>monitor-1</task-id>',
      '<status>completed</status>',
      '<summary>Monitor event: "build finished"</summary>',
      '<event>build finished</event>',
      '</task-notification>',
    ].join('\n'),
  });

  const converted = normalizedToChatMessages([notification]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.type, 'assistant');
  assert.equal(converted[0]?.isTaskNotification, true);
  assert.equal(converted[0]?.content, 'Monitor event: "build finished"');
  assert.ok(!converted[0]?.content.includes('<task-notification>'), 'the raw XML must not become the row body');
  assert.ok(converted.every((row) => row.type !== 'unattended-divider'), 'a notification is not an unattended turn');
  assert.ok(converted.every((row) => row.type !== 'unattended'), 'a notification is not an unattended turn');
});

test('a cross-session peer message still draws the divider and the unattended turn', () => {
  // The control for the test above: the reorder that keeps notifications as
  // notifications must NOT swallow the other host-opened cause. A peer message
  // carries an origin too, but it is not a `<task-notification>`, so it keeps
  // rendering as a divider plus an unattended turn carrying the sender's body.
  const peer = message('peer-message', {
    role: 'user',
    origin: { trigger: 'cross-session', sender: 'peer-session' },
    content: 'Peer question: what changed?',
  });

  const converted = normalizedToChatMessages([peer]);

  assert.deepEqual(converted.map((row) => row.type), ['unattended-divider', 'unattended']);
  assert.equal(converted[1]?.content, 'Peer question: what changed?');
  assert.deepEqual(converted[1]?.origin, { trigger: 'cross-session', sender: 'peer-session' });
});

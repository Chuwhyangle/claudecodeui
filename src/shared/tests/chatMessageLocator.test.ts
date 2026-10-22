import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  consumePendingLocateRequest,
  readPendingLocateRequest,
  requestLocateMessage,
  subscribeToLocateRequests,
  type ChatMessageLocateRequest,
} from '@/shared/chatMessageLocator';

/**
 * The locate seam's contract:
 *  · a request is announced to every current subscriber;
 *  · the latest request is remembered until the chat consumes it, so a click
 *    made while the Chat tab is hidden is not lost;
 *  · unsubscribing stops delivery;
 *  · an empty id is ignored rather than sent as a destination.
 */

beforeEach(() => {
  consumePendingLocateRequest();
});

test('a request reaches every subscriber and stays pending until consumed', () => {
  const first: ChatMessageLocateRequest[] = [];
  const second: ChatMessageLocateRequest[] = [];
  const unsubscribeFirst = subscribeToLocateRequests((request) => first.push(request));
  const unsubscribeSecond = subscribeToLocateRequests((request) => second.push(request));

  requestLocateMessage('message-42');

  assert.deepEqual(first, [{ messageId: 'message-42' }], 'the first subscriber hears the request');
  assert.deepEqual(second, [{ messageId: 'message-42' }], 'the second subscriber hears it too');
  assert.deepEqual(readPendingLocateRequest(), { messageId: 'message-42' }, 'the request is remembered');

  assert.deepEqual(consumePendingLocateRequest(), { messageId: 'message-42' });
  assert.equal(readPendingLocateRequest(), null, 'consuming clears the pending request');
  assert.equal(consumePendingLocateRequest(), null, 'a second consume finds nothing');

  unsubscribeFirst();
  unsubscribeSecond();
});

test('unsubscribing stops delivery', () => {
  const received: ChatMessageLocateRequest[] = [];
  const unsubscribe = subscribeToLocateRequests((request) => received.push(request));

  requestLocateMessage('one');
  unsubscribe();
  requestLocateMessage('two');

  assert.deepEqual(received, [{ messageId: 'one' }], 'an unsubscribed listener must not be called again');
  // The request still lands in the store: a chat pane that re-subscribes reads
  // it from the pending slot rather than depending on a listener that was gone.
  assert.deepEqual(readPendingLocateRequest(), { messageId: 'two' });
});

test('the latest request wins and an empty id is ignored', () => {
  const received: ChatMessageLocateRequest[] = [];
  const unsubscribe = subscribeToLocateRequests((request) => received.push(request));

  requestLocateMessage('first');
  requestLocateMessage('second');
  requestLocateMessage('   ');
  requestLocateMessage('');

  assert.deepEqual(received, [{ messageId: 'first' }, { messageId: 'second' }], 'blank ids must not be delivered');
  assert.deepEqual(readPendingLocateRequest(), { messageId: 'second' }, 'the latest destination is the one kept');

  unsubscribe();
});

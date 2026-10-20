import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBoundedLedger,
  MAX_REMEMBERED_APPROVALS,
  type BoundedLedger,
} from '@/shared/bounded-approval-ledger.js';

/**
 * The one bounded-approval policy the debug agent and the Claude runtime share.
 *
 * AC-287 requires the MCP `approval_answer` surface to tell an id that was HELD and then dropped
 * from one that was never minted. Both runtimes answer that from a bounded ledger beside their live
 * pending map, so the ledger's ORDER is the whole contract: re-remembering an id must make it the
 * newest survivor, the oldest id must be the one a cap overflow drops, and an id that was dropped
 * must read as the conservative reason rather than as a decision nobody made. These cases read
 * those facts back off the ledger's own `keys()` order and out of the same expressions the two
 * runtimes use to classify a missing id.
 */

test('re-remembering an id moves it to the newest end (read-back order)', () => {
  const ledger = createBoundedLedger<number>(3);
  ledger.remember('request-a', 1);
  ledger.remember('request-b', 2);
  ledger.remember('request-c', 3);

  // Reading 1: the initial order is the insertion order, oldest first.
  assert.deepEqual(ledger.keys(), ['request-a', 'request-b', 'request-c']);

  // The same id arriving again must not keep its old position.
  ledger.remember('request-a', 1);

  // Reading 2: `request-a` is now the newest, so it is the LAST candidate for eviction.
  assert.deepEqual(ledger.keys(), ['request-b', 'request-c', 'request-a']);
  assert.equal(ledger.size, 3, 're-remembering an existing id does not grow the ledger');
});

test('an insert past the cap evicts the oldest id', () => {
  const ledger = createBoundedLedger<number>(3);
  ledger.remember('request-1', 1);
  ledger.remember('request-2', 2);
  ledger.remember('request-3', 3);
  ledger.remember('request-4', 4);

  // Reading 3: the overflow dropped exactly the oldest id and kept the cap.
  assert.equal(ledger.has('request-1'), false, 'the oldest id is the one evicted');
  assert.deepEqual(ledger.keys(), ['request-2', 'request-3', 'request-4']);
  assert.equal(ledger.size, 3);
});

test('querying an evicted id reads the conservative reason, never a decision', () => {
  // The two runtimes answer "why is this id missing?" with this exact expression over the held
  // ledger (`debug-agent.provider.ts` and `claude-runtime.provider.ts` both spell it the same way).
  const heldReason = (ledger: BoundedLedger<true>, id: string) =>
    (ledger.has(id) ? 'expired' : 'never_issued');

  const held = createBoundedLedger<true>(2);
  held.remember('held-1', true);
  held.remember('held-2', true);
  held.remember('held-3', true);

  // Reading 4: a remembered id reads `expired`; the evicted id degrades to `never_issued`.
  assert.equal(heldReason(held, 'held-3'), 'expired');
  assert.equal(heldReason(held, 'held-1'), 'never_issued', 'an evicted id must not read as expired');

  // The decision ledger has the same conservative fallback: an evicted decision reads absent, so
  // the caller falls back to the missing-approval classification instead of `ALREADY_DECIDED`.
  const decisions = createBoundedLedger<{ decidedBy: string | null; allow: boolean | null; decidedAt: number }>(2);
  decisions.remember('decided-1', { decidedBy: 'caller-1', allow: true, decidedAt: 1 });
  decisions.remember('decided-2', { decidedBy: 'caller-2', allow: false, decidedAt: 2 });
  decisions.remember('decided-3', { decidedBy: 'caller-3', allow: true, decidedAt: 3 });

  // Reading 5: the surviving decision is readable verbatim; the evicted one is `undefined`.
  assert.deepEqual(decisions.read('decided-3'), { decidedBy: 'caller-3', allow: true, decidedAt: 3 });
  assert.equal(decisions.read('decided-1'), undefined, 'an evicted decision is not a lost race');
  assert.equal(decisions.read('never-minted'), undefined);
});

test('the default capacity is the shared MAX_REMEMBERED_APPROVALS', () => {
  const ledger = createBoundedLedger<true>();
  for (let index = 0; index < MAX_REMEMBERED_APPROVALS; index += 1) {
    ledger.remember(`id-${index}`, true);
  }
  assert.equal(ledger.size, MAX_REMEMBERED_APPROVALS, 'the ledger is full at the shared cap');

  ledger.remember('one-past-the-cap', true);

  assert.equal(ledger.size, MAX_REMEMBERED_APPROVALS, 'the cap is a ceiling, not a trigger to grow');
  assert.equal(ledger.has('id-0'), false, 'the oldest id is evicted at the shared cap');
  assert.equal(ledger.has('one-past-the-cap'), true);
});

test('a capacity that cannot bound anything is rejected', () => {
  assert.throws(() => createBoundedLedger<true>(0), RangeError);
  assert.throws(() => createBoundedLedger<true>(-1), RangeError);
  assert.throws(() => createBoundedLedger<true>(1.5), RangeError);
});

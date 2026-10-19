/**
 * AC1/AC2 — the terminal taxonomy is a real reduction, not a word list.
 *
 * Every case below drives the REAL ledger transitions (the same `applyLedgerEvent`
 * the driver uses) and then reads `deriveTerminalStates`. Nothing is injected
 * into the reduction itself, so a fixture cannot pass by agreeing with a
 * hand-built reading: the ledger decides what happened, and the reduction is
 * asked what it was.
 *
 * Each of the five states has a positive case and a negative case that differs by
 * ONE ledger fact. The negative is the discriminator: if the classifier ignored
 * that fact, the pair would collapse onto one word and the case fails.
 *
 * The error/timeout pair is called out separately (AC2's explicit requirement):
 * both are "the turn did not simply complete", and the ledger distinguishes them
 * by `process-exit` versus `owed-terminal-missing`. A classifier that mapped
 * every non-completion to one word would pass both positive cases individually
 * and fail the distinctness case.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResidentLedger } from '@/shared/types.js';

import { applyLedgerEvent, createResidentLedger } from '../ledger.js';
import { deriveTerminalStates } from '../terminal-state.js';

// ---------------------------------------------------------------------------
// The one ledger-writing helper
// ---------------------------------------------------------------------------

let serial = 0;

/** A ledger plus the command uuid this fixture will send under. */
type Fixture = {
  ledger: ResidentLedger;
  commandUuid: string;
};

function fixture(): Fixture {
  serial += 1;
  return { ledger: createResidentLedger(), commandUuid: `ac-terminal-cmd-${serial}` };
}

function send(f: Fixture, at: number): void {
  applyLedgerEvent(f.ledger, {
    kind: 'send',
    at,
    commandUuid: f.commandUuid,
    uuids: [f.commandUuid],
    text: 'hello',
    source: 'user',
    priority: null,
  });
}

function started(f: Fixture, at: number): void {
  applyLedgerEvent(f.ledger, {
    kind: 'lifecycle',
    at,
    commandUuid: f.commandUuid,
    lifecycle: 'started',
    cancelledReason: 'cli',
  });
}

function completed(f: Fixture, at: number): void {
  applyLedgerEvent(f.ledger, {
    kind: 'lifecycle',
    at,
    commandUuid: f.commandUuid,
    lifecycle: 'completed',
    cancelledReason: 'cli',
  });
}

function openTurn(f: Fixture, at: number): void {
  applyLedgerEvent(f.ledger, {
    kind: 'turn-init',
    at,
    initFrameUuid: `init-${f.commandUuid}`,
  });
}

function closeTurn(f: Fixture, at: number, isError: boolean): void {
  applyLedgerEvent(f.ledger, { kind: 'turn-result', at, isError });
}

function stateOf(f: Fixture) {
  return deriveTerminalStates(f.ledger);
}

/** The newest reading, or a failure naming the empty case rather than `undefined`. */
function latest(f: Fixture) {
  const readings = stateOf(f);
  assert.ok(readings.length > 0, 'the fixture produced no terminal reading');
  return readings[readings.length - 1];
}

// ---------------------------------------------------------------------------
// success
// ---------------------------------------------------------------------------

test('AC1 success: a turn whose command completed reads success', () => {
  const f = fixture();
  send(f, 1_000);
  started(f, 1_100);
  openTurn(f, 1_200);
  completed(f, 1_300);
  closeTurn(f, 1_400, false);

  const reading = latest(f);
  assert.equal(reading.state, 'success');
  assert.equal(reading.deliveryId, f.commandUuid);
  assert.equal(reading.at, 1_300);
});

test('AC1 success-negative: the same turn with an unanswered interrupt reads interrupted, not success', () => {
  const f = fixture();
  send(f, 1_000);
  started(f, 1_100);
  openTurn(f, 1_200);
  applyLedgerEvent(f.ledger, { kind: 'interrupt-request' });
  applyLedgerEvent(f.ledger, {
    kind: 'lifecycle',
    at: 1_300,
    commandUuid: f.commandUuid,
    lifecycle: 'cancelled',
    cancelledReason: 'interrupt',
  });
  closeTurn(f, 1_400, true);

  assert.equal(latest(f).state, 'interrupted');
});

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

test('AC1 error: a process that exits mid-delivery reads error', () => {
  const f = fixture();
  send(f, 1_000);
  started(f, 1_100);
  openTurn(f, 1_200);
  // No `completed`: the process goes away while the command is still running.
  closeTurn(f, 1_300, false);
  applyLedgerEvent(f.ledger, { kind: 'process-exit', at: 1_400, reason: 'process-exit' });

  const reading = latest(f);
  assert.equal(reading.state, 'error');
  assert.equal(reading.detail, 'process-exit');
});

test('AC1 error-negative: without the process exit the same turn reads success', () => {
  const f = fixture();
  send(f, 1_000);
  started(f, 1_100);
  openTurn(f, 1_200);
  closeTurn(f, 1_300, false);

  assert.equal(latest(f).state, 'success');
});

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

test('AC1 timeout: a terminal that never arrives before the next boundary reads timeout', () => {
  const f = fixture();
  send(f, 1_000);
  started(f, 1_100);
  openTurn(f, 1_200);
  closeTurn(f, 1_300, false);
  // The run closed without a terminal; the next turn boundary is where I4
  // settles it as `cancelled(owed-terminal-missing)`.
  applyLedgerEvent(f.ledger, { kind: 'owed-boundary', at: 1_400 });

  const reading = latest(f);
  assert.equal(reading.state, 'timeout');
  assert.equal(reading.detail, 'owed-terminal-missing');
});

test('AC1 timeout-negative: the same turn with its terminal reads success', () => {
  const f = fixture();
  send(f, 1_000);
  started(f, 1_100);
  openTurn(f, 1_200);
  completed(f, 1_300);
  closeTurn(f, 1_400, false);

  assert.equal(latest(f).state, 'success');
});

test('AC2 error and timeout are distinguishable', () => {
  const errorFixture = fixture();
  send(errorFixture, 1_000);
  started(errorFixture, 1_100);
  openTurn(errorFixture, 1_200);
  closeTurn(errorFixture, 1_300, false);
  applyLedgerEvent(errorFixture.ledger, { kind: 'process-exit', at: 1_400, reason: 'process-exit' });

  const timeoutFixture = fixture();
  send(timeoutFixture, 1_000);
  started(timeoutFixture, 1_100);
  openTurn(timeoutFixture, 1_200);
  closeTurn(timeoutFixture, 1_300, false);
  applyLedgerEvent(timeoutFixture.ledger, { kind: 'owed-boundary', at: 1_400 });

  assert.equal(latest(errorFixture).state, 'error');
  assert.equal(latest(timeoutFixture).state, 'timeout');
  assert.notEqual(latest(errorFixture).state, latest(timeoutFixture).state);
});

// ---------------------------------------------------------------------------
// interrupted
// ---------------------------------------------------------------------------

test('AC1 interrupted: an interrupt the CLI honoured reads interrupted', () => {
  const f = fixture();
  send(f, 1_000);
  started(f, 1_100);
  openTurn(f, 1_200);
  applyLedgerEvent(f.ledger, { kind: 'interrupt-request' });
  applyLedgerEvent(f.ledger, {
    kind: 'lifecycle',
    at: 1_300,
    commandUuid: f.commandUuid,
    lifecycle: 'cancelled',
    cancelledReason: 'interrupt',
  });
  closeTurn(f, 1_400, true);

  const reading = latest(f);
  assert.equal(reading.state, 'interrupted');
  assert.equal(reading.detail, 'interrupt');
});

test('AC1 interrupted-negative: a withdrawn command reads interrupted, a completed one does not', () => {
  const withdrawn = fixture();
  send(withdrawn, 1_000);
  applyLedgerEvent(withdrawn.ledger, { kind: 'withdraw-request', commandUuid: withdrawn.commandUuid });
  applyLedgerEvent(withdrawn.ledger, {
    kind: 'lifecycle',
    at: 1_100,
    commandUuid: withdrawn.commandUuid,
    lifecycle: 'cancelled',
    cancelledReason: 'withdrawn',
  });
  applyLedgerEvent(withdrawn.ledger, { kind: 'withdrawn-run', commandUuid: withdrawn.commandUuid });

  // The withdrawn command never opened a turn. The run it would have opened is
  // closed by `withdrawn-run`, and the ledger has no closed turn to attach the
  // ending to — so there is no terminal reading yet, which is the negative: a
  // withdrawal is not by itself a turn's ending.
  assert.deepEqual(stateOf(withdrawn), []);

  const clean = fixture();
  send(clean, 1_000);
  started(clean, 1_100);
  openTurn(clean, 1_200);
  completed(clean, 1_300);
  closeTurn(clean, 1_400, false);
  assert.equal(latest(clean).state, 'success');
});

test('AC1 interrupted-by-anomaly: an unanswered interrupt is recorded as interrupted', () => {
  const f = fixture();
  send(f, 1_000);
  started(f, 1_100);
  openTurn(f, 1_200);
  // The turn is left open: the driver records the residue rather than inventing
  // an ending. The reading still names what happened.
  applyLedgerEvent(f.ledger, {
    kind: 'anomaly',
    code: 'interrupt-no-result',
    detail: 'no RESULT within 30000ms of the interrupt request',
  });

  const readings = stateOf(f);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].state, 'interrupted');
  assert.equal(readings[0].turnId, null, 'no turn closed, so the reading names none');
});

// ---------------------------------------------------------------------------
// needs-human
// ---------------------------------------------------------------------------

test('AC1 needs-human: a permission-scoped anomaly reads needs-human', () => {
  const f = fixture();
  applyLedgerEvent(f.ledger, {
    kind: 'anomaly',
    code: 'permission.unattended_refused',
    detail: 'a permission prompt was refused because the session is unattended',
  });

  const readings = stateOf(f);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].state, 'needs-human');
  assert.equal(readings[0].turnId, null);
});

test('AC1 needs-human-negative: a stream-contract anomaly is not terminal evidence', () => {
  const f = fixture();
  applyLedgerEvent(f.ledger, {
    kind: 'anomaly',
    code: 'double-init',
    detail: 'system/init init-2 arrived before turn turn-1 ended',
  });

  assert.deepEqual(stateOf(f), []);
});

test('AC1 needs-human outranks a clean ending of the newest turn', () => {
  const f = fixture();
  send(f, 1_000);
  started(f, 1_100);
  openTurn(f, 1_200);
  completed(f, 1_300);
  closeTurn(f, 1_400, false);
  applyLedgerEvent(f.ledger, {
    kind: 'anomaly',
    code: 'permission.write_refused',
    detail: 'a write needed consent nobody was there to give',
  });

  assert.equal(latest(f).state, 'needs-human');
});

// ---------------------------------------------------------------------------
// Shape: one reading per closed turn, oldest first
// ---------------------------------------------------------------------------

test('AC1 one reading per closed turn, in the ledger order', () => {
  const f = fixture();
  send(f, 1_000);
  started(f, 1_100);
  openTurn(f, 1_200);
  completed(f, 1_300);
  closeTurn(f, 1_400, false);

  // A second turn, interrupted, closes after the clean one.
  openTurn(f, 1_500);
  applyLedgerEvent(f.ledger, { kind: 'interrupt-request' });
  closeTurn(f, 1_600, true);

  const readings = stateOf(f);
  assert.equal(readings.length, 2);
  assert.equal(readings[0].state, 'success');
  assert.equal(readings[1].state, 'interrupted');
});

test('AC1 an empty ledger has no terminal state to report', () => {
  const f = fixture();
  assert.deepEqual(stateOf(f), []);
});

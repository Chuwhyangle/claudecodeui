/**
 * The tool-result RECEIPT criterion for the DashScope realtime transport.
 *
 * THE DEFECT. A tool result is a message about an EARLIER turn. The endpoint answers it only while
 * that turn is still the live one; once the person speaks again the endpoint has stopped holding the
 * call and refuses the result with `Unknown function call id`, followed — for the `response.create`
 * the transport synthesized for that same result — by `Cannot create response after
 * rejected function_call_output`. Both frames reach the bridge's own error boundary, so both reach
 * the BROWSER as `UPSTREAM_ERROR`: a red bar the person can do nothing about, for a race they did
 * not cause and the model never saw the tool result of. The live journal `b5d01c21` carries that
 * pair eight times, the two frames within ~1 ms of each other and ~0.1-3.9 s after the result left.
 *
 * THE FIX (see `FunctionCallReceipt` in the shipping transport). One receipt per call —
 * `pending` → `output-sent` → `acked | rejected | superseded` — read against the transport's
 * user-turn counter. A result whose turn has been superseded is NOT sent at all; a result the
 * endpoint REFUSES is absorbed at the transport and recorded in the journal in place of a browser
 * error. The delivery the person already got is untouched either way.
 *
 * WHAT THIS FILE READS
 *
 *  - AC2 positive: a scripted upstream plays the real rejection pair; the bridge's error boundary
 *    sees ZERO `UPSTREAM_ERROR`, and the journal carries a `state=rejected` receipt naming the call.
 *  - AC2 false form: the SAME script against a copy of the shipping module with the absorb removed
 *    does reach the bridge, so the positive reading is load-bearing rather than green for a reason
 *    of its own.
 *  - the superseded half: a result the executor returns only AFTER a new user turn began never goes
 *    on the wire, and the journal carries `state=superseded`. Its own false form removes the turn
 *    counter and shows the result going out again.
 *  - AC3: the normal path is what it was — both client frames still go out, no error, and no receipt
 *    line at all, so the state machine is silent when nothing goes wrong.
 *  - AC4: a rejected call does not disturb the delivery that already happened — the executor runs
 *    exactly once, the result reaches the wire exactly once, and nothing re-sends it.
 *
 * The mutants are copies of the shipping module written BESIDE it (their relative imports resolve
 * there), named with `__criterion-falsify-` so `server/tsconfig.json` excludes them from the
 * typecheck program — the convention the sibling `*.false-forms.test.ts` uses — and removed in a
 * `finally`. A closing case proves this process left none of its own copies behind.
 *
 * RUN WITH THIS REPO'S RUNNER:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test <this file>
 *
 * The server tree is TS-ESM — source imports use `.js` specifiers that resolve to same-named `.ts`
 * files — and Node's type-stripping does NOT remap `.js` → `.ts`, so `node --test` dies with
 * ERR_MODULE_NOT_FOUND on `../index.js`.
 *
 * Consumers: the quay worker's AC state for
 * `gap-live-voice-function-call-output-rejected-after-speech-resume`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import '../../../../shared/asr/asrRegistry.js';
import {
  connect,
  REALTIME_TOOLS,
  type DashscopeTransport,
  type DashscopeTransportOptions,
  type RealtimeBridgeError,
  type RealtimeToolExecutor,
} from '../index.js';

import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';
import { waitFor } from './realtime-bridge-harness.js';

// ── where things are ─────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This module's directory — where a mutant copy must sit so its relative imports resolve. */
const MODULE_DIR = path.resolve(HERE, '..');
/** The shipping transport: what the two mutations below copy. */
const SHIPPING_TRANSPORT_MODULE = path.join(MODULE_DIR, 'voice-realtime-dashscope-transport.ts');

/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
/** A copy this process owns: prefixed AND pid-tagged, so a sibling's copy is never mistaken for ours. */
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** The signature the shipping (and copied) factory exposes. */
type CreateTransportFn = (options?: DashscopeTransportOptions) => DashscopeTransport;

/** Imports a transport module by path. The specifier is dynamic, so TS types it structurally here. */
async function importTransport(modulePath: string): Promise<{ createDashscopeTransport: CreateTransportFn }> {
  return (await import(pathToFileURL(modulePath).href)) as { createDashscopeTransport: CreateTransportFn };
}

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Writes a base copy and a mutated copy of the shipping transport and imports both. */
async function importBaseAndMutant(
  label: string,
  replace: (source: string) => string,
): Promise<{ base: CreateTransportFn; mutant: CreateTransportFn; cleanup: () => void }> {
  const source = readFileSync(SHIPPING_TRANSPORT_MODULE, 'utf8');
  const basePath = ownCopy(`${label}-base`);
  const mutPath = ownCopy(`${label}-mut`);
  const mutated = replace(source);
  assert.notEqual(mutated, source, 'the mutation must actually change the source');
  writeFileSync(basePath, source, 'utf8');
  writeFileSync(mutPath, mutated, 'utf8');
  const base = (await importTransport(basePath)).createDashscopeTransport;
  const mutant = (await importTransport(mutPath)).createDashscopeTransport;
  return {
    base,
    mutant,
    cleanup: () => {
      rmSync(basePath, { force: true });
      rmSync(mutPath, { force: true });
    },
  };
}

// ── the two mutations ────────────────────────────────────────────────────────────────────────

/**
 * The absorb anchor. `rejectedFunctionCallOutputCallId` is what recognises the endpoint naming a
 * call it never held; reading `null` instead forwards the frame to the bridge exactly as it was
 * forwarded before the fix.
 */
const ABSORB_ANCHOR = '      const rejectedCallId = rejectedFunctionCallOutputCallId(event);';
const ABSORB_REMOVED = '      const rejectedCallId: string | null = null;';

/**
 * The turn-counter anchor. `startsNewUserTurn` is the only thing that moves the counter, so pinning
 * it false leaves every result looking like it still belongs to the live turn.
 */
const TURN_ANCHOR = '      if (startsNewUserTurn(event)) userTurnSeq += 1;';
const TURN_REMOVED = '      if (false) userTurnSeq += 1;';

// ── driving one scripted session ─────────────────────────────────────────────────────────────

/** Everything one scripted session observed, from the three seats that matter. */
type Session = {
  /** Every failure the BRIDGE reported — the browser's error bar is built from exactly these. */
  readonly bridgeErrors: RealtimeBridgeError[];
  /** The transport's journal sink, verbatim. */
  readonly journal: string[];
  /** The upstream's wire log: every client frame the transport put on the socket. */
  readonly sent: Array<Record<string, unknown>>;
  /** The fake upstream, for scripting what the endpoint says next. */
  readonly server: ReturnType<typeof createFakeDashscopeServer>;
  readonly bridge: ReturnType<typeof connect>;
};

/** The tool the scripted model calls. `REALTIME_TOOLS` declares it, so the whitelist admits it. */
const TOOL_NAME = 'ui_visible_context';
const CALL_ID = 'call_receipt_script_1';

/** Opens a session over the fake upstream, with everything a reading below needs recorded. */
async function openSession(
  createTransport: CreateTransportFn,
  executor: RealtimeToolExecutor,
): Promise<Session> {
  const server = createFakeDashscopeServer({ callId: CALL_ID, toolName: TOOL_NAME });
  const bridgeErrors: RealtimeBridgeError[] = [];
  const journal: string[] = [];
  const transport = createTransport({
    apiKey: 'test-key-not-a-real-credential',
    socketFactory: server.socketFactory,
    log: (line) => journal.push(line),
  });
  const bridge = connect(transport, REALTIME_TOOLS, executor, { hooks: { onError: (error) => bridgeErrors.push(error) } });
  await bridge.whenConnected();
  bridge.sendSessionUpdate('go');
  // One audio frame is what the fixture answers with `response.created` + the function call, i.e.
  // the scripted model deciding to use the tool.
  bridge.sendAudioFrame('AAAA');
  await waitFor(() => server.sent.some((frame) => frame.type === 'input_audio_buffer.append'));
  return { bridgeErrors, journal, sent: server.sent, server, bridge };
}

/** The transport's receipt lines only — what the journal records about the ledger. */
const receiptLines = (journal: readonly string[]): string[] =>
  journal.filter((line) => line.startsWith('function_call_output receipt'));

/** The result items the transport actually put on the wire. */
const outputItemsOnWire = (sent: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> =>
  sent.filter((frame) => {
    const item = frame.item as Record<string, unknown> | undefined;
    return frame.type === 'conversation.item.create' && item?.type === 'function_call_output';
  });

/** The two frames the REAL endpoint sends when it refuses a result, byte-for-byte from `b5d01c21`. */
const REJECTION_PAIR: ReadonlyArray<Record<string, unknown>> = [
  {
    type: 'error',
    error: { type: 'invalid_request_error', message: `Unknown function call id: ${CALL_ID}`, param: 'call_id' },
  },
  {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'Cannot create response after rejected function_call_output; submit valid input or retry for the current input',
      param: 'response',
    },
  },
];

/** The browser-facing errors caused by the rejection — the ones this fix exists to remove. */
const rejectionErrors = (errors: readonly RealtimeBridgeError[]): RealtimeBridgeError[] =>
  errors.filter(
    (error) =>
      error.code === 'UPSTREAM_ERROR' &&
      (/Unknown function call id/i.test(error.message) ||
        /Cannot create response after rejected function_call_output/i.test(error.message)),
  );

// ── AC2: the rejected result is absorbed, and the journal keeps the reading ───────────────────

test('AC2: a refused tool result never reaches the browser and is journalled as rejected', async () => {
  /** Plays the real rejection pair at one session and returns what the three seats saw. */
  const drive = async (
    createTransport: CreateTransportFn,
  ): Promise<{ rejectionErrors: number; total: number; receipts: string[]; outputItems: number }> => {
    const ran: string[] = [];
    const session = await openSession(createTransport, {
      [TOOL_NAME]: () => {
        ran.push(TOOL_NAME);
        return { devices: [] };
      },
    });
    try {
      // The executor returned immediately, so the result is on the wire by now — the harness's
      // answer to a result item stands in for the endpoint having ACCEPTED it, which is exactly the
      // acceptance the real endpoint did not give; the scripted pair below is what it gave instead.
      await waitFor(() => outputItemsOnWire(session.sent).length === 1);
      // The pair, in the order the live journal recorded it and with its own wording.
      for (const frame of REJECTION_PAIR) session.server.peerSend(frame);
      // The transport answers synchronously off `onmessage`, so one turn of the loop is enough for
      // both frames to have been read and classified.
      await waitFor(() => receiptLines(session.journal).length >= 1);
      return {
        rejectionErrors: rejectionErrors(session.bridgeErrors).length,
        total: session.bridgeErrors.length,
        receipts: receiptLines(session.journal),
        outputItems: outputItemsOnWire(session.sent).length,
      };
    } finally {
      await session.bridge.close();
    }
  };

  // Unmutated: the cause is absorbed at the transport, so the browser's error bar stays clean and
  // the journal — not the browser — is where the rejection is recorded.
  const absorbed = await drive((await importTransport(SHIPPING_TRANSPORT_MODULE)).createDashscopeTransport);
  assert.equal(absorbed.rejectionErrors, 0, 'no rejection-caused UPSTREAM_ERROR may reach the bridge');
  assert.equal(absorbed.total, 0, 'the refused pair must not surface as ANY bridge error');
  assert.ok(
    absorbed.receipts.some((line) => line.includes(`call_id=${CALL_ID}`) && line.includes('state=rejected')),
    `the journal must carry a rejected receipt for the call; got ${JSON.stringify(absorbed.receipts)}`,
  );

  // False form: with the absorb removed the SAME script reaches the bridge, so the reading above is
  // the fix's doing and not a property of the script.
  const source = readFileSync(SHIPPING_TRANSPORT_MODULE, 'utf8');
  assert.equal(countOccurrences(source, ABSORB_ANCHOR), 1, 'the absorb anchor must occur exactly once');
  const { mutant, cleanup } = await importBaseAndMutant('receipt-absorb', (text) =>
    text.replace(ABSORB_ANCHOR, ABSORB_REMOVED),
  );
  try {
    const leaked = await drive(mutant);
    assert.ok(
      leaked.rejectionErrors >= 1,
      'without the absorb the refusal must reach the browser, or the assertion above proves nothing',
    );
  } finally {
    cleanup();
  }
});

// ── AC2: the superseded half — a result whose turn is over is not sent at all ─────────────────

test('AC2: a result the executor returns after a new user turn is not sent, and is journalled as superseded', async () => {
  /** Runs one session where the executor answers only after a new user turn has begun. */
  const drive = async (
    createTransport: CreateTransportFn,
  ): Promise<{ outputItems: number; receipts: string[]; resumes: number }> => {
    // The executor holds its result until the test releases it — that hold IS the race: the person
    // speaks again while the tool is still running. A holder object rather than a `let`, because a
    // `let` narrowed to its `null` initialiser is not callable to the type checker.
    const gate: { release: () => void } = { release: () => {} };
    const held = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const dispatched: string[] = [];
    const session = await openSession(createTransport, {
      [TOOL_NAME]: () => {
        dispatched.push(TOOL_NAME);
        return held;
      },
    });
    try {
      // The scripted model called the tool; the executor is now holding the result.
      await waitFor(() => dispatched.length === 1);
      // The person speaks again BEFORE the tool answers — the race, in the order the live journal
      // has it (as a fresh utterance, which is also the reading a manual-VAD session gets).
      session.server.peerSend({ type: 'input_audio_buffer.speech_started' });
      session.server.peerSend({
        type: 'conversation.item.created',
        item: { id: 'item_script_user_1', type: 'message', role: 'user' },
      });
      gate.release();
      // Wait for the transport's DECISION, whichever way it went: the refused result leaves a
      // receipt line and nothing on the wire, the sent one leaves an item on the wire and no line.
      // Waiting on the line alone would hang on the mutated copy, where there is deliberately none.
      const decisionMade = (): boolean =>
        receiptLines(session.journal).length >= 1 || outputItemsOnWire(session.sent).length >= 1;
      await waitFor(decisionMade);
      return {
        outputItems: outputItemsOnWire(session.sent).length,
        receipts: receiptLines(session.journal),
        resumes: session.sent.filter((frame) => frame.type === 'response.create').length,
      };
    } finally {
      await session.bridge.close();
    }
  };

  const skipped = await drive((await importTransport(SHIPPING_TRANSPORT_MODULE)).createDashscopeTransport);
  assert.equal(
    skipped.outputItems,
    0,
    'a result whose turn is over must not be put on the wire: it can only be refused',
  );
  assert.equal(
    skipped.resumes,
    0,
    'and no `response.create` may be synthesized for it either, or the bridge expects a turn nobody will serve',
  );
  assert.ok(
    skipped.receipts.some((line) => line.includes(`call_id=${CALL_ID}`) && line.includes('state=superseded')),
    `the journal must carry a superseded receipt for the call; got ${JSON.stringify(skipped.receipts)}`,
  );

  // False form: pin the turn counter still and the very same session sends the result again.
  const source = readFileSync(SHIPPING_TRANSPORT_MODULE, 'utf8');
  assert.equal(countOccurrences(source, TURN_ANCHOR), 1, 'the turn-counter anchor must occur exactly once');
  const { mutant, cleanup } = await importBaseAndMutant('receipt-supersede', (text) =>
    text.replace(TURN_ANCHOR, TURN_REMOVED),
  );
  try {
    const sentAnyway = await drive(mutant);
    assert.equal(sentAnyway.outputItems, 1, 'without the turn counter the result goes out, as it did before the fix');
  } finally {
    cleanup();
  }
});

// ── AC3: the normal path is unchanged ────────────────────────────────────────────────────────

test('AC3: a result the endpoint accepts goes out exactly as before, with no receipt line', async () => {
  const session = await openSession((await importTransport(SHIPPING_TRANSPORT_MODULE)).createDashscopeTransport, {
    [TOOL_NAME]: () => ({ devices: [] }),
  });
  try {
    // The fixture's own answer to a result item is `response.done` — its stand-in for acceptance.
    await waitFor(() => outputItemsOnWire(session.sent).length === 1);
    await waitFor(() => session.sent.some((frame) => frame.type === 'response.create'));
    assert.equal(session.bridgeErrors.length, 0, 'the happy path raises nothing');
    assert.deepEqual(receiptLines(session.journal), [], 'the ledger stays silent when nothing goes wrong');
  } finally {
    await session.bridge.close();
  }
});

// ── AC4: a rejection does not disturb the delivery that already happened ─────────────────────

test('AC4: a rejected result leaves the delivery record — and the wire — exactly as they were', async () => {
  // The `session_send` delivery the person sees is written by the WS proxy from the ABSENCE of a
  // bridge error and from the executor having run once. Both are read here, at the boundary the
  // proxy reads them from: a delivered message stays delivered because the refusal never becomes an
  // error and never causes a re-dispatch or a re-send.
  const runs: Array<Record<string, unknown>> = [];
  const session = await openSession((await importTransport(SHIPPING_TRANSPORT_MODULE)).createDashscopeTransport, {
    [TOOL_NAME]: (args) => {
      runs.push(args);
      return { devices: [] };
    },
  });
  try {
    await waitFor(() => outputItemsOnWire(session.sent).length === 1);
    const sentBefore = outputItemsOnWire(session.sent).length;
    for (const frame of REJECTION_PAIR) session.server.peerSend(frame);
    await waitFor(() => receiptLines(session.journal).some((line) => line.includes('state=rejected')));
    // A rejection is not a delivery failure: nothing is re-dispatched, nothing is re-sent, and the
    // browser is told nothing — which is what keeps the delivered record `delivered`.
    assert.equal(runs.length, 1, 'the executor must run exactly once — a refusal is not a retry trigger');
    assert.equal(outputItemsOnWire(session.sent).length, sentBefore, 'the result must not be re-sent');
    assert.equal(session.bridgeErrors.length, 0, 'no error reaches the proxy, so no delivery outcome changes');
  } finally {
    await session.bridge.close();
  }
});

// ── the copies this process wrote are gone ───────────────────────────────────────────────────

test('this criterion leaves none of its own falsify copies behind', () => {
  const strays = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(`${TEMP_PREFIX}receipt-`) && name.includes(`-${process.pid}.ts`),
  );
  assert.deepEqual(strays, [], `criterion copies must be removed; found ${JSON.stringify(strays)}`);
});

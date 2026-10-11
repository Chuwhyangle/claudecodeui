/**
 * AC1 — the loopback gate. Drives `runDiagnosedSession` (the SAME instrument a paid session uses)
 * against the local fake endpoint in `loopback-ws.mts`, once per ground-truth scenario, and asserts
 * the instrument names each one correctly. Nothing here costs money and nothing here talks to
 * DashScope: the point is that when a paid timeout IS diagnosed, the thing doing the diagnosing has
 * already been shown to read a known outcome correctly.
 *
 * WHY FIVE AND NOT ONE. A single "it works" run proves the happy path; the instrument's whole job is
 * the unhappy ones, and they fail in different places — a fire that lands after the harness gave up,
 * an endpoint that never narrates the utterance at all, a socket that dies with a close code, and a
 * fire the attribution window throws away. Each is a distinct classification, so each gets its own
 * scenario and its own assertion. A green happy path with a broken attribution rule would pass a
 * one-scenario test.
 *
 * Run:
 *   node_modules/.bin/tsx experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/loopback.test.mts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runDiagnosedSession, type SessionDiagnosis } from './diagnose.mts';
import { buildLoopbackSpan, startLoopbackServer, type LoopbackOptions } from './loopback-ws.mts';

const SPAN = buildLoopbackSpan(1_000, 2_000, 16_000);
/** 2000 ms of audio at the 100 ms frame the runner paces: 20 appends. */
const FRAMES = SPAN.audio.length / (SPAN.sampleRate * 0.1);

/** Run one scenario end to end and hand back both the diagnosis and the fake server. */
async function runScenario(s: LoopbackOptions, diagnoseOpts: { silenceDurationMs: number; closeWaitMs: number; lateGraceMs: number }): Promise<{ diag: SessionDiagnosis; server: Awaited<ReturnType<typeof startLoopbackServer>> }> {
  const server = await startLoopbackServer(s);
  try {
    const diag = await runDiagnosedSession(SPAN, {
      apiKey: 'loopback-test-key-not-a-credential',
      endpoint: server.url,
      silenceDurationMs: diagnoseOpts.silenceDurationMs,
      closeWaitMs: diagnoseOpts.closeWaitMs,
      lateGraceMs: diagnoseOpts.lateGraceMs,
      timeoutMs: 30_000,
    });
    return { diag, server };
  } catch (error) {
    await server.close();
    throw error;
  }
}

/** Every scenario must have warmed through the real code path and recorded a complete WS lifecycle. */
function assertCommonEvidence(diag: SessionDiagnosis, server: { instructions: () => string | null; connections: () => number }): void {
  assert.equal(server.connections(), 1, 'the client opened exactly one socket');
  assert.notEqual(server.instructions(), null, 'the client sent `session.update` with its instructions (it warmed through the real path)');
  assert.notEqual(diag.ws.openAtMs, null, 'the WS open was recorded');
  assert.ok((diag.ws.handshakeMs ?? -1) >= 0, 'the handshake latency was recorded');
  assert.ok(diag.sessionId !== null, 'the session id was read off session.created');
  assert.ok(
    diag.sent.some((f) => f.type === 'session.update'),
    'the sent-frame log contains the session.update',
  );
  assert.ok(diag.audio.framesSent >= 1, 'at least one audio frame was sent');
  assert.equal(
    diag.sent.filter((f) => f.isAudio).length,
    diag.audio.framesSent,
    'every audio frame the runner counted appears in the sent-frame log',
  );
  assert.ok(diag.received.length >= 1, 'the received-event log is populated');
}

test('loopback/normal — a clean endpoint is classified ok, with an accepted stop inside the deadline', async () => {
  const { diag, server } = await runScenario({ scenario: 'normal' }, { silenceDurationMs: 400, closeWaitMs: 1_500, lateGraceMs: 800 });
  await server.close();
  assertCommonEvidence(diag, server);
  assert.equal(diag.classification, 'ok');
  assert.equal(diag.status, 'ok');
  assert.notEqual(diag.attribution.acceptedStopWallMs, null, 'a stop was accepted');
  assert.ok(diag.deadline.acceptedStopBeforeDeadline, 'the accepted stop landed at or before the deadline');
  assert.equal(diag.audio.framesSent, FRAMES, `all ${FRAMES} frames were sent`);
  assert.ok(diag.audio.appendIntervalsMs.length > 0, 'the send cadence was measured');
  assert.equal(diag.ws.errors.length, 0, 'a clean scenario records no socket error');
  assert.equal(diag.facts.stopCount, 1);
});

test('loopback/late — a fire that lands after the deadline is classified late-beyond-deadline, not upstream-no-event', async () => {
  const { diag, server } = await runScenario({ scenario: 'late', stopDelayMs: 1_500 }, { silenceDurationMs: 400, closeWaitMs: 700, lateGraceMs: 5_000 });
  await server.close();
  assertCommonEvidence(diag, server);
  assert.equal(diag.classification, 'late-beyond-deadline');
  assert.equal(diag.status, 'timeout');
  assert.ok(diag.facts.stopCount >= 1, 'the endpoint DID fire — this is the whole difference from upstream-no-event');
  assert.notEqual(diag.attribution.acceptedStopWallMs, null, 'the fire was a valid stop for this candidate, just too late');
  assert.ok(
    (diag.attribution.acceptedStopWallMs ?? 0) > (diag.deadline.deadlineAtMs ?? 0),
    'the accepted stop arrived strictly after the deadline',
  );
});

test('loopback/zero-event — an endpoint that never narrates the utterance is classified upstream-no-event', async () => {
  const { diag, server } = await runScenario({ scenario: 'zero-event' }, { silenceDurationMs: 400, closeWaitMs: 400, lateGraceMs: 200 });
  await server.close();
  assertCommonEvidence(diag, server);
  assert.equal(diag.classification, 'upstream-no-event');
  assert.equal(diag.status, 'timeout');
  assert.equal(diag.facts.stopCount, 0, 'no speech_stopped was received at all');
  assert.equal(diag.attribution.acceptedStopWallMs, null);
  assert.equal(diag.ws.errors.length, 0, 'the socket itself was healthy — the endpoint was simply silent');
  assert.equal(diag.audio.framesSent, FRAMES);
});

test('loopback/abnormal-close — a socket that dies with a close code is classified network-ws-failure, with the code recorded', async () => {
  const { diag, server } = await runScenario({ scenario: 'abnormal-close', closeAfterMs: 250, closeCode: 1011, closeReason: 'loopback upstream failure' }, { silenceDurationMs: 400, closeWaitMs: 800, lateGraceMs: 500 });
  await server.close();
  assertCommonEvidence(diag, server);
  assert.equal(diag.classification, 'network-ws-failure');
  assert.equal(diag.status, 'error');
  assert.notEqual(diag.ws.close, null, 'the close was recorded');
  assert.equal(diag.ws.close?.code, 1011, 'the close code is preserved');
  assert.equal(diag.ws.close?.deliberate, false, 'the close was the upstream’s, not ours');
  assert.ok(
    diag.audio.framesSent < FRAMES,
    'the stream was cut short — the sent-frame count is the evidence that this was not an endpoint miss',
  );
  assert.equal(diag.facts.framesSentBeforeFailure, diag.audio.framesSent, 'the pre-failure frame count is recorded');
});

test('loopback/attribution-rejected — a fire thrown away by the attribution window is classified attribution-window-rejected, not upstream-no-event', async () => {
  const { diag, server } = await runScenario({ scenario: 'attribution-rejected', onsetMs: 1_000 }, { silenceDurationMs: 400, closeWaitMs: 1_500, lateGraceMs: 800 });
  await server.close();
  assertCommonEvidence(diag, server);
  assert.equal(diag.classification, 'attribution-window-rejected');
  assert.equal(diag.status, 'timeout');
  assert.ok(diag.facts.stopCount >= 1, 'a stop WAS received — upstream was not silent');
  assert.equal(diag.attribution.acceptedStopWallMs, null, 'but no stop was accepted for this candidate');
  const cand = diag.attribution.stops[0];
  assert.equal(cand.accepted, false);
  assert.match(cand.reason, /interrupted-by-resume/, `the rejection reason names the resume; got: ${cand.reason}`);
  assert.equal(diag.attribution.stops.length, 1, 'exactly one stop arrived');
});

test('loopback/evidence — the log separates the four timeout causes by what it RECORDED, not by what it assumed', async () => {
  // The whole point of AC5's classification: the four timeout classes must not collapse. Run three of
  // them and assert the discriminators are actually different fields, not one field re-read.
  const zero = await runScenario({ scenario: 'zero-event' }, { silenceDurationMs: 400, closeWaitMs: 300, lateGraceMs: 200 });
  await zero.server.close();
  const rejected = await runScenario({ scenario: 'attribution-rejected', onsetMs: 1_000 }, { silenceDurationMs: 400, closeWaitMs: 1_200, lateGraceMs: 500 });
  await rejected.server.close();
  const late = await runScenario({ scenario: 'late', stopDelayMs: 1_200 }, { silenceDurationMs: 400, closeWaitMs: 600, lateGraceMs: 4_000 });
  await late.server.close();

  assert.notEqual(zero.diag.classification, rejected.diag.classification);
  assert.notEqual(rejected.diag.classification, late.diag.classification);
  // zero-event and attribution-rejected both RECEIVE no accepted stop, and differ only in whether a
  // rejected stop was recorded — the discriminator is `facts.stopCount` and the attribution reasons.
  assert.equal(zero.diag.facts.stopCount, 0);
  assert.ok(rejected.diag.facts.stopCount >= 1);
  // late and attribution-rejected both RECEIVE a stop, and differ only in what became of it: the
  // `late` fire IS this candidate's and was merely too late; the `rejected` fire was thrown away.
  assert.equal(rejected.diag.attribution.acceptedStopWallMs, null);
  assert.notEqual(late.diag.attribution.acceptedStopWallMs, null);
  assert.equal(rejected.diag.attribution.stops[0].accepted, false);
  assert.equal(late.diag.attribution.stops[0].accepted, true);
});

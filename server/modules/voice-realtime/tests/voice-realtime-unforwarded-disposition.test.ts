/**
 * The continuous relay's "heard, not forwarded" disposition (decision doc §12.6 B-8; §12.5's
 * reserved slot for it).
 *
 * The model answering a spoken turn in TEXT instead of calling `session_send` is the "nothing to
 * do" disposition, not a fault. On the SEGMENTED wire it is the retired relay's regression and
 * arrives as a recoverable `error` (see `voice-realtime-streaming-stages.test.ts` P6). On the
 * CONTINUOUS wire it used to be SILENT: the proxy logged the reading to the journal and told the
 * browser nothing, so a person whose words never reached Claude saw a bar that looked exactly like
 * one where the model had relayed. This file pins that the continuous path now has a destination
 * of its own — a `heard_not_forwarded` frame — and that the destination is NOT the failure state.
 *
 * Three cases, one per criterion:
 *  - AC1 — continuous + one `MODEL_TEXT_REPLY` produces the VISIBLE disposition, exactly once.
 *  - AC3 — the SAME disposition does not reach the `error` channel and does not close the session,
 *          so the page never enters its `failed` phase (which only a non-recoverable `error` frame
 *          or a socket error produces).
 *  - AC2 — its false form: the shipping module is copied beside itself with the disposition's
 *          `send(...)` line removed (back to the old silent `return`) and driven through the same
 *          fixture; the disposition must then be ABSENT, i.e. AC1 shades red.
 *
 * The AC2 mutant is a copy of the shipping proxy written BESIDE it (its imports are all relative,
 * so a sibling copy resolves), named with `__criterion-falsify-` so `server/tsconfig.json` excludes
 * it from the typecheck program — the same convention the voice criteria's other false forms use —
 * and removed in a `finally`. A closing case proves this process left none of its own copies behind.
 *
 * The continuous wire is PINNED (`segmentedRelay: false`), never left to the environment's default
 * relay mode: the segmented `error` reading belongs to P6, and this file's readings must not drift
 * with whichever mode the environment happens to select.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS } from 'ws';

import { createDashscopeTransport, type RealtimeToolExecutor } from '../index.js';
import {
  handleVoiceRealtimeConnection,
  VOICE_REALTIME_INSTRUCTIONS,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';

const KEY = 'sk-test-not-a-real-key';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The shipping proxy's own `handleVoiceRealtimeConnection` signature — the base and mutant copies expose the same one. */
type HandleConnection = typeof handleVoiceRealtimeConnection;
type Upstream = ReturnType<typeof createFakeDashscopeServer>;
type Socket = FakeBrowserSocket;

// ── how the wire is driven ──────────────────────────────────────────────────────────────────────

class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];
  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }
  close(): void {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close');
  }
}

/** An upstream that never volunteers a function call on its own: every event in a case is one we send. */
const quietUpstream = (): Upstream => createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });

const okExecutor = (): RealtimeToolExecutor => ({
  session_send: async () => ({ runId: 'r', queued: false }),
});

/** Opens a proxy connection over `handler`, pinned to the CONTINUOUS relay (never the ambient default). */
function proxyOver(handler: HandleConnection, upstream: Upstream, extra: Partial<VoiceRealtimeProxySeams> = {}): Socket {
  const socket = new FakeBrowserSocket();
  handler(socket as unknown as Parameters<HandleConnection>[0], 'bound', {
    createTransport: (report) => createDashscopeTransport({ apiKey: KEY, socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => okExecutor(),
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    segmentedRelay: false,
    ...extra,
  });
  return socket;
}

const isOpen = (socket: Socket): boolean => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

/**
 * Drives ONE `response.text.done` (the model's text reply) over a continuous connection and returns
 * the socket once the outcome has settled.
 *
 * The wait is satisfied by EITHER a disposition or an `error` frame, and a timeout is swallowed:
 * the false form under test is the case where NEITHER arrives, so a fixed wait must not itself be
 * the reason a case is red.
 */
async function driveTextReply(handler: HandleConnection, upstream: Upstream): Promise<Socket> {
  const socket = proxyOver(handler, upstream);
  await waitFor(() => isOpen(socket));
  upstream.peerSend({ type: 'response.text.done', text: '是的，我听到了。' });
  await waitFor(
    () => socket.outbound.some((frame) => frame.type === 'heard_not_forwarded' || frame.type === 'error'),
    1_500,
  ).catch(() => undefined);
  await sleep(50);
  return socket;
}

const dispositions = (socket: Socket): VoiceRealtimeOutboundFrame[] =>
  socket.outbound.filter((frame) => frame.type === 'heard_not_forwarded');

// ── AC1 — the disposition is visible under continuous ────────────────────────────────────────────

test('AC1: continuous + one MODEL_TEXT_REPLY produces a VISIBLE heard_not_forwarded disposition', async () => {
  const socket = await driveTextReply(handleVoiceRealtimeConnection, quietUpstream());
  assert.equal(
    dispositions(socket).length,
    1,
    'the model heard the person and did not forward them: exactly one disposition frame must reach the browser',
  );
  socket.close();
});

// ── AC3 — the disposition is NOT the failure state ───────────────────────────────────────────────

test('AC3: the disposition does NOT put the session into a failed state', async () => {
  const socket = await driveTextReply(handleVoiceRealtimeConnection, quietUpstream());

  // The page's `failed` phase is entered ONLY by a non-recoverable `error` frame or a socket error
  // (`useVoiceRealtimeSession`). So "not failed" reads here as: the reply produced NO error frame at
  // all — not even the recoverable `MODEL_TEXT_REPLY` the segmented wire pins in P6.
  assert.equal(
    socket.outbound.some((frame) => frame.type === 'error'),
    false,
    'the continuous disposition must never reach the error channel',
  );
  // And the connection is still open on the browser side — the `open` state frame plus the socket's
  // own OPEN readyState — so nothing about the disposition closed the session.
  assert.equal(socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'), true, 'the session was opened');
  assert.equal(socket.readyState, WS.OPEN, 'the disposition leaves the browser connection open');
  socket.close();
});

// ── AC2 false form ──────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This test module's directory — where a mutant copy must sit so its relative imports resolve. */
const MODULE_DIR = path.resolve(HERE, '..');
/** The shipping proxy: what the AC2 mutation copies. */
const SHIPPING_PROXY_MODULE = path.join(MODULE_DIR, 'voice-realtime-ws-proxy.service.ts');

/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
/** A copy this process owns: prefixed AND pid-tagged, so a sibling's copy is never mistaken for ours. */
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** The disposition's one send — the line whose removal returns the reply to the old silent `return`. */
const DISPOSITION_SEND = "send({ type: 'heard_not_forwarded' });";

/** Imports a proxy module by path. The specifier is dynamic, so TS types it structurally here. */
async function importProxy(modulePath: string): Promise<{ handleVoiceRealtimeConnection: HandleConnection }> {
  return (await import(pathToFileURL(modulePath).href)) as { handleVoiceRealtimeConnection: HandleConnection };
}

test('AC2 false form: removing the disposition send returns MODEL_TEXT_REPLY to silence (AC1 reds)', async () => {
  const source = readFileSync(SHIPPING_PROXY_MODULE, 'utf8');
  const lines = source.split('\n');
  assert.equal(
    lines.filter((line) => line.trim() === DISPOSITION_SEND).length,
    1,
    'the disposition anchor must occur exactly once',
  );
  // The mutation: drop the `send({ type: 'heard_not_forwarded' });` line, leaving the `seams.log?.()`
  // and the `return` that follow it — the shipping code exactly as it was before this task, where the
  // browser was told nothing.
  const mutatedSource = lines.filter((line) => line.trim() !== DISPOSITION_SEND).join('\n');

  const basePath = ownCopy('unforwarded-base');
  const mutPath = ownCopy('unforwarded-mut');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, mutatedSource, 'utf8');
    const base = await importProxy(basePath);
    const mut = await importProxy(mutPath);

    // Unmutated: the copy still speaks, so the reading is not green for a reason of its own (green).
    const baseSocket = await driveTextReply(base.handleVoiceRealtimeConnection, quietUpstream());
    assert.equal(dispositions(baseSocket).length, 1, 'the unmutated copy still emits the disposition');
    baseSocket.close();

    // Mutated: the disposition is gone — the reply is silent again, which is exactly what AC1 must catch.
    const mutSocket = await driveTextReply(mut.handleVoiceRealtimeConnection, quietUpstream());
    assert.equal(
      dispositions(mutSocket).length,
      0,
      'with the send removed, the continuous reply is silent again — AC1 would red on this build',
    );
    mutSocket.close();
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ── residue ─────────────────────────────────────────────────────────────────────────────────────

test('the false form leaves none of this process`s copies behind', () => {
  const leftovers = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});

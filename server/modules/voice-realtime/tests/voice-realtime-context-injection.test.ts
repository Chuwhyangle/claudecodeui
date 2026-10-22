/**
 * The C2 ContextPack, on the SERVER half of the wire: what the proxy does with the
 * `context` frame the browser sends, and where the resulting text goes.
 *
 * WHAT THIS FILE IS FOR. AC-320's client suite (`voiceContextPack.test.ts`) proves
 * the pack is BUILT from the transcript's visibility rules. Nothing until this file
 * proved it is INJECTED — that the proxy turns one frame into the upstream session's
 * `instructions`, that a session with nothing said is left byte-identical to what it
 * was before C2, and that the prompt is a per-connection reading so an edit lands on
 * the NEXT connection instead of under a live one (`voice-realtime-settings.ts`).
 * Fully offline: the same `createFakeTransport` the bridge suites use stands in for
 * the DashScope upstream, and a minimal EventEmitter stands in for the browser's
 * WebSocket, exactly as `voice-realtime-ws-proxy.protocol-simulation.test.ts` does.
 *
 * WHAT EACH CASE PROVES:
 *   - the pack reaches the session: one `context` frame becomes an upstream
 *     `session.update` whose `instructions` carry the pack under the shipped header;
 *   - no pack, no change: a connection that is never sent a `context` frame opens
 *     with instructions BYTE-IDENTICAL to `seams.instructions` (the empty case has
 *     no header and no blank lines — which is also what makes it comparable);
 *   - the size limit is enforced here: a frame over the connection's effective budget is
 *     TRIMMED to the newest rows (the runtime knobs are configurable now), with a
 *     `context truncated from=… to=…` line, and the next, in-budget frame is still
 *     injected (so the trim is about the size, not a broken path);
 *   - read-once: one settings file read is held for a connection's whole life —
 *     editing the file under a live connection does not change what that connection
 *     composes, while the next connection reads the new file;
 *   - fail open on I/O, fail closed on shape: an unreadable file falls back to the
 *     shipped defaults with the reason logged, and a frame that is not JSON is
 *     ignored rather than forwarded.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that
 * resolve to same-named `.ts` files):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-context-injection.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeClientMessage, RealtimeToolExecutor } from '../index.js';
import {
  VOICE_REALTIME_CONTEXT_MAX_CHARS,
  handleVoiceRealtimeConnection,
  readVoiceRealtimeInboundFrame,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';
import { VOICE_REALTIME_CONTEXT_HEADER } from '../voice-realtime-settings.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/**
 * A minimal stand-in for the browser's `ws.WebSocket`, satisfying exactly the surface
 * `handleVoiceRealtimeConnection` uses — copied from the protocol-simulation suite so
 * this file stands alone over the same fake.
 */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  close(): void {
    if (this.readyState === WS.CLOSED) {
      return;
    }
    this.readyState = WS.CLOSED;
    this.emit('close');
  }

  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

/** The `session.update` `instructions` the fake upstream has been sent, in order. */
function advertisedInstructions(transport: FakeTransport): string[] {
  return transport.sent
    .filter(
      (message): message is Extract<RealtimeClientMessage, { type: 'session.update' }> =>
        message.type === 'session.update',
    )
    .map((message) => message.session.instructions);
}

/** Wiring knobs this file adds on top of the protocol-simulation suite's `wireConnection`. */
type WireOptions = {
  /** The base prompt the connection is opened with; distinct so it cannot be confused with a pack. */
  instructions?: string;
  /** The settings file for this connection, if any. */
  settingsPath?: string;
};

/** Wires one fresh proxy connection over a fake browser socket and a fake transport. */
function wireConnection(options: WireOptions = {}): {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  logs: string[];
} {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const logs: string[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => ({ ok: true, echoedMessage: args.message }),
  };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: options.instructions ?? 'BASE-PROMPT',
    ...(options.settingsPath === undefined ? {} : { settingsPath: options.settingsPath }),
    log: (line: string) => {
      logs.push(line);
    },
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transport, logs };
}

/** A temp directory and settings file this case owns, removed when `cleanup()` is called. */
function withSettingsFile(): { dir: string; path: string; write: (contents: unknown) => void; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'voice-context-injection-'));
  const path = join(dir, 'settings.json');
  return {
    dir,
    path,
    write: (contents: unknown) => {
      writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
    },
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A `context` frame carrying `text`, with the counts the builder would have sent. */
function contextFrame(text: string, rows = 1): VoiceRealtimeInboundFrame {
  return { type: 'context', text, chars: text.length, rows };
}

test('one context frame becomes the upstream session instructions, under the shipped header', async () => {
  const { socket, transport, logs } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

  const pack = '用户（2 分钟前）：把超时改成五十秒\n助手（1 分钟前）：已改，超时现在是五十秒。';
  socket.receive(contextFrame(pack, 2));

  await waitFor(() => advertisedInstructions(transport).some((instructions) => instructions.includes(pack)));
  const injected = advertisedInstructions(transport).find((instructions) => instructions.includes(pack))!;

  // The composition is the base prompt, then the header, then the pack — nothing else.
  assert.equal(injected, `BASE-PROMPT\n\n${VOICE_REALTIME_CONTEXT_HEADER}\n\n${pack}`);

  // The log names the size and the provenance — never the body, which is the person's
  // conversation and has no business in the server's console (SPEC §C2).
  await waitFor(() => logs.some((line) => line.startsWith('context injected')));
  const injectedLog = logs.find((line) => line.startsWith('context injected'))!;
  assert.ok(injectedLog.includes(`chars=${pack.length}`), injectedLog);
  assert.ok(injectedLog.includes('rows=2'), injectedLog);
  assert.equal(injectedLog.includes(pack), false, 'the injected log must not carry the pack body');
});

test('a connection never sent a context frame opens BYTE-IDENTICAL to the base prompt', async () => {
  const { transport } = wireConnection({ instructions: 'BASE-PROMPT-no-context' });
  await waitFor(() => advertisedInstructions(transport).length >= 1);

  assert.deepEqual(
    advertisedInstructions(transport),
    ['BASE-PROMPT-no-context'],
    'an empty pack must leave the prompt exactly as it was — no header, no blank lines',
  );
});

test('a frame over the budget is trimmed with a log line, and the next in-budget frame is still injected', async () => {
  const { socket, transport, logs } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => advertisedInstructions(transport).length >= 1);

  const oversized = '要'.repeat(VOICE_REALTIME_CONTEXT_MAX_CHARS + 1);
  socket.receive(contextFrame(oversized));

  // The frame is USABLE, not dropped: with no row boundaries it is one row, elided to the shipped
  // 600-char row cap, and the connection's reading (default 4 / 1,200 / 600) is what decides.
  await waitFor(() => logs.some((line) => line.includes('context truncated from=')));
  assert.ok(
    logs.some((line) => line.includes(`rows/${VOICE_REALTIME_CONTEXT_MAX_CHARS + 1} chars`)),
    'the trim must name the frame it received',
  );
  assert.equal(
    advertisedInstructions(transport).some((instructions) => instructions.includes(oversized)),
    false,
    'an over-budget pack must not reach the upstream whole',
  );
  assert.ok(
    advertisedInstructions(transport).some((instructions) => instructions.includes('要')),
    'the trimmed pack must still reach the upstream',
  );

  // The trim is about SIZE, not a broken path: an in-budget frame on the same connection
  // is injected normally, which is what stops this case passing vacuously.
  const ok = '用户：这是合法的一包。';
  socket.receive(contextFrame(ok));
  await waitFor(() => advertisedInstructions(transport).some((instructions) => instructions.includes(ok)));
  assert.equal(
    advertisedInstructions(transport).find((instructions) => instructions.includes(ok)),
    `BASE-PROMPT\n\n${VOICE_REALTIME_CONTEXT_HEADER}\n\n${ok}`,
  );
});

test('the settings file is read once per connection: an edit reaches the NEXT connection, not the live one', async () => {
  const settings = withSettingsFile();
  try {
    settings.write({ version: 'v1', instructions: 'RELAY-V1', contextTemplate: 'BLOCK-V1\n\n{{context}}' });

    // The live connection reads v1 and holds that reading.
    const live = wireConnection({ settingsPath: settings.path });
    await waitFor(() => live.transport.openCalls >= 1);
    await waitFor(() => advertisedInstructions(live.transport).length >= 1);
    assert.equal(advertisedInstructions(live.transport).at(-1), 'RELAY-V1');

    // The deployment edits the prompt while that connection is open.
    settings.write({ version: 'v2', instructions: 'RELAY-V2', contextTemplate: 'BLOCK-V2\n\n{{context}}' });

    // The live connection composes from the reading it took at connect time — proven by a pack
    // that arrives only AFTER the edit: it must come out under v1's block, not v2's.
    live.socket.receive(contextFrame('LIVE-PACK'));
    await waitFor(() => advertisedInstructions(live.transport).some((instructions) => instructions.includes('LIVE-PACK')));
    assert.equal(
      advertisedInstructions(live.transport).find((instructions) => instructions.includes('LIVE-PACK')),
      'RELAY-V1\n\nBLOCK-V1\n\nLIVE-PACK',
      'the live connection must keep the template it was opened with',
    );

    // A connection opened after the edit reads v2.
    const next = wireConnection({ settingsPath: settings.path });
    await waitFor(() => next.transport.openCalls >= 1);
    await waitFor(() => advertisedInstructions(next.transport).length >= 1);
    next.socket.receive(contextFrame('NEXT-PACK'));
    await waitFor(() => advertisedInstructions(next.transport).some((instructions) => instructions.includes('NEXT-PACK')));
    assert.equal(
      advertisedInstructions(next.transport).find((instructions) => instructions.includes('NEXT-PACK')),
      'RELAY-V2\n\nBLOCK-V2\n\nNEXT-PACK',
      'a connection opened after the edit must read the new file',
    );
  } finally {
    settings.cleanup();
  }
});

test('an unreadable settings file falls back to the shipped defaults, with the reason logged', async () => {
  const settings = withSettingsFile();
  try {
    settings.write('{ this is not JSON');
    const { socket, transport, logs } = wireConnection({ settingsPath: settings.path });
    await waitFor(() => transport.openCalls >= 1);

    await waitFor(() => logs.some((line) => line.includes('settings: using the built-in prompt')));
    assert.ok(
      logs.some((line) => line.includes('not valid JSON')),
      'the fallback must say WHY the file was refused',
    );

    // The defaults ARE what is used: the shipped header introduces the pack.
    socket.receive(contextFrame('PACK-AFTER-FALLBACK'));
    await waitFor(() =>
      advertisedInstructions(transport).some((instructions) => instructions.includes('PACK-AFTER-FALLBACK')),
    );
    assert.equal(
      advertisedInstructions(transport).find((instructions) => instructions.includes('PACK-AFTER-FALLBACK')),
      `BASE-PROMPT\n\n${VOICE_REALTIME_CONTEXT_HEADER}\n\nPACK-AFTER-FALLBACK`,
    );
  } finally {
    settings.cleanup();
  }
});

test('the context frame is parsed, and a malformed one is ignored rather than forwarded', () => {
  assert.deepEqual(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'context', text: 'x', chars: 1, rows: 1 })), {
    type: 'context',
    text: 'x',
    chars: 1,
    rows: 1,
  });

  // No text — nothing to inject, so it is refused at the parser, not turned into an empty pack.
  assert.equal(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'context', rows: 3 })), null);
  assert.equal(readVoiceRealtimeInboundFrame('not json at all'), null);

  // A frame with the text but a missing/mis-typed count is USABLE: the counts are for the log,
  // and refusing the text over a bad integer would drop the context it carries.
  assert.deepEqual(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'context', text: 'abc' })), {
    type: 'context',
    text: 'abc',
    chars: 3,
    rows: 0,
  });
});

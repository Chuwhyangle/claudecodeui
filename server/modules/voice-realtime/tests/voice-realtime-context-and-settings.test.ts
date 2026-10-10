/**
 * AC-320's own entry point for the server half: the `context` frame in, the session's instructions
 * out, and the settings file read once per connection so an edit is hot for the NEXT one only.
 *
 * WHY A SECOND SUITE. `voice-realtime-context-injection.test.ts` is the deeper one (parser
 * edge cases, the refusal's log line, the fallback reason). This file is the criterion AC-320
 * names, and it reads the three properties the criterion states, each end-to-end over a real
 * `handleVoiceRealtimeConnection`: 如实标注 (the pack arrives under the honest "这是当前 Claude Code
 * 会话的上下文" lead-in and carries no usage rules of its own), 字符预算硬上限 (the proxy re-checks the
 * frame against its own cap and refuses an over-cap pack whole), and 热修改 (a connection keeps the
 * settings it read at connect time; the next connection reads the edited file — no restart).
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts
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
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';
import { VOICE_REALTIME_CONTEXT_HEADER } from '../voice-realtime-settings.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/** The browser's socket, as far as `handleVoiceRealtimeConnection` uses it. */
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

const instructionsSent = (transport: FakeTransport): string[] =>
  transport.sent
    .filter(
      (message): message is Extract<RealtimeClientMessage, { type: 'session.update' }> =>
        message.type === 'session.update',
    )
    .map((message) => message.session.instructions);

function wire(options: { settingsPath?: string } = {}): {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  logs: string[];
} {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const logs: string[] = [];
  const executor: RealtimeToolExecutor = { session_send: async () => ({ ok: true }) };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'BASE-PROMPT',
    ...(options.settingsPath === undefined ? {} : { settingsPath: options.settingsPath }),
    log: (line: string) => logs.push(line),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transport, logs };
}

const contextFrame = (text: string, rows = 1): VoiceRealtimeInboundFrame => ({
  type: 'context',
  text,
  chars: text.length,
  rows,
});

test('如实标注: the pack reaches upstream under the honest lead-in, with no usage rules added', async () => {
  const { socket, transport, logs } = wire();
  await waitFor(() => transport.openCalls >= 1);
  const pack = '用户（1 分钟前）：把超时改成五十秒\n助手（刚刚）：已改。';
  socket.receive(contextFrame(pack, 2));

  await waitFor(() => instructionsSent(transport).some((text) => text.includes(pack)));
  const composed = instructionsSent(transport).find((text) => text.includes(pack))!;
  assert.equal(composed, `BASE-PROMPT\n\n${VOICE_REALTIME_CONTEXT_HEADER}\n\n${pack}`);
  assert.ok(
    composed.indexOf(VOICE_REALTIME_CONTEXT_HEADER) < composed.indexOf(pack),
    'the lead-in must come BEFORE the pack, so the model reads it as what follows',
  );
  assert.equal(logs.some((line) => line.includes(pack)), false, 'the body is the conversation; it is not logged');
});

test('a session that was sent no pack opens with the base prompt, byte for byte', async () => {
  const { transport } = wire();
  await waitFor(() => instructionsSent(transport).length >= 1);
  assert.deepEqual(instructionsSent(transport), ['BASE-PROMPT']);
});

test('字符预算硬上限: the proxy re-checks the frame and refuses an over-cap pack whole', async () => {
  const { socket, transport, logs } = wire();
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => instructionsSent(transport).length >= 1);

  const oversized = '字'.repeat(VOICE_REALTIME_CONTEXT_MAX_CHARS + 1);
  socket.receive(contextFrame(oversized));
  await waitFor(() => logs.some((line) => line.includes('context refused')));
  assert.equal(
    instructionsSent(transport).some((text) => text.includes(oversized)),
    false,
    'the cap is re-checked server-side; an over-cap pack must not reach the upstream',
  );
});

test('热修改: an edit reaches the next connection while the live one keeps its reading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-context-and-settings-'));
  const file = join(dir, 'settings.json');
  try {
    writeFileSync(
      file,
      JSON.stringify({ version: 'v1', instructions: 'RELAY-V1', contextTemplate: 'LEAD-V1\n\n{{context}}' }),
    );
    const live = wire({ settingsPath: file });
    await waitFor(() => instructionsSent(live.transport).length >= 1);
    assert.equal(instructionsSent(live.transport).at(-1), 'RELAY-V1');

    writeFileSync(
      file,
      JSON.stringify({ version: 'v2', instructions: 'RELAY-V2', contextTemplate: 'LEAD-V2\n\n{{context}}' }),
    );

    // The live connection composes from the reading it took at connect time — the pack arrives only
    // after the edit, so this can only come out under v1 if the reading really is held.
    live.socket.receive(contextFrame('LIVE'));
    await waitFor(() => instructionsSent(live.transport).some((text) => text.includes('LIVE')));
    assert.equal(instructionsSent(live.transport).find((text) => text.includes('LIVE')), 'RELAY-V1\n\nLEAD-V1\n\nLIVE');

    const next = wire({ settingsPath: file });
    await waitFor(() => instructionsSent(next.transport).length >= 1);
    assert.equal(
      instructionsSent(next.transport).at(-1),
      'RELAY-V2',
      'a connection opened after the edit must read the new file, with no restart',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

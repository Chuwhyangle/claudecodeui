/**
 * Stage 0 — N1 through the PRODUCTION ws-proxy, fully offline (¥0).
 *
 * The live replay (run.mts) drives transport + bridge only, so the proxy's own machinery — duplicate
 * guard, coalescing window, busy hold, text-reply net, span watermark — was never exercised without a
 * closing response. This runs the SAME scripted conversation twice through `handleVoiceRealtimeConnection`
 * with a fake upstream: K (shipped) and N1 (no closing response + both "reply OK" requests removed),
 * then compares what the person can observe: what reached the session, and what the browser was shown.
 *
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-closing-turn/proxy-offline.mts
 */
import { EventEmitter } from 'node:events';

import { WebSocket as WS } from 'ws';

import { createDashscopeTransport, type RealtimeToolExecutor } from '../../server/modules/voice-realtime/index.js';
import {
  handleVoiceRealtimeConnection,
  VOICE_REALTIME_INSTRUCTIONS,
  type VoiceRealtimeOutboundFrame,
} from '../../server/modules/voice-realtime/voice-realtime-ws-proxy.service.js';
import { createFakeDashscopeServer } from '../../server/modules/voice-realtime/tests/voice-realtime-dashscope-harness.js';

import { N1_INSTRUCTIONS, OK_TAIL, withN1Results } from './n1.mts';

type Config = 'K' | 'N1';
const INTERRUPT_NOTE = /^\[The previous turn was interrupted[^\]]*\]\n\n/;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

type Ctx = {
  upstream: ReturnType<typeof createFakeDashscopeServer>;
  socket: FakeBrowserSocket;
  delivered: Array<{ message: string; priority: unknown }>;
  order: string[];
  say: (itemId: string, text: string) => void;
  call: (callId: string, message: string, tool?: 'session_send' | 'session_interrupt') => void;
  until: (predicate: () => boolean, ms?: number) => Promise<void>;
};

type Summary = {
  delivered: string[];
  order: string[];
  responseCreates: number;
  toolOutputs: string[];
  browserFrames: Record<string, number>;
  errors: string[];
};

async function run(config: Config, script: (ctx: Ctx) => Promise<void>, busyFirst = 0): Promise<Summary> {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const delivered: Ctx['delivered'] = [];
  const order: string[] = [];
  let busyLeft = busyFirst;
  const executor: RealtimeToolExecutor = {
    session_send: async (args) => {
      if (busyLeft > 0) {
        busyLeft -= 1;
        throw Object.assign(new Error('Session already has a run in progress.'), { code: 'SESSION_BUSY' });
      }
      delivered.push({ message: String(args.message ?? ''), priority: args.priority });
      order.push('send');
      return { runId: 'r', queued: false, queuedMessageUuid: `u${delivered.length}` };
    },
    session_interrupt: async () => {
      order.push('abort');
      return { aborted: true };
    },
  };
  const socket = new FakeBrowserSocket();
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'bound', {
    createTransport: (report) => {
      const transport = createDashscopeTransport({
        apiKey: 'sk-test-not-a-real-key',
        socketFactory: upstream.socketFactory,
        onError: report,
        respondToToolOutputs: config === 'K',
      });
      return config === 'N1' ? withN1Results(transport as never) : transport;
    },
    createExecutor: () => executor,
    instructions: config === 'N1' ? N1_INSTRUCTIONS : VOICE_REALTIME_INSTRUCTIONS,
    segmentedRelay: false,
    coalesceMs: 50,
    busyRetry: { intervalMs: 20, maxMs: 5_000 },
  });
  const until = async (predicate: () => boolean, ms = 2_500): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await sleep(5);
    }
  };
  await until(() => socket.outbound.some((f) => f.type === 'state' && f.state === 'open'));
  // The closing response K asks for: the endpoint answers each synthesized `response.create` with a
  // one-word text turn. Without this the K arm would owe a reply forever and swallow the next one.
  let answeredCreates = 0;
  const closer = setInterval(() => {
    const creates = (upstream.sent as Array<Record<string, unknown>>).filter((f) => f.type === 'response.create').length;
    while (answeredCreates < creates) {
      answeredCreates += 1;
      const id = `closing-${answeredCreates}`;
      upstream.peerSend({ type: 'response.created', response: { id } });
      upstream.peerSend({ type: 'response.text.done', response_id: id, text: 'OK' });
      upstream.peerSend({ type: 'response.done', response: { id, status: 'completed' } });
    }
  }, 5);
  const ctx: Ctx = {
    upstream,
    socket,
    delivered,
    order,
    until,
    say: (itemId, text) =>
      upstream.peerSend({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: text }),
    call: (callId, message, tool = 'session_send') =>
      upstream.peerSend({
        type: 'response.function_call_arguments.done',
        call_id: callId,
        name: tool,
        arguments: JSON.stringify(tool === 'session_interrupt' ? { message, intent: 'the person changed direction' } : { message }),
      }),
  };
  await script(ctx);
  await sleep(1_700); // past the relay's own ~1 s window: a late second delivery would have landed
  const frames: Record<string, number> = {};
  const errors: string[] = [];
  for (const f of socket.outbound) {
    frames[f.type] = (frames[f.type] ?? 0) + 1;
    if (f.type === 'error') errors.push(String((f as { code?: unknown }).code));
  }
  const sent = upstream.sent as Array<Record<string, unknown>>;
  const toolOutputs = sent
    .filter((f) => f.type === 'conversation.item.create' && (f.item as { type?: string } | undefined)?.type === 'function_call_output')
    .map((f) => String((f.item as { output?: unknown }).output));
  clearInterval(closer);
  socket.close();
  return {
    delivered: delivered.map((d) => d.message.replace(INTERRUPT_NOTE, '<interrupt-note>')),
    order,
    responseCreates: sent.filter((f) => f.type === 'response.create').length,
    toolOutputs,
    browserFrames: frames,
    errors,
  };
}

type Scenario = { name: string; busyFirst?: number; script: (ctx: Ctx) => Promise<void>; expectDelivered?: string[]; expectContains?: string[] };

const scenarios: Scenario[] = [
  {
    name: 'S1 three utterances, three calls, no closing turns',
    expectDelivered: ['第一句。', '第二句。', '第三句。'],
    script: async (c) => {
      for (const [i, text] of ['第一句。', '第二句。', '第三句。'].entries()) {
        c.say(`i${i}`, text);
        c.call(`c${i}`, text);
        await c.until(() => c.delivered.length === i + 1);
      }
    },
  },
  {
    name: 'S2a after an interrupt, the next sentence is relayed by a call (N1 intent)',
    expectDelivered: ['先停一下。', '<interrupt-note>然后改成这样做。'],
    script: async (c) => {
      c.say('i1', '先停一下。');
      c.call('c1', '先停一下。', 'session_interrupt');
      await c.until(() => c.order.includes('abort'));
      c.say('i2', '然后改成这样做。');
      c.call('c2', '然后改成这样做。');
      await c.until(() => c.delivered.length === 2);
    },
  },
  {
    name: 'S2b after an interrupt, the model answers the next sentence in TEXT (the N0 failure form)',
    expectDelivered: ['先停一下。', '<interrupt-note>然后改成这样做。'],
    script: async (c) => {
      c.say('i1', '先停一下。');
      c.call('c1', '先停一下。', 'session_interrupt');
      await c.until(() => c.order.includes('abort'));
      c.say('i2', '然后改成这样做。');
      c.upstream.peerSend({ type: 'response.created', response: { id: 'r2' } });
      c.upstream.peerSend({ type: 'response.text.done', response_id: 'r2', text: 'OK' });
    },
  },
  {
    name: 'S3 a stray text reply after a delivered sentence delivers nothing twice',
    expectDelivered: ['跑一下测试。'],
    script: async (c) => {
      c.say('i1', '跑一下测试。');
      c.call('c1', '跑一下测试。');
      await c.until(() => c.delivered.length === 1);
      c.upstream.peerSend({ type: 'response.created', response: { id: 'r9' } });
      c.upstream.peerSend({ type: 'response.text.done', response_id: 'r9', text: 'No response requested.' });
    },
  },
  {
    name: 'S4 the same call again with no new audio is refused (duplicate guard)',
    expectDelivered: ['跑一下测试。'],
    script: async (c) => {
      c.say('i1', '跑一下测试。');
      c.call('c1', '跑一下测试。');
      await c.until(() => c.delivered.length === 1);
      c.call('c2', '跑一下测试。');
      await sleep(300);
    },
  },
  {
    name: 'S5 a busy session is waited for; one delivery',
    busyFirst: 2,
    expectDelivered: ['等你忙完再说。'],
    script: async (c) => {
      c.say('i1', '等你忙完再说。');
      c.call('c1', '等你忙完再说。');
      await c.until(() => c.delivered.length === 1, 4_000);
    },
  },
  {
    name: 'S6 two fragments of one sentence arrive while the first is held: one delivery, in order',
    busyFirst: 3,
    expectDelivered: ['前半句后半句'],
    script: async (c) => {
      c.say('i1', '前半句');
      c.call('c1', '前半句');
      await sleep(30);
      c.say('i2', '后半句');
      c.call('c2', '后半句');
      await c.until(() => c.delivered.length >= 1, 4_000);
    },
  },
  {
    name: 'S7 REPLAY S_A#2: two finals heard, the call relays only the second — the first must ride along',
    expectContains: ['现在跑一个时间长一些的前台 batch 测试', '大概三十到六十秒'],
    script: async (c) => {
      c.say('i1', '现在跑一个时间长一些的前台 batch 测试。');
      c.say('i2', '大概三十到六十秒。');
      c.call('c1', '大概三十到六十秒。');
      await c.until(() => c.delivered.length >= 1, 3_000);
    },
  },
  {
    name: 'S8 REPLAY S_A#1: the first call is cut by the next speech (empty), the next call carries only the second',
    expectContains: ['我比较喜欢的就是每一次', '这好神奇啊'],
    script: async (c) => {
      c.say('i1', '你看，我比较喜欢的就是每一次它就能认对了。');
      c.upstream.peerSend({ type: 'response.created', response: { id: 'rcut' } });
      c.upstream.peerSend({ type: 'response.function_call_arguments.done', call_id: 'ccut', name: 'session_send', arguments: '{"message": "' });
      c.upstream.peerSend({ type: 'response.done', response: { id: 'rcut', status: 'cancelled', status_details: { type: 'cancelled', reason: 'turn_detected' } } });
      await sleep(100);
      c.say('i2', '这好神奇啊。');
      c.call('c2', '这好神奇啊。');
      await c.until(() => c.delivered.length >= 1, 3_000);
    },
  },
];

const jobs = scenarios.flatMap((s) => (['K', 'N1'] as const).map((cfg) => ({ s, cfg })));
const t0 = Date.now();
const results = await Promise.all(jobs.map(async ({ s, cfg }) => ({ s, cfg, r: await run(cfg, s.script, s.busyFirst ?? 0) })));
const wall = Date.now() - t0;

let violations = 0;
const fail = (msg: string): void => {
  violations += 1;
  console.log(`    ✘ ${msg}`);
};
const j = (value: unknown): string => JSON.stringify(value);

for (const s of scenarios) {
  const k = results.find((x) => x.s === s && x.cfg === 'K')!.r;
  const n = results.find((x) => x.s === s && x.cfg === 'N1')!.r;
  console.log(`\n${s.name}`);
  console.log(`  K : delivered=${j(k.delivered)} createsUp=${k.responseCreates} outputs=${k.toolOutputs.length} frames=${j(k.browserFrames)}`);
  console.log(`  N1: delivered=${j(n.delivered)} createsUp=${n.responseCreates} outputs=${n.toolOutputs.length} frames=${j(n.browserFrames)}`);
  if (s.expectDelivered !== undefined && j(n.delivered) !== j(s.expectDelivered)) fail(`N1 delivered ${j(n.delivered)}, expected ${j(s.expectDelivered)}`);
  for (const needle of s.expectContains ?? []) {
    if (!n.delivered.join('\n').includes(needle)) fail(`N1 never delivered "${needle}"`);
    if (!k.delivered.join('\n').includes(needle)) fail(`K never delivered "${needle}"`);
  }
  if (j(n.delivered) !== j(k.delivered)) fail(`N1 and K delivered differently: K=${j(k.delivered)}`);
  if (n.responseCreates !== 0) fail(`N1 sent ${n.responseCreates} response.create (a closing turn survived)`);
  if (n.toolOutputs.some((o) => o.includes('single word OK'))) fail('an N1 tool result still asks for "OK"');
  if (j(n.order) !== j(k.order)) fail(`N1 and K ordered effects differently: K=${j(k.order)} N1=${j(n.order)}`);
  const frameDiff = [...new Set([...Object.keys(k.browserFrames), ...Object.keys(n.browserFrames)])]
    .filter((t) => (k.browserFrames[t] ?? 0) !== (n.browserFrames[t] ?? 0))
    .map((t) => `${t}: K=${k.browserFrames[t] ?? 0} N1=${n.browserFrames[t] ?? 0}`);
  if (frameDiff.length > 0) console.log(`    ⚠ browser-visible difference — ${frameDiff.join('; ')}`);
  if (j(n.errors) !== j(k.errors)) fail(`N1 surfaced different error frames: K=${j(k.errors)} N1=${j(n.errors)}`);
  if (!k.toolOutputs.some((o) => o.includes(OK_TAIL)) && k.toolOutputs.length > 0) {
    console.log('    ⚠ K control: no tool result carried the "OK" request (rewrite check is vacuous here)');
  }
}

console.log(`\nwall ${wall} ms · ${jobs.length} runs concurrent · violations ${violations}`);
process.exit(violations === 0 ? 0 : 1);

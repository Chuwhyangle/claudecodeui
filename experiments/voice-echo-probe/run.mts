#!/usr/bin/env tsx
/**
 * 回声探针：外放场景下，浏览器 `getUserMedia` 的 `echoCancellation` 遮不遮得住系统播报。
 *
 * 问题（GOAL-047 配套 C1）：TTS 开始出声后，扬声器放出来的「系统的话」会绕回自己的麦克风，
 * 被当成用户输入。浏览器 `echoCancellation: true` 若足够，就不必上真 AEC。
 *
 * 协议（预注册，见同目录 README.md）：
 *   - 播报：一段 6 s、语音形状的确定性信号（或 `--announcement` 指定的 PCM16 wav），循环播放。
 *   - 采集：`getUserMedia`，`noiseSuppression:false`、`autoGainControl:false`，只切换
 *     `echoCancellation`（false / true / 'all'，'all' 只在设备能力报告支持时跑）。
 *   - 播放路径两臂：
 *       plain    = WebAudio 直接进 destination（今天 TTS 最可能的形态）；
 *       loopback = 绕经本地 RTCPeerConnection 再播（远端媒体流一定在 AEC 参考里）。
 *   - 稳态窗：跳过前 `--warmup` 秒（AEC 收敛），取接下来 `--tail` 秒的功率。
 *
 * 读数：
 *   pickupDb   = 20log10(采回功率 / 播报功率)      —— 麦克风采回播报的程度
 *   erleDb     = 20log10(off 功率 / arm 功率)      —— AEC 的抑制量（Echo Return Loss Enhancement）
 *   另有 WebRTC `echoReturnLossEnhancement` 统计作为旁证。
 *
 * 判定（`--min-erle`，默认 12 dB）：
 *   plain-on   ≥ min            → echoCancellation 够
 *   loopback-on≥ min            → echoCancellation 够，但播放侧需走本地 PeerConnection 参考
 *   都不够                      → 需真 AEC
 *   测不到回声 / 无输入设备      → 环境问题，拒绝给产品结论（exit 2）
 *
 * `--capture simulated` 用 Chrome 假设备从合成回声 wav 采集，只用于验证「测量管线」本身。
 * 它不是产品读数：假采集路径下 Chrome 的 AEC 不参与（ERLE≈0，见 README 的本机记录）。
 *
 * 用法：
 *   npx tsx experiments/voice-echo-probe/run.mts --self-test
 *   npx tsx experiments/voice-echo-probe/run.mts --capture device
 *   npx tsx experiments/voice-echo-probe/run.mts --capture simulated
 *   npx tsx experiments/voice-echo-probe/run.mts --capture device --announcement /path/to/ann.wav
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

// ---------------------------------------------------------------------------
// CLI

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
};
const has = (name: string): boolean => argv.includes(name);

if (has('--help') || has('-h')) {
  process.stdout.write(
    [
      'voice-echo-probe — 外放回声测量',
      '',
      '  --self-test                 只跑测量数学的自检（无浏览器）',
      '  --capture device|simulated  真设备（默认）或假设备+合成回声',
      '  --announcement <wav>        播报音频（PCM16），默认生成 6 s 语音形状信号',
      '  --seconds <n>               每臂采集秒数（默认 10）',
      '  --warmup <n>                跳过收敛秒数（默认 5）',
      '  --tail <n>                  稳态窗秒数（默认 4）',
      '  --min-erle <db>             判定阈值（默认 12）',
      '  --out <dir>                 trace 输出目录（默认 /tmp/voice-echo-probe-<ts>）',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const SELF_TEST = has('--self-test');
const CAPTURE = arg('--capture', 'device');
const ANNOUNCEMENT = arg('--announcement', '');
const ARM_SECONDS = Number(arg('--seconds', '10'));
const WARMUP_SEC = Number(arg('--warmup', '5'));
const TAIL_SEC = Number(arg('--tail', '4'));
const MIN_ERLE_DB = Number(arg('--min-erle', '12'));
const OUT_DIR = arg('--out', path.join(os.tmpdir(), `voice-echo-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`));

if (CAPTURE !== 'device' && CAPTURE !== 'simulated') {
  process.stderr.write(`--capture 只接受 device|simulated，收到 ${CAPTURE}\n`);
  process.exit(2);
}
if (!SELF_TEST && !(ARM_SECONDS > WARMUP_SEC + TAIL_SEC)) {
  process.stderr.write('--seconds 必须大于 --warmup + --tail\n');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 信号：确定性、语音形状（低通噪声 + 3 Hz 音节包络）

const SR = 48_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeAnnouncement(sampleRate = SR, seconds = 6, seed = 0x5eed): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const rnd = mulberry32(seed);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i += 1) {
    const white = rnd() * 2 - 1;
    lp = 0.85 * lp + 0.15 * white; // 语音频段倾斜
    const t = i / sampleRate;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 3.1 * t)) ** 0.6;
    out[i] = lp * syllable * 0.35;
  }
  return out;
}

/** 合成「外放」路径：延迟 + 衰减 + 一次反射 + 扬声器软饱和 + 底噪。 */
function applyEchoPath(
  ref: Float32Array,
  sampleRate = SR,
  { delayMs = 120, gainDb = -9, reflectionDelayMs = 40, reflectionGainDb = -16, noiseDbfs = -55, saturation = 1.8 } = {},
): Float32Array {
  const n = ref.length;
  const rnd = mulberry32(0xec0);
  const out = new Float32Array(n);
  const delay = Math.round((delayMs / 1000) * sampleRate);
  const reflection = Math.round((reflectionDelayMs / 1000) * sampleRate);
  const gain = 10 ** (gainDb / 20);
  const reflectionGain = 10 ** (reflectionGainDb / 20);
  const noise = 10 ** (noiseDbfs / 20);
  for (let i = 0; i < n; i += 1) {
    let v = 0;
    if (i >= delay) v += gain * ref[i - delay];
    if (i >= delay + reflection) v += reflectionGain * ref[i - delay - reflection];
    // 扬声器软饱和；底噪在饱和之后加入，模拟麦克风端本底。
    out[i] = Math.tanh(v * saturation) / saturation + (rnd() * 2 - 1) * noise;
  }
  return out;
}

function writeWav(file: string, samples: Float32Array, sampleRate = SR): void {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  }
  writeFileSync(file, buf);
}

function readWav(file: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: 不是 RIFF/WAVE`);
  }
  let offset = 12;
  let channels = 1;
  let sampleRate = SR;
  let bits = 16;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      const format = body.readUInt16LE(0);
      if (format !== 1) throw new Error(`${file}: 只支持 PCM wav（format=${format}）`);
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }
  if (!data || bits !== 16) throw new Error(`${file}: 需要 16-bit PCM data chunk`);
  const frames = Math.floor(data.length / (2 * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += data.readInt16LE((i * channels + c) * 2) / 32768;
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

// ---------------------------------------------------------------------------
// 测量数学

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(samples.length, to); i += 1) {
    sum += samples[i]! * samples[i]!;
    n += 1;
  }
  return n === 0 ? 0 : Math.sqrt(sum / n);
}

const toDb = (ratio: number): number => (ratio > 0 ? 20 * Math.log10(ratio) : Number.NEGATIVE_INFINITY);

/** `--min-erle` 判定用的自检：已知增益的回声必须读回同样的 pickup/ERLE。 */
function selfTest(): void {
  const ref = makeAnnouncement(SR, 6, 0xa11ce);
  // 自检只验数学：单一增益、无反射，期望值才能写成 -9 dB。
  const echo = applyEchoPath(ref, SR, { gainDb: -9, reflectionGainDb: -120, noiseDbfs: -80 });
  const pickup = toDb(rms(echo) / rms(ref));
  const cancelled = new Float32Array(echo.length);
  const erleApplied = 18;
  const factor = 10 ** (-erleApplied / 20);
  for (let i = 0; i < echo.length; i += 1) cancelled[i] = echo[i]! * factor;

  const failures: string[] = [];
  if (Math.abs(pickup - -9) > 0.5) failures.push(`pickup 期望 -9 dB，读到 ${pickup.toFixed(2)} dB`);
  const erle = toDb(rms(echo) / rms(cancelled));
  if (Math.abs(erle - erleApplied) > 0.5) failures.push(`ERLE 期望 ${erleApplied} dB，读到 ${erle.toFixed(2)} dB`);

  // 窗口化尾部读数必须与整段一致（实跑走的就是这条路径）。
  const windowSec = 0.5;
  const selfWarmupSec = 1;
  const selfTailSec = 2;
  const windows: number[] = [];
  for (let at = 0; at + windowSec <= echo.length / SR + 1e-9; at += windowSec) {
    windows.push(rms(echo, Math.round(at * SR), Math.round((at + windowSec) * SR)));
  }
  const first = Math.floor(selfWarmupSec / windowSec);
  const tail = windows.slice(first, first + Math.round(selfTailSec / windowSec));
  const tailRms = Math.sqrt(tail.reduce((s, v) => s + v * v, 0) / Math.max(1, tail.length));
  if (Math.abs(toDb(tailRms / rms(ref)) - -9) > 1.0) failures.push(`窗口 pickup 期望 -9 dB，读到 ${toDb(tailRms / rms(ref)).toFixed(2)} dB`);

  if (failures.length > 0) {
    process.stderr.write(`SELF-TEST FAIL\n  ${failures.join('\n  ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`SELF-TEST PASS  pickup=${pickup.toFixed(2)} dB  ERLE(注入 ${erleApplied} dB)=${erle.toFixed(2)} dB\n`);
}

if (SELF_TEST) {
  selfTest();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 浏览器页：一臂 = 一次 getUserMedia + 一段播放 + 0.5 s 窗 RMS

const PAGE = String.raw`<!doctype html><html><body><script>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function negotiate(a, b) {
  a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
  b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
  a.createDataChannel('probe');
  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(offer);
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(answer);
  await sleep(300);
}

/** 把麦克风轨送进一条本地 PC，只为让 getStats 报告 AEC 的 ERL/ERLE。 */
async function aecStats(stream) {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.addTrack(stream.getAudioTracks()[0], stream);
  await negotiate(a, b);
  return { a, b };
}

window.runArm = async (opts) => {
  const { playback, echoCancellation, seconds } = opts;
  const ctx = new AudioContext({ sampleRate: 48000 });
  let buffer = null;
  if (playback !== 'none') {
    const wav = await (await fetch('/announcement.wav')).arrayBuffer();
    buffer = await ctx.decodeAudioData(wav);
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (error) {
    return { error: String(error), capabilities: null };
  }
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  const capabilities = track.getCapabilities ? track.getCapabilities() : null;

  // 采集分析。ScriptProcessor 的输入必须被 destination 拉取；经一个 0 增益节点静音，
  // 否则真机模式下麦克风会被自己的采集再放出来，污染测量。
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  const windowSec = 0.5;
  const windows = [];
  let windowStart = 0;
  let windowSum = 0;
  let windowN = 0;
  const t0 = performance.now();
  proc.onaudioprocess = (event) => {
    const data = event.inputBuffer.getChannelData(0);
    const t = (performance.now() - t0) / 1000;
    for (let i = 0; i < data.length; i += 1) {
      windowSum += data[i] * data[i];
      windowN += 1;
    }
    if (t - windowStart >= windowSec && windowN > 0) {
      windows.push({ t: Number(windowStart.toFixed(3)), rms: Math.sqrt(windowSum / windowN) });
      windowStart = t;
      windowSum = 0;
      windowN = 0;
    }
  };

  const stats = await aecStats(stream);
  let playbackStart = 0;
  const stops = [];
  if (playback === 'plain') {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(ctx.destination);
    await ctx.resume();
    src.start();
    playbackStart = (performance.now() - t0) / 1000;
    stops.push(() => src.stop());
  } else if (playback === 'loopback') {
    // 播报绕经本地 PeerConnection：远端媒体流一定在 Chrome 的 AEC 参考里。
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(dest);
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
    const audio = document.createElement('audio');
    audio.autoplay = true;
    document.body.appendChild(audio);
    b.ontrack = (event) => { audio.srcObject = event.streams[0]; audio.play().catch(() => {}); };
    await negotiate(a, b);
    await ctx.resume();
    src.start();
    playbackStart = (performance.now() - t0) / 1000;
    stops.push(() => { src.stop(); audio.remove(); a.close(); b.close(); });
  } else {
    await ctx.resume();
  }

  await sleep(seconds * 1000);

  let aec = null;
  try {
    const report = await stats.a.getStats();
    report.forEach((s) => {
      if (s.type === 'media-source' && s.kind === 'audio' && s.echoReturnLossEnhancement !== undefined) {
        aec = { echoReturnLoss: s.echoReturnLoss, echoReturnLossEnhancement: s.echoReturnLossEnhancement };
      }
    });
  } catch { /* 统计缺失不是失败 */ }

  stops.forEach((fn) => { try { fn(); } catch { /* */ } });
  stream.getTracks().forEach((t) => t.stop());
  stats.a.close();
  stats.b.close();
  await ctx.close();

  if (windowN > 0) {
    windows.push({ t: Number(windowStart.toFixed(3)), rms: Math.sqrt(windowSum / windowN) });
  }
  return { settings, capabilities, playbackStart, windows, aec };
};
</script></body></html>`;

// ---------------------------------------------------------------------------
// 一臂的读数

type Window = { t: number; rms: number };
type ArmResult = {
  settings?: Record<string, unknown>;
  capabilities?: { echoCancellation?: unknown } | null;
  playbackStart?: number;
  windows?: Window[];
  aec?: { echoReturnLoss?: number; echoReturnLossEnhancement?: number } | null;
  error?: string;
};

function windowRms(windows: Window[], from: number, to: number): number {
  const picked = windows.filter((w) => w.t + 0.5 > from && w.t < to);
  if (picked.length === 0) return 0;
  return Math.sqrt(picked.reduce((s, w) => s + w.rms * w.rms, 0) / picked.length);
}

function steadyRms(arm: ArmResult, fallbackStart = 0): number {
  const windows = arm.windows ?? [];
  const start = (arm.playbackStart ?? fallbackStart) + WARMUP_SEC;
  return windowRms(windows, start, start + TAIL_SEC);
}

// ---------------------------------------------------------------------------
// 主流程

async function run(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const announcementFile = path.join(OUT_DIR, 'announcement.wav');
  const echoFile = path.join(OUT_DIR, 'echo-path.wav');

  const loaded = ANNOUNCEMENT ? readWav(ANNOUNCEMENT) : { samples: makeAnnouncement(), sampleRate: SR };
  const announcement = loaded.samples;
  writeWav(announcementFile, announcement, loaded.sampleRate);
  const referenceRms = rms(announcement);

  if (CAPTURE === 'simulated') {
    writeWav(echoFile, applyEchoPath(announcement, loaded.sampleRate), loaded.sampleRate);
  }

  const server = http.createServer((request, response) => {
    if (request.url === '/announcement.wav') {
      response.writeHead(200, { 'Content-Type': 'audio/wav' });
      response.end(readFileSync(announcementFile));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const args = ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  if (CAPTURE === 'simulated') {
    args.push('--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${echoFile}`);
  }
  const browser = await chromium.launch({ headless: true, args });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const userAgent = await page.evaluate(() => navigator.userAgent);

  const arms: Record<string, ArmResult> = {};
  const runArm = async (name: string, playback: 'none' | 'plain' | 'loopback', echoCancellation: boolean | string) => {
    const result = (await page.evaluate(
      (opts) => (window as unknown as { runArm: (o: typeof opts) => Promise<ArmResult> }).runArm(opts),
      { playback, echoCancellation, seconds: ARM_SECONDS },
    )) as ArmResult;
    arms[name] = result;
    if (result.error) {
      process.stdout.write(`arm ${name}: 失败 ${result.error}\n`);
    } else {
      const applied = result.settings?.echoCancellation;
      process.stdout.write(`arm ${name}: echoCancellation(请求 ${String(echoCancellation)}, 生效 ${String(applied)})\n`);
    }
    return result;
  };

  await runArm('baseline', 'none', false);
  await runArm('plain-off', 'plain', false);
  const plainOn = await runArm('plain-on', 'plain', true);

  const capabilities = plainOn.capabilities?.echoCancellation;
  const supportsAll = Array.isArray(capabilities) && capabilities.includes('all');
  if (supportsAll) {
    await runArm('plain-all', 'plain', 'all');
  }
  await runArm('loopback-on', 'loopback', true);

  await browser.close();
  server.close();

  // ---- 读数

  const noiseRms = steadyRms(arms['baseline']!);
  const offRms = steadyRms(arms['plain-off']!);
  const onRms = steadyRms(arms['plain-on']!);
  const loopRms = steadyRms(arms['loopback-on']!);
  const allRms = arms['plain-all'] ? steadyRms(arms['plain-all']) : null;

  const pickupDb = toDb(offRms / referenceRms);
  const erlePlainDb = toDb(offRms / onRms);
  const erleLoopbackDb = toDb(offRms / loopRms);
  const erleAllDb = allRms !== null ? toDb(offRms / allRms) : null;
  const echoOverNoiseDb = toDb(offRms / noiseRms);

  // ---- 判定

  let verdict: string;
  let exitCode: number;
  let conclusion: string;

  if (arms['plain-off']!.error) {
    verdict = 'no-audio-device';
    exitCode = 2;
    conclusion = `没有可用的音频输入设备（${arms['plain-off']!.error}）。请在带麦克风/扬声器的机器上重跑 --capture device。`;
  } else if (offRms === 0) {
    verdict = 'invalid-no-capture';
    exitCode = 2;
    conclusion = '没有采到任何音频；检查麦克风权限/设备。';
  } else if (CAPTURE === 'simulated') {
    const engaged = erleLoopbackDb >= 6 || (arms['loopback-on']!.aec?.echoReturnLossEnhancement ?? 0) >= 6;
    if (!engaged) {
      verdict = 'inconclusive-harness';
      exitCode = 2;
      conclusion =
        '假采集路径下 Chrome 的 AEC 不参与（ERLE≈0 dB），本次读数不能回答产品问题。' +
        '合成模式只验证测量管线；结论以 --capture device 的真机读数为准。';
    } else if (erlePlainDb >= MIN_ERLE_DB) {
      verdict = 'echoCancellation-suffices';
      exitCode = 0;
      conclusion = `plain ≥ ${MIN_ERLE_DB} dB：浏览器 echoCancellation 足以遮住当前播放路径。`;
    } else if (erleLoopbackDb >= MIN_ERLE_DB) {
      verdict = 'suffices-with-loopback';
      exitCode = 0;
      conclusion = `plain 不够（${erlePlainDb.toFixed(1)} dB），loopback 够（${erleLoopbackDb.toFixed(1)} dB）：播放侧走本地 PeerConnection 即可。`;
    } else {
      verdict = 'need-real-aec';
      exitCode = 1;
      conclusion = '两臂都不够：需真 AEC。';
    }
  } else if (echoOverNoiseDb < 6) {
    verdict = 'invalid-no-echo';
    exitCode = 2;
    conclusion = `没测到回声（回声只比底噪高 ${echoOverNoiseDb.toFixed(1)} dB）。扬声器静音/耳机/音量过低时都会这样；调大音量重跑。`;
  } else if (erlePlainDb >= MIN_ERLE_DB) {
    verdict = 'echoCancellation-suffices';
    exitCode = 0;
    conclusion = `plain ≥ ${MIN_ERLE_DB} dB：浏览器 echoCancellation 足以遮住当前播放路径，不需要真 AEC。`;
  } else if (erleLoopbackDb >= MIN_ERLE_DB) {
    verdict = 'suffices-with-loopback';
    exitCode = 0;
    conclusion = `plain 不够（${erlePlainDb.toFixed(1)} dB），loopback 够（${erleLoopbackDb.toFixed(1)} dB）：把 TTS 播放绕经本地 PeerConnection 即可，不需要真 AEC。`;
  } else {
    verdict = 'need-real-aec';
    exitCode = 1;
    conclusion = `plain ${erlePlainDb.toFixed(1)} dB、loopback ${erleLoopbackDb.toFixed(1)} dB，都低于 ${MIN_ERLE_DB} dB：需真 AEC。`;
  }

  const report = {
    startedAt: new Date().toISOString(),
    capture: CAPTURE,
    userAgent,
    settings: {
      seconds: ARM_SECONDS,
      warmupSec: WARMUP_SEC,
      tailSec: TAIL_SEC,
      minErleDb: MIN_ERLE_DB,
      sampleRate: SR,
      announcement: ANNOUNCEMENT || '(generated)',
    },
    capabilities,
    supportsAll,
    readings: {
      referenceDbfs: toDb(referenceRms),
      noiseDbfs: toDb(noiseRms),
      echoDbfs: toDb(offRms),
      pickupDb,
      echoOverNoiseDb,
      erlePlainDb,
      erleLoopbackDb,
      erleAllDb,
      aecStats: {
        'plain-on': arms['plain-on']!.aec ?? null,
        'loopback-on': arms['loopback-on']!.aec ?? null,
      },
    },
    arms,
    verdict,
    conclusion,
  };
  const traceFile = path.join(OUT_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(traceFile, JSON.stringify(report, null, 1));

  process.stdout.write(
    [
      '',
      `capture=${CAPTURE}  chrome=${userAgent}`,
      `echoCancellation 能力: ${JSON.stringify(capabilities)}${supportsAll ? '' : '（无 all）'}`,
      `底噪 ${toDb(noiseRms).toFixed(1)} dBFS | 回声 ${toDb(offRms).toFixed(1)} dBFS | pickup ${pickupDb.toFixed(1)} dB | 回声/底噪 ${echoOverNoiseDb.toFixed(1)} dB`,
      `ERLE: plain ${erlePlainDb.toFixed(1)} dB | loopback ${erleLoopbackDb.toFixed(1)} dB${erleAllDb === null ? '' : ` | all ${erleAllDb.toFixed(1)} dB`}`,
      `结论: ${verdict} — ${conclusion}`,
      `trace: ${traceFile}`,
      '',
    ].join('\n'),
  );
  process.exitCode = exitCode;
}

run().catch((error) => {
  process.stderr.write(`voice-echo-probe 失败: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 2;
});

#!/usr/bin/env node
/**
 * Push an audio file through a running server's Live Voice pipeline over HTTP and print
 * what the upstream heard and what the model did. No browser, no microphone.
 *
 *   node scripts/voice-realtime-diagnose.mjs --url http://127.0.0.1:3001 \
 *     --token <JWT> --session <sessionId> --wav clip.wav [--live] [--speed 1] [--json]
 *
 * The WAV must be mono, 16 kHz, 16-bit PCM (`ffmpeg -i in.mp3 -ac 1 -ar 16000 -c:a pcm_s16le out.wav`).
 * By default the run is a dry run: the model's `session_send` is recorded, not delivered,
 * so the conversation is not touched. `--live` delivers it. The token may also come from
 * the VOICE_DIAGNOSE_TOKEN environment variable. Exit code 0 only when the audio was both
 * heard and acted on.
 *
 * Multi-turn: `--wav a.wav,b.wav,c.wav [--gap 1500]` speaks the clips in order on ONE connection,
 * `--gap` ms of silence after each (`--quiet` ms of upstream silence ends each turn; raise it with `--live`
 * so Claude has time to answer before the next turn), and prints what each turn was heard as and what it sent.
 *
 * Contract mode: `--repeat N [--min-ok K]` runs the same clip N times (each on a fresh connection)
 * and prints one line per run plus the pass rate; exit 0 only when at least K runs (default N)
 * were `ok`. The real upstream is variable (connect time 0.2-9 s, an occasional stall), so a
 * single green run proves little and a single red run proves less; the rate is the reading.
 *
 * Segmented mode: `--segments` splits the WAV on THIS side with the browser's own relay segmenter
 * (`voiceLiveSegmenter`'s `relay` profile, driven by the shipping `StreamingVad`) and sends the
 * pieces as `turns`, so the HTTP diagnosis can exercise the segment protocol too — no browser, no
 * microphone. Start the server with `VOICE_REALTIME_SEGMENT_COMMIT=manual` so the service maps those
 * turns to segments (the route itself carries only the turn list). The report's per-segment
 * `seq`/duration/`ack` are printed one line each. Use this with a real upstream for the DoD run.
 *
 * Turn detector: `--turn-detection <type>[@<silenceMs>] [--threshold <n>]` overrides the upstream
 * detector for THIS run only — `server_vad`, `server_vad@800` and `semantic_vad` are the three the
 * GOAL-037 comparison (AC-325) runs. The values are NOT validated here: the server resolves them with
 * the same rules it reads `VOICE_REALTIME_TURN_DETECTION*` with, so an out-of-range number is refused
 * and falls back to the deployment default ON THE SERVER, not silently corrected on this side.
 */
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The frontend's `@/` source-root alias, resolved for this plain-node process, so the segmenter the
// browser runs (and its `StreamingVad`) can be driven here unchanged. Must be registered before the
// dynamic import in the `--segments` block below.
const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(join(SRC_ROOT, specifier.slice(2)) + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

/** @type {Map<string, string>} */
const args = new Map();
const flags = new Set();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next === undefined || next.startsWith('--')) flags.add(token.slice(2));
  else {
    args.set(token.slice(2), next);
    index += 1;
  }
}

const url = args.get('url') ?? 'http://127.0.0.1:3001';
const token = args.get('token') ?? process.env.VOICE_DIAGNOSE_TOKEN;
const session = args.get('session');
const wav = args.get('wav');
const wavFiles = wav ? wav.split(',').filter(Boolean) : [];
if (!token || !session || !wav) {
  console.error('usage: voice-realtime-diagnose.mjs --token <JWT> --session <id> --wav <file> [--url <base>] [--live] [--speed n] [--json] [--turn-detection <type>[@<silenceMs>]] [--threshold <n>]');
  process.exit(2);
}

/**
 * Parses `--turn-detection <type>[@<silenceMs>]` (+ optional `--threshold <n>`) into the route's
 * `turnDetection` body field — the per-run override of the upstream detector. Values are handed on
 * UNVALIDATED on purpose: the server resolves them with the same rules it reads the
 * `VOICE_REALTIME_TURN_DETECTION*` environment with, so an out-of-range number is refused and reported
 * there rather than silently corrected here.
 * @returns {{ type?: string, silenceMs?: number, threshold?: number } | undefined}
 */
function parseTurnDetection() {
  if (!args.has('turn-detection')) return undefined;
  const [type, silence] = String(args.get('turn-detection')).split('@');
  /** @type {{ type?: string, silenceMs?: number, threshold?: number }} */
  const override = {};
  if (type) override.type = type;
  if (silence !== undefined && silence !== '') override.silenceMs = Number(silence);
  if (args.has('threshold')) override.threshold = Number(args.get('threshold'));
  return override;
}
const turnDetection = parseTurnDetection();

const audioBase64 = readFileSync(wavFiles[0]).toString('base64');
const gapMs = args.has('gap') ? Number(args.get('gap')) : 1500;
const turns = wavFiles.length > 1 ? wavFiles.map((file) => ({ audioBase64: readFileSync(file).toString('base64'), gapMs })) : undefined;

/**
 * Decodes a mono 16-bit PCM RIFF/WAVE buffer into the Float32Array the segmenter reads, with the
 * format it declares. Finds the `fmt ` and `data` chunks rather than trusting a 44-byte header.
 * @param {Buffer} buf
 * @returns {{ samples: Float32Array, sampleRate: number, channels: number }}
 */
function wavToFloat32(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('--segments needs a RIFF/WAVE file (mono 16 kHz PCM16)');
  }
  let sampleRate = 0;
  let channels = 0;
  let dataStart = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
    } else if (id === 'data') {
      dataStart = offset + 8;
      dataLength = Math.min(size, buf.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error('--segments: WAV has no data chunk');
  const samples = new Float32Array(Math.floor(dataLength / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = buf.readInt16LE(dataStart + index * 2) / 32768;
  return { samples, sampleRate, channels };
}

/**
 * Splits the `--wav` clip on this side with the browser's relay segmenter and returns the pieces as
 * `turns` (the route's only multi-clip channel). Requires `VOICE_REALTIME_SEGMENT_COMMIT` on the
 * server so the service maps them to segments rather than a plain multi-turn script.
 * @returns {Promise<Array<{ audioBase64: string, gapMs: number }>>}
 */
async function buildSegmentTurns() {
  if (wavFiles.length !== 1) {
    console.error('--segments takes exactly one --wav file');
    process.exit(2);
  }
  const { segmentLive } = await import(new URL('../src/modules/chat/utils/voice/voiceLiveSegmenter.ts', import.meta.url).href);
  const { StreamingVad } = await import(new URL('../src/shared/voiceEndpoint.ts', import.meta.url).href);
  const { samples, sampleRate, channels } = wavToFloat32(readFileSync(wavFiles[0]));
  if (sampleRate !== 16_000 || channels !== 1) {
    console.error(`--segments needs mono 16 kHz PCM16; got ${channels} ch @ ${sampleRate} Hz`);
    process.exit(2);
  }
  const vad = new StreamingVad({ sampleRate });
  const events = vad.push(samples);
  const segments = segmentLive(samples, sampleRate, events, { profile: 'relay' });
  if (segments.length === 0) {
    console.error('--segments: the relay segmenter found no speech in the clip');
    process.exit(2);
  }
  if (segments.length > 8) {
    console.error(`--segments: the clip cut into ${segments.length} segments, over the route's 8-turn cap`);
    process.exit(2);
  }
  console.error(`--segments: relay segmenter cut ${segments.length} segment(s): ${segments.map((/** @type {{ reason?: string }} */ s) => s.reason ?? '?').join(', ')}`);
  return segments.map((/** @type {{ wav: Uint8Array }} */ s) => ({ audioBase64: Buffer.from(s.wav).toString('base64'), gapMs: 0 }));
}

const segmentTurns = flags.has('segments') ? await buildSegmentTurns() : undefined;
// `node:http` rather than `fetch`: a multi-turn script can run for minutes before the report is
// ready, and fetch gives up waiting for response headers after five.
/**
 * @param {string} target
 * @param {Record<string, string>} headers
 * @param {Record<string, unknown>} payload
 * @returns {Promise<any>}
 */
function postJson(target, headers, payload) {
  return new Promise((resolve, reject) => {
    const client = target.startsWith('https:') ? https : http;
    const request = client.request(target, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, timeout: 0 }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (text += chunk));
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
        } catch {
          resolve({ status: response.statusCode ?? 0, body: { error: text.slice(0, 300) } });
        }
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify(payload));
  });
}

async function diagnoseOnce() {
  const { status, body } = await postJson(`${url}/api/voice-realtime/diagnose`, { authorization: `Bearer ${token}` }, {
    sessionId: session,
    ...(segmentTurns !== undefined ? { turns: segmentTurns } : turns === undefined ? { audioBase64 } : { turns }),
    dryRun: !flags.has('live'),
    speed: args.has('speed') ? Number(args.get('speed')) : 1,
    ...(args.has('quiet') ? { quietMs: Number(args.get('quiet')) } : {}),
    ...(turnDetection === undefined ? {} : { turnDetection }),
  });
  if (status < 200 || status >= 300) {
    console.error(`HTTP ${status}: ${body.error ?? JSON.stringify(body)}`);
    process.exit(2);
  }
  return body;
}

const repeat = args.has('repeat') ? Number(args.get('repeat')) : 1;
if (repeat > 1) {
  const minOk = args.has('min-ok') ? Number(args.get('min-ok')) : repeat;
  let okCount = 0;
  for (let run = 1; run <= repeat; run += 1) {
    const result = await diagnoseOnce();
    if (result.ok) okCount += 1;
    const open = result.wire.find((/** @type {{ summary: string, atMs?: number }} */ entry) => entry.summary.startsWith('session.update'))?.atMs ?? '-';
    const why = result.problems.length > 0 ? ` | ${result.problems.join(' ; ').slice(0, 160)}` : '';
    console.log(`run ${run}/${repeat}: ok=${result.ok} heard=${result.heard} answered=${result.answered} finals=${result.captions.length} open@${open}ms total=${result.elapsedMs}ms${why}`);
  }
  console.log(`pass rate ${okCount}/${repeat} (need ${minOk})`);
  process.exitCode = okCount >= minOk ? 0 : 1;
}

if (repeat <= 1) {
  const report = await diagnoseOnce();
  if (flags.has('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`heard=${report.heard} answered=${report.answered} ok=${report.ok} (${report.elapsedMs} ms)`);
    if (Array.isArray(report.turns) && report.turns.length > 1) {
    for (const turn of report.turns) {
      console.log(`turn ${turn.index + 1}: heard=${turn.heard} sent=${turn.sentMessages.length}`);
      console.log(`    heard : ${JSON.stringify(turn.captions)}`);
      console.log(`    sent  : ${JSON.stringify(turn.sentMessages)}`);
      for (const text of turn.modelText) console.log(`    ${text}`);
      for (const error of turn.errors) console.log(`    ! ${error}`);
    }
  }
  console.log(`usage: ${report.usage.responses} responses, input ${report.usage.inputTokens} tokens, output ${report.usage.outputTokens} tokens`);
  console.log('captions:', JSON.stringify(report.captions), `(+${report.interimCaptionCount} interim; ${report.audioChunksSent} chunks fed, ${report.audioFramesUpstream} written upstream)`);
    if (report.segments.length > 0) {
      console.log(`segments: ${report.segments.length} (audio upstream ${report.audioSecondsUpstream.toFixed(2)} s)`);
      for (const segment of report.segments) {
        const why = segment.reason === undefined ? '' : ` (${segment.reason})`;
        console.log(`  segment ${segment.seq}: ${segment.durationMs} ms ${segment.commit} ack=${segment.ack}${why}`);
      }
    }
    console.log('--- upstream timeline');
    for (const entry of report.wire) console.log(`${String(entry.atMs).padStart(6)}ms ${entry.direction === 'sent' ? '>>' : '<<'} ${entry.summary}`);
    if (report.problems.length > 0) {
      console.log('--- problems');
      for (const problem of report.problems) console.log(`- ${problem}`);
    }
  }
  process.exitCode = report.ok ? 0 : 1;
}

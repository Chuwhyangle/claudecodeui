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
 * `--gap` ms of silence after each, and prints what each turn was heard as and what it sent.
 *
 * Contract mode: `--repeat N [--min-ok K]` runs the same clip N times (each on a fresh connection)
 * and prints one line per run plus the pass rate; exit 0 only when at least K runs (default N)
 * were `ok`. The real upstream is variable (connect time 0.2-9 s, an occasional stall), so a
 * single green run proves little and a single red run proves less; the rate is the reading.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

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
  console.error('usage: voice-realtime-diagnose.mjs --token <JWT> --session <id> --wav <file> [--url <base>] [--live] [--speed n] [--json]');
  process.exit(2);
}

const audioBase64 = readFileSync(wavFiles[0]).toString('base64');
const gapMs = args.has('gap') ? Number(args.get('gap')) : 1500;
const turns = wavFiles.length > 1 ? wavFiles.map((file) => ({ audioBase64: readFileSync(file).toString('base64'), gapMs })) : undefined;
// `node:http` rather than `fetch`: a multi-turn script can run for minutes before the report is
// ready, and fetch gives up waiting for response headers after five.
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
    ...(turns === undefined ? { audioBase64 } : { turns }),
    dryRun: !flags.has('live'),
    speed: args.has('speed') ? Number(args.get('speed')) : 1,
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
    const open = result.wire.find((entry) => entry.summary.startsWith('session.update'))?.atMs ?? '-';
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
    if (report.turns.length > 1) {
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
    console.log('--- upstream timeline');
    for (const entry of report.wire) console.log(`${String(entry.atMs).padStart(6)}ms ${entry.direction === 'sent' ? '>>' : '<<'} ${entry.summary}`);
    if (report.problems.length > 0) {
      console.log('--- problems');
      for (const problem of report.problems) console.log(`- ${problem}`);
    }
  }
  process.exitCode = report.ok ? 0 : 1;
}

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
 * Contract mode: `--repeat N [--min-ok K]` runs the same clip N times (each on a fresh connection)
 * and prints one line per run plus the pass rate; exit 0 only when at least K runs (default N)
 * were `ok`. The real upstream is variable (connect time 0.2-9 s, an occasional stall), so a
 * single green run proves little and a single red run proves less; the rate is the reading.
 */
import { readFileSync } from 'node:fs';

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
if (!token || !session || !wav) {
  console.error('usage: voice-realtime-diagnose.mjs --token <JWT> --session <id> --wav <file> [--url <base>] [--live] [--speed n] [--json]');
  process.exit(2);
}

const audioBase64 = readFileSync(wav).toString('base64');
async function diagnoseOnce() {
  const response = await fetch(`${url}/api/voice-realtime/diagnose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      sessionId: session,
      audioBase64,
      dryRun: !flags.has('live'),
      speed: args.has('speed') ? Number(args.get('speed')) : 1,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${body.error ?? JSON.stringify(body)}`);
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

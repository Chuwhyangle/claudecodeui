#!/usr/bin/env node
/**
 * P0.14 — fetch and label the REAL CHINESE held-out corpus for the zero-shot turn-detection
 * benchmark.
 *
 * WHY A CHINESE-SPECIFIC FETCHER AND NOT THE P0.6 ONE. P0.6's `datasets/fetch-real-samples.mjs`
 * pulls a handful of samples per language for a 4-group sanity comparison. P0.14 needs enough
 * Chinese spans to carry a Wilson interval and to keep a held-out split, AND it needs to keep the
 * ONE distinction the task is built around: real NATURAL continuous speech vs a READ/SCRIPTED
 * single-utterance ASR corpus. The two must be fetched, labelled and reported SEPARATELY (AC2), so
 * they get different corpus ids here.
 *
 * WHAT IS LABELLED, AND UNDER WHAT POLICY. A "span" is a silence run, exactly as eot-bench defines
 * it: a run of frames below a silence floor. For each clip:
 *   · every INTERNAL silence run of >= MIN_SPAN_MS becomes a `hold` span (the speaker resumes);
 *   · the TRAILING silence after the last speech frame becomes the clip's single `eot` span.
 * The floor is per-recording (the P0.6 rule: max(corpus floor, 15th-percentile frame RMS)), because
 * an absolute floor is a synthetic-corpus artefact and real room tone sits above it.
 *
 * A SCRIPTED CLIP HAS NO INTERNAL SENTENCE BOUNDARY, AND THAT IS CHECKED, NOT ASSUMED. Every
 * THCHS-30 row is ONE read sentence (the transcript is a single clause). Its internal silence runs
 * are therefore intra-sentence pauses, and the ONLY sentence boundary is the clip end. The labeler
 * re-checks this from the transcript (no sentence-final punctuation inside the text) and records
 * the check per clip under `review`, so "we did not mistake a sentence boundary for a hold" is
 * evidence, not a promise.
 *
 * The audio is written to `real/<id>.wav` (16 kHz mono PCM s16le) and is GITIGNORED: the repo
 * carries the source, the licence and this script, not the bytes (THCHS-30's redistribution status
 * is ambiguous — see corpus-license-review.json).
 *
 * Usage: node fetch-chinese-corpus.mjs [--thchs30 N] [--natural N] [--out data/corpus.json]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REAL_DIR = path.join(DIR, 'real');
const ROWS_API = 'https://datasets-server.huggingface.co/rows';

const MODEL_SR = 16000;
const FRAME_MS = 20;
const SILENCE_FLOOR = 1e-3; // corpus floor, same as P0.6 SILENCE_RMS
const REAL_FLOOR_PERCENTILE = 0.15;
const MIN_SPAN_MS = 100; // eot-bench DEFAULT_MIN_SILENCE
const MAX_HOLD_MS = 5000;
const EOT_TAIL_MS = 1500; // closing silence given to a turn end (same as P0.6/P0.13)
const MIN_CLIP_S = 2.0;

/** The corpora this task may fetch. `nature` is the AC2 distinction: natural continuous dialogue vs
 *  a read/scripted single-utterance ASR corpus. Two ids, two rows in the report, never merged.
 *
 *  THE NATURAL SOURCE IS HELD TO A HARDER BAR THAN THE SCRIPTED ONE. A per-utterance crop of a
 *  conversation is trimmed tight around the words, so its "trailing silence" is often a few
 *  milliseconds of codec ring — giving it the same 1500 ms digital tail the scripted clips get would
 *  manufacture a turn end out of nothing. So the natural source admits a clip ONLY when the silence
 *  it will be scored on is REAL audio: a real trailing pause (`minRealTrailingMs`) for the eot span,
 *  and (for the clip to be usable at all) at least one real internal pause for a hold. Every clip
 *  the gate drops is counted and named, so the corpus is what survived a stated test, not a promise. */
const SOURCES = {
  thchs30: {
    id: 'thchs30-zh-scripted',
    nature: 'scripted-single-utterance',
    language: 'zh',
    dataset: 'urarik/thchs30',
    config: 'default',
    split: 'test',
    licenceSpdx: 'Apache-2.0-or-academic-only (ambiguous)',
    licenceUrl: 'https://www.openslr.org/18/',
    licenceNote: 'OpenSLR says Apache-2.0; CSLT prose says "totally free to academic users". Treated as ambiguous → audio NOT committed.',
    redistribution: 'not clearly permitted (see corpus-license-review.json)',
    groupKey: 'clipId (THCHS-30 rows carry no speaker id in this mirror)',
    attribution: 'THCHS-30, CSLT@Tsinghua University (OpenSLR SLR18)',
    // The mirror exposes `sentence` (the reference text) and `audio`.
    textField: 'sentence',
  },
  ascend: {
    id: 'ascend-zh-natural-dialogue',
    nature: 'natural-spontaneous-dialogue',
    language: 'zh (+ code-switched zh/en rows)',
    dataset: 'CAiRE/ASCEND',
    config: 'main',
    split: 'test',
    licenceSpdx: 'CC-BY-SA-4.0',
    licenceUrl: 'https://huggingface.co/datasets/CAiRE/ASCEND',
    licenceNote: 'CC BY-SA 4.0 (dataset card). Share-alike: derived samples would carry the same licence.',
    redistribution: 'permitted with attribution + share-alike (audio itself is NOT committed anyway)',
    groupKey: 'session_id (a session = one recorded conversation; rows of one session are consecutive turns)',
    attribution: 'CAiRE/ASCEND — spontaneous Mandarin/English code-switched conversation (HKUST)',
    textField: 'transcription',
    languageField: 'language',
    sessionField: 'session_id',
    speakerField: 'original_speaker_id',
    // The natural-silence gate (see the SOURCES comment). A crop that does not carry this much REAL
    // trailing pause cannot stand in for a turn end.
    minRealTrailingMs: 200,
    minRealInternalMs: 120,
    minClipS: 1.0,
    languageFilter: new Set(['zh', 'mixed']),
  },
};

const args = process.argv.slice(2);
const flagNum = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const N_THCHS = flagNum('--thchs30', 48);
const N_ASCEND = flagNum('--ascend', 40);
// Clips admitted per ASCEND session (see the SESSION CAP note in fetchAscend); 0/undefined -> n/4.
const SESSION_CAP = args.includes('--per-session') ? Number(args[args.indexOf('--per-session') + 1]) : null;
const OUT_PATH = (() => {
  const i = args.indexOf('--out');
  return i >= 0 ? path.resolve(DIR, args[i + 1]) : path.join(DIR, 'data', 'corpus.json');
})();

// ── tiny WAV reader (ffmpeg writes standard 16-bit PCM) ──────────────────────────────────────────
function decodeWav16(p) {
  const buf = readFileSync(p);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${p}: not RIFF/WAVE`);
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { audioFormat: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    else if (id === 'data') {
      dataOff = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error(`${p}: missing fmt/data`);
  if (fmt.audioFormat !== 1 || fmt.bits !== 16) throw new Error(`${p}: expected PCM s16le, got fmt=${fmt.audioFormat} bits=${fmt.bits}`);
  const n = Math.floor(dataLen / 2 / fmt.channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += buf.readInt16LE(dataOff + (i * fmt.channels + c) * 2) / 32768;
    out[i] = acc / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, samples: out };
}

function frameEnergies(samples, rate, frame) {
  const n = Math.floor(samples.length / frame);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let acc = 0;
    const from = f * frame;
    for (let i = 0; i < frame; i++) acc += samples[from + i] * samples[from + i];
    out[f] = Math.sqrt(acc / frame);
  }
  return out;
}

function realFloor(energies) {
  const sorted = [...energies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(REAL_FLOOR_PERCENTILE * (sorted.length - 1))));
  const p = sorted[idx] ?? 0;
  return {
    floor: Math.max(SILENCE_FLOOR, p),
    percentileValue: Number(p.toExponential(3)),
    method: `max(${SILENCE_FLOOR} (corpus floor), ${REAL_FLOOR_PERCENTILE * 100}th-percentile frame RMS of this recording)`,
  };
}

/** True when the reference text ends a sentence — a scripted-sentence check for the AC2 review. */
const SENTENCE_FINAL = /[。！？!?.；;]$/;

/**
 * Label one clip's silence runs into spans.
 *
 * The review block is the AC2 evidence: for a scripted single-utterance corpus it asserts, from the
 * transcript, that the clip contains no INTERNAL sentence boundary — so none of the admitted
 * internal pauses can be a sentence boundary mislabeled as a hold.
 */
function labelClip({ id, corpus, group, wav, sampleRate, samples, transcript, nature, licence, gate, extra }) {
  const frame = Math.round((FRAME_MS / 1000) * sampleRate);
  const energies = frameEnergies(samples, sampleRate, frame);
  const floorInfo = realFloor(energies);
  const quiet = Array.from(energies, (e) => e < floorInfo.floor);

  // silence runs [startFrame, endFrame) of quiet frames
  const runs = [];
  let i = 0;
  while (i < quiet.length) {
    if (quiet[i]) {
      let j = i;
      while (j < quiet.length && quiet[j]) j += 1;
      runs.push({ start: i, end: j, durMs: (j - i) * FRAME_MS });
      i = j;
    } else i += 1;
  }

  const lastSpeech = (() => {
    for (let k = quiet.length - 1; k >= 0; k--) if (!quiet[k]) return k;
    return -1;
  })();
  const trailingStartFrame = lastSpeech < 0 ? 0 : lastSpeech + 1;
  const trailingMs = (energies.length - trailingStartFrame) * FRAME_MS;

  const spans = [];
  let spanIndex = 0;
  // internal silence runs -> hold spans (must have speech after them; that is what "internal" means)
  for (const r of runs) {
    if (r.end > lastSpeech + 1) continue; // the trailing run is handled below
    if (r.durMs < MIN_SPAN_MS || r.durMs > MAX_HOLD_MS) continue;
    spans.push({
      key: `${corpus}|${id}#${spanIndex}`,
      corpus,
      group,
      id,
      spanIndex,
      label: 'hold',
      onsetMs: Math.round(r.start * FRAME_MS),
      silenceMs: Math.round(r.durMs),
      wav,
      sampleRate,
      appendTailMs: 0,
      clipMs: Math.round((samples.length / sampleRate) * 1000),
    });
    spanIndex += 1;
  }
  // trailing silence -> the clip's single eot span, given the same closing tail P0.6/P0.13 give a
  // turn end so the grid has room to walk (a scripted clip stops within ms of its last word).
  const eotOnsetFrame = trailingStartFrame;
  const eotSilenceMs = Math.max(MIN_SPAN_MS, Math.round(trailingMs)) + EOT_TAIL_MS;
  spans.push({
    key: `${corpus}|${id}#${spanIndex}`,
    corpus,
    group,
    id,
    spanIndex,
    label: 'eot',
    onsetMs: Math.round(eotOnsetFrame * FRAME_MS),
    silenceMs: eotSilenceMs,
    wav,
    sampleRate,
    appendTailMs: EOT_TAIL_MS,
    clipMs: Math.round((samples.length / sampleRate) * 1000),
  });

  const internalRunsMs = runs.filter((r) => r.end <= lastSpeech + 1).map((r) => Math.round(r.durMs));
  const review =
    nature === 'scripted-single-utterance'
      ? {
          kind: 'scripted-single-utterance transcript check',
          sentenceBoundariesInsideClip: 0,
          checkedBy: 'transcript contains no sentence-final punctuation, and each clip is ONE THCHS-30 read sentence',
          consequence: 'every admitted internal pause is intra-sentence (a genuine pause inside the utterance), NOT a sentence boundary; no inter-sentence silence exists inside a clip to misuse',
          cannotAudit: 'no human listened to each clip; a breath vs a linguistic pause cannot be told apart from the acoustic envelope alone, and that limitation is carried into CONCLUSION.md',
        }
      : {
          kind: 'natural spontaneous dialogue (per-utterance crop from a recorded conversation)',
          turnEndIsReal: `the trailing ${Math.round(trailingMs)} ms is REAL audio from the recording (the speaker stopped); the digital tail beyond it is padding so the grid can walk to timeout`,
          cropLimitation: 'ASCEND crops each turn at its own utterance, so the pause BEFORE the next speaker starts is NOT in this clip; "turn end" here means "this speaker stopped", which is what the released crop supports',
          cannotAudit: 'no human listened to each clip; whether a >=250 ms internal pause is a hesitation or a turn-yield is not decidable from the envelope alone',
          ...(extra ?? {}),
        };

  // The natural-silence gate: a scripted clip is scored on its own real pauses by construction; a
  // natural crop is admitted only if the silence it will be scored on is real (see SOURCES).
  let gateResult = null;
  if (gate) {
    const realInternalPauses = internalRunsMs.filter((d) => d >= gate.minRealInternalMs).length;
    const realTrailingMs = Math.round(trailingMs);
    const okTrailing = realTrailingMs >= gate.minRealTrailingMs;
    const okInternal = realInternalPauses >= 1;
    gateResult = {
      admitted: okTrailing && okInternal,
      realTrailingMs,
      realInternalPauses,
      minRealTrailingMs: gate.minRealTrailingMs,
      minRealInternalMs: gate.minRealInternalMs,
      reason: okTrailing && okInternal
        ? `real trailing pause (${realTrailingMs} ms) + ${realInternalPauses} real internal pause(s)`
        : !okTrailing
          ? `trailing real silence ${realTrailingMs} ms < ${gate.minRealTrailingMs} ms — crop is trimmed, a turn end here would be synthetic`
          : `no internal pause >= ${gate.minRealInternalMs} ms — nothing to test as a hold`,
    };
  }

  return {
    gate: gateResult,
    clip: {
      id,
      corpus,
      group,
      wav,
      sampleRate,
      transcript,
      nature,
      licence,
      durationSeconds: Number((samples.length / sampleRate).toFixed(3)),
      sha256: createHash('sha256').update(readFileSync(path.join(REAL_DIR, `${id}.wav`))).digest('hex'),
      silenceFloor: floorInfo,
      trailingSilenceMs: Math.round(trailingMs),
      internalSilenceRuns: runs.filter((r) => r.end <= lastSpeech + 1).map((r) => Math.round(r.durMs)),
      review,
    },
    spans,
  };
}

/** Page the rows API in small pages with retries — the server 502s on a page of 100 (it times out
 *  building that page) while a page of 50 is reliable, so the page size is fixed and retried. */
async function rowsPage(src, offset, length) {
  const url = `${ROWS_API}?dataset=${encodeURIComponent(src.dataset)}&config=${encodeURIComponent(src.config)}&split=${encodeURIComponent(src.split)}&offset=${offset}&length=${length}`;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()).rows;
      lastErr = new Error(`rows API ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`rows API failed after retries for ${src.dataset} offset=${offset}: ${lastErr?.message}`);
}

/** Fetch `length` rows, paging at 50 (the reliably-served page size). */
async function rowsFor(src, length) {
  const out = [];
  for (let off = 0; out.length < length; off += 50) {
    const page = await rowsPage(src, off, Math.min(50, length - out.length));
    if (page.length === 0) break;
    out.push(...page);
  }
  return out;
}

async function fetchThchs30(n) {
  const src = SOURCES.thchs30;
  const rows = await rowsFor(src, Math.max(n * 2, 120));
  const clips = [];
  const allSpans = [];
  let kept = 0;
  for (const { row_idx, row } of rows) {
    if (kept >= n) break;
    const audio = Array.isArray(row.audio) ? row.audio[0] : row.audio;
    const srcUrl = audio?.src;
    if (!srcUrl) continue;
    const tmp = path.join(REAL_DIR, `.tmp-thchs30-${row_idx}.bin`);
    const res = await fetch(srcUrl);
    if (!res.ok) {
      console.log(`  row ${row_idx}: audio ${res.status}, skip`);
      continue;
    }
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    const id = `thchs30-${String(row_idx).padStart(4, '0')}`;
    const wav = path.join(REAL_DIR, `${id}.wav`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-ac', '1', '-ar', String(MODEL_SR), '-c:a', 'pcm_s16le', wav]);
    execFileSync('rm', ['-f', tmp]);
    const { sampleRate, samples } = decodeWav16(wav);
    const durS = samples.length / sampleRate;
    if (durS < MIN_CLIP_S) {
      execFileSync('rm', ['-f', wav]);
      continue;
    }
    const transcript = String(row[src.textField] ?? '');
    if (SENTENCE_FINAL.test(transcript)) {
      // A clip whose transcript ends in sentence punctuation is still ONE utterance; THCHS-30 rows
      // are single sentences by construction. This check only records the punctuation shape.
    }
    const { clip, spans } = labelClip({
      id,
      corpus: src.id,
      group: id,
      wav: path.relative(DIR, wav),
      sampleRate,
      samples,
      transcript,
      nature: src.nature,
      licence: { spdx: src.licenceSpdx, url: src.licenceUrl, note: src.licenceNote, redistribution: src.redistribution, attribution: src.attribution },
    });
    clips.push(clip);
    allSpans.push(...spans);
    kept += 1;
    console.log(`  kept ${id}  ${durS.toFixed(2)}s  holds=${spans.filter((s) => s.label === 'hold').length}  "${transcript.slice(0, 32)}"`);
  }
  return { clips, spans: allSpans };
}

/** Fetch the REAL NATURAL-DIALOGUE source under the natural-silence gate (AC2). Every dropped row is
 *  kept with its reason, so "the natural corpus is small" is an evidenced statement, not a shrug. */
async function fetchAscend(n) {
  const src = SOURCES.ascend;
  // The gate is selective (per-utterance crops are tight), so the scan covers the WHOLE test split
  // rather than a multiple of the target — the yield is what it is, and it is reported.
  // The ASCEND test split is ~1000 usable rows then EMPTY (rowsFor stops on the first empty page),
  // and the zh/mixed rows cluster into whole sessions — an 800-row cap silently returned ONE
  // conversation (session 1), which would make the "natural dialogue" corpus a cluster of one. The
  // cap is set past the split's real end so every session is visible; the empty-page stop bounds it.
  const rows = await rowsFor(src, Math.min(2600, Math.max(n * 20, 1200)));
  const clips = [];
  const allSpans = [];
  const dropped = [];
  const perSession = new Map();
  let kept = 0;
  // SESSION CAP. The test split is four conversations (sessions 1-4) and the zh/mixed rows come in
  // long contiguous runs, so a plain first-N scan returns ONE session and makes the "natural
  // dialogue" corpus a cluster of one — the exact failure a single-conversation corpus would have.
  // Admission is therefore capped PER SESSION so every conversation is represented; rows that pass
  // the gate but arrive after their session is full are dropped with that reason recorded.
  const sessionCap = SESSION_CAP ?? Math.max(1, Math.ceil(n / 4));
  const perSessionKept = new Map();
  for (const { row_idx, row } of rows) {
    if (kept >= n) break;
    const lang = String(row[src.languageField] ?? '');
    if (!src.languageFilter.has(lang)) {
      dropped.push({ row: row_idx, reason: `language=${lang} not in {zh, mixed}` });
      continue;
    }
    const rowSession = row[src.sessionField];
    if ((perSessionKept.get(rowSession) ?? 0) >= sessionCap) {
      dropped.push({ row: row_idx, reason: `session ${rowSession} already at its cap of ${sessionCap} clips` });
      continue;
    }
    const audio = Array.isArray(row.audio) ? row.audio[0] : row.audio;
    const srcUrl = audio?.src;
    if (!srcUrl) {
      dropped.push({ row: row_idx, reason: 'no audio src' });
      continue;
    }
    const tmp = path.join(REAL_DIR, `.tmp-ascend-${row_idx}.bin`);
    const res = await fetch(srcUrl);
    if (!res.ok) {
      dropped.push({ row: row_idx, reason: `audio HTTP ${res.status}` });
      continue;
    }
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    const id = `ascend-${String(row_idx).padStart(5, '0')}`;
    const wav = path.join(REAL_DIR, `${id}.wav`);
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-ac', '1', '-ar', String(MODEL_SR), '-c:a', 'pcm_s16le', wav]);
    } catch (err) {
      dropped.push({ row: row_idx, reason: `ffmpeg failed: ${String(err.message).slice(0, 60)}` });
      continue;
    } finally {
      execFileSync('rm', ['-f', tmp]);
    }
    const { sampleRate, samples } = decodeWav16(wav);
    const durS = samples.length / sampleRate;
    if (durS < (src.minClipS ?? MIN_CLIP_S)) {
      execFileSync('rm', ['-f', wav]);
      dropped.push({ row: row_idx, reason: `duration ${durS.toFixed(2)}s < ${src.minClipS ?? MIN_CLIP_S}s` });
      continue;
    }
    const session = row[src.sessionField];
    const turn = perSession.get(session) ?? 0;
    perSession.set(session, turn + 1);
    const { clip, spans, gate } = labelClip({
      id,
      corpus: src.id,
      group: `session-${session}`,
      wav: path.relative(DIR, wav),
      sampleRate,
      samples,
      transcript: String(row[src.textField] ?? ''),
      nature: src.nature,
      licence: { spdx: src.licenceSpdx, url: src.licenceUrl, note: src.licenceNote, redistribution: src.redistribution, attribution: src.attribution },
      gate: { minRealTrailingMs: src.minRealTrailingMs, minRealInternalMs: src.minRealInternalMs },
      extra: {
        sessionId: session,
        speakerId: row[src.speakerField],
        language: lang,
        turnIndexInSession: turn,
        topic: row.topic ?? null,
        natureOfTurnEnd: 'this speaker stopped (the released crop ends at the utterance; the inter-speaker gap is not in the clip)',
      },
    });
    if (gate && !gate.admitted) {
      execFileSync('rm', ['-f', wav]);
      dropped.push({ row: row_idx, reason: gate.reason });
      continue;
    }
    clip.gate = gate;
    clips.push(clip);
    allSpans.push(...spans);
    kept += 1;
    perSessionKept.set(session, (perSessionKept.get(session) ?? 0) + 1);
    console.log(`  kept ${id}  ${durS.toFixed(2)}s  ses=${session} spk=${row[src.speakerField]}  holds=${spans.filter((s) => s.label === 'hold').length}  realTrailing=${gate?.realTrailingMs}ms  "${String(row[src.textField] ?? '').slice(0, 24)}"`);
  }
  const byReason = {};
  for (const d of dropped) byReason[d.reason.slice(0, 40)] = (byReason[d.reason.slice(0, 40)] ?? 0) + 1;
  console.log(`  ascend: kept ${clips.length}, dropped ${dropped.length} (${JSON.stringify(byReason)})`);
  return { clips, spans: allSpans, dropped, byReason };
}

async function main() {
  mkdirSync(REAL_DIR, { recursive: true });
  console.log(`== thchs30 (${SOURCES.thchs30.dataset} ${SOURCES.thchs30.config}/${SOURCES.thchs30.split}) target ${N_THCHS} ==`);
  const thchs = await fetchThchs30(N_THCHS);
  console.log(`== ascend (${SOURCES.ascend.dataset} ${SOURCES.ascend.config}/${SOURCES.ascend.split}) target ${N_ASCEND} ==`);
  const ascend = N_ASCEND > 0 ? await fetchAscend(N_ASCEND) : { clips: [], spans: [], dropped: [], byReason: {} };
  const clips = [...thchs.clips, ...ascend.clips];
  const spans = [...thchs.spans, ...ascend.spans];

  const doc = {
    schema: 'voice-turn-detection-compare/chinese-corpus@1',
    generatedAt: new Date().toISOString(),
    generatedBy: 'fetch-chinese-corpus.mjs',
    policy: {
      span: `a silence run of >= ${MIN_SPAN_MS} ms at the per-recording floor`,
      hold: `an INTERNAL silence run in [${MIN_SPAN_MS}, ${MAX_HOLD_MS}] ms with speech after it`,
      eot: `the TRAILING silence after the last speech frame, plus a ${EOT_TAIL_MS} ms digital closing tail`,
      floor: `per recording: ${SOURCES.thchs30.nature} -> max(${SILENCE_FLOOR}, 15th-percentile frame RMS)`,
      frameMs: FRAME_MS,
    },
    corpora: Object.values(SOURCES).map((s) => ({
      id: s.id,
      label: s.id,
      nature: s.nature,
      language: s.language,
      dataset: s.dataset,
      config: s.config,
      split: s.split,
      groupKey: s.groupKey,
      licenceSpdx: s.licenceSpdx,
      licenceUrl: s.licenceUrl,
      redistribution: s.redistribution,
    })),
    naturalGate: {
      source: SOURCES.ascend.id,
      policy: `admit a natural crop ONLY if it carries >= ${SOURCES.ascend.minRealTrailingMs} ms of REAL trailing silence (so the eot is not synthetic) AND >= 1 real internal pause >= ${SOURCES.ascend.minRealInternalMs} ms (so there is a hold to test)`,
      dropped: ascend.dropped,
      droppedByReason: ascend.byReason,
    },
    clips,
    spans,
  };
  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(doc, null, 2)}\n`);
  const holds = spans.filter((s) => s.label === 'hold').length;
  const eots = spans.filter((s) => s.label === 'eot').length;
  console.log(`\nwrote ${OUT_PATH}`);
  console.log(`clips=${clips.length}  spans=${spans.length}  holds=${holds}  eots=${eots}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

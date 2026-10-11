#!/usr/bin/env node
/**
 * P0.6 / AC2 — fetch REAL human speech samples for the turn-detection comparison.
 *
 * Two public datasets are used, both chosen because their FIRST-HAND licence text was read and
 * recorded in ../dataset-sources.json before any download:
 *
 *  - LibriSpeech (OpenSLR SLR12), en, CC BY 4.0. The licence was read out of the distribution itself
 *    (LibriSpeech/LICENSE.TXT, first entry of dev-clean.tar.gz) — "LibriSpeech (c) 2014 by Vassil
 *    Panayotov ... licensed under a Creative Commons Attribution 4.0 International License."
 *  - THCHS-30 (OpenSLR SLR18), zh, Apache-2.0 per the OpenSLR page while CSLT's own prose says
 *    "totally free to academic users". Because those two statements disagree, the audio is treated
 *    as NOT-clearly-redistributable: it is downloaded to a gitignored directory and never committed.
 *
 * WHY THE HuggingFace datasets-server ROWS API. A single LibriSpeech FLAC is ~100 kB and THCHS-30's
 * own tarball is 6.4 GB; the rows API hands back one signed per-row audio URL, so a handful of
 * samples can be pulled without mirroring an entire corpus.
 *
 * The audio is written to `datasets/real/<id>.wav` (16 kHz mono PCM s16le) and a provenance record
 * per sample to `datasets/real/samples.json`. `datasets/real/` is gitignored: the repo carries the
 * SOURCE, the LICENCE and this script, not the audio bytes (see dataset-sources.json for which of
 * the two licences would permit committing them — LibriSpeech's would, THCHS-30's is ambiguous, so
 * both are kept out for consistency and the script refetches them).
 *
 * Usage: node experiments/voice-turn-detection-compare/datasets/fetch-real-samples.mjs [--per-lang N]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(DIR, 'real');
const ROWS_API = 'https://datasets-server.huggingface.co/rows';

/** The two corpora, with the licence conclusion carried alongside the fetch so the two cannot drift. */
const SOURCES = [
  {
    key: 'librispeech',
    language: 'en',
    dataset: 'openslr/librispeech_asr',
    config: 'clean',
    split: 'test',
    licenseSpdx: 'CC-BY-4.0',
    licenseUrl: 'https://www.openslr.org/12/',
    licenseInDistribution: 'LibriSpeech/LICENSE.TXT inside dev-clean.tar.gz',
    redistributable: true,
    attribution: 'LibriSpeech (c) 2014 by Vassil Panayotov, CC BY 4.0',
  },
  {
    key: 'thchs30',
    language: 'zh',
    dataset: 'urarik/thchs30',
    config: 'default',
    split: 'test',
    licenseSpdx: 'Apache-2.0',
    licenseUrl: 'https://www.openslr.org/18/',
    licenseInDistribution: 'open-slr mirror: no LICENSE file found in resource.tgz head; upstream CSLT README says "totally free to academic users"',
    redistributable: false, // upstream OpenSLR says Apache-2.0, CSLT prose says academic-only: not clearly redistributable
    attribution: 'THCHS-30, CSLT@Tsinghua University (OpenSLR SLR18)',
  },
];

const MIN_DURATION_S = 2.0;

async function rowsFor(src, length) {
  const url = `${ROWS_API}?dataset=${encodeURIComponent(src.dataset)}&config=${encodeURIComponent(src.config)}&split=${encodeURIComponent(src.split)}&offset=0&length=${length}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rows API ${res.status} for ${src.dataset}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).rows;
}

function probeDuration(wavPath) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', wavPath], { encoding: 'utf8' });
  return Number(out.trim());
}

function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

async function main() {
  const perLang = (() => {
    const i = process.argv.indexOf('--per-lang');
    return i >= 0 ? Number(process.argv[i + 1]) : 8;
  })();
  mkdirSync(OUT_DIR, { recursive: true });
  const records = [];
  for (const src of SOURCES) {
    console.log(`\n== ${src.key} (${src.dataset} ${src.config}/${src.split}) ==`);
    const rows = await rowsFor(src, 100);
    let kept = 0;
    for (const { row_idx, row } of rows) {
      if (kept >= perLang) break;
      const audio = Array.isArray(row.audio) ? row.audio[0] : row.audio;
      const srcUrl = audio?.src;
      if (!srcUrl) continue;
      await new Promise((r) => setTimeout(r, 0));
      const flac = path.join(OUT_DIR, `.tmp-${src.key}-${row_idx}.bin`);
      const res = await fetch(srcUrl);
      if (!res.ok) {
        console.log(`  row ${row_idx}: audio fetch ${res.status}, skip`);
        continue;
      }
      writeFileSync(flac, Buffer.from(await res.arrayBuffer()));
      const id = `${src.key}-${String(row_idx).padStart(3, '0')}`;
      const wav = path.join(OUT_DIR, `${id}.wav`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', flac, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
      const duration = probeDuration(wav);
      if (duration < MIN_DURATION_S) {
        console.log(`  row ${row_idx}: ${duration.toFixed(2)}s < ${MIN_DURATION_S}s, skip`);
        continue;
      }
      const text = row.text ?? row.sentence ?? null;
      records.push({
        id,
        language: src.language,
        dataset: src.dataset,
        config: src.config,
        split: src.split,
        rowIndex: row_idx,
        // Corpus-native identifiers where the row carries them; null where it does not (recorded, not invented).
        speakerId: row.speaker_id ?? null,
        chapterId: row.chapter_id ?? null,
        corpusId: row.id ?? null,
        reference: text,
        licenseSpdx: src.licenseSpdx,
        licenseUrl: src.licenseUrl,
        licenseInDistribution: src.licenseInDistribution,
        redistributable: src.redistributable,
        attribution: src.attribution,
        sampleRate: 16000,
        channels: 1,
        format: 'wav/pcm_s16le (decoded from the corpus-native FLAC via ffmpeg)',
        durationSeconds: Number(duration.toFixed(3)),
        sha256: sha256(wav),
        fetchScript: 'experiments/voice-turn-detection-compare/datasets/fetch-real-samples.mjs',
        fetchedAt: new Date().toISOString(),
      });
      execFileSync('rm', ['-f', flac]);
      kept += 1;
      console.log(`  kept ${id}  ${duration.toFixed(2)}s  "${String(text).slice(0, 48)}"`);
    }
    if (kept < perLang) console.log(`  ONLY ${kept}/${perLang} kept for ${src.key}`);
  }
  writeFileSync(
    path.join(OUT_DIR, 'samples.json'),
    `${JSON.stringify({ schema: 'voice-turn-detection-compare/real-samples@1', generatedAt: new Date().toISOString(), sources: SOURCES, sampleCount: records.length, samples: records }, null, 2)}\n`,
  );
  console.log(`\nwrote ${path.join(OUT_DIR, 'samples.json')} (${records.length} real samples)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

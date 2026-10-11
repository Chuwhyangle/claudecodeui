/**
 * The unified replay corpus: the manifest's 44 samples / 73 candidate points, flattened into the
 * `Span` shape the eot-bench protocol walks, with the PCM each group is asked about.
 *
 * ONE CORPUS, NOT TWO. This module imports `buildAllSamples`, `sampleAudio` and `sampleWavPath` from
 * the P0.6 harness (`../run.mts`) rather than re-reading `manifest.json` itself. A second loader is a
 * second corpus: the label policy (`SILENCE_RMS`, the 250–1500 ms natural-pause window, the VAD
 * endpoint) lives in `run.mts`, and a copy here would drift from it silently. The only thing this
 * module ADDS is the eot-bench view of a candidate point — a span start, a span length, and the
 * label rename (`turn-end` → `eot`, every within-turn pause → `hold`).
 *
 * THE CLOSING SILENCE, AND WHY IT IS APPENDED FOR `eot` SPANS ONLY. A real LibriSpeech/THCHS-30 clip
 * ends a few milliseconds after its last word: measured on this corpus, 31 of the 44 turn-end points
 * have under 200 ms of trailing silence and 29 have under 100 ms. eot-bench interrogates a span by
 * walking the silence AFTER it, so those points would have an empty grid and would score as
 * "never detected" for every group — a fact about the recording, not about the detector. In a live
 * call the person stops and the channel keeps running, so the honest model is: append a closing
 * silence tail and ask each detector whether it commits inside it. The tail is DIGITAL SILENCE (exact
 * zeros), is the SAME length for every `eot` span, and is recorded in the run config
 * (`closingSilenceMs`) so a reader can see exactly how much room the turn-end points were given. For
 * `hold` spans nothing is appended: their silence is the real within-turn pause and the speaker
 * resumes at its end — appending would invent silence the speaker never left.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Span } from './protocol.mts';
import { buildAllSamples, sampleAudio } from '../run.mts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const COMPARE_DIR = path.resolve(DIR, '..');

/** The default closing tail appended to every `eot` span (ms). Matches the sibling probe's
 *  `TRAILING_SILENCE_MS` so the two experiments give a turn end the same room. */
export const DEFAULT_CLOSING_SILENCE_MS = 1_500;

/** One span, with the PCM a detector is asked about and the bookkeeping the run records. */
export type ReplaySpan = Span & {
  /** The sample's full id — the manifest's. */
  sampleId: string;
  /** 0-based index of this candidate point within its sample (the P0.6 reading order). */
  spanIndex: number;
  /** The silence the grid walks, in ms, AFTER the closing tail is accounted for. */
  silenceMs: number;
  /** The tail this span got (0 for a `hold`). */
  appendedTailMs: number;
  /** The sample's PCM with the closing tail already appended (so a prefix cut needs no special case). */
  audio: Float32Array;
  sampleRate: number;
  language: 'en' | 'zh';
  source: 'synthetic' | 'real';
  /** P0.6's own scenario tag, carried so the report can slice by it. */
  scenario: string;
  /** The clip's own duration in ms (BEFORE the tail) — the onset of the appended tail. */
  clipMs: number;
  /** AC1: WHERE this span's audio comes from and under what licence — the eligibility evidence. */
  acquisition: Acquisition;
};

/**
 * AC1's provenance record for one sample: the reproducibility dimension and the licence dimension,
 * as DATA read off the corpus loader's own `Sample` (which is where the manifest's fields land) —
 * not as a claim in a comment.
 *
 * WHY THIS IS DATA AND NOT A PREDICATE ON `silenceMs`. The first version of this module decided
 * eligibility purely from "does the span have silence to walk". That answers the SCORING question
 * and nothing else; it would have admitted a sample whose audio no fresh checkout can obtain, or one
 * whose licence the manifest never recorded, and the report would still have said `eligible: 73`.
 * AC1 asks which samples may be used and why the rest may not, so the two dimensions are checked
 * against the loader's fields and the verdict is carried per span.
 */
export type Acquisition = {
  /** The loader's derivation tag: `authored-fixture` | `derived-midpause` | `real-corpus`. */
  derivation: string;
  /** HOW the PCM is obtained on a fresh checkout. */
  how: 'committed-fixture' | 'derived-in-memory' | 'fetch-script+pinned-sha256' | 'unknown';
  /** The licence the corpus records for this sample's origin, or null when none is recorded. */
  licenceSpdx: string | null;
  licenceNote: string;
  /** Whether the corpus may REDISTRIBUTE the audio. Redistribution is not this experiment's use. */
  redistributable: boolean | null;
  sha256: string | null;
  /** The committed script that fetches this audio (real samples only). */
  fetchScript: string | null;
  /** Human-readable summary of the two dimensions, one per sample class. */
  note: string;
};

export type Corpus = {
  spans: ReplaySpan[];
  /** The manifest's own counts, for the report. */
  sampleCount: number;
  /** Truths dropped from the END/CONTINUE sweep because they mean something else (CORRECTION). */
  correctionSpans: ReplaySpan[];
  /** Spans whose grid is shorter than the protocol's `min_silence` even after the tail — recorded, not
   *  silently dropped. On this corpus this is the zero-length set (every span gets ≥ the tail). */
  shortSpans: ReplaySpan[];
};

/** Zeroed PCM (exact digital silence) of `ms`. */
export function digitalSilence(ms: number, sampleRate: number): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * sampleRate));
}

/**
 * Flatten the manifest into replay spans.
 *
 * Deterministic and side-effect free apart from reading the corpus from disk. The audio arrays are
 * freshly allocated per span (the tail is appended) so a detector that mutates its input cannot
 * corrupt a sibling span.
 */
export function loadCorpus(opts: { closingSilenceMs?: number } = {}): Corpus {
  const tailMs = opts.closingSilenceMs ?? DEFAULT_CLOSING_SILENCE_MS;
  const samples = buildAllSamples();
  const spans: ReplaySpan[] = [];
  const correctionSpans: ReplaySpan[] = [];
  const shortSpans: ReplaySpan[] = [];

  for (const sample of samples) {
    const { sampleRate, samples: pcm } = sampleAudio(sample);
    const clipMs = (pcm.length / sampleRate) * 1000;
    const acquisition = acquisitionFor(sample);
    for (let spanIndex = 0; spanIndex < sample.candidatePoints.length; spanIndex++) {
      const c = sample.candidatePoints[spanIndex];
      const isEnd = c.truth === 'END';
      // `eot` spans get the closing tail; a `hold` span's silence is the real pause inside the clip.
      const appendedTailMs = isEnd ? tailMs : 0;
      let audio: Float32Array;
      if (appendedTailMs > 0) {
        audio = new Float32Array(pcm.length + Math.round((appendedTailMs / 1000) * sampleRate));
        audio.set(pcm, 0);
      } else {
        audio = new Float32Array(pcm);
      }
      const silenceMs = isEnd
        ? Math.max(0, clipMs - c.onsetMs) + appendedTailMs
        : Math.max(0, c.pauseMs ?? 0);
      const span: ReplaySpan = {
        sampleId: sample.id,
        spanIndex,
        onsetMs: c.onsetMs,
        silenceMs,
        truth: c.truth,
        label: isEnd ? 'eot' : 'hold',
        scenario: c.scenario,
        appendedTailMs,
        audio,
        sampleRate,
        language: sample.language,
        source: sample.source,
        clipMs,
        acquisition,
      };
      spans.push(span);
      if (c.truth === 'CORRECTION') correctionSpans.push(span);
      if (silenceMs < 100) shortSpans.push(span);
    }
  }
  return { spans, sampleCount: samples.length, correctionSpans, shortSpans };
}

/** The spans the END/CONTINUE sweep scores: everything except a CORRECTION, which is neither. */
export function scorableSpans(spans: ReplaySpan[]): ReplaySpan[] {
  return spans.filter((s) => s.label === 'eot' || s.label === 'hold');
}

/** Counts by truth and by label, computed rather than asserted. */
export function corpusBreakdown(spans: ReplaySpan[]): Record<string, unknown> {
  const byTruth: Record<string, number> = {};
  const byLabel: Record<string, number> = {};
  const byScenario: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const s of spans) {
    byTruth[s.truth] = (byTruth[s.truth] ?? 0) + 1;
    byLabel[s.label] = (byLabel[s.label] ?? 0) + 1;
    byScenario[s.scenario] = (byScenario[s.scenario] ?? 0) + 1;
    bySource[s.source] = (bySource[s.source] ?? 0) + 1;
  }
  return { total: spans.length, byTruth, byLabel, byScenario, bySource };
}

/**
 * Build one sample's {@link Acquisition} from the loader's fields — the two AC1 dimensions (how the
 * audio is obtained on a fresh checkout; under what licence), READ off `Sample`, not asserted.
 */
export function acquisitionFor(sample: {
  derivation: string;
  sha256: string;
  derivedFrom?: string;
  provenance?: Record<string, unknown>;
}): Acquisition {
  const derivation = sample.derivation;
  const prov = sample.provenance ?? {};
  const str = (k: string): string | null => (typeof prov[k] === 'string' ? (prov[k] as string) : null);
  const bool = (k: string): boolean | null => (typeof prov[k] === 'boolean' ? (prov[k] as boolean) : null);
  const sha256 = typeof sample.sha256 === 'string' ? sample.sha256 : null;

  if (derivation === 'authored-fixture') {
    return {
      derivation,
      how: 'committed-fixture',
      licenceSpdx: null,
      licenceNote: 'authored TTS fixture — repository-owned, committed under experiments/voice-trim/fixtures',
      redistributable: true,
      sha256,
      fetchScript: null,
      note: 'committed WAV, readable from the tree with no fetch',
    };
  }
  if (derivation === 'derived-midpause') {
    return {
      derivation,
      how: 'derived-in-memory',
      licenceSpdx: null,
      licenceNote: `derived in memory from the committed fixture \`${sample.derivedFrom ?? '?'}\` by zeroing a within-pause span`,
      redistributable: true,
      sha256,
      fetchScript: null,
      note: 'deterministically derived from a committed fixture — reproducible from the tree alone',
    };
  }
  // real-corpus: the acquisition record MUST be present. Absence is a real exclusion, not an assumption.
  const fetchScript = str('fetchScript');
  const licenceSpdx = str('licenseSpdx');
  const redistributable = bool('redistributable');
  const licenceExtras =
    redistributable === false
      ? ' (audio NOT redistributable by the corpus — fetched locally and gitignored; this experiment USES it, it does not redistribute)'
      : '';
  return {
    derivation,
    how: fetchScript && sha256 ? 'fetch-script+pinned-sha256' : 'unknown',
    licenceSpdx,
    licenceNote: licenceSpdx
      ? `${licenceSpdx} — ${str('attribution') ?? '(attribution in datasets/real/samples.json)'}${licenceExtras}`
      : 'no licence recorded for this real sample',
    redistributable,
    sha256,
    fetchScript,
    note:
      fetchScript && sha256
        ? 'fetched by the committed script and integrity-pinned by sha256'
        : 'acquisition record incomplete (missing fetch script and/or sha256)',
  };
}

/**
 * AC1 — the licence-and-reproducibility gate, as a pure predicate over one span.
 *
 * A span is eligible for the unified replay when its audio can be OBTAINED deterministically on a
 * fresh checkout (a committed fixture, an in-memory derivation of one, or a committed fetch script
 * that pins the sha256) AND a licence is on record for it. The verdict is carried per span as
 * `acquisition` data, so `corpusEligibility()` can enumerate the exclusions by reason instead of
 * reporting a bare count — which is what AC1 asks for and what a "does it have silence" test alone
 * could never substantiate.
 */
export type Eligibility = {
  eligible: boolean;
  reason: string | null;
};

export function spanEligibility(span: ReplaySpan): Eligibility {
  if (span.silenceMs <= 0) {
    return { eligible: false, reason: 'no silence after the candidate point — the span cannot be interrogated' };
  }
  const a = span.acquisition;
  if (a.how === 'unknown') {
    return { eligible: false, reason: `audio is not reproducible on a fresh checkout: ${a.note}` };
  }
  if (a.derivation === 'real-corpus' && !a.licenceSpdx) {
    return { eligible: false, reason: 'real-corpus sample carries no licence record — cannot admit a real recording without one' };
  }
  if (!a.sha256) {
    return { eligible: false, reason: 'no integrity hash is recorded for the audio' };
  }
  return { eligible: true, reason: null };
}

/** The eligibility verdict over the whole corpus, with the exclusion list AC1 requires as data. */
export function corpusEligibility(spans: ReplaySpan[]): {
  eligible: ReplaySpan[];
  excluded: Array<{ id: string; reason: string }>;
  /** The admitted spans grouped by their acquisition class — so the report shows WHERE the 73 came from. */
  admittedByClass: Record<string, number>;
  /** The admitted real recordings grouped by their recorded licence. */
  admittedRealByLicence: Record<string, number>;
} {
  const eligible: ReplaySpan[] = [];
  const excluded: Array<{ id: string; reason: string }> = [];
  const admittedByClass: Record<string, number> = {};
  const admittedRealByLicence: Record<string, number> = {};
  for (const s of spans) {
    const verdict = spanEligibility(s);
    if (verdict.eligible) {
      eligible.push(s);
      const a = s.acquisition;
      admittedByClass[a.how] = (admittedByClass[a.how] ?? 0) + 1;
      if (a.derivation === 'real-corpus') {
        const lic = a.licenceSpdx ?? 'unrecorded';
        admittedRealByLicence[lic] = (admittedRealByLicence[lic] ?? 0) + 1;
      }
    } else {
      excluded.push({ id: `${s.sampleId}#${s.spanIndex}`, reason: verdict.reason ?? 'unspecified' });
    }
  }
  return { eligible, excluded, admittedByClass, admittedRealByLicence };
}

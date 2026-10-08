#!/usr/bin/env node
/**
 * Prereg completeness self-check for experiments/voice-realtime-ambiguity.
 *
 * Reads fixtures/manifest.json + each class fixture and asserts the frozen prereg
 * material is intact BEFORE any data is taken (Task 3 reads this material to run
 * the paired comparison; this script never runs an answer model):
 *
 *   - PREREG.md exists and names all four frozen classes;
 *   - exactly the four frozen classes are declared, each with a fixture file;
 *   - every class reaches its PREREG-frozen minimum number of entries;
 *   - no class has an empty corpus (a class with 0 entries is a FAILURE, naming it);
 *   - every class carries at least one negative control, and that control records a
 *     predicted direction (the direction is frozen in PREREG.md; the fixture must
 *     carry it so it cannot be dropped silently);
 *   - the world-model class carries BOTH gold subcases (has-answer / no-info) and
 *     its scoring marks an honest "unknown" as a PASS, not a failure.
 *
 * Filesystem only: it reads JSON and one markdown file. It never opens a socket.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const FIXTURES = join(HERE, 'fixtures');
const MANIFEST_PATH = join(FIXTURES, 'manifest.json');
const PREREG_PATH = join(HERE, 'PREREG.md');

/** The four classes the prereg freezes. A missing one is a failure, not silence. */
const FROZEN_CLASSES = [
  'homophone-entity-ambiguity',
  'self-correction',
  'coreference',
  'world-model',
];

/** Printed as the LAST stdout line: this tool is about completeness, not answer quality. */
const DECLARATION = 'this script only checks prereg completeness, not answer quality';

/** @type {string[]} */
const problems = [];

/**
 * @param {string} path
 * @param {string} label
 * @returns {any}
 */
function readJson(path, label) {
  if (!existsSync(path)) {
    problems.push(`${label}: fixture file not found at ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(`${label}: fixture file is not valid JSON (${message})`);
    return null;
  }
}

// -- AC1: PREREG.md exists and names every frozen class ----------------------
if (!existsSync(PREREG_PATH)) {
  problems.push(`PREREG.md not found at ${PREREG_PATH}`);
} else {
  const prereg = readFileSync(PREREG_PATH, 'utf8');
  for (const key of FROZEN_CLASSES) {
    if (!prereg.includes(key)) {
      problems.push(`PREREG.md: no section naming the frozen class "${key}"`);
    }
  }
}

// -- manifest: the four classes and their fixture files ---------------------
const manifest = readJson(MANIFEST_PATH, 'manifest');
/** @type {Map<string, any>} */
const declared = new Map();
if (manifest && Array.isArray(manifest.classes)) {
  for (const cls of manifest.classes) {
    if (cls && typeof cls.key === 'string') declared.set(cls.key, cls);
  }
}

for (const key of FROZEN_CLASSES) {
  const cls = declared.get(key);
  if (!cls) {
    problems.push(`class "${key}": not declared in fixtures/manifest.json`);
    continue;
  }
  const data = readJson(join(FIXTURES, cls.file), `class "${key}"`);
  if (!data) continue;

  const entries = Array.isArray(data.entries) ? data.entries : [];
  const negatives = Array.isArray(data.negativeControls) ? data.negativeControls : [];

  // AC4: an empty reading is not green — name the empty class.
  if (entries.length === 0) {
    problems.push(`class "${key}": corpus is EMPTY (0 entries)`);
  }

  // AC2: entries must reach the frozen minimum.
  const minimum = typeof cls.minEntries === 'number' ? cls.minEntries : 0;
  if (entries.length < minimum) {
    problems.push(`class "${key}": ${entries.length} entries, below the frozen minimum (${minimum})`);
  }

  // AC3: every class needs at least one negative control, with a frozen direction.
  if (negatives.length === 0) {
    problems.push(`class "${key}": MISSING a negative control`);
  } else {
    for (const neg of negatives) {
      if (!neg || typeof neg.predictedDirection !== 'string' || neg.predictedDirection.trim() === '') {
        const id = neg && typeof neg.id === 'string' ? neg.id : '(unnamed)';
        problems.push(`class "${key}": negative control "${id}" has no predicted direction`);
      }
    }
  }
}

// -- AC6: world-model must carry both subcases and honour "unknown" ----------
const wm = declared.get('world-model');
if (wm) {
  const data = readJson(join(FIXTURES, wm.file), 'class "world-model"');
  if (data) {
    const subs = new Set(
      (Array.isArray(data.entries) ? data.entries : []).map((e) => (e ? e.subcase : undefined)),
    );
    if (!subs.has('has-answer')) {
      problems.push('class "world-model": no entry with subcase "has-answer"');
    }
    if (!subs.has('no-info')) {
      problems.push('class "world-model": no entry with subcase "no-info"');
    }
    const noInfo = data.scoring && data.scoring.subcases && data.scoring.subcases['no-info'];
    if (!noInfo || noInfo.honestUnknownIsNotFailure !== true) {
      problems.push(
        'class "world-model": scoring.subcases["no-info"].honestUnknownIsNotFailure must be true',
      );
    }
  }
}

// -- AC5: this script must carry no HTTP client ------------------------------
// The tokens are assembled from fragments so the check does not itself contain
// the literals it forbids (a scanner over this file would otherwise match).
const FORBIDDEN_TOKENS = ['fet' + 'ch', 'XMLHttp' + 'Request', 'axi' + 'os', 'undi' + 'ci', 'ht' + 'tp'];
const source = readFileSync(SELF, 'utf8');
for (const token of FORBIDDEN_TOKENS) {
  if (source.includes(token)) {
    problems.push(`this script references a network client ("${token}")`);
  }
}

if (problems.length > 0) {
  console.error(`prereg check FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
  for (const p of problems) console.error(`  - ${p}`);
}

// AC8: the self-declaration is always the LAST line, and on success nothing else
// is printed — no number here can be mistaken for an answer-quality threshold.
console.log(DECLARATION);
process.exit(problems.length > 0 ? 1 : 0);

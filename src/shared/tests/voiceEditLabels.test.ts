/**
 * The weak labels a send derives from the user's own edit — the known answers, the shape rule's
 * agreement with the offline index, and the negative control that keeps "rewrite" falsifiable.
 *
 * WHAT IS ACTUALLY BEING PINNED. `labelsFor` answers one question — which part of the final text did
 * this segment of speech become, and what changed there — and the answer is only useful if it is
 * THE SAME ANSWER a reader would give. So the criteria below are not "does it return something": a
 * fix that emitted one `rewrite` per segment would satisfy a shape-only assertion and teach nothing.
 * Each case names the pair and the op, and case ⑥ is the one where a plausible-looking answer is
 * the wrong one.
 *
 * THE SHAPE RULE IS PINNED AGAINST THE PYTHON IT WAS PORTED FROM. `isIdentifierShaped` is a port of
 * `is_id` in `experiments/voice-index-loop/sim/extract.py`, and the two are compared on a
 * known-answer table below. The table is not decoration: a label written by this module is scored
 * against a vocabulary the offline index built, so a rule that drifted by one token shape would make
 * every label about that token wrong in a way nothing else would notice.
 *
 * THE NEGATIVE CONTROL IS EXECUTED, NOT DESCRIBED. Section 4 builds a variant of
 * `src/shared/voice/labels/voiceEditLabels.ts` with the correction/rewrite boundary turned off — the budget
 * constants set to infinity, which is the "一律当纠正" reading — imports it, and shows that case ⑥
 * loses its `rewrite` on it. The unmutated module is named as the other arm, so the control cannot
 * pass by the case being red for some unrelated reason.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, expect, test } from 'vitest';

import {
  isIdentifierShaped,
  labelsFor,
  type VoiceEditLabel,
  type VoiceSourceSegment,
} from '@/shared/voice/labels/voiceEditLabels';

/** One committed segment, as the fixture's listen would have produced it. */
const segment = (index: number, text: string): VoiceSourceSegment => ({ index, text });

/** The label for a single-segment fixture, so a case can name the op it expects without indexing. */
const onlyLabel = (segments: readonly VoiceSourceSegment[], finalText: string): VoiceEditLabel => {
  const labels = labelsFor(segments, finalText);
  expect(labels).toHaveLength(1);
  return labels[0];
};

// --------------------------- 1. The eight known answers ---------------------------

test('① a single word the recogniser got wrong is a replace', () => {
  expect(onlyLabel([segment(0, 'key')], 'quay')).toMatchObject({
    segmentIndex: 0,
    heard: 'key',
    final: 'quay',
    op: 'replace',
  });
});

test('① the same correction inside an untouched sentence is still just that word', () => {
  // The sentence is what makes this case worth stating twice: the alignment has to find the changed
  // region INSIDE the segment rather than report the whole segment, and the fence of unchanged
  // tokens on both sides is what does it.
  expect(onlyLabel([segment(0, 'send the key')], 'send the quay')).toMatchObject({
    heard: 'key',
    final: 'quay',
    op: 'replace',
  });
});

test('② two heard words the user joined into one identifier are a merge', () => {
  expect(onlyLabel([segment(0, 'quay fleet')], 'quay-fleet')).toMatchObject({
    heard: 'quay fleet',
    final: 'quay-fleet',
    op: 'merge',
  });
});

test('② the mirror image — one heard token the user split — is a split', () => {
  expect(onlyLabel([segment(0, 'quayfleet')], 'quay fleet')).toMatchObject({
    heard: 'quayfleet',
    final: 'quay fleet',
    op: 'split',
  });
});

test('③ a token-count change with different characters is a replace, not a merge', () => {
  // THE CASE THAT KEEPS THE TWO APART. This goes from two tokens to one, exactly as case ② does, so
  // a rule that read the op off the token counts alone would call it a merge. It is a replace: the
  // characters changed (`零零二` is not `002`), and only the spacing moved.
  expect(onlyLabel([segment(0, 'AC 零零二')], 'AC-002')).toMatchObject({
    heard: 'AC 零零二',
    final: 'AC-002',
    op: 'replace',
  });
});

test('④ a word the user deleted is a delete, with no final text', () => {
  expect(onlyLabel([segment(0, 'restart the server now')], 'restart the server')).toMatchObject({
    heard: 'now',
    final: '',
    op: 'delete',
  });
});

test('⑤ text typed before or after the voice segment produces no labels', () => {
  // The user typed around the dictation rather than correcting it, so there is no `heard → final`
  // pair to record. An alignment that mapped the segment onto the whole box would answer with the
  // typed words as a "correction", which is the failure this case exists to catch.
  expect(labelsFor([segment(0, 'hello world')], 'well hello world then')).toEqual([]);
});

test('⑥ a whole-sentence rewrite is reported as a rewrite, not as a correction', () => {
  const labels = labelsFor(
    [segment(0, 'please restart the server now')],
    'totally different words entirely',
  );
  expect(labels).toHaveLength(1);
  expect(labels[0].op).toBe('rewrite');
  expect(labels.every((label) => label.op === 'rewrite')).toBe(true);
});

test('⑦ two voice segments each produce their own label', () => {
  // Two segments, two edits, and the ordinals have to survive: a label that lost its segment index
  // could not be tied back to the audio in the record.
  expect(labelsFor([segment(0, 'key'), segment(1, 'clik')], 'quay click')).toEqual([
    { segmentIndex: 0, heard: 'key', final: 'quay', op: 'replace' },
    { segmentIndex: 1, heard: 'clik', final: 'click', op: 'replace' },
  ]);
});

test('⑧ an untouched transcript produces an empty array', () => {
  // The whole point of "weak" labels: nothing changed, so nothing is written back. This is also the
  // common case — most sends are not corrections — so it is the reading that decides how much noise
  // the record carries.
  expect(labelsFor([segment(0, 'hello world')], 'hello world')).toEqual([]);
});

test('⑧ a segment that carried no words produces no labels', () => {
  expect(labelsFor([segment(0, '   ')], 'hello world')).toEqual([]);
  expect(labelsFor([], 'hello world')).toEqual([]);
});

test('the region widens across an identifier joiner, so a partial correction keeps the whole token', () => {
  // `quay-fleet` is ONE token here — the same reading `isIdentifierShaped` gives — so a correction
  // that landed inside it is reported against the whole identifier rather than against a fragment.
  expect(onlyLabel([segment(0, 'quay-fleet')], 'quay-flot')).toMatchObject({
    heard: 'quay-fleet',
    final: 'quay-flot',
    op: 'replace',
  });
});

// --------------------------- 2. The identifier shape rule ---------------------------

/**
 * The known-answer table for `is_id`, taken from `experiments/voice-index-loop/sim/extract.py`.
 *
 * Every expectation below was produced by the Python function itself, not by reading it — the
 * command is `python3 -I -c "<is_id>"` over this exact list — so a disagreement here is a real
 * disagreement between the two implementations rather than a disagreement with this file's author.
 * The six the acceptance criteria name by hand are `needs-human`, `AC-103`, `CLOUDPIT`, `server.ts`,
 * `plain` and `a/b`; the rest are here so the rule is pinned on the boundaries and not only on the
 * examples — `v1.2` and `voice-routes.ts` for the file-suffix rule, `x` and `ab` for the length
 * floor, `...` for the "no letters at all" case, `UPPER` and `AC` for the all-caps run.
 */
const SHAPE_ANSWERS: [string, boolean][] = [
  ['needs-human', true],
  ['AC-103', true],
  ['CLOUDPIT', true],
  ['quayFleet', true],
  ['snake_case', true],
  ['AC1', true],
  ['UPPER', true],
  ['AC', true],
  ['useVoiceInput', true],
  ['PORT', true],
  ['a-b-c', true],
  ['aB', true],
  ['9lives', true],
  ['server.ts', false],
  ['voice-routes.ts', false],
  ['index.ts', false],
  ['v1.2', false],
  ['plain', false],
  ['a/b', false],
  ['hello', false],
  ['x', false],
  ['ab', false],
  ['...', false],
];

test('isIdentifierShaped agrees with extract.py\'s is_id on every known answer', () => {
  expect(SHAPE_ANSWERS.length).toBeGreaterThanOrEqual(12);
  for (const [token, expected] of SHAPE_ANSWERS) {
    expect([token, isIdentifierShaped(token)]).toEqual([token, expected]);
  }
});

// --------------------------- 3. The op boundary is falsifiable ---------------------------

/**
 * The fixture case ⑥ is stated over, kept as a constant because the negative control below runs the
 * SAME inputs through a mutated copy of the module — a control that changed the inputs as well would
 * be measuring two things.
 */
const REWRITE_SEGMENTS: VoiceSourceSegment[] = [segment(0, 'please restart the server now')];
const REWRITE_FINAL = 'totally different words entirely';

/** The source of the module under test, resolved from the suite's own root. */
const MODULE_PATH = path.resolve(process.cwd(), 'src/shared/voice/labels/voiceEditLabels.ts');

/**
 * The variant file, written BESIDE the module and deleted in the `finally` below.
 *
 * IT HAS TO LIVE UNDER `src/` to be importable: the suite's transform pipeline only serves files
 * inside its root, so a copy in the OS temp directory fails to load (that is measured, in the
 * probe that chose this design, not assumed). It carries no `.test.` in its name, so the runner
 * never collects it — and the mutation below keeps every symbol used, so the file is a valid,
 * type-checking module for the moment it exists.
 */
const VARIANT_PATH = path.resolve(
  process.cwd(),
  'src/shared/tests/__criterion-falsify-voiceEditLabels.ts',
);

/**
 * The two substitutions that turn the correction/rewrite boundary OFF — "一律当纠正".
 *
 * Setting the budget to infinity is the boundary removed rather than the boundary mistuned: every
 * hunk then passes `withinCorrectionBudget`, so `opFor` can only ever answer with the change's
 * SHAPE. That is precisely the variant the criterion asks for, and it is expressed as two edits to
 * the shipped source rather than as a second copy of the module, so the two cannot drift.
 */
const BOUNDARY_OFF_EDITS: [string, string][] = [
  ['const MAX_CORRECTION_TOKENS = 3;', 'const MAX_CORRECTION_TOKENS = Number.POSITIVE_INFINITY;'],
  ['const MAX_CORRECTION_EDIT_RATIO = 0.5;', 'const MAX_CORRECTION_EDIT_RATIO = Number.POSITIVE_INFINITY;'],
];

afterAll(() => {
  rmSync(VARIANT_PATH, { force: true });
});

test('the correction/rewrite boundary is falsifiable: case ⑥ goes red without it', async () => {
  const source = readFileSync(MODULE_PATH, 'utf8');
  let mutated = source;
  for (const [from, to] of BOUNDARY_OFF_EDITS) {
    // Anchored on an exact declaration rather than on a line number, so the control fails loudly if
    // the constants are renamed instead of silently mutating something else.
    expect(mutated).toContain(from);
    mutated = mutated.replace(from, to);
  }
  expect(mutated).not.toBe(source);

  writeFileSync(VARIANT_PATH, mutated);
  try {
    const variant = (await import(/* @vite-ignore */ pathToFileURL(VARIANT_PATH).href)) as {
      labelsFor: (segments: readonly VoiceSourceSegment[], finalText: string) => VoiceEditLabel[];
    };

    // The reading under test, stated once so both arms below are the SAME question.
    const losesItsRewrite = (labels: VoiceEditLabel[]): boolean =>
      labels.every((label) => label.op !== 'rewrite');

    // `redWhenOff` is the house shape for this control: one arm turns the boundary off and asks
    // whether case ⑥ is red, the other leaves it on and asks the same question of the shipped
    // module. The second arm is not decoration — without it, a case ⑥ that was red for some
    // unrelated reason (a fixture that no longer exercises the boundary at all) would pass.
    const redWhenOff = (boundaryOff: boolean): boolean => (boundaryOff
      ? losesItsRewrite(variant.labelsFor(REWRITE_SEGMENTS, REWRITE_FINAL))
      : losesItsRewrite(labelsFor(REWRITE_SEGMENTS, REWRITE_FINAL)));

    expect(redWhenOff(true)).toBe(true);
    expect(redWhenOff(false)).toBe(false);

    // And the mutation is narrow: case ① is untouched by it, so the control is about the boundary
    // and not about the variant module having failed to load or having lost its diff.
    expect(variant.labelsFor([segment(0, 'key')], 'quay')).toEqual([
      { segmentIndex: 0, heard: 'key', final: 'quay', op: 'replace' },
    ]);
  } finally {
    rmSync(VARIANT_PATH, { force: true });
  }
});

// --------------- 4. Han granularity and the segment's own region (this task) ---------------

/**
 * The transcript the defect was reported over, kept as a constant because several cases below are
 * variations of the SAME dictation — ① is the repair on its own, ② puts another dictation and some
 * typing around it. Using one string for both keeps the two cases measuring the region and not the
 * fixture.
 */
const CHINESE_HEARD = '检查了功启后，是否有服务端的语音识别？';
const CHINESE_REPAIRED = '检查重启后是否有服务端的语音识别记录。';

test('① a one-character Han repair is one small label, not the whole sentence', () => {
  const labels = labelsFor([segment(0, CHINESE_HEARD)], CHINESE_REPAIRED);
  expect(labels).toHaveLength(1);
  expect(labels[0].segmentIndex).toBe(0);
  expect(labels[0].heard).toContain('功');
  expect(labels[0].final).toContain('重');
  expect([...labels[0].heard].length).toBeLessThanOrEqual(6);
  expect([...labels[0].final].length).toBeLessThanOrEqual(6);
  expect(labels[0].op).not.toBe('rewrite');
});

test('② another dictation and the user\'s own typing stay out of the labels', () => {
  const labels = labelsFor(
    [segment(0, CHINESE_HEARD)],
    `语音输入测试。${CHINESE_REPAIRED}谢谢`,
  );
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) {
    expect(label.heard).not.toContain('语音输入测试');
    expect(label.final).not.toContain('语音输入测试');
    expect(label.heard).not.toContain('谢谢');
    expect(label.final).not.toContain('谢谢');
  }
});

test('③ a punctuation or full/half-width difference is not a change', () => {
  expect(labelsFor([segment(0, '是否有服务端的语音识别？')], '是否有服务端的语音识别?')).toEqual([]);
  expect(labelsFor([segment(0, '是否有服务端的语音识别？')], '是否有服务端的语音识别')).toEqual([]);
});

test('④ a whole Han sentence rewritten is a rewrite, never a replace', () => {
  const labels = labelsFor(
    [segment(0, CHINESE_REPAIRED)],
    '明天下午三点开会讨论发布计划安排。',
  );
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.some((label) => label.op === 'replace')).toBe(false);
  expect(labels.every((label) => label.op === 'rewrite')).toBe(true);
  // The in-case control: the SAME boundary must NOT call the small repair (①) a rewrite.
  expect(labelsFor([segment(0, CHINESE_HEARD)], CHINESE_REPAIRED)[0].op).not.toBe('rewrite');
});

test('⑤ a mixed Han/Latin sentence yields its two words and no surrounding Han context', () => {
  // The pair is Han and Latin together, which is where the two tokenizations meet: a Han run must not
  // swallow the identifier next to it, and `AC 一九零` must stay one change rather than the Han run
  // being split off from the `AC` it is part of.
  const labels = labelsFor([segment(0, '检查 key 的 AC 一九零')], '检查 quay 的 AC-190');
  expect(labels).toHaveLength(2);
  expect(labels.every((label) => label.op !== 'rewrite')).toBe(true);
  expect(labels.map((label) => [label.heard, label.final])).toEqual([
    ['key', 'quay'],
    ['AC 一九零', 'AC-190'],
  ]);
  for (const label of labels) {
    expect(label.heard).not.toContain('检查');
    expect(label.final).not.toContain('检查');
    expect(label.heard).not.toContain('的');
    expect(label.final).not.toContain('的');
  }
});

test('⑥ two segments: only the second is labelled, and text typed between them is not', () => {
  const labels = labelsFor(
    [segment(0, CHINESE_REPAIRED), segment(1, '明天下午三点开会讨论发布计划安排。')],
    `检查重启后是否有服务端的语音识别记录。我先说一句。明天下午四点开会讨论发布计划安排。`,
  );
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.every((label) => label.segmentIndex === 1)).toBe(true);
  for (const label of labels) {
    expect(label.heard).not.toContain('我先说一句');
    expect(label.final).not.toContain('我先说一句');
    expect(label.final).not.toContain('检查');
  }
});

test('⑦ an emptied box deletes each segment that carried words', () => {
  const labels = labelsFor(
    [segment(0, CHINESE_REPAIRED), segment(1, '明天下午三点开会讨论发布计划安排。')],
    '',
  );
  expect(labels).toHaveLength(2);
  expect(labels.every((label) => label.op === 'delete' && label.final === '')).toBe(true);
  expect(labels.map((label) => label.segmentIndex)).toEqual([0, 1]);
});

// --------------- 5. The two regressions are falsifiable ---------------

/** The module under test again, as the control below imports its mutated twin through the same shape. */
type LabelsModule = {
  labelsFor: (segments: readonly VoiceSourceSegment[], finalText: string) => VoiceEditLabel[];
};

const shipped: LabelsModule = { labelsFor };

/**
 * The four readings the controls below compare across two copies of the module — one shipped, one
 * mutated. Written ONCE and reused for both arms, so the control asks the same question of both and
 * cannot pass by asserting something the shipped module never satisfied anyway (the existing section
 * 3 makes the same move with `losesItsRewrite`).
 */
const caseOneHolds = (mod: LabelsModule): boolean => {
  const labels = mod.labelsFor([segment(0, CHINESE_HEARD)], CHINESE_REPAIRED);
  return labels.length === 1
    && labels[0].heard.includes('功')
    && labels[0].final.includes('重')
    && [...labels[0].heard].length <= 6
    && [...labels[0].final].length <= 6
    && labels[0].op !== 'rewrite';
};

const caseTwoHolds = (mod: LabelsModule): boolean => {
  const labels = mod.labelsFor(
    [segment(0, CHINESE_HEARD)],
    `语音输入测试。${CHINESE_REPAIRED}谢谢`,
  );
  return labels.length > 0 && labels.every((label) => !label.heard.includes('语音输入测试')
    && !label.final.includes('语音输入测试')
    && !label.heard.includes('谢谢')
    && !label.final.includes('谢谢'));
};

const caseFourHolds = (mod: LabelsModule): boolean => {
  const labels = mod.labelsFor([segment(0, CHINESE_REPAIRED)], '明天下午三点开会讨论发布计划安排。');
  return labels.length > 0 && labels.every((label) => label.op === 'rewrite');
};

/**
 * The variant files, written BESIDE the module and deleted in each control's `finally`. Each control
 * gets its OWN path: a second `import()` of the same URL is served from the module cache rather than
 * re-read, so two mutations sharing one path would race and the second control would silently test
 * the first control's module.
 */
const variantPaths: string[] = [];

function variantPath(): string {
  const file = path.resolve(
    process.cwd(),
    `src/shared/tests/__criterion-falsify-cjk-${variantPaths.length}.ts`,
  );
  variantPaths.push(file);
  return file;
}

afterAll(() => {
  for (const file of variantPaths) {
    rmSync(file, { force: true });
  }
});

/**
 * Replaces the block a pair of marker comments brackets, so a mutation names the REGION of the source
 * it rewrites rather than a line number that would drift. The markers are the two the shipped file
 * carries around the Han tokenizer and the region shrink.
 */
function spliceBlock(
  source: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const lineStart = source.lastIndexOf('\n', start) + 1;
  const lineEnd = source.indexOf('\n', end);
  return `${source.slice(0, lineStart)}${replacement}${source.slice(lineEnd)}`;
}

/** Writes the mutated module, imports it, hands it to the caller, and removes it again. */
async function withVariant<T>(
  mutate: (source: string) => string,
  run: (mod: LabelsModule) => T,
): Promise<T> {
  const file = variantPath();
  const mutated = mutate(readFileSync(MODULE_PATH, 'utf8'));
  writeFileSync(file, mutated);
  try {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as LabelsModule;
    return run(mod);
  } finally {
    rmSync(file, { force: true });
  }
}

/** `text.split(/\s+/)` — the whitespace tokenizer the defect came from; Han is one token per run. */
const WHITESPACE_TOKENIZE = `  // Whitespace split — the regression: a sentence of Han is one token.
  return text.split(/\\s+/).filter((token) => token !== '').map((token) => {
    const start = text.indexOf(token);
    return { text: token, start, end: start + token.length };
  });`;

/**
 * The pre-fix region: no surviving neighbour on a side means the sentinel `-1` / `textLength`, and
 * the region is then widened to the neighbours' images — which drags a segment that has nothing
 * before or after it out to the ends of the whole final text.
 */
const ENDPOINT_EXPANDING_REGION = `  const mapped = mapping.slice(first, last + 1).filter((index) => index >= 0);
  let low: number;
  let high: number;
  if (mapped.length > 0) {
    low = Math.min(...mapped);
    high = Math.max(...mapped);
  } else {
    const previous = mapping.slice(0, first).reverse().find((index) => index >= 0) ?? -1;
    const next = mapping.slice(last + 1).find((index) => index >= 0) ?? textLength;
    low = previous + 1;
    high = next - 1;
    if (high < low) {
      return null;
    }
  }
  const previousMatched = mapping.slice(0, first).reverse().find((index) => index >= 0) ?? -1;
  const nextMatched = mapping.slice(last + 1).find((index) => index >= 0) ?? textLength;
  low = Math.min(low, previousMatched + 1);
  high = Math.max(high, nextMatched - 1);
  if (high < low) {
    return null;
  }
  return { start: textStripped.at[low], end: textStripped.at[high] + 1 };`;

test('the Han tokenization is falsifiable: whitespace splitting reds cases ① and ④', async () => {
  // The shipped arm first: the control only means something if these readings were green to start.
  expect(caseOneHolds(shipped)).toBe(true);
  expect(caseFourHolds(shipped)).toBe(true);
  await withVariant(
    (source) => spliceBlock(
      source,
      '// ---- HAN TOKENIZATION',
      '// ---- end Han tokenization ----',
      WHITESPACE_TOKENIZE,
    ),
    (mod) => {
      expect(caseOneHolds(mod)).toBe(false);
      expect(caseFourHolds(mod)).toBe(false);
    },
  );
});

test('the region shrink is falsifiable: expanding to the text ends reds case ②', async () => {
  expect(caseTwoHolds(shipped)).toBe(true);
  await withVariant(
    (source) => spliceBlock(
      source,
      '// ---- REGION SHRINK',
      '// ---- end region shrink ----',
      ENDPOINT_EXPANDING_REGION,
    ),
    (mod) => {
      expect(caseTwoHolds(mod)).toBe(false);
    },
  );
});

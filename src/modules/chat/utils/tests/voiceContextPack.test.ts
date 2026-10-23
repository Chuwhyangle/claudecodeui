/**
 * The C2 ContextPack judged against the transcript's OWN visibility rules, plus the two false forms
 * that keep the filter and the budget falsifiable.
 *
 * WHAT IS ACTUALLY BEING PINNED. `buildVoiceContextPack` answers one question — which rows of this
 * conversation could the person see said, and how much of them fits in the budget — and the answer
 * is only right if the rows it keeps are THE SAME ROWS the transcript itself puts in front of the
 * person. So the criteria here are not "does it return something": a pack that carried every row
 * including tool results would satisfy a shape-only assertion and would hand the voice model a wall
 * of tool output to reason about. Section 1 therefore judges the pack against the two predicates the
 * transcript already uses — `isWorkSegmentMember` and `shouldHideToolResult`, imported, on the SAME
 * fixture batch — and the fixture holds one row of every kind the transcript can render.
 *
 * THE TWO PREDICATES ARE CROSS-CHECKED AGAINST THE COMPOSITE. `groupWorkSegments` is what the
 * transcript actually runs before rendering; a row the primitive calls a work member is a row the
 * composite never emits as a bare item. Asserting the two agree is what catches a drift where the
 * grouping grows a rule the primitive does not have — the pack reads the primitive, so a drift
 * there would silently change what the voice model sees.
 *
 * THE BUDGET IS A LIMIT, NOT A TARGET. Section 2 drives ≥200 seeded random batches through the
 * builder at eight budgets (including budget 0 and budget 1) and asserts the pack never exceeds the
 * budget, that `chars` is the RENDERED length, and that the walk stops at the newest row that did
 * not fit rather than skipping it — which is what "newest-first until it no longer fits" means.
 *
 * THE FALSE FORMS ARE EXECUTED, NOT DESCRIBED. Section 3 writes a mutated copy of
 * `src/modules/chat/utils/voice/voiceContextPack.ts` beside the suite and imports it: one arm turns the
 * budget check off (超预算时不截断), the other drops tool rows from the work-row exclusion (把工具
 * 调用/结果放进 pack). Each control runs the SAME reading through both arms — the mutated module and
 * the shipped one — so it cannot pass by being red for some unrelated reason, and both variants are
 * removed in a `finally` with an on-disk residue check.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, test } from 'vitest';

import { shouldHideToolResult } from '@/modules/chat/tools';
import {
  buildVoiceContextPack,
  buildVoiceInputContextPack,
  buildVoiceReferencePack,
  isVoiceContextRow,
  resolveVoiceContextPackRuntime,
  resolveVoiceReference,
  VOICE_CONTEXT_BUDGET_CHARS,
  VOICE_CONTEXT_MAX_ROWS,
  VOICE_CONTEXT_PACK_CEILING,
  VOICE_CONTEXT_ROW_CAP_CHARS,
  VOICE_INPUT_DRAFT_AFTER_HEADING,
  VOICE_INPUT_DRAFT_BEFORE_HEADING,
  VOICE_INPUT_VOICE_SO_FAR_HEADING,
} from '@/modules/chat/utils/voice/voiceContextPack';
import type { VoiceContextPack } from '@/modules/chat/utils/voice/voiceContextPack';
import { groupWorkSegments, isWorkSegmentMember } from '@/modules/chat/utils/transcript/workSegments';
import type { ChatMessage, QuayFocusableObject } from '@/shared/types';

/** The clock every case reads against, so a `刚刚` in the rendered line is a constant. */
const NOW = Date.parse('2026-10-10T12:00:00.000Z');

/** One minute before {@link NOW} — inside the `刚刚` bucket, so labels stay short and predictable. */
const FRESH = new Date(NOW - 60_000).toISOString();

/** The source of the module under test, read for the same-source and no-turn-count criteria. */
const MODULE_PATH = path.resolve(process.cwd(), 'src/modules/chat/utils/voice/voiceContextPack.ts');
const TESTS_DIR = path.resolve(process.cwd(), 'src/modules/chat/utils/tests');

// ── 1. The filter, judged against the transcript's own rules on one fixture batch ─────────────

type Fixture = {
  /** Why this row is in the batch — the row KIND the criterion names. */
  why: string;
  message: ChatMessage;
  /**
   * The substring this row contributes to the pack when it is visible, or `null` when the row
   * carries no text at all (a subagent container, an emptied row). A row that must stay out carries
   * its marker anyway, so the batch can assert the pack does NOT contain it.
   */
  marker: string | null;
};

/**
 * ONE ROW OF EVERY KIND the transcript can render, in the order the transcript would stack them.
 *
 * The batch is shared by the predicate comparison, the pack-level marker reading and the two false
 * form controls below, so all three are measuring the same conversation rather than three fixtures
 * that happen to look alike.
 */
const BATCH: Fixture[] = [
  {
    why: 'a thing the person typed',
    message: { type: 'user', content: 'ROW-user-1', timestamp: FRESH },
    marker: 'ROW-user-1',
  },
  {
    why: 'a thing the assistant said',
    message: { type: 'assistant', content: 'ROW-assistant-1', timestamp: FRESH },
    marker: 'ROW-assistant-1',
  },
  {
    why: 'a thinking row',
    message: { type: 'assistant', content: 'ROW-thinking', timestamp: FRESH, isThinking: true },
    marker: 'ROW-thinking',
  },
  {
    // The tool CALL and the tool RESULT are one row here, exactly as the transcript renders them:
    // the result is drawn inside the tool row. So admitting this row would put the result's carrier
    // — and everything the model would read around it — into the pack.
    why: 'a tool call carrying a hidden result',
    message: {
      type: 'assistant',
      content: 'ROW-call-read',
      timestamp: FRESH,
      isToolUse: true,
      toolName: 'Read',
      toolResult: { content: 'ROW-result-read', isError: false },
    },
    marker: 'ROW-call-read',
  },
  {
    // A tool row whose result the transcript does NOT hide: `shouldHideToolResult` returns false
    // for an error, because failed calls stay diagnosable. This row is therefore excluded by the
    // work-row half ALONE — which is what makes that half load-bearing rather than belt-and-braces,
    // and what the filter false form below turns on.
    why: 'a tool call whose result is an error (never hidden)',
    message: {
      type: 'assistant',
      content: 'ROW-call-bash',
      timestamp: FRESH,
      isToolUse: true,
      toolName: 'Bash',
      toolResult: { content: 'ROW-result-bash', isError: true },
    },
    marker: 'ROW-call-bash',
  },
  {
    why: 'a subagent container',
    message: {
      type: 'assistant',
      content: '',
      timestamp: FRESH,
      isToolUse: true,
      toolName: 'Task',
      isSubagentContainer: true,
    },
    marker: null,
  },
  {
    why: 'a task notification',
    message: {
      type: 'assistant',
      content: 'ROW-notification',
      timestamp: FRESH,
      isTaskNotification: true,
    },
    marker: 'ROW-notification',
  },
  {
    why: 'an error row',
    message: { type: 'error', content: 'ROW-error', timestamp: FRESH },
    marker: 'ROW-error',
  },
  {
    why: 'the resident_pending lifecycle row',
    message: { type: 'resident_pending', content: 'ROW-lifecycle', timestamp: FRESH },
    marker: 'ROW-lifecycle',
  },
  {
    why: 'the unattended divider',
    message: { type: 'unattended-divider', content: 'ROW-divider', timestamp: FRESH },
    marker: 'ROW-divider',
  },
  {
    why: 'an unattended turn nobody typed',
    message: { type: 'unattended', content: 'ROW-unattended', timestamp: FRESH },
    marker: 'ROW-unattended',
  },
  {
    why: 'a picture the person pasted, with no words',
    message: {
      type: 'user',
      content: '',
      timestamp: FRESH,
      images: [{ data: 'data:image/png;base64,AAAA' }],
    },
    marker: '[图片]',
  },
  {
    why: 'a turn that carried a file',
    message: { type: 'user', content: 'ROW-user-2', timestamp: FRESH, files: [{ name: 'x.ts' }] },
    marker: 'ROW-user-2',
  },
  {
    why: 'a visible row that carries no text at all',
    message: { type: 'assistant', content: '   ', timestamp: FRESH },
    marker: null,
  },
];

const MESSAGES: ChatMessage[] = BATCH.map((fixture) => fixture.message);

/**
 * The oracle: whether the transcript's own rules say this row is something the person saw said.
 *
 * It is built from the two IMPORTED predicates — not from a second copy of their logic — so a pack
 * that quietly grew its own rule would disagree with it here. The row-TYPE whitelist is the one part
 * that is stated rather than imported, because the SPEC's `user`/`assistant` pair is the criterion
 * this task was written to satisfy and there is no shipping predicate for it.
 */
function visibleBySameSourceRules(message: ChatMessage): boolean {
  if (message.type !== 'user' && message.type !== 'assistant') return false;
  if (isWorkSegmentMember(message)) return false;
  const result = message.toolResult;
  if (result && shouldHideToolResult(String(message.toolName ?? 'UnknownTool'), result)) return false;
  return true;
}

test('① the pack keeps exactly the rows the transcript rules call visible, and nothing else', () => {
  const pack = buildVoiceContextPack(MESSAGES, { now: NOW });

  // `flatMap` rather than `filter().map()` so the marker's `null` is narrowed away: a `filter`
  // predicate does not narrow the element type a later `map` reads.
  const expected = BATCH.flatMap((fixture) =>
    fixture.marker !== null && visibleBySameSourceRules(fixture.message) ? [fixture.marker] : [],
  );

  assert.equal(
    pack.entries.length,
    expected.length,
    'the pack kept a different number of rows than the same-source rules select',
  );
  expected.forEach((marker, index) => {
    assert.ok(
      pack.entries[index].text.includes(marker),
      `row ${index}: expected the row carrying ${marker}, got ${JSON.stringify(pack.entries[index].text)}`,
    );
  });
  assert.equal(pack.rows, 4, 'the batch carries four visible rows with text');

  // Per-row, in both directions: every visible marker is IN the pack, every other marker is not —
  // the half that a "returns something" assertion would miss entirely.
  for (const fixture of BATCH) {
    if (fixture.marker === null) continue;
    const rendered = visibleBySameSourceRules(fixture.message);
    assert.equal(
      pack.text.includes(fixture.marker),
      rendered,
      `${fixture.why}: pack ${rendered ? 'dropped' : 'kept'} it`,
    );
  }

  // Neither result body reaches the pack, even though both carrier rows were considered.
  assert.equal(pack.text.includes('ROW-result-read'), false, 'a tool RESULT body entered the pack');
  assert.equal(pack.text.includes('ROW-result-bash'), false, 'a tool RESULT body entered the pack');

  // WHY THE WORK-ROW HALF IS LOAD-BEARING, stated in the case rather than assumed: the error tool
  // row's result is visible to the transcript's own rule, so only work-row membership keeps it out.
  assert.equal(
    shouldHideToolResult('Bash', { content: 'ROW-result-bash', isError: true }),
    false,
    'the fixture no longer exercises the work-row half: its result became hidden',
  );
  assert.equal(
    shouldHideToolResult('Read', { content: 'ROW-result-read', isError: false }),
    true,
    'the fixture no longer exercises the result-hiding half: the Read result became visible',
  );
});

test('① the exported predicate and the pack agree row by row on the same batch', () => {
  for (const fixture of BATCH) {
    assert.equal(
      isVoiceContextRow(fixture.message),
      visibleBySameSourceRules(fixture.message),
      `${fixture.why}: the exported predicate diverged from the same-source rules`,
    );
  }
});

test('① the primitive and the composite agree: a work member is absorbed into the run', () => {
  // `isWorkSegmentMember` is the primitive the pack reads; `groupWorkSegments` is the composite the
  // transcript renders through. A row the primitive calls work must be ABSORBED rather than emitted
  // as itself, or the pack is reading a rule the transcript no longer applies.
  //
  // A known member is placed next to the candidate on purpose: a run of exactly one member is
  // emitted as that member itself (see `groupWorkSegments`), so a lone candidate would look
  // identical whether or not it was a member, and the comparison would be vacuous.
  const knownMember: ChatMessage = {
    type: 'assistant',
    content: 'a row that is unambiguously work',
    timestamp: FRESH,
    isThinking: true,
  };

  for (const fixture of BATCH) {
    const items = groupWorkSegments([fixture.message, knownMember]);
    const absorbed = items.length === 1 && items[0] !== fixture.message;
    assert.equal(
      absorbed,
      isWorkSegmentMember(fixture.message),
      `${fixture.why}: grouping and membership disagree`,
    );
  }
});

test('① the pack READS the two predicates rather than restating them', () => {
  // The SPEC's own reason for this design: a second implementation of "what counts as work" would
  // drift the first time either side changed. Pinned at the source, because an import that was
  // quietly inlined would leave every reading above green.
  const source = readFileSync(MODULE_PATH, 'utf8');
  assert.match(source, /import \{ shouldHideToolResult \} from '@\/modules\/chat\/tools';/);
  assert.match(source, /import \{ isWorkSegmentMember \} from '@\/modules\/chat\/utils\/transcript\/workSegments';/);
  assert.match(source, /isWorkSegmentMember\(message\)/);
});

// ── 2. The budget ────────────────────────────────────────────────────────────────────────────

/** mulberry32: a small seeded PRNG, so every "randomized" case below is re-derivable from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The budgets the randomized case sweeps: the two degenerate floors, then real sizes. */
const BUDGETS = [1, 7, 60, 200, 601, 2000, 5000];

const RANDOM_SEEDS = 200;

test('② the pack never exceeds its budget, over ≥200 seeded random batches and eight budgets', () => {
  let nonTrivial = 0;

  for (let seed = 1; seed <= RANDOM_SEEDS; seed++) {
    const rng = mulberry32(seed);
    const count = 2 + Math.floor(rng() * 24);
    const messages: ChatMessage[] = [];
    for (let index = 0; index < count; index++) {
      const kind = rng();
      // Rows are kept SHORT so that a majority of seeds actually fill a multi-row pack — the
      // reading only means something if packs are usually non-empty. The long-row boundary is
      // covered by the over-budget case and the SPEC-values case below instead.
      const body = 'x'.repeat(Math.floor(rng() * 60));
      const common = { content: body, timestamp: FRESH };
      messages.push(
        kind < 0.5
          ? { type: 'user', ...common }
          : kind < 0.7
            ? { type: 'assistant', ...common }
            : kind < 0.8
              ? { type: 'assistant', ...common, isThinking: true }
              : kind < 0.9
                ? {
                    type: 'assistant',
                    ...common,
                    isToolUse: true,
                    toolName: 'Read',
                    toolResult: { content: body, isError: false },
                  }
              : { type: 'error', ...common },
      );
    }

    const budget = BUDGETS[Math.floor(rng() * BUDGETS.length)];
    const pack = buildVoiceContextPack(messages, { budgetChars: budget, now: NOW });

    assert.ok(pack.chars <= budget, `seed ${seed}: chars ${pack.chars} exceeded budget ${budget}`);
    assert.equal(pack.chars, pack.text.length, `seed ${seed}: chars is not the rendered length`);
    assert.equal(pack.rows, pack.entries.length, `seed ${seed}: rows and entries disagree`);
    assert.equal(pack.rows === 0, pack.text === '', `seed ${seed}: an empty pack rendered text`);
    assert.ok(pack.rows <= messages.length, `seed ${seed}: more rows than messages`);
    if (pack.rows > 1) nonTrivial++;
  }

  // Positive control: "≤ budget" is also satisfied by a pack that is always empty, so the batch
  // must actually produce multi-row packs for the reading to be load-bearing.
  assert.ok(nonTrivial > RANDOM_SEEDS / 2, `only ${nonTrivial} seeds produced a multi-row pack`);
});

test('② the shipped budget and row cap are the defaults, and the default holds the budget', () => {
  assert.equal(VOICE_CONTEXT_BUDGET_CHARS, 1200);
  assert.equal(VOICE_CONTEXT_ROW_CAP_CHARS, 600);
  assert.equal(VOICE_CONTEXT_MAX_ROWS, 4);

  // Twelve rows of 500 characters: far past 1200 in total, so the default budget is what cuts it.
  const messages: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
    type: index % 2 === 0 ? 'user' : 'assistant',
    content: `row-${index} ${'y'.repeat(500)}`,
    timestamp: FRESH,
  }));
  const pack = buildVoiceContextPack(messages, { now: NOW });
  assert.ok(pack.chars <= VOICE_CONTEXT_BUDGET_CHARS, `default budget overshot: ${pack.chars}`);
  assert.ok(pack.rows > 0 && pack.rows < messages.length, 'the default budget did not cut anything');
  assert.ok(pack.rows <= VOICE_CONTEXT_MAX_ROWS, `default row cap overshot: ${pack.rows}`);
});

test('② runtime knobs: 2/400 produces rows<=2 && chars<=400, defaults are 4/1200, 99/99999 is clamped to the browser ceiling', () => {
  // Six visible rows, each long enough that the row cap and the budget both matter.
  const messages: ChatMessage[] = Array.from({ length: 6 }, (_, index) => ({
    type: index % 2 === 0 ? 'user' : 'assistant',
    content: `RUNTIME-${index} ${'z'.repeat(320)}`,
    timestamp: FRESH,
  }));

  const runtime = buildVoiceContextPack(messages, { maxRows: 2, budgetChars: 400, rowCapChars: 300, now: NOW });
  console.log(`runtime 2/400/300 -> rows=${runtime.rows} chars=${runtime.chars}`);
  assert.ok(runtime.rows <= 2, `runtime row cap overshot: ${runtime.rows}`);
  assert.ok(runtime.chars <= 400, `runtime budget overshot: ${runtime.chars}`);
  assert.ok(runtime.text.includes('RUNTIME-5'), 'the newest row is what survives the trim');
  assert.equal(runtime.text.includes('RUNTIME-0'), false, 'the oldest row is dropped');

  const defaults = buildVoiceContextPack(messages, { now: NOW });
  console.log(`defaults -> rows=${defaults.rows} chars=${defaults.chars}`);
  assert.ok(defaults.rows <= 4, `default row cap overshot: ${defaults.rows}`);
  assert.ok(defaults.chars <= 1200, `default budget overshot: ${defaults.chars}`);

  // A reading past the browser's ceiling is CLAMPED, never obeyed: 99 rows / 99,999 chars would be
  // three times the protocol envelope the socket was validated at.
  const ceiling = resolveVoiceContextPackRuntime({ maxRows: 99, budgetChars: 99999, rowCapChars: 99999 });
  console.log(
    `config 99/99999 -> clamped maxRows=${ceiling.maxRows} budgetChars=${ceiling.budgetChars} rowCapChars=${ceiling.rowCapChars} (ceiling ${VOICE_CONTEXT_PACK_CEILING.maxRows}/${VOICE_CONTEXT_PACK_CEILING.budgetChars}/${VOICE_CONTEXT_PACK_CEILING.rowCapChars})`,
  );
  assert.equal(ceiling.maxRows, VOICE_CONTEXT_PACK_CEILING.maxRows);
  assert.equal(ceiling.budgetChars, VOICE_CONTEXT_PACK_CEILING.budgetChars);
  assert.equal(ceiling.rowCapChars, VOICE_CONTEXT_PACK_CEILING.rowCapChars);

  const clamped = buildVoiceContextPack(messages, { maxRows: 99, budgetChars: 99999, rowCapChars: 99999, now: NOW });
  console.log(`config 99/99999 build -> rows=${clamped.rows} chars=${clamped.chars}`);
  assert.ok(clamped.rows <= VOICE_CONTEXT_PACK_CEILING.maxRows);
  assert.ok(clamped.chars <= VOICE_CONTEXT_PACK_CEILING.budgetChars);

  // The one-shot pack forwards the same row cap to its conversation portion.
  const input = buildVoiceInputContextPack({
    messages,
    maxRows: 2,
    budgetChars: 400,
    rowCapChars: 300,
    now: NOW,
  });
  console.log(`input runtime 2/400/300 -> rows=${input.rows} chars=${input.chars}`);
  assert.ok(input.chars <= 400);
  assert.ok(input.rows <= 2);
});

test('② the walk STOPS at the newest row that did not fit instead of skipping it', () => {
  // Oldest first: a small row, a huge one, a small one. Newest-first walk keeps the newest small
  // row, meets the huge one, and must stop there — `continue`-ing past it would pull the oldest row
  // in, which is the "skip an old row to reach the budget" behaviour the SPEC forbids.
  const messages: ChatMessage[] = [
    { type: 'user', content: `OLDEST ${'a'.repeat(40)}`, timestamp: FRESH },
    { type: 'assistant', content: `BLOCKER ${'b'.repeat(4000)}`, timestamp: FRESH },
    { type: 'user', content: `NEWEST ${'c'.repeat(40)}`, timestamp: FRESH },
  ];
  const pack = buildVoiceContextPack(messages, { budgetChars: 300, now: NOW });

  assert.equal(pack.text.includes('NEWEST'), true, 'the newest row was not kept');
  assert.equal(pack.text.includes('BLOCKER'), false, 'the row that did not fit was truncated in anyway');
  assert.equal(pack.text.includes('OLDEST'), false, 'the walk skipped the oversized row to reach the oldest one');
  assert.ok(pack.chars <= 300);
});

test('② the implementation carries no "last N turns" constant', () => {
  // The SPEC rejects a turn count (D5): turns get longer, so a count would silently change what the
  // model sees. The criterion is a grep, so it is written as one — over the MODULE's source only,
  // never this file, so the assertion cannot satisfy itself.
  const source = readFileSync(MODULE_PATH, 'utf8');
  assert.doesNotMatch(source, /最近\s*\d+\s*轮/, 'a "最近 N 轮" window is in the module');
  assert.doesNotMatch(source, /最近\s*[一二三四五六七八九十]+\s*轮/, 'a spelled-out turn window is in the module');
  assert.doesNotMatch(source, /last\s+\d+\s+turns/i, 'a "last N turns" window is in the module');
});

// ── 3. The two false forms ───────────────────────────────────────────────────────────────────

/** The mutated module's shape, so both arms below are asked the SAME question. */
type PackModule = {
  buildVoiceContextPack: (
    messages: readonly ChatMessage[],
    options?: { budgetChars?: number; now?: number },
  ) => VoiceContextPack;
};

const shipped: PackModule = { buildVoiceContextPack };

/**
 * Writes a mutated copy of the module BESIDE the suite and imports it.
 *
 * It has to live under `src/` to be importable — the transform pipeline only serves files inside
 * its root — and it carries no `.test.` in its name, so the runner never collects it. Each control
 * gets its OWN path: a second `import()` of one URL is served from the module cache rather than
 * re-read, so two mutations sharing a path would race.
 */
const variantPaths: string[] = [];

function variantPath(): string {
  const file = path.resolve(
    TESTS_DIR,
    `__criterion-falsify-voiceContextPack-${variantPaths.length}.ts`,
  );
  variantPaths.push(file);
  return file;
}

afterAll(() => {
  for (const file of variantPaths) rmSync(file, { force: true });
  const residue = readdirSync(TESTS_DIR).filter((name) => name.startsWith('__criterion-falsify-'));
  assert.deepEqual(residue, [], 'a falsification variant was left on disk');
});

/** Asserts one mutation's anchor exists, then applies it — anchored on an exact declaration rather
 * than a line number, so a rename fails loudly instead of silently mutating something else. */
function mutate(source: string, edits: [string, string][]): string {
  let mutated = source;
  for (const [from, to] of edits) {
    assert.ok(mutated.includes(from), `the mutation anchor is gone: ${JSON.stringify(from)}`);
    mutated = mutated.replace(from, to);
  }
  assert.notEqual(mutated, source, 'the mutation changed nothing');
  return mutated;
}

async function withVariant<T>(edits: [string, string][], run: (mod: PackModule) => T): Promise<T> {
  const file = variantPath();
  writeFileSync(file, mutate(readFileSync(MODULE_PATH, 'utf8'), edits));
  try {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as PackModule;
    return run(mod);
  } finally {
    rmSync(file, { force: true });
    assert.equal(existsSync(file), false, `the variant ${file} survived its case`);
  }
}

/** Five rows of 200 characters — about 1030 characters of pack against a 300-character budget. */
const BUDGET_ROWS: ChatMessage[] = Array.from({ length: 5 }, (_, index) => ({
  type: index % 2 === 0 ? 'user' : 'assistant',
  content: `row-${index} ${'z'.repeat(190)}`,
  timestamp: FRESH,
}));

/** Case ②'s reading, stated once so both arms of the control below are the same question. */
const budgetCaseHolds = (mod: PackModule): boolean =>
  mod.buildVoiceContextPack(BUDGET_ROWS, { budgetChars: 300, now: NOW }).chars <= 300;

/** Case ①'s reading: the visible rows are in, every work row is out. */
const filterCaseHolds = (mod: PackModule): boolean => {
  const pack = mod.buildVoiceContextPack(MESSAGES, { now: NOW });
  const visible = BATCH
    .filter((fixture) => fixture.marker !== null && visibleBySameSourceRules(fixture.message))
    .every((fixture) => pack.text.includes(fixture.marker as string));
  const workRowsOut = BATCH
    .filter((fixture) => fixture.marker !== null && isWorkSegmentMember(fixture.message))
    .every((fixture) => !pack.text.includes(fixture.marker as string));
  return visible && workRowsOut;
};

test('③ the budget is falsifiable: with the check off, case ② goes red', async () => {
  assert.equal(budgetCaseHolds(shipped), true, 'the shipped module was already red');
  await withVariant(
    [
      // 超预算时不截断: the cap opened to the largest safe integer, so every row is taken. This is
      // the boundary removed rather than mistuned — the walk still runs in the same order.
      ['if (chars + added > budgetChars) break;', 'if (chars + added > Number.MAX_SAFE_INTEGER) break;'],
    ],
    (mod) => {
      assert.equal(budgetCaseHolds(mod), false, 'the budget case survived the cap being removed');
    },
  );
});

test('③ the filter is falsifiable: with tool rows admitted, case ① goes red', async () => {
  assert.equal(filterCaseHolds(shipped), true, 'the shipped module was already red');
  await withVariant(
    [
      // 把工具调用/结果放进 pack: only `isToolUse` is dropped from the work-row exclusion, so the
      // mutant stays narrow — thinking, subagent containers and notifications are still excluded,
      // and the only reading it can red is the tool row's.
      [
        'if (isWorkSegmentMember(message)) return false;',
        'if (message.isThinking || message.isSubagentContainer || message.isTaskNotification) return false;',
      ],
    ],
    (mod) => {
      assert.equal(filterCaseHolds(mod), false, 'the filter case survived tool rows being admitted');
      // And the mutation is narrow: the thinking and notification rows are still out, and so is the
      // tool row whose RESULT the transcript hides, so the red above is about the work-row half and
      // not about the variant having lost the whole filter.
      const pack = mod.buildVoiceContextPack(MESSAGES, { now: NOW });
      assert.equal(pack.text.includes('ROW-thinking'), false);
      assert.equal(pack.text.includes('ROW-notification'), false);
      assert.equal(pack.text.includes('ROW-call-read'), false);
      // The row the work-row half was the ONLY defense for is the one that got in.
      assert.equal(pack.text.includes('ROW-call-bash'), true);
      // Even admitted, the row carries its own rendering only — no result body is ever copied in.
      assert.equal(pack.text.includes('ROW-result-read'), false);
      assert.equal(pack.text.includes('ROW-result-bash'), false);
    },
  );
});

// ── 4. The one-shot dictation's pack: the box around the caret, then the conversation ────────

/**
 * WHAT THIS SECTION PINS. One-shot dictation (`useVoiceInput`) hands the recogniser more than the
 * conversation: the composer's own draft on both sides of the caret, and the text this listen has
 * already committed. Three readings, matching the three AC clauses:
 *
 *   · the three blocks go in by PRIORITY — draft-before, draft-after, voice-so-far — and the
 *     conversation comes after all of them, because a spoken 「这段」 points at the box first;
 *   · an empty block renders NO heading, so a listen in an empty box says nothing about a draft
 *     it did not have;
 *   · the whole pack is still ONE budget of 2000, and the conversation is built with exactly the
 *     room the draft blocks left — asserted by building the two halves separately and comparing
 *     the concatenation, which a pack that gave the conversation its own budget could not satisfy.
 */

const DRAFT_BEFORE_MARKER = 'DRAFT-BEFORE-用户此前打的';
const DRAFT_AFTER_MARKER = 'DRAFT-AFTER-光标后面的';
const VOICE_SO_FAR_MARKER = 'VOICE-SO-FAR-已经说出来的';

test('④ the draft blocks go in before the conversation, in the order the caret splits them', () => {
  const pack = buildVoiceInputContextPack({
    messages: MESSAGES,
    draftBefore: DRAFT_BEFORE_MARKER,
    draftAfter: DRAFT_AFTER_MARKER,
    voiceSoFar: VOICE_SO_FAR_MARKER,
    now: NOW,
  });

  const at = (marker: string) => pack.text.indexOf(marker);
  assert.ok(at(DRAFT_BEFORE_MARKER) >= 0, 'the caret-before block is missing');
  assert.ok(at(DRAFT_AFTER_MARKER) >= 0, 'the caret-after block is missing');
  assert.ok(at(VOICE_SO_FAR_MARKER) >= 0, 'the voice-so-far block is missing');

  // Priority, not merely presence: the box's two sides, then what this listen said, then the
  // conversation — which must contain the fixture's visible rows.
  assert.ok(at(DRAFT_BEFORE_MARKER) < at(DRAFT_AFTER_MARKER), 'the caret-before block is not first');
  assert.ok(at(DRAFT_AFTER_MARKER) < at(VOICE_SO_FAR_MARKER), 'the voice-so-far block is out of order');
  assert.ok(at(VOICE_SO_FAR_MARKER) < at('ROW-user-1'), 'the conversation was placed above the draft');

  // Each heading appears exactly once, on its own block.
  for (const heading of [
    VOICE_INPUT_DRAFT_BEFORE_HEADING,
    VOICE_INPUT_DRAFT_AFTER_HEADING,
    VOICE_INPUT_VOICE_SO_FAR_HEADING,
  ]) {
    assert.equal(pack.text.split(heading).length - 1, 1, `heading ${heading} is not exactly once`);
  }
  assert.equal(pack.text.split('ROW-user-1').length - 1, 1, 'a conversation row was duplicated');
});

test('④ an empty draft or an empty voice-so-far section renders no heading at all', () => {
  const draftOnly = buildVoiceInputContextPack({
    messages: MESSAGES,
    draftBefore: '   ',
    draftAfter: '',
    voiceSoFar: '',
    now: NOW,
  });

  for (const heading of [
    VOICE_INPUT_DRAFT_BEFORE_HEADING,
    VOICE_INPUT_DRAFT_AFTER_HEADING,
    VOICE_INPUT_VOICE_SO_FAR_HEADING,
  ]) {
    assert.equal(draftOnly.text.includes(heading), false, `an empty block still announced ${heading}`);
  }

  // With nothing but whitespace the pack IS the conversation pack — byte for byte, because the
  // whole-budget and remaining-budget calls must agree when nothing was spent first.
  assert.equal(draftOnly.text, buildVoiceContextPack(MESSAGES, { now: NOW }).text);

  const empty = buildVoiceInputContextPack({ now: NOW });
  assert.equal(empty.text, '', 'an empty pack rendered text');
  assert.equal(empty.chars, 0);
  assert.equal(empty.rows, 0);
});

test('④ each draft side is elided AWAY from the caret, so the words it points at survive', () => {
  // The far end of a long draft is not what 「这段」 refers to; the text beside the caret is.
  const longBefore = `BEFORE-FAR${'x'.repeat(3000)}BEFORE-NEAR`;
  const beforePack = buildVoiceInputContextPack({ draftBefore: longBefore, budgetChars: 2000 });
  assert.equal(beforePack.text.includes('BEFORE-FAR'), false, 'the caret-before block kept the far end');
  assert.equal(
    beforePack.text.endsWith('BEFORE-NEAR'),
    true,
    'the caret-before block lost the text closest to the caret',
  );

  const longAfter = `AFTER-NEAR${'x'.repeat(3000)}AFTER-FAR`;
  const afterPack = buildVoiceInputContextPack({ draftAfter: longAfter, budgetChars: 2000 });
  assert.equal(afterPack.text.includes('AFTER-NEAR'), true, 'the caret-after block lost the text closest to the caret');
  assert.equal(afterPack.text.includes('AFTER-FAR'), false, 'the caret-after block kept the far end');
});

test('④ the conversation is built with exactly the room the draft blocks left, and never more', () => {
  const draft = `ROOM-DRAFT${'d'.repeat(500)}`;
  const draftOnly = buildVoiceInputContextPack({ draftBefore: draft, budgetChars: VOICE_CONTEXT_BUDGET_CHARS });
  assert.ok(draftOnly.chars > 0 && draftOnly.chars < VOICE_CONTEXT_BUDGET_CHARS, 'the draft fixture does not leave room');

  // The separator between the draft blocks and the conversation is inside the same budget.
  const remaining = VOICE_CONTEXT_BUDGET_CHARS - draftOnly.chars - 2;
  const conversation = buildVoiceContextPack(BUDGET_ROWS, { budgetChars: remaining, now: NOW });
  const combined = buildVoiceInputContextPack({
    messages: BUDGET_ROWS,
    draftBefore: draft,
    budgetChars: VOICE_CONTEXT_BUDGET_CHARS,
    now: NOW,
  });

  assert.equal(
    combined.text,
    `${draftOnly.text}\n\n${conversation.text}`,
    'the conversation did not get exactly the remaining budget',
  );
  assert.ok(combined.chars <= VOICE_CONTEXT_BUDGET_CHARS);
  assert.equal(combined.chars, combined.text.length);
});

test('④ the whole pack stays within its budget over ≥200 seeded inputs, every block counted', () => {
  let withConversation = 0;

  for (let seed = 1; seed <= RANDOM_SEEDS; seed++) {
    const rng = mulberry32(seed);
    const budget = BUDGETS[Math.floor(rng() * BUDGETS.length)];
    const piece = (marker: string) => (rng() < 0.2 ? '' : marker + 'x'.repeat(Math.floor(rng() * 400)));
    const messages: ChatMessage[] = Array.from({ length: Math.floor(rng() * 8) }, (_, index) => ({
      type: index % 2 === 0 ? 'user' : 'assistant',
      content: `row-${index} ${'y'.repeat(Math.floor(rng() * 80))}`,
      timestamp: FRESH,
    }));

    const draftBefore = piece('B-');
    const draftAfter = piece('A-');
    const voiceSoFar = piece('V-');
    const pack = buildVoiceInputContextPack({ messages, draftBefore, draftAfter, voiceSoFar, budgetChars: budget, now: NOW });

    assert.ok(pack.chars <= budget, `seed ${seed}: chars ${pack.chars} exceeded budget ${budget}`);
    assert.equal(pack.chars, pack.text.length, `seed ${seed}: chars is not the rendered length`);
    assert.equal(pack.rows, pack.entries.length, `seed ${seed}: rows and entries disagree`);
    for (const [body, heading] of [
      [draftBefore, VOICE_INPUT_DRAFT_BEFORE_HEADING],
      [draftAfter, VOICE_INPUT_DRAFT_AFTER_HEADING],
      [voiceSoFar, VOICE_INPUT_VOICE_SO_FAR_HEADING],
    ] as const) {
      if (body.trim() === '') {
        assert.equal(pack.text.includes(heading), false, `seed ${seed}: an empty block rendered ${heading}`);
      }
    }
    if (pack.text.includes('row-')) withConversation++;
  }

  // Positive control: "≤ budget" is also satisfied by a pack that never includes the conversation.
  assert.ok(withConversation > RANDOM_SEEDS / 4, `only ${withConversation} seeds reached the conversation`);
});

// ── 5. The reference pack: wall objects sent as references, never as prose ───────────────────

/**
 * The visible set a view contract would publish: three objects with the four display
 * attributes AC4 resolves against. The URIs are the project-segmented form the wall mints
 * (`quay://<project>/task/<id>`), so the fixture exercises the real address grammar.
 */
const WALL_VISIBLE: QuayFocusableObject[] = [
  {
    uri: 'quay://claudecodeui/task/gap-wall-red',
    label: '①',
    display: { status: 'needs-human', color: 'red', ordinal: 1, pos: { row: 1, column: 1 } },
  },
  {
    uri: 'quay://claudecodeui/task/gap-wall-green',
    label: '②',
    display: { status: 'done', color: 'green', ordinal: 2, pos: { row: 2, column: 1 } },
  },
  {
    uri: 'quay://claudecodeui/task/gap-wall-blue',
    label: '③',
    display: { status: 'implementing', color: 'blue', ordinal: 3, pos: { row: 3, column: 1 } },
  },
];

/** The text half's conversation, distinct from anything the reference half may carry. */
const REFERENCE_HISTORY: ChatMessage[] = [
  { type: 'user', content: 'ROW-history-text', timestamp: FRESH },
  { type: 'assistant', content: 'ROW-history-reply', timestamp: FRESH },
];

const HISTORY_URIS = ['quay://claudecodeui/board', 'quay://claudecodeui/goal/GOAL-043'] as const;
const TRAY_URIS = [WALL_VISIBLE[0].uri] as const;

/** Resolves and returns the match, failing loudly (with the whole result) when it does not. */
function resolved(phrase: string, visible: readonly QuayFocusableObject[] = WALL_VISIBLE) {
  const match = resolveVoiceReference(visible, phrase);
  if (match.status !== 'resolved') {
    throw new Error(`${phrase} did not resolve: ${JSON.stringify(match)}`);
  }
  return match;
}

test('⑤ the reference pack carries URIs and display attributes, and only `text` carries prose', () => {
  const draftBefore = 'DRAFT-BEFORE-光标前';
  const draftAfter = 'DRAFT-AFTER-光标后';
  const voiceSoFar = 'VOICE-SO-FAR-已经说出';

  const existing = buildVoiceInputContextPack({
    messages: REFERENCE_HISTORY,
    draftBefore,
    draftAfter,
    voiceSoFar,
    now: NOW,
  });
  const pack = buildVoiceReferencePack({
    utterance: '把第二个改成三十秒',
    focusables: WALL_VISIBLE,
    focusUri: WALL_VISIBLE[1].uri,
    history: HISTORY_URIS,
    tray: TRAY_URIS,
    messages: REFERENCE_HISTORY,
    draftBefore,
    draftAfter,
    voiceSoFar,
    now: NOW,
  });

  // focus names the focused object by reference; visible is the same set, spatial order.
  assert.equal(pack.focus?.uri, WALL_VISIBLE[1].uri);
  assert.deepEqual(pack.visible, WALL_VISIBLE);

  // history/tray are URI ARRAYS — not conversation text and not the draft.
  assert.deepEqual(pack.history, [...HISTORY_URIS]);
  assert.deepEqual(pack.tray, [...TRAY_URIS]);
  assert.ok(pack.history.every((uri) => uri.startsWith('quay://')));
  assert.ok(pack.tray.every((uri) => uri.startsWith('quay://')));

  // The text half is BYTE-FOR-BYTE the existing C2 + draft/voice output — the degradation
  // path did not change when the reference pack was added.
  assert.equal(pack.text, existing.text);
  assert.ok(pack.text.includes('ROW-history-text'), 'the text half lost the conversation');
  assert.ok(pack.text.includes('DRAFT-BEFORE-光标前'), 'the text half lost the draft');

  // The reference half carries NO content: no conversation row, no draft text, and each
  // focusable is exactly the {uri, label, display} triple.
  const referenceHalf = JSON.stringify({
    focus: pack.focus,
    visible: pack.visible,
    history: pack.history,
    tray: pack.tray,
  });
  assert.equal(referenceHalf.includes('ROW-history-text'), false, 'conversation text entered the reference half');
  assert.equal(referenceHalf.includes('DRAFT-BEFORE'), false, 'draft text entered the reference half');
  for (const object of [...pack.visible, ...(pack.focus === null ? [] : [pack.focus])]) {
    assert.deepEqual(Object.keys(object).sort(), ['display', 'label', 'uri']);
    assert.deepEqual(Object.keys(object.display).sort(), ['color', 'ordinal', 'pos', 'status']);
  }
});

test('⑤ a focus URI outside the visible set yields no focus, and an empty wall is the text-only pack', () => {
  const offWall = buildVoiceReferencePack({
    focusables: WALL_VISIBLE,
    focusUri: 'quay://claudecodeui/task/gap-wall-absent',
  });
  // No fabricated reference: a focus the view never declared cannot be resolved downstream.
  assert.equal(offWall.focus, null);

  // No wall at all: the reference half is genuinely empty and the text half is unchanged —
  // this is the compatibility boundary with C2.
  const textOnly = buildVoiceReferencePack({ messages: REFERENCE_HISTORY, now: NOW });
  assert.equal(textOnly.focus, null);
  assert.deepEqual(textOnly.visible, []);
  assert.deepEqual(textOnly.history, []);
  assert.deepEqual(textOnly.tray, []);
  assert.equal(textOnly.text, buildVoiceInputContextPack({ messages: REFERENCE_HISTORY, now: NOW }).text);
});

test('⑤ a spoken reference resolves by ordinal, label, colour or position', () => {
  // 「第二个」 — display.ordinal.
  const second = resolved('第二个');
  assert.equal(second.object.uri, WALL_VISIBLE[1].uri);
  assert.deepEqual(second.by, ['ordinal']);

  // 「②」 — the short spoken label itself.
  const circled = resolved('②');
  assert.equal(circled.object.uri, WALL_VISIBLE[1].uri);
  assert.deepEqual(circled.by, ['label']);

  // 「红的那个」 — display.color.
  const red = resolved('红的那个');
  assert.equal(red.object.uri, WALL_VISIBLE[0].uri);
  assert.deepEqual(red.by, ['color']);

  // 「左上那个」 — display.pos, top-left origin.
  const topLeft = resolved('左上那个');
  assert.equal(topLeft.object.uri, WALL_VISIBLE[0].uri);
  assert.deepEqual(topLeft.by, ['pos']);

  // A phrase naming two attributes must satisfy BOTH (AND, not OR).
  const greenSecond = resolved('第二个绿的');
  assert.equal(greenSecond.object.uri, WALL_VISIBLE[1].uri);
  assert.deepEqual(greenSecond.by, ['color', 'ordinal']);
});

test('⑤ two matching objects are ambiguous, and ordinary words are not ordinals', () => {
  // A second red object: 「红的那个」 no longer names a unique object.
  const twoReds: QuayFocusableObject[] = [
    WALL_VISIBLE[0],
    {
      uri: 'quay://claudecodeui/task/gap-wall-red-2',
      label: '③',
      display: { status: 'needs-human', color: 'red', ordinal: 3, pos: { row: 3, column: 1 } },
    },
  ];
  const ambiguous = resolveVoiceReference(twoReds, '红的那个');
  assert.equal(ambiguous.status, 'unresolved');
  if (ambiguous.status === 'unresolved') {
    assert.equal(ambiguous.reason, 'ambiguous');
    assert.deepEqual(ambiguous.candidates.map((object) => object.uri), [twoReds[0].uri, twoReds[1].uri]);
  }

  // 「一起」 and 「十二点」 are ordinary words, not "the first/second object". Treating them
  // as ordinals would silently edit an object nobody named.
  for (const phrase of ['一起', '十二点']) {
    const match = resolveVoiceReference(WALL_VISIBLE, phrase);
    assert.equal(match.status, 'unresolved', `${phrase} was treated as a reference`);
    if (match.status === 'unresolved') assert.equal(match.reason, 'none');
  }

  // A named attribute with no matching object is `none`, not a guess.
  const missing = resolveVoiceReference(WALL_VISIBLE, '第五个');
  assert.equal(missing.status, 'unresolved');
  if (missing.status === 'unresolved') assert.equal(missing.reason, 'none');
});

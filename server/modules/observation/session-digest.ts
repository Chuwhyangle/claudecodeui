/**
 * The deterministic session digest — what one finished turn was about.
 *
 * A digest is READ OFF THE TRANSCRIPT, never inferred by a model: the conclusion is the
 * assistant's own final words (marked `tier: 'deterministic'`, excerpted verbatim), the changed
 * files and commands are the turn's own tool calls, and the test reading is parsed out of the
 * command's real output. When any of those cannot be read the digest says so with
 * `state: 'unevaluated'` and a reason — the same "get it wrong loudly" rule the observation
 * layer applies to every other reading.
 *
 * The turn boundary is the provider's own: the rows after the last REAL user prompt. Tool-result
 * rows are `user` rows in Claude's transcript but they are not prompts, so a turn that ends in a
 * long test run still reads as the turn that started with the person's message.
 *
 * Consumers: `server/modules/observation/session-digest.producer.ts` (the write path) and
 * `server/modules/observation/tests/session-digest.test.ts` (the criterion).
 */

/** What one turn's activity reads as on the wall. */
export type SessionActivity = 'running' | 'waiting' | 'idle' | 'error';

/** The test runners whose summary output the digest knows how to read. */
export type SessionTestRunner = 'vitest' | 'node-test' | 'playwright';

/**
 * One turn's test reading.
 *
 * `unevaluated` is not a failure: it is "this turn produced no output we could read a count
 * from", and it always carries the reason it could not.
 */
export type SessionTestReading =
  | { state: 'evaluated'; runner: SessionTestRunner; passed: number; failed: number }
  | { state: 'unevaluated'; reason: string };

/** One turn's deterministic summary. The observation store carries it as an opaque JSON digest. */
export type SessionDigest = {
  /** `running` only ever comes from activity outside the transcript; a digest is written at rest. */
  activity: SessionActivity;
  /** The assistant's final paragraph, verbatim, marked as an excerpt. */
  conclusion: {
    text: string;
    truncated: boolean;
    tier: 'deterministic';
    label: '原文摘录';
  };
  /** Files this turn edited, deduplicated, in first-touched order. */
  changedFiles: string[];
  /** Commands this turn ran, as a description or the command's first segment. */
  commands: string[];
  /** The last parseable test run of the turn, or why none was readable. */
  tests: SessionTestReading;
  /** The final paragraph's question and numbered options, when it asks one. */
  askingYou: {
    isAsking: boolean;
    question: string | null;
    options: string[];
  };
  /** How many real user prompts the transcript holds — the delta's "新增 N 轮" baseline. */
  turnCount: number;
};

/** Either a readable digest or the reason one could not be read. */
export type SessionDigestResult =
  | { state: 'evaluated'; digest: SessionDigest }
  | { state: 'unevaluated'; reason: string };

/** The excerpt cap: about 280 characters of the assistant's own final words. */
export const SESSION_DIGEST_CONCLUSION_CHARS = 280;

/** Tool names whose calls name a file this turn changed. */
const FILE_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** Commands that are a test run, by the words the runner itself prints. */
// `tsx` is in the same arm as `node` because every server criterion in this repo runs node's
// own test runner through the TS loader (`npx tsx --tsconfig server/tsconfig.json --test …`);
// leaving it out read those turns as "no test command" even though node printed the summary.
const TEST_COMMAND = /\b(?:vitest|playwright)\b|\b(?:node|tsx)\b[^\n]*\s--test\b|\bnpm\s+(?:run\s+)?test\b|\bjest\b/;

/** The vitest summary line: `Tests  2 failed | 8 passed (10)`, or a passed-only line. */
const VITEST_SUMMARY = /^\s*Tests\s+(.+)$/m;
const VITEST_FAILED = /(\d+)\s+failed/;
const VITEST_PASSED = /(\d+)\s+passed/;

/** node:test's TAP/spec summaries: `# pass 5` / `ℹ fail 0`. */
const NODE_TEST_PASSED = /(?:^|\n)\s*(?:#|ℹ)\s*pass\s+(\d+)/;
const NODE_TEST_FAILED = /(?:^|\n)\s*(?:#|ℹ)\s*fail\s+(\d+)/;

/** Playwright's summary lines: `  9 passed (5.2s)` / `  1 failed`. */
const PLAYWRIGHT_COUNT = /^\s*(\d+)\s+(passed|failed)\b/gm;

/** A numbered option line: `1.`, `1)`, `1、`, `(1)`. */
const NUMBERED_OPTION = /^\s*(?:\(?\d+[.)、]|（\d+）)\s+(.+)$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The message object of a transcript row, whichever provider shape it uses. */
function rowMessage(row: UnknownRecord): UnknownRecord | null {
  return isRecord(row.message) ? row.message : null;
}

/** One row's content blocks, normalised from the string and array forms transcripts use. */
function rowContentBlocks(row: UnknownRecord): UnknownRecord[] {
  const message = rowMessage(row);
  const content = message?.content;
  if (Array.isArray(content)) {
    return content.filter(isRecord);
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return [];
}

/** A text block's text, or the empty string. */
function blockText(block: UnknownRecord): string {
  const text = block.text;
  return typeof text === 'string' ? text : '';
}

/**
 * Whether one row is a real prompt — a person's message, not a tool result.
 *
 * Claude records tool results as `user` rows. Treating those as turn boundaries would split a
 * single turn at every tool call, so the boundary is a row that carries non-empty text.
 */
function isUserPromptRow(row: UnknownRecord): boolean {
  const message = rowMessage(row);
  const role = asString(message?.role) || asString(row.type);
  if (role !== 'user') return false;
  return rowContentBlocks(row).some((block) => block.type === 'text' && blockText(block).trim() !== '');
}

/** The content of a tool_result block, as text (providers store it either way). */
function toolResultText(block: UnknownRecord): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .map((part) => (part.type === 'text' ? blockText(part) : ''))
      .filter((text) => text !== '')
      .join('\n');
  }
  return '';
}

/** The first segment of a shell command — what the wall shows as "the command". */
function commandLabel(command: string): string {
  const first = command.split(/\s*(?:&&|\|\||;|\n)\s*/)[0]?.trim() ?? '';
  return (first === '' ? command.trim() : first).slice(0, 160);
}

/** Parses a vitest summary, or `null` when the output carries none. */
function parseVitestOutput(output: string): { passed: number; failed: number } | null {
  const summary = VITEST_SUMMARY.exec(output);
  if (summary === null) return null;
  const line = summary[1] ?? '';
  const failed = VITEST_FAILED.exec(line);
  const passed = VITEST_PASSED.exec(line);
  if (failed === null && passed === null) return null;
  return {
    passed: passed === null ? 0 : Number(passed[1]),
    failed: failed === null ? 0 : Number(failed[1]),
  };
}

/** Parses a node:test summary, or `null` when the output carries none. */
function parseNodeTestOutput(output: string): { passed: number; failed: number } | null {
  const passed = NODE_TEST_PASSED.exec(output);
  const failed = NODE_TEST_FAILED.exec(output);
  if (passed === null && failed === null) return null;
  return {
    passed: passed === null ? 0 : Number(passed[1]),
    failed: failed === null ? 0 : Number(failed[1]),
  };
}

/** Parses a playwright summary, or `null` when the output carries none. */
function parsePlaywrightOutput(output: string): { passed: number; failed: number } | null {
  let passed = 0;
  let failed = 0;
  let matched = false;
  for (const match of output.matchAll(PLAYWRIGHT_COUNT)) {
    matched = true;
    const count = Number(match[1]);
    if (match[2] === 'passed') passed += count;
    else failed += count;
  }
  return matched ? { passed, failed } : null;
}

/**
 * Reads passed/failed counts out of one test command's output.
 *
 * The three runners this project uses are recognized in turn; anything else is `unevaluated`
 * with the reason spelled out, never silently zero.
 */
export function parseTestOutput(output: string): SessionTestReading {
  const vitest = parseVitestOutput(output);
  if (vitest !== null) return evaluatedOrVacuous('vitest', vitest);
  const nodeTest = parseNodeTestOutput(output);
  if (nodeTest !== null) return evaluatedOrVacuous('node-test', nodeTest);
  const playwright = parsePlaywrightOutput(output);
  if (playwright !== null) return evaluatedOrVacuous('playwright', playwright);
  return { state: 'unevaluated', reason: '未识别到 vitest / node --test / playwright 的通过失败计数输出' };
}

/**
 * A `0 passed / 0 failed` summary is what a skipped or not-executed run prints. Calling that
 * green would be the "silent green" the observation layer exists to avoid, so it is reported as
 * unevaluated instead of as a healthy zero.
 */
function evaluatedOrVacuous(
  runner: SessionTestRunner,
  counts: { passed: number; failed: number },
): SessionTestReading {
  if (counts.passed === 0 && counts.failed === 0) {
    return { state: 'unevaluated', reason: `${runner} 报告 0 通过 0 失败：测试未执行或全部跳过` };
  }
  return { state: 'evaluated', runner, ...counts };
}

/**
 * Whether the assistant's final paragraph asks the person something.
 *
 * Two endings count as "asking you": a question mark, and a paragraph of numbered options (the
 * CLI's own "pick one" shape). Everything else is a statement. This is a heuristic that only
 * decides how the wall emphasizes the tile — it never triggers an action.
 */
export function analyzeAsking(paragraph: string): SessionDigest['askingYou'] {
  const lines = paragraph
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return { isAsking: false, question: null, options: [] };

  const options = lines
    .map((line) => NUMBERED_OPTION.exec(line)?.[1]?.trim() ?? '')
    .filter((option) => option !== '');
  const lastLine = lines.at(-1) ?? '';
  const endsWithQuestion = /[?？][」』"'）)]*\s*$/.test(lastLine);
  const isAsking = endsWithQuestion || options.length >= 2;

  if (!isAsking) return { isAsking: false, question: null, options: [] };
  // Prefer the line that actually poses the question; "pick one" paragraphs often carry a
  // lead-in line above the options rather than ending on the question mark.
  const questionLine = [...lines].reverse().find((line) => /[?？]/.test(line)) ?? null;
  return {
    isAsking: true,
    question: questionLine ?? (endsWithQuestion ? lastLine : null),
    options,
  };
}

/** The last non-empty paragraph of a text, which is the part a reader skims for the conclusion. */
function lastParagraph(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
  return paragraphs.at(-1) ?? '';
}

/** Truncates a conclusion excerpt to the tail that carries the answer. */
function excerptConclusion(paragraph: string): SessionDigest['conclusion'] {
  const truncated = paragraph.length > SESSION_DIGEST_CONCLUSION_CHARS;
  const text = truncated ? paragraph.slice(paragraph.length - SESSION_DIGEST_CONCLUSION_CHARS).trim() : paragraph;
  return { text, truncated, tier: 'deterministic', label: '原文摘录' };
}

/** Parses one transcript's non-empty lines, keeping the rows that are JSON objects. */
function parseRows(raw: string): UnknownRecord[] {
  const rows: UnknownRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) rows.push(parsed);
    } catch {
      // A transcript can end mid-line while a turn is being written. A line that does not
      // parse is skipped here; a file where NOTHING parses is reported as unreadable below.
    }
  }
  return rows;
}

/**
 * Builds one turn's deterministic digest from a transcript's raw JSONL text.
 *
 * `error` is the terminal run's own reading (the registry saw an `error` frame); the digest
 * cannot invent an error from text alone, and it does not try to.
 */
export function buildSessionDigest(raw: string, options: { error?: boolean } = {}): SessionDigestResult {
  const rows = parseRows(raw);
  if (rows.length === 0) {
    return { state: 'unevaluated', reason: 'transcript 为空或没有任何可解析的行' };
  }

  const promptIndexes = rows
    .map((row, index) => (isUserPromptRow(row) ? index : -1))
    .filter((index) => index >= 0);
  if (promptIndexes.length === 0) {
    return { state: 'unevaluated', reason: 'transcript 中没有可识别的用户输入行' };
  }

  const turnRows = rows.slice((promptIndexes.at(-1) ?? 0) + 1);
  const assistantTexts: string[] = [];
  const changedFiles: string[] = [];
  const commands: string[] = [];
  const commandsById = new Map<string, string>();
  const testOutputs: Array<{ command: string; output: string }> = [];

  for (const row of turnRows) {
    const message = rowMessage(row);
    const role = asString(message?.role) || asString(row.type);
    for (const block of rowContentBlocks(row)) {
      if (block.type === 'text' && role === 'assistant') {
        const text = blockText(block).trim();
        if (text !== '') assistantTexts.push(text);
        continue;
      }
      if (block.type === 'tool_use') {
        const name = asString(block.name);
        const input = isRecord(block.input) ? block.input : {};
        const toolUseId = asString(block.id);
        if (FILE_TOOL_NAMES.has(name)) {
          const filePath = asString(input.file_path) || asString(input.notebook_path) || asString(input.path);
          if (filePath !== '' && !changedFiles.includes(filePath)) changedFiles.push(filePath);
        }
        if (name === 'Bash') {
          const command = asString(input.command);
          if (command.trim() !== '') {
            const label = asString(input.description).trim() || commandLabel(command);
            commands.push(label);
            if (toolUseId !== '') commandsById.set(toolUseId, command);
          }
        }
        continue;
      }
      if (block.type === 'tool_result') {
        const command = commandsById.get(asString(block.tool_use_id)) ?? '';
        const output = toolResultText(block);
        if (command !== '' && TEST_COMMAND.test(command)) {
          testOutputs.push({ command, output });
        }
      }
    }
  }

  if (assistantTexts.length === 0) {
    return { state: 'unevaluated', reason: '本轮没有可读的助手文本' };
  }

  const lastText = assistantTexts.at(-1) ?? '';
  const conclusionParagraph = lastParagraph(lastText);
  const askingYou = analyzeAsking(conclusionParagraph);

  const lastTestOutput = testOutputs.at(-1);
  const tests: SessionTestReading =
    lastTestOutput === undefined
      ? { state: 'unevaluated', reason: '本轮未识别到测试命令' }
      : parseTestOutput(lastTestOutput.output);

  const activity: SessionActivity =
    options.error === true ? 'error' : askingYou.isAsking ? 'waiting' : 'idle';

  return {
    state: 'evaluated',
    digest: {
      activity,
      conclusion: excerptConclusion(conclusionParagraph),
      changedFiles,
      commands,
      tests,
      askingYou,
      turnCount: promptIndexes.length,
    },
  };
}

/**
 * Reply-suggestions debug-ledger criterion.
 *
 * WHAT IT PINS. The OPT-IN local debug ledger is OFF by default and creates no file; when it is
 * ON each draft-rewrite attempt appends exactly one JSONL line carrying the FULL draft and the
 * full candidate (and, on a refusal, the RAW upstream answer), with the directory at 0700 and
 * the file at 0600. Rotation keeps the current file plus `.1`/`.2`/`.3` and discards the oldest.
 * A refused write is ONE warning with no draft/candidate content and never reaches the rewrite
 * response. No API key, credential-file content, `baseUrl` or system-prompt text is ever written.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/reply-suggestions/tests/reply-suggestions-debug-log.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';

import { AppError } from '@/shared/utils.js';
import type { LlmCompletion } from '@/modules/llm-gateway/index.js';

import { buildDraftRewriteSystemPrompt } from '../reply-suggestions-draw.js';
import type { ReplySuggestionsCompletionRequest } from '../reply-suggestions-client.js';
import {
  createReplySuggestionsDebugLog,
  REPLY_SUGGESTIONS_DEBUG_LOG_MAX_BYTES,
  REPLY_SUGGESTIONS_DEBUG_LOG_MAX_OUTPUT_CHARS,
} from '../reply-suggestions-debug-log.js';
import { createReplySuggestionsModule } from '../reply-suggestions.module.js';
import { createReplySuggestionsSettingsSource } from '../reply-suggestions-settings.js';

const API_KEY = 'sk-debug-ledger-secret';
const BASE_URL = 'http://debug-gateway.invalid';
const DRAFT = '把这段话润色一下，明天上午十点见，记得带文档';
const CANDIDATE = '请把这段话润色一下：明天上午十点见，记得带文档。';

function temporaryDirectory(t: { after(callback: () => void | Promise<void>): void }, prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function readLines(filePath: string): Record<string, unknown>[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type Harness = {
  baseUrl: string;
  lines: () => Record<string, unknown>[];
  debugLogPath: string;
  cleanup: () => Promise<void>;
};

/** Runs the real module over a temp settings file and a temp debug-ledger path. */
async function start(
  t: { after(callback: () => void | Promise<void>): void },
  options: {
    debugLog: boolean;
    completeResult?: () => LlmCompletion;
    maxBytes?: number;
  },
): Promise<Harness> {
  const directory = temporaryDirectory(t, 'debug-ledger-');
  const keyFile = path.join(directory, 'key.txt');
  writeFileSync(keyFile, `${API_KEY}\n`, { mode: 0o600 });
  const settingsPath = path.join(directory, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({
    enabled: true,
    baseUrl: BASE_URL,
    model: 'debug-model',
    apiKeyFile: keyFile,
    usageLog: false,
    debugLog: options.debugLog,
  }), { mode: 0o600 });
  const debugLogPath = path.join(directory, 'cloudpit', 'reply-suggestions-debug.jsonl');

  const app = express();
  app.use(express.json());
  app.use('/api/reply-suggestions', createReplySuggestionsModule({
    settingsPath,
    homeDir: directory,
    debugLogPath,
    ...(options.maxBytes === undefined ? {} : { debugLogMaxBytes: options.maxBytes }),
    readLastAssistantMessage: async () => null,
    complete: async (_request: ReplySuggestionsCompletionRequest) => (
      options.completeResult?.() ?? {
        text: CANDIDATE, inputTokens: 21, outputTokens: 13, stopReason: 'end_turn', truncated: false,
      }
    ),
  }));
  app.use((error: unknown, _request: ExpressRequest, response: ExpressResponse, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    response.status(status).json({ success: false, error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const cleanup = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(cleanup);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    debugLogPath,
    lines: () => (existsSync(debugLogPath) ? readLines(debugLogPath) : []),
    cleanup,
  };
}

async function rewrite(baseUrl: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/reply-suggestions/draft-rewrite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

//---------------------------------------------------------------------------------------------
// off by default / one line per attempt
//---------------------------------------------------------------------------------------------

test('(a) the shipped default is OFF: no file is created and the settings read false', (t) => {
  const directory = temporaryDirectory(t, 'debug-ledger-default-');
  const settings = createReplySuggestionsSettingsSource({ homeDir: directory }).read();
  assert.equal(settings.debugLog, false);
  assert.equal(existsSync(path.join(directory, '.cloudpit', 'reply-suggestions-debug.jsonl')), false);
});

test('(b) an off ledger writes nothing across a successful and a refused attempt', async (t) => {
  const harness = await start(t, { debugLog: false });
  const ok = await rewrite(harness.baseUrl, { text: DRAFT });
  assert.equal(ok.status, 200);
  assert.equal(harness.lines().length, 0, 'debugLog:false writes no line');
  assert.equal(existsSync(harness.debugLogPath), false, 'the file is never created while off');
});

test('(c) an on ledger writes exactly one line whose input/output are the draft and the candidate', async (t) => {
  const harness = await start(t, { debugLog: true });
  const response = await rewrite(harness.baseUrl, { text: DRAFT, sessionId: 'session-debug-1' });
  assert.equal(response.status, 200);
  assert.equal(response.body.rewrittenText, CANDIDATE);

  const lines = harness.lines();
  assert.equal(lines.length, 1, 'exactly one line per attempt');
  const row = lines[0];
  assert.equal(row.type, 'draftRewrite');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.input, DRAFT, 'input is the request draft, verbatim');
  assert.equal(row.output, CANDIDATE, 'output is the response candidate, verbatim');
  assert.equal(row.inputChars, DRAFT.length);
  assert.equal(row.outputChars, CANDIDATE.length);
  assert.equal(row.sessionId, 'session-debug-1');
  assert.equal(row.model, 'debug-model');
  assert.equal(row.protocol, 'anthropic');
  assert.equal(row.version, 'example-1');
  assert.equal(row.inputTokens, 21);
  assert.equal(row.outputTokens, 13);
  assert.equal(typeof row.at, 'string');
  assert.equal(typeof row.requestId, 'string');
  assert.equal(typeof row.durationMs, 'number');
});

test('(d) the line field set is exact, and an omitted sessionId is ABSENT (not null)', async (t) => {
  const writerDir = temporaryDirectory(t, 'debug-ledger-fields-');
  const filePath = path.join(writerDir, 'nested', 'debug.jsonl');
  const log = createReplySuggestionsDebugLog({ filePath, now: () => 1_700_000_000_000 });
  log.record({
    requestId: 'req-1',
    outcome: 'ok',
    durationMs: 12,
    model: 'm',
    protocol: 'anthropic',
    version: 'v1',
    inputTokens: 3,
    outputTokens: 4,
    input: 'draft',
    output: 'candidate',
  });
  const row = readLines(filePath)[0];
  assert.deepEqual(
    Object.keys(row).sort(),
    ['at', 'durationMs', 'input', 'inputChars', 'inputTokens', 'model', 'outcome', 'output',
      'outputChars', 'outputTokens', 'protocol', 'requestId', 'type', 'version'].sort(),
  );
  assert.equal('sessionId' in row, false, 'an omitted sessionId is absent from the record');
  assert.equal(row.type, 'draftRewrite');
});

test('(e) tokens are omitted when the completion did not expose them', async (t) => {
  const writerDir = temporaryDirectory(t, 'debug-ledger-tokens-');
  const filePath = path.join(writerDir, 'debug.jsonl');
  const log = createReplySuggestionsDebugLog({ filePath });
  log.record({
    requestId: 'req-2', outcome: 'ok', durationMs: 1, model: 'm', protocol: 'openai', version: 'v1',
    input: 'a', output: 'b',
  });
  const row = readLines(filePath)[0];
  assert.equal('inputTokens' in row, false);
  assert.equal('outputTokens' in row, false);
});

//---------------------------------------------------------------------------------------------
// permissions and rotation
//---------------------------------------------------------------------------------------------

test('(f) the directory is 0700 and the file is 0600', async (t) => {
  const writerDir = temporaryDirectory(t, 'debug-ledger-mode-');
  const filePath = path.join(writerDir, 'cloudpit', 'reply-suggestions-debug.jsonl');
  const log = createReplySuggestionsDebugLog({ filePath });
  log.record({
    requestId: 'req-3', outcome: 'ok', durationMs: 1, model: 'm', protocol: 'anthropic', version: 'v1',
    input: 'x', output: 'y',
  });
  assert.equal(statSync(path.dirname(filePath)).mode & 0o777, 0o700);
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
});

test('(g) rotation keeps the current file plus .1/.2/.3 and discards the oldest', async (t) => {
  const writerDir = temporaryDirectory(t, 'debug-ledger-rotate-');
  const filePath = path.join(writerDir, 'debug.jsonl');
  const maxBytes = 2000;
  const log = createReplySuggestionsDebugLog({ filePath, maxBytes });
  // Each line is ~150 bytes; pre-filling to `maxBytes - 10` makes the next append rotate.
  const filler = 'f'.repeat(maxBytes - 10);
  const marker = (value: string): void => {
    writeFileSync(filePath, `${value}${filler}`, { mode: 0o600 });
  };
  const attempt = (n: number) => ({
    requestId: `req-${n}`, outcome: 'ok' as const, durationMs: 1, model: 'm',
    protocol: 'anthropic', version: 'v1', input: `draft-${n}`, output: `candidate-${n}`,
  });

  marker('OLDEST');
  log.record(attempt(1));
  marker('SECOND');
  log.record(attempt(2));
  marker('THIRD');
  log.record(attempt(3));

  assert.equal(existsSync(filePath), true);
  for (const suffix of ['.1', '.2', '.3']) {
    assert.equal(existsSync(`${filePath}${suffix}`), true, `${suffix} exists`);
  }
  assert.equal(existsSync(`${filePath}.4`), false, 'there is never a .4');
  assert.ok(readFileSync(`${filePath}.3`, 'utf8').startsWith('OLDEST'), 'the oldest is the one discarded');
  assert.ok(readFileSync(`${filePath}.2`, 'utf8').startsWith('SECOND'));
  assert.ok(readFileSync(`${filePath}.1`, 'utf8').startsWith('THIRD'));
  assert.ok(statSync(filePath).size <= maxBytes + 1024, 'one file stays within the cap plus one line');
  assert.equal(log.path, filePath);
});

test('(h) the shipped cap is 2 MB', () => {
  assert.equal(REPLY_SUGGESTIONS_DEBUG_LOG_MAX_BYTES, 2 * 1024 * 1024);
});

//---------------------------------------------------------------------------------------------
// refusal is contained and content-free
//---------------------------------------------------------------------------------------------

test('(i) a refused write produces ONE warning with no draft/candidate content and never throws', (t) => {
  const directory = temporaryDirectory(t, 'debug-ledger-refused-');
  // A regular file where a directory must be makes mkdirSync fail deterministically (ENOTDIR).
  const blocker = path.join(directory, 'blocked');
  writeFileSync(blocker, 'not a directory');
  const filePath = path.join(blocker, 'debug.jsonl');
  const warnings: string[] = [];
  const log = createReplySuggestionsDebugLog({ filePath, logger: (line) => warnings.push(line) });

  assert.doesNotThrow(() => {
    log.record({
      requestId: 'req-refused', outcome: 'ok', durationMs: 1, model: 'm', protocol: 'anthropic',
      version: 'v1', input: DRAFT, output: CANDIDATE,
    });
  });
  assert.equal(warnings.length, 1, 'exactly one warning');
  assert.ok(!warnings[0].includes(DRAFT), 'the warning carries no draft');
  assert.ok(!warnings[0].includes(CANDIDATE), 'the warning carries no candidate');
});

test('(j) the row never carries the key, baseUrl or the system-prompt text', async (t) => {
  const harness = await start(t, { debugLog: true });
  await rewrite(harness.baseUrl, { text: DRAFT });
  const serialised = JSON.stringify(harness.lines());
  assert.ok(!serialised.includes(API_KEY), 'no API key');
  assert.ok(!serialised.includes(BASE_URL), 'no baseUrl');
  assert.ok(!serialised.includes('polish a single message'), 'no system-prompt text');
  assert.ok(!serialised.includes(buildDraftRewriteSystemPrompt()));
});

//---------------------------------------------------------------------------------------------
// a refusal keeps the RAW upstream answer; an over-long answer is clipped in the log only
//---------------------------------------------------------------------------------------------

test('(k) a truncated answer is logged as rejected:truncated with the raw upstream output', async (t) => {
  const raw = `${CANDIDATE} [cut off here]`;
  const harness = await start(t, {
    debugLog: true,
    completeResult: () => ({ text: raw, inputTokens: 5, outputTokens: 400, stopReason: 'max_tokens', truncated: true }),
  });
  const response = await rewrite(harness.baseUrl, { text: DRAFT });
  assert.equal(response.status, 502);
  const row = harness.lines()[0];
  assert.equal(row.outcome, 'rejected:truncated');
  assert.equal(row.output, raw, 'the log keeps the raw upstream answer');
});

test('(l) an over-long candidate logs the first 6000 characters and sets the truncation flag', (t) => {
  const directory = temporaryDirectory(t, 'debug-ledger-long-');
  const filePath = path.join(directory, 'debug.jsonl');
  const log = createReplySuggestionsDebugLog({ filePath });
  const output = 'y'.repeat(REPLY_SUGGESTIONS_DEBUG_LOG_MAX_OUTPUT_CHARS + 250);
  log.record({
    requestId: 'req-long', outcome: 'ok', durationMs: 1, model: 'm', protocol: 'anthropic', version: 'v1',
    input: DRAFT, output,
  });
  const row = readLines(filePath)[0];
  assert.equal(String(row.output).length, REPLY_SUGGESTIONS_DEBUG_LOG_MAX_OUTPUT_CHARS);
  assert.equal(row.output, output.slice(0, REPLY_SUGGESTIONS_DEBUG_LOG_MAX_OUTPUT_CHARS));
  assert.equal(row.outputChars, output.length, 'outputChars reports the full upstream length');
  assert.equal(row.outputTruncatedForLog, true);
});

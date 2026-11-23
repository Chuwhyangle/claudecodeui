import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The service reads the registry through the shared port; evaluating the registry
// module is what installs that port (it is no longer a static dependency of the service).
import '@/modules/providers/provider.registry.js';
import {
  summarizeClaudeHistoryTokenUsage,
  summarizeClaudeTurnUsage,
} from '@/modules/providers/list/claude/claude-token-usage.provider.js';
import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';

/**
 * The current-turn block answers "how fast did the model write, how long did I
 * wait, what did this turn cost" — questions the context-window reading cannot.
 *
 * A turn runs from the last human prompt to its final assistant row. A streamed
 * reply writes one assistant row per content block that repeats that request's
 * usage, so they deduplicate by `requestRef`; and the CLI's injected user rows
 * (system reminders, local-command output) are not prompts. These cases pin the
 * aggregation, the cache subsets, the timing denominators and the opt-in cost.
 */

const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const at = (seconds: number) => new Date(BASE + seconds * 1_000).toISOString();

const prompt = (seconds: number, content = 'do the thing') => ({
  type: 'user',
  timestamp: at(seconds),
  message: { role: 'user', content },
});

const assistant = (
  seconds: number,
  usage: Record<string, number>,
  requestRef?: string,
) => ({
  type: 'assistant',
  timestamp: at(seconds),
  ...(requestRef ? { requestRef } : {}),
  message: { usage },
});

test('a turn sums every assistant row after the last human prompt over wall-clock time', () => {
  const entries = [
    prompt(0),
    assistant(4, { input_tokens: 100, output_tokens: 40 }),
    assistant(10, { input_tokens: 50, output_tokens: 60 }),
  ];

  const turn = summarizeClaudeTurnUsage(entries, null);
  assert.ok(turn);
  assert.equal(turn.totalTokens, 250);
  assert.equal(turn.inputTokens, 150);
  assert.equal(turn.outputTokens, 100);
  assert.equal(turn.elapsedMs, 10_000);
  // No request timing to join, so tps falls back to the end-to-end wall clock.
  assert.equal(turn.tps, 10);
  assert.equal(turn.apiMs, undefined);
  assert.equal(turn.costUsd, undefined);
  assert.equal(turn.calls, 2);
});

test('repeated rows of one request deduplicate by requestRef and keep the finished usage', () => {
  const entries = [
    prompt(0),
    assistant(2, { input_tokens: 100, output_tokens: 10 }, 'r1'),
    assistant(5, { input_tokens: 100, output_tokens: 30 }, 'r1'),
  ];

  const turn = summarizeClaudeTurnUsage(entries, null);
  assert.ok(turn);
  // One request, not two: the last row of the ref is the finished answer.
  assert.equal(turn.calls, 1);
  assert.equal(turn.inputTokens, 100);
  assert.equal(turn.outputTokens, 30);
});

test('joining an api-request row measures API latency and makes it the tps denominator', () => {
  const entries = [
    prompt(0),
    { type: 'api-request', id: 'r1', timestamp: at(1) },
    assistant(3, { input_tokens: 100, output_tokens: 60 }, 'r1'),
  ];

  const turn = summarizeClaudeTurnUsage(entries, null);
  assert.ok(turn);
  // Request started at +1s and finished at +3s: 2000ms of API time, while the
  // person waited 3000ms.
  assert.equal(turn.apiMs, 2_000);
  assert.equal(turn.elapsedMs, 3_000);
  assert.equal(turn.tps, 30);
});

test('injected user rows are not prompts, so the turn starts at the real prompt', () => {
  const entries = [
    prompt(0, '<system-reminder>ignore me</system-reminder>'),
    prompt(1, '<local-command-stdout>x</local-command-stdout>'),
    prompt(2, 'the actual request'),
    assistant(4, { input_tokens: 100, output_tokens: 20 }),
  ];

  const turn = summarizeClaudeTurnUsage(entries, null);
  assert.ok(turn);
  // Prompt at +2s, answer at +4s.
  assert.equal(turn.elapsedMs, 2_000);
});

test('cache reads and writes are subsets of input with a derived ratio and fresh remainder', () => {
  const entries = [
    prompt(0),
    assistant(1, {
      input_tokens: 10,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 90,
      output_tokens: 50,
    }),
  ];

  const turn = summarizeClaudeTurnUsage(entries, null);
  assert.ok(turn);
  assert.equal(turn.inputTokens, 500);
  assert.equal(turn.cacheReadTokens, 400);
  assert.equal(turn.cacheWriteTokens, 90);
  assert.equal(turn.cacheHitRatio, 0.8);
  assert.equal(turn.fresh, 10);
});

test('a turn that never reported a cache quantity claims none instead of zero', () => {
  const entries = [
    prompt(0),
    assistant(1, { input_tokens: 100, output_tokens: 20 }),
  ];

  const turn = summarizeClaudeTurnUsage(entries, null);
  assert.ok(turn);
  assert.equal(turn.cacheReadTokens, undefined);
  assert.equal(turn.cacheWriteTokens, undefined);
  assert.equal(turn.cacheHitRatio, undefined);
  assert.equal(turn.fresh, undefined);
});

test('costUsd is priced only when rates are supplied, never fabricated', () => {
  const entries = [
    prompt(0),
    assistant(1, {
      input_tokens: 10,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      output_tokens: 1_000_000,
    }),
  ];

  const priced = summarizeClaudeTurnUsage(entries, { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0 });
  assert.ok(priced);
  // 10 direct input * $1/M + 1M cache read * $0.1/M + 1M output * $3/M.
  assert.equal(priced.costUsd, (10 * 1 + 1_000_000 * 0.1 + 1_000_000 * 3) / 1_000_000);

  assert.equal(summarizeClaudeTurnUsage(entries, null)?.costUsd, undefined);
});

test('the environment pricing variable is the only source of rates', () => {
  const entries = [prompt(0), assistant(1, { input_tokens: 1_000_000, output_tokens: 0 })];
  const previous = process.env.CLOUDPIT_TOKEN_PRICING;

  try {
    delete process.env.CLOUDPIT_TOKEN_PRICING;
    assert.equal(summarizeClaudeTurnUsage(entries)?.costUsd, undefined);

    process.env.CLOUDPIT_TOKEN_PRICING = JSON.stringify({ input: 2, output: 4 });
    assert.equal(summarizeClaudeTurnUsage(entries)?.costUsd, 2);

    process.env.CLOUDPIT_TOKEN_PRICING = 'not json';
    assert.equal(summarizeClaudeTurnUsage(entries)?.costUsd, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.CLOUDPIT_TOKEN_PRICING;
    } else {
      process.env.CLOUDPIT_TOKEN_PRICING = previous;
    }
  }
});

test('a transcript with no assistant row after the prompt has no turn to report', () => {
  assert.equal(summarizeClaudeTurnUsage([prompt(0)], null), undefined);
  assert.equal(summarizeClaudeTurnUsage([], null), undefined);
});

test('the history summarizer carries a turn so a history refresh cannot erase it', () => {
  const entries = [
    prompt(0),
    assistant(2, { input_tokens: 100, output_tokens: 40 }, 'r1'),
    assistant(6, { input_tokens: 100, output_tokens: 60 }, 'r1'),
  ];

  const reading = summarizeClaudeHistoryTokenUsage(entries, 'claude-sonnet-4-5');
  assert.ok(reading.turn, 'the history reading attaches a turn');
  assert.equal(reading.turn.calls, 1);
  assert.equal(reading.turn.elapsedMs, 6_000);
  // The history projection drops api-request rows, so apiMs is absent and tps
  // uses the wall clock.
  assert.equal(reading.turn.apiMs, undefined);
  assert.equal(reading.turn.tps, 10);
});

test('the live-service reader attaches a turn joined to its api-request rows', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-turn-usage-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      prompt(0),
      { type: 'api-request', id: 'r1', timestamp: at(1) },
      assistant(3, { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 60 }, 'r1'),
    ].map((entry) => JSON.stringify(entry)).join('\n'));

    const previousPricing = process.env.CLOUDPIT_TOKEN_PRICING;
    delete process.env.CLOUDPIT_TOKEN_PRICING;
    try {
      const service = createProviderTokenUsageService({
        getSessionById: () => ({
          session_id: 'app-session',
          provider: 'claude',
          provider_session_id: 'provider-session',
          project_path: null,
          jsonl_path: sessionFilePath,
          custom_name: null,
          name_source: 'derived',
          model: null,
          effort: null,
          permission_mode: null,
          forked_from_session_id: null,
          isArchived: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        }),
        getClaudeContextWindow: () => '200000',
        fileExists: () => true,
      });

      const reading = await service.getSessionTokenUsage('app-session');
      assert.ok(reading.turn);
      assert.equal(reading.turn.apiMs, 2_000);
      assert.equal(reading.turn.elapsedMs, 3_000);
      assert.equal(reading.turn.tps, 30);
      // No configured rates in this environment, so no fabricated cost.
      assert.equal(reading.turn.costUsd, undefined);
    } finally {
      if (previousPricing !== undefined) {
        process.env.CLOUDPIT_TOKEN_PRICING = previousPricing;
      }
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

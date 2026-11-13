import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

// The service reads the registry through the shared port; evaluating the registry
// module is what installs that port (it is no longer a static dependency of the service).
import '@/modules/providers/provider.registry.js';
import {
  createProviderTokenUsageService,
  summarizeClaudeTokenUsage,
} from '@/modules/providers/services/provider-token-usage.service.js';
import { AppError } from '@/shared/utils.js';

function createSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'app-session',
    provider: 'claude',
    provider_session_id: 'provider-session',
    project_path: null,
    jsonl_path: null,
    custom_name: null,
    name_source: 'derived',
    model: null,
    effort: null,
    permission_mode: null,
    forked_from_session_id: null,
    isArchived: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('a known Claude session reports empty usage until its transcript exists', async () => {
  // The session row exists the moment the provider allocates it, but the
  // transcript file appears only when the first turn lands. Before this
  // behaviour existed the lookup threw SESSION_FILE_NOT_FOUND (404) in that
  // window, which left the composer's token/context counter blank until a turn
  // completed or a realtime token_budget frame arrived.
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({
      provider: 'claude',
      jsonl_path: '/tmp/not-written-yet/provider-session.jsonl',
    }),
    getClaudeContextWindow: () => '200000',
    fileExists: () => false,
  });

  const usage = await service.getSessionTokenUsage('app-session');

  assert.equal(usage.used, 0);
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
  assert.deepEqual(usage.breakdown, { input: 0, output: 0 });
  // The context window still comes through, the way the file-exists-but-empty
  // path and `emptyCodexTokenUsage` both report it: the panel's context row
  // stays populated instead of vanishing until the first turn lands.
  assert.equal(usage.total, 200_000);
});

test('a known Claude session whose transcript path is derived reports empty usage when absent', async () => {
  // Same window, but the row carries only project_path, so the service derives
  // the transcript location. The derived file is absent, so the answer is the
  // same zero reading rather than a file-not-found error.
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({
      provider: 'claude',
      jsonl_path: null,
      project_path: '/work/example-project',
    }),
    getHomeDirectory: () => '/home/example',
    getClaudeContextWindow: () => '200000',
    fileExists: () => false,
  });

  const usage = await service.getSessionTokenUsage('app-session');

  assert.equal(usage.used, 0);
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
  assert.deepEqual(usage.breakdown, { input: 0, output: 0 });
  assert.equal(usage.total, 200_000);
});

test('token usage lookup requires only the app-facing session id for Claude', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            output_tokens: 30,
          },
        },
      }),
      '{incomplete',
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 155,
      total: 180_000,
      // One turn: the session total and the newest request coincide, but they
      // are now named separately.
      sessionSpend: {
        inputTokens: 125,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
      },
      contextOccupancy: { used: 155, total: 180_000 },
      inputTokens: 125,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      cacheTokens: 25,
      cumulative: {
        inputTokens: 125,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
      },
      lastRequest: {
        inputTokens: 125,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
      },
      breakdown: { input: 125, output: 30 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage uses the latest token_count snapshot', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            model_context_window: 100_000,
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49 },
            model_context_window: 250_000,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        provider: 'codex',
        jsonl_path: sessionFilePath,
      }),
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 49,
      total: 250_000,
      sessionSpend: { inputTokens: 40, outputTokens: 9, totalTokens: 49 },
      // Codex knows the window but no measured request occupancy.
      contextOccupancy: { total: 250_000 },
      inputTokens: 40,
      outputTokens: 9,
      cumulative: { inputTokens: 40, outputTokens: 9, totalTokens: 49 },
      usageScope: 'session-cumulative',
      breakdown: { input: 40, output: 9 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage keeps cumulative spend and the latest request in separate scopes', async () => {
  // Real rollout shape: the event carries both quantity sets plus the model's
  // window. Cached input is a subset of input and reasoning output a subset of
  // output, so the reading must expose them without adding them in again.
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-shape-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        timestamp: '2026-10-30T12:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1_200,
              cached_input_tokens: 900,
              output_tokens: 300,
              reasoning_output_tokens: 120,
              total_tokens: 1_500,
            },
            last_token_usage: {
              input_tokens: 800,
              cached_input_tokens: 600,
              output_tokens: 90,
              reasoning_output_tokens: 40,
              total_tokens: 890,
            },
            model_context_window: 258_400,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        provider: 'codex',
        jsonl_path: sessionFilePath,
      }),
    });

    const usage = await service.getSessionTokenUsage('app-session');
    // Cumulative is the legacy `used`; the latest request is never treated as
    // the number of tokens used in the session, and neither is the window.
    assert.equal(usage.used, 1_500);
    assert.equal(usage.total, 258_400);
    assert.deepEqual(usage.cumulative, {
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 900,
      reasoningOutputTokens: 120,
      totalTokens: 1_500,
    });
    assert.deepEqual(usage.lastRequest, {
      inputTokens: 800,
      outputTokens: 90,
      cacheReadTokens: 600,
      reasoningOutputTokens: 40,
      totalTokens: 890,
    });
    assert.equal(usage.usageScope, 'session-cumulative');
    assert.equal(usage.observedAt, '2026-10-30T12:00:00.000Z');
    // Subsets are carried through unchanged, not folded into input/output.
    assert.equal(usage.inputTokens, 1_200);
    assert.equal(usage.outputTokens, 300);
    assert.equal(usage.cacheReadTokens, 900);
    assert.equal(usage.reasoningOutputTokens, 120);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage keeps missing quantities unknown instead of reporting zero', async () => {
  // A snapshot that reports only the cumulative total: the absent per-kind
  // counts must stay undefined, while an explicitly reported zero survives.
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-missing-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 10,
              output_tokens: 0,
              total_tokens: 10,
            },
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        provider: 'codex',
        jsonl_path: sessionFilePath,
      }),
    });

    const usage = await service.getSessionTokenUsage('app-session');
    // Absent detail fields stay unknown; assert this before deepEqual narrows
    // the cumulative block to the literal shape it was compared against.
    assert.equal(usage.cumulative?.cacheReadTokens, undefined);
    assert.equal(usage.cumulative?.reasoningOutputTokens, undefined);
    assert.deepEqual(usage.cumulative, { inputTokens: 10, outputTokens: 0, totalTokens: 10 });
    // No last request and no window in this event: neither is invented.
    assert.equal(usage.lastRequest, undefined);
    assert.equal(usage.total, undefined);
    // Explicit zero is preserved and must not read as "unknown".
    assert.equal(usage.cumulative?.outputTokens, 0);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage skips a blank info row and a partially written tail line', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-tail-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 70, output_tokens: 30, total_tokens: 100 },
            model_context_window: 258_400,
          },
        },
      }),
      // Codex emits token_count rows with no info; they must not end the scan.
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":',
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        provider: 'codex',
        jsonl_path: sessionFilePath,
      }),
    });

    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage.used, 100);
    assert.equal(usage.total, 258_400);
    assert.deepEqual(usage.cumulative, { inputTokens: 70, outputTokens: 30, totalTokens: 100 });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex carries cache_write_input_tokens into both usage scopes without adding it again', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-cachewrite-'));
  const withKeyPath = path.join(tempDirectory, 'with-cache-write.jsonl');
  const withoutKeyPath = path.join(tempDirectory, 'without-cache-write.jsonl');

  try {
    await writeFile(withKeyPath, JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1_200,
            cached_input_tokens: 900,
            cache_write_input_tokens: 300,
            output_tokens: 200,
            total_tokens: 1_400,
          },
          last_token_usage: {
            input_tokens: 800,
            cached_input_tokens: 600,
            cache_write_input_tokens: 100,
            output_tokens: 90,
            total_tokens: 890,
          },
          model_context_window: 200_000,
        },
      },
    }));

    const withKey = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'codex', jsonl_path: withKeyPath }),
    });
    const usage = await withKey.getSessionTokenUsage('app-session');

    assert.equal(usage.cumulative?.cacheWriteTokens, 300);
    assert.equal(usage.lastRequest?.cacheWriteTokens, 100);
    // Written-to-cache input is a subset of input: never a second addend.
    assert.equal(usage.cumulative?.inputTokens, 1_200);
    assert.equal(usage.lastRequest?.inputTokens, 800);
    assert.equal(usage.inputTokens, 1_200);
    assert.equal(usage.outputTokens, 200);
    assert.equal(usage.used, 1_400);

    // A rollout that does not report the key keeps the field absent: "not
    // reported" must not read as a fabricated zero.
    await writeFile(withoutKeyPath, JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1_200,
            cached_input_tokens: 900,
            output_tokens: 200,
            total_tokens: 1_400,
          },
          last_token_usage: {
            input_tokens: 800,
            cached_input_tokens: 600,
            output_tokens: 90,
            total_tokens: 890,
          },
        },
      },
    }));

    const withoutKey = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'codex', jsonl_path: withoutKeyPath }),
    });
    const missing = await withoutKey.getSessionTokenUsage('app-session');
    assert.equal(missing.cumulative?.cacheWriteTokens, undefined);
    assert.equal(missing.lastRequest?.cacheWriteTokens, undefined);
    assert.equal(
      Object.prototype.hasOwnProperty.call(missing.cumulative, 'cacheWriteTokens'),
      false,
      'an unreported cache write must not be added as a zero',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(missing.lastRequest, 'cacheWriteTokens'),
      false,
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('OpenCode token usage resolves its provider-native id from the session row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-opencode-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER
      )
    `);
    database.prepare(`
      INSERT INTO session (
        id,
        tokens_input,
        tokens_output,
        tokens_reasoning,
        tokens_cache_read,
        tokens_cache_write
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('provider-session', 12, 7, 3, 5, 2);
  } finally {
    database.close();
  }

  try {
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'opencode' }),
      getOpenCodeDatabasePath: () => databasePath,
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 29,
      // The OpenCode row is a whole-session accumulator, not a request
      // reading; its cache-read quantity is a subset of input.
      sessionSpend: { inputTokens: 17, outputTokens: 7, cacheReadTokens: 5 },
      inputTokens: 17,
      outputTokens: 7,
      breakdown: { input: 17, output: 7 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Cursor returns an explicit unsupported token usage result', async () => {
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({ provider: 'cursor' }),
  });

  const result = await service.getSessionTokenUsage('app-session');

  assert.equal(result.unsupported, true);
  assert.equal(result.used, 0);
  assert.equal(result.total, 0);
});

test('token usage reports SESSION_NOT_FOUND for an unknown app session id', async () => {
  const service = createProviderTokenUsageService({ getSessionById: () => null });

  await assert.rejects(
    () => service.getSessionTokenUsage('missing-session'),
    (error: unknown) => (
      error instanceof AppError
      && error.code === 'SESSION_NOT_FOUND'
      && error.statusCode === 404
    ),
  );
});

test('the Claude summarizer reads the newest assistant turn, not the whole conversation', () => {
  const entries = [
    { type: 'assistant', message: { usage: { input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 50 } } },
    { type: 'user', message: { role: 'user', content: 'next' } },
    // The newest turn's prompt is the whole context, so its cache_read already
    // includes everything before it. Summing turns would double-count.
    { type: 'assistant', message: { usage: { input_tokens: 3, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100, output_tokens: 80 } } },
  ];

  assert.deepEqual(summarizeClaudeTokenUsage(entries, '200000'), {
    used: 4183,
    total: 200_000,
    inputTokens: 4103,
    outputTokens: 80,
    cacheReadTokens: 4000,
    cacheCreationTokens: 100,
    cacheTokens: 4100,
    // First-class session spend: both turns are main-thread, so their prompts
    // accumulate: 1005 + 4103.
    sessionSpend: {
      inputTokens: 5108,
      outputTokens: 130,
      cacheReadTokens: 5000,
      cacheWriteTokens: 100,
    },
    cumulative: {
      inputTokens: 5108,
      outputTokens: 130,
      cacheReadTokens: 5000,
      cacheWriteTokens: 100,
    },
    // First-class newest-turn occupancy: the window is independent of it.
    contextOccupancy: { used: 4183, total: 200_000 },
    // The newest turn also answers the context-occupancy scope in counts shape.
    lastRequest: {
      inputTokens: 4103,
      outputTokens: 80,
      cacheReadTokens: 4000,
      cacheWriteTokens: 100,
    },
    breakdown: { input: 4103, output: 80 },
  });
});

test('a Claude reading names its two scopes and keeps the legacy fields for older consumers', () => {
  const entries = [
    { type: 'assistant', message: { usage: { input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 50 } } },
    { type: 'assistant', message: { usage: { input_tokens: 3, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100, output_tokens: 80 } } },
  ];
  const reading = summarizeClaudeTokenUsage(entries, '200000');

  // `contextOccupancy.used` is the NEWEST turn's input+output, and the window
  // is a separate fact.
  assert.equal(reading.contextOccupancy?.used, 4103 + 80);
  assert.equal(reading.contextOccupancy?.total, 200_000);
  // `sessionSpend` is the whole session's accumulated spend (1005 + 4103
  // input, 50 + 80 output), never the newest turn's occupancy.
  assert.deepEqual(reading.sessionSpend, {
    inputTokens: 5108,
    outputTokens: 130,
    cacheReadTokens: 5000,
    cacheWriteTokens: 100,
  });
  assert.notEqual(reading.contextOccupancy?.used, reading.sessionSpend?.inputTokens);
  // Backward compatibility: the old dual-meaning fields are still emitted.
  // Claude leaves `usageScope` unset exactly as before, so an older consumer
  // keeps reading `used` as the context occupancy.
  assert.equal(reading.used, 4183);
  assert.deepEqual(reading.cumulative, reading.sessionSpend);
  assert.equal(reading.usageScope, undefined);
});

test('the Claude summarizer skips synthetic rows that carry an all-zero usage block', () => {
  // Interrupts, API errors and "No response requested." are written as
  // assistant rows with a fully zeroed usage block. Reading one as the newest
  // turn dropped the composer counter to 0 until the next turn pushed it back.
  const entries = [
    { type: 'assistant', message: { usage: { input_tokens: 3, cache_read_input_tokens: 4000, output_tokens: 80 } } },
    {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ];

  assert.equal(summarizeClaudeTokenUsage(entries, '200000').used, 4083);
});

test('the Claude summarizer skips a subagent sidechain turn', () => {
  // A sidechain turn reports the subagent's own context window. Reading it
  // made the counter drop to the subagent's number mid-run.
  const entries = [
    { type: 'assistant', message: { usage: { input_tokens: 3, cache_read_input_tokens: 4000, output_tokens: 80 } } },
    {
      type: 'assistant',
      isSidechain: true,
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 5 } },
    },
  ];

  assert.equal(summarizeClaudeTokenUsage(entries, '200000').used, 4083);
});

test('the Claude summarizer reports session-cumulative spend and a separate sidechain bucket', async () => {
  const entries = [
    {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens: 30,
        },
      },
    },
    { type: 'user', message: { role: 'user', content: 'look into this' } },
    {
      type: 'assistant',
      isSidechain: true,
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
          output_tokens: 5,
        },
      },
    },
    {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 11,
          output_tokens: 9,
        },
      },
    },
    {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ];

  const reading = summarizeClaudeTokenUsage(entries, '200000');
  // Main-thread turns accumulate instead of last-wins:
  // input = (100+20+5) + (7+400+11) = 543; output = 30 + 9;
  // cacheRead = 20 + 400; cacheWrite = 5 + 11. The all-zero row adds nothing.
  assert.deepEqual(reading.cumulative, {
    inputTokens: 543,
    outputTokens: 39,
    cacheReadTokens: 420,
    cacheWriteTokens: 16,
  });
  // Sidechain turns bill to the session but never enter the main-thread total:
  // input = 10 + 900 + 50 = 960.
  assert.deepEqual(reading.sidechain, {
    inputTokens: 960,
    outputTokens: 5,
    cacheReadTokens: 900,
    cacheWriteTokens: 50,
  });
  // The newest main-thread turn still answers the context-occupancy read.
  assert.equal(reading.used, 427);
  assert.equal(reading.inputTokens, 418);
  assert.equal(reading.outputTokens, 9);

  // Same transcript through the real JSONL -> service path (DoD), where the
  // session-cumulative spend must be a sum rather than the newest turn.
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-cumulative-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, entries.map((entry) => JSON.stringify(entry)).join('\n'));
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '200000',
    });

    const usage = await service.getSessionTokenUsage('app-session');
    assert.deepEqual(usage.cumulative, reading.cumulative);
    assert.deepEqual(usage.sidechain, reading.sidechain);
    assert.equal(usage.used, 427);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('the Claude summarizer reports zero for a transcript with no assistant turn yet', () => {
  const usage = summarizeClaudeTokenUsage([{ type: 'user', message: { role: 'user', content: 'hi' } }], '200000');

  assert.equal(usage.used, 0);
  assert.equal(usage.total, 200_000);
});

/** Padding rows large enough to push earlier rows out of the 4MB tail window. */
function paddingLines(totalBytes: number): string {
  const line = JSON.stringify({ type: 'attachment', filler: 'x'.repeat(4096) });
  return Array.from({ length: Math.ceil(totalBytes / line.length) }, () => line).join('\n');
}

test('Claude token usage reads the whole transcript for cumulative when it is larger than the tail', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-cumulative-full-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    // Two main-thread turns separated by >4MB of padding so only the second
    // sits inside the tail window. A tail-only read would sum just the second
    // turn and undercount the session by the first.
    const first = { type: 'assistant', message: { usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 5 } } };
    const last = { type: 'assistant', message: { usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 } } };
    await writeFile(sessionFilePath, [
      JSON.stringify(first),
      paddingLines(5 * 1024 * 1024),
      JSON.stringify(last),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
    });

    const usage = await service.getSessionTokenUsage('app-session');
    // Both turns contribute: input = (100+20) + (7+3), output = 5 + 2,
    // cacheRead = 20 + 3. Neither reported cache_creation, so cacheWriteTokens
    // stays absent instead of being fabricated as zero.
    assert.deepEqual(usage.cumulative, {
      inputTokens: 130,
      outputTokens: 7,
      cacheReadTokens: 23,
    });
    // The newest-turn occupancy read still answers the last row, unchanged.
    assert.equal(usage.inputTokens, 10);
    assert.equal(usage.outputTokens, 2);
    assert.equal(usage.cacheReadTokens, 3);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('the Claude summarizer omits cache subsets it never reported instead of fabricating zero', () => {
  // Both turns report cache reads but no cache creation: the cumulative block
  // keeps cacheReadTokens and omits cacheWriteTokens (absent ≠ reported zero).
  const entries = [
    { type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 2 } } },
    { type: 'assistant', message: { usage: { input_tokens: 5, cache_read_input_tokens: 1, output_tokens: 3 } } },
  ];

  const reading = summarizeClaudeTokenUsage(entries, '200000');
  assert.deepEqual(reading.cumulative, {
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 5,
  });
  assert.equal('cacheWriteTokens' in (reading.cumulative ?? {}), false);
});

test('Claude token usage falls back to the whole file when the tail has no usage row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-fallback-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 11, output_tokens: 3 } } }),
      paddingLines(5 * 1024 * 1024),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
    });

    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage.inputTokens, 11);
    assert.equal(usage.outputTokens, 3);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage reads only the tail of a large rollout', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-tail-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      paddingLines(5 * 1024 * 1024),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 21, output_tokens: 8, total_tokens: 29 },
            model_context_window: 150_000,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'codex', jsonl_path: sessionFilePath }),
      readTextFile: () => { throw new Error('full read must not happen when the tail has usage'); },
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 29,
      total: 150_000,
      sessionSpend: { inputTokens: 21, outputTokens: 8, totalTokens: 29 },
      contextOccupancy: { total: 150_000 },
      inputTokens: 21,
      outputTokens: 8,
      cumulative: { inputTokens: 21, outputTokens: 8, totalTokens: 29 },
      usageScope: 'session-cumulative',
      breakdown: { input: 21, output: 8 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage falls back to the whole file when the tail has no token_count row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-fallback-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } },
        },
      }),
      paddingLines(5 * 1024 * 1024),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'codex', jsonl_path: sessionFilePath }),
    });

    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage.used, 6);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

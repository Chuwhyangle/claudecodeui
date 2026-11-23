import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createCommandsRouter } from '../commands.routes.js';

/**
 * Stands in for `providerModelsService`. `resolveSessionModel` mirrors the real
 * precedence closely enough for the command handlers: a model recorded for the
 * session wins, otherwise the client's requested model, otherwise the catalog
 * default.
 */
function createModelsService(sessionModels: Record<string, string> = {}) {
  return {
    getProviderModels: async () => ({
      OPTIONS: [{ value: 'default', label: 'Default' }],
      DEFAULT: 'default',
    }),
    getCurrentActiveModel: async () => ({ model: 'default' }),
    setSessionModel: () => null,
    resolveSessionModel: async (
      provider: string,
      options: { sessionId?: string | null; requestedModel?: string | null } = {},
    ) => {
      const recorded = options.sessionId ? sessionModels[options.sessionId] : undefined;
      const model = recorded || options.requestedModel || 'default';
      return {
        provider,
        sessionId: options.sessionId ?? null,
        model,
        source: model === 'default' ? 'default' : 'session',
      };
    },
    resolveResumeModel: async () => undefined,
  };
}

/**
 * Stands in for the providers module's transcript reader. Defaults to "no
 * generated title", which is what every session that is not a Claude one with
 * a titled transcript answers.
 */
const noAiTitle = async () => null;

/**
 * The authoritative token-usage reader `/cost` goes through. Defaults to
 * "there is no reading for this session", which is the path that uses the
 * `context.tokenUsage` test-injection fallback; a case that exercises the real
 * data source passes its own reader and a conflicting live frame.
 */
type TokenUsageService = {
  getSessionTokenUsage: (sessionId: string) => Promise<Record<string, unknown> | null>;
};

const noAuthoritativeReading: TokenUsageService = {
  getSessionTokenUsage: async () => null,
};

async function executeCommand(
  commandName: string,
  context: Record<string, unknown>,
  sessionModels: Record<string, string> = {},
  aiTitles: (sessionId: string) => Promise<string | null> = noAiTitle,
  tokenUsage: TokenUsageService = noAuthoritativeReading,
): Promise<Record<string, unknown>> {
  const router = createCommandsRouter({
    fileSystem: {
      readFile: async () => JSON.stringify({ name: 'claude-code-ui', version: '0.0.0-test' }),
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService(sessionModels) as never,
    aiTitles: aiTitles as never,
    tokenUsage: tokenUsage as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName, context }),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('models command returns models only for the active provider using injected catalog', async () => {
  const result = await executeCommand('/models', { provider: 'codex' });
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(data.available as object), ['codex']);
});

test('models command falls back to claude for unsupported providers', async () => {
  const result = await executeCommand('/models', { provider: 'unknown-provider' });
  const data = result.data as { current: { provider: string } };
  assert.equal(data.current.provider, 'claude');
});

test('models command reports the model recorded for the session', async () => {
  const result = await executeCommand(
    '/models',
    { provider: 'claude', sessionId: 'session-1', model: 'sonnet' },
    { 'session-1': 'haiku' },
  );

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('models command reports the composer model for a chat with no session yet', async () => {
  const result = await executeCommand('/models', { provider: 'claude', model: 'haiku' });

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('cost and status commands report the same resolved model as /models', async () => {
  const context = { provider: 'claude', sessionId: 'session-1', model: 'sonnet' };
  const sessionModels = { 'session-1': 'haiku' };

  const cost = await executeCommand('/cost', context, sessionModels);
  const status = await executeCommand('/status', context, sessionModels);

  assert.equal((cost.data as { model: string }).model, 'haiku');
  assert.equal((status.data as { model: string }).model, 'haiku');
});

test('cost command reports the ai-title read for the session', async () => {
  const seen: string[] = [];
  const result = await executeCommand(
    '/cost',
    { provider: 'claude', sessionId: 'session-1' },
    {},
    async (sessionId) => {
      seen.push(sessionId);
      return 'Generated From The Chat';
    },
  );

  assert.deepEqual(seen, ['session-1'], 'the reader must be asked about this session');
  assert.equal((result.data as { aiTitle?: string }).aiTitle, 'Generated From The Chat');
});

test('cost command omits aiTitle when the session has none', async () => {
  const result = await executeCommand(
    '/cost',
    { provider: 'claude', sessionId: 'session-1' },
    {},
    async () => null,
  );

  assert.equal(
    Object.prototype.hasOwnProperty.call(result.data, 'aiTitle'),
    false,
    'an absent title must be an absent field, not a null the modal has to interpret',
  );
});

test('cost command does not ask for an ai-title without a session', async () => {
  const seen: string[] = [];
  const result = await executeCommand(
    '/cost',
    { provider: 'claude' },
    {},
    async (sessionId) => {
      seen.push(sessionId);
      return 'Generated From The Chat';
    },
  );

  assert.deepEqual(seen, [], 'a chat with no session row has no transcript to read');
  assert.equal(Object.prototype.hasOwnProperty.call(result.data, 'aiTitle'), false);
});

test('cost command still reports the derived view when the ai-title reader throws', async () => {
  const result = await executeCommand(
    '/cost',
    {
      provider: 'claude',
      sessionId: 'session-1',
      // The injected fallback reading (no authoritative reader in this case).
      tokenUsage: { contextOccupancy: { used: 120, total: 200 } },
    },
    {},
    async () => {
      throw new Error('transcript unreadable');
    },
  );

  const data = result.data as {
    cost: { context?: { used?: number; window?: number } };
    model: string;
    aiTitle?: string;
  };
  assert.equal(data.cost.context?.used, 120);
  assert.equal(data.cost.context?.window, 200);
  assert.equal(data.model, 'default');
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'aiTitle'), false);
});

test('cost command reads the session spend from sessionSpend and keeps the window separate', async () => {
  const tokenUsage = {
    sessionSpend: {
      inputTokens: 2_000,
      outputTokens: 400,
      cacheReadTokens: 1_500,
      reasoningOutputTokens: 150,
      totalTokens: 2_400,
    },
    contextOccupancy: { total: 258_400 },
    lastRequest: {
      inputTokens: 700,
      outputTokens: 120,
      cacheReadTokens: 500,
      reasoningOutputTokens: 60,
      totalTokens: 820,
    },
  };

  const result = await executeCommand('/cost', { provider: 'codex', sessionId: 'session-1', tokenUsage });
  const data = result.data as Record<string, any>;
  const cost = data.cost;

  // `sessionSpend` is the session total, so it lands in the session slot and
  // is never repeated as a context occupancy.
  assert.equal(cost.session.total, tokenUsage.sessionSpend.totalTokens);
  assert.equal(cost.context.used, undefined);
  // The window is an independent fact, never a denominator applied to `used`.
  assert.equal(cost.context.window, 258_400);
  assert.equal(cost.session.input, 2_000);
  assert.equal(cost.session.output, 400);
  assert.equal(cost.session.cacheRead, 1_500);
  assert.equal(cost.session.reasoningOutput, 150);
  // Server-derived: cached input over input, and the uncached remainder.
  assert.equal(cost.session.cacheHitRatio, 0.75);
  assert.equal(cost.session.fresh, 500);
  assert.deepEqual(cost.lastRequest, tokenUsage.lastRequest);
  // Detail reads stay detail: no second total is produced by adding them up.
  assert.equal(Object.keys(cost.session).some((key) => /percent|fraction/i.test(key)), false);
});

test('cost command omits unreported quantities instead of reporting zero', async () => {
  const result = await executeCommand('/cost', {
    provider: 'codex',
    sessionId: 'session-1',
    tokenUsage: {
      sessionSpend: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
    },
  });
  const data = result.data as Record<string, any>;
  const cost = data.cost;

  assert.equal(cost.session.total, 10);
  // The explicit zero survives, and the absent cache/reasoning reads do not
  // turn into zeros.
  assert.equal(cost.session.output, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(cost.session, 'cacheRead'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cost.session, 'cacheWrite'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cost.session, 'reasoningOutput'), false);
  // With no cache read reported there is no numerator, so no ratio or fresh row.
  assert.equal(cost.session.cacheHitRatio, undefined);
  assert.equal(cost.session.fresh, undefined);
  assert.equal(cost.lastRequest, undefined);
  // No window was reported, so the context block is absent rather than zeroed.
  assert.equal(cost.context, undefined);
});

test('cost command derives one provider-agnostic view for a context-scoped reading', async () => {
  // A Claude-shaped first-class reading: `sessionSpend` describes the whole
  // session and `contextOccupancy` the newest turn, so the two facts land in
  // different slots without a scope marker to tell them apart.
  const result = await executeCommand('/cost', {
    provider: 'claude',
    sessionId: 'session-1',
    tokenUsage: {
      sessionSpend: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 75,
        cacheWriteTokens: 5,
      },
      contextOccupancy: { used: 120, total: 200_000 },
      lastRequest: { inputTokens: 90, outputTokens: 15, cacheReadTokens: 60 },
    },
  });
  const data = result.data as Record<string, any>;
  const cost = data.cost;

  // The session total is the cumulative spend, never the newest-turn occupancy.
  assert.equal(cost.session.total, 100 + 20);
  assert.equal(cost.context.used, 120);
  assert.equal(cost.context.window, 200_000);
  // Ratio and fresh remainder are derived on the server from cache reads only.
  assert.equal(cost.session.cacheHitRatio, 0.75);
  assert.equal(cost.session.fresh, 100 - 75 - 5);
  assert.match(cost.accountingNote, /Input already includes cache reads and cache writes/);
  assert.deepEqual(cost.lastRequest, { inputTokens: 90, outputTokens: 15, cacheReadTokens: 60 });

  // The retired wire shape is gone, including the dual-meaning top-level fields.
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'used'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'scope'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'tokenUsage'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'tokenBreakdown'), false);
});

test('cost command passes cacheWrite through as a subset of input', async () => {
  const tokenUsage = {
    sessionSpend: {
      inputTokens: 2_000,
      outputTokens: 400,
      cacheReadTokens: 1_500,
      cacheWriteTokens: 300,
      totalTokens: 2_400,
    },
    contextOccupancy: { total: 258_400 },
    lastRequest: {
      inputTokens: 700,
      outputTokens: 120,
      cacheReadTokens: 500,
      cacheWriteTokens: 80,
      totalTokens: 820,
    },
  };

  const result = await executeCommand('/cost', { provider: 'claude', sessionId: 'session-1', tokenUsage });
  const data = result.data as Record<string, any>;

  // Both scopes carry their own written-to-cache quantity unchanged.
  assert.deepEqual(data.cost.lastRequest, tokenUsage.lastRequest);
  assert.equal(data.cost.session.cacheWrite, 300);
  assert.equal(data.cost.lastRequest.cacheWriteTokens, 80);
  // cacheWrite is a subset of input and is never folded into input or output as
  // another addend; it is only subtracted from the derived fresh remainder.
  assert.equal(data.cost.session.input, 2_000);
  assert.equal(data.cost.session.fresh, 2_000 - 1_500 - 300);
});

test('cost command omits cacheWrite when the reading never reported it', async () => {
  const result = await executeCommand('/cost', {
    provider: 'claude',
    sessionId: 'session-1',
    tokenUsage: {
      sessionSpend: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
    },
  });
  const data = result.data as Record<string, any>;

  assert.equal(
    Object.prototype.hasOwnProperty.call(data.cost.session, 'cacheWrite'),
    false,
    'an unreported cache write must stay absent, not print as zero',
  );
  assert.deepEqual(data.cost.session, {
    total: 10,
    input: 10,
    output: 0,
  });
});

test('cost command derives no session block from a context-semantic reading', async () => {
  const result = await executeCommand('/cost', {
    provider: 'claude',
    sessionId: 'session-1',
    tokenUsage: {
      // A context-semantic reading: no `sessionSpend`, no `usageScope`, just
      // the newest request and the window. The legacy flat counts are present
      // too, and must NOT be stitched into a session — that stitching is the
      // defect this shape removes.
      used: 120,
      total: 200_000,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      contextOccupancy: { used: 120, total: 200_000 },
    },
  });
  const data = result.data as Record<string, any>;
  const cost = data.cost;

  // No session data means no session block, not one assembled from request
  // counts. The context reading stands on its own.
  assert.equal(cost.session, undefined);
  assert.equal(cost.context.used, 120);
  assert.equal(cost.context.window, 200_000);
  assert.equal(cost.lastRequest, undefined);
  assert.equal(data.provider, 'claude');
});

test('cost command reads the authoritative session reading, never the injected live frame', async () => {
  const asked: string[] = [];
  const authoritative = {
    // The shape a Claude session's provider reader answers with: the newest
    // turn (437K) is the context occupancy, the whole session (118.5M) is the
    // spend. Only the session's own reader knows both.
    used: 437_000,
    total: 917_000,
    sessionSpend: {
      inputTokens: 100_000_000,
      outputTokens: 18_500_000,
      totalTokens: 118_500_000,
    },
    contextOccupancy: { used: 437_000, total: 917_000 },
  };
  const tokenUsage = {
    getSessionTokenUsage: async (sessionId: string) => {
      asked.push(sessionId);
      return authoritative;
    },
  };

  const result = await executeCommand(
    '/cost',
    {
      provider: 'claude',
      sessionId: 'session-1',
      // The composer's live frame, injected through the legacy context field.
      // It must not shadow the authoritative reading: its 437K is the newest
      // turn, not the session.
      tokenUsage: { used: 437_000, total: 917_000 },
    },
    {},
    noAiTitle,
    tokenUsage,
  );
  const data = result.data as Record<string, any>;
  const cost = data.cost;

  assert.deepEqual(asked, ['session-1'], 'the provider reader must be asked for this session');
  // The session total is the whole-session reading, not the newest turn.
  assert.equal(cost.session.total, 118_500_000);
  assert.equal(cost.context.used, 437_000);
  assert.equal(cost.context.window, 917_000);
});

test('cost passes the provider reading\'s current turn through to the panel untouched', async () => {
  const turn = {
    totalTokens: 1_234,
    inputTokens: 1_000,
    outputTokens: 234,
    cacheReadTokens: 800,
    cacheHitRatio: 0.8,
    fresh: 200,
    elapsedMs: 5_000,
    apiMs: 4_000,
    tps: 58.5,
    costUsd: 0.0042,
    calls: 3,
  };
  const tokenUsage = {
    sessionSpend: { inputTokens: 2_000, outputTokens: 400, totalTokens: 2_400 },
    contextOccupancy: { used: 1_234, total: 200_000 },
    turn,
  };

  const result = await executeCommand(
    '/cost',
    { provider: 'claude', sessionId: 'session-1' },
    {},
    noAiTitle,
    { getSessionTokenUsage: async () => tokenUsage },
  );
  const cost = (result.data as Record<string, any>).cost;

  assert.deepEqual(cost.turn, turn, 'the turn block is rendered, not re-derived');
});

test('a failed authoritative read keeps the browser turn from the fallback', async () => {
  const turn = { totalTokens: 500, inputTokens: 400, outputTokens: 100, elapsedMs: 2_000, tps: 50, calls: 1 };
  const failing = {
    getSessionTokenUsage: async () => {
      throw new Error('transcript unreadable');
    },
  };

  const result = await executeCommand(
    '/cost',
    {
      provider: 'claude',
      sessionId: 'session-1',
      // The composer's last reading, delivered by the browser.
      tokenUsage: { used: 500, total: 200_000, turn },
    },
    {},
    noAiTitle,
    failing,
  );
  const cost = (result.data as Record<string, any>).cost;

  assert.deepEqual(cost.turn, turn, 'the fallback keeps the turn the browser carried');
});

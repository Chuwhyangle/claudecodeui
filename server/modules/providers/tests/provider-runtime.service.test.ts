import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { IProvider, IProviderRuntime } from '@/shared/interfaces.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';
import type { LLMProvider, ProcessHost } from '@/shared/types.js';

function createRuntime(overrides: Partial<IProviderRuntime> = {}): IProviderRuntime {
  return {
    async run() {
      return undefined;
    },
    abort() {
      return false;
    },
    ...overrides,
  };
}

function createProvider(id: LLMProvider, runtime: IProviderRuntime): IProvider {
  return {
    id,
    runtime,
    auth: {
      async getStatus() {
        return {
          provider: id,
          installed: true,
          authenticated: true,
          method: 'test',
          details: {},
        };
      },
    },
    sessions: {
      normalizeMessage(raw: unknown, sessionId: string | null) {
        return [{ kind: 'assistant', content: String(raw), sessionId, provider: id }];
      },
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as IProvider;
}

function createService(providers: IProvider[]) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  return createProviderRuntimeService({
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: (sessionId) => sessionId ? `native-${sessionId}` : null,
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel?.trim() || undefined;
    },
    async getProviderModels() {
      return {
        OPTIONS: [],
        DEFAULT: 'default-model',
      };
    },
  });
}

test('providerRegistry owns one runtime for every registered provider', () => {
  const providers = providerRegistry.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), [
    'claude',
    'codex',
    'cursor',
    'opencode',
  ]);
  assert.equal(providers.every((provider) => typeof provider.runtime.run === 'function'), true);
  assert.equal(providers.every((provider) => typeof provider.runtime.abort === 'function'), true);
});

test('dispatches runs and aborts through the runtime owned by providerRegistry', async () => {
  const calls: unknown[][] = [];
  const runtime = createRuntime({
    async run(command, options, writer, context) {
      calls.push(['run', command, options, writer]);
      assert.equal(context.resolveProviderSessionId('session-1'), 'native-session-1');
      assert.equal(await context.resolveResumeModel('session-1', 'sonnet'), 'sonnet');
      assert.deepEqual(await context.getProviderModels(), { OPTIONS: [], DEFAULT: 'default-model' });
      assert.equal(context.normalizeMessage('hello', 'session-1')[0]?.provider, 'claude');
      assert.equal(await context.isProviderInstalled(), true);
      return 'complete';
    },
    async abort(sessionId) {
      calls.push(['abort', sessionId]);
      return true;
    },
  });
  const service = createService([createProvider('claude', runtime)]);
  const writer = { send() {} };

  assert.equal(service.hasRuntime('claude'), true);
  assert.equal(service.hasRuntime('unknown'), false);
  assert.equal(await service.getRunner('claude')('hello', { model: 'sonnet' }, writer), 'complete');
  assert.equal(await service.abort('claude', 'session-1'), true);
  assert.deepEqual(calls, [
    ['run', 'hello', { model: 'sonnet' }, writer],
    ['abort', 'session-1'],
  ]);
});

test('routes permission decisions through provider-owned runtime capabilities', () => {
  const decisions: unknown[][] = [];
  const claudeRuntime = createRuntime({
    permissions: {
      resolve(requestId, decision) {
        decisions.push([requestId, decision]);
      },
      listPending(sessionId) {
        return [{ requestId: 'request-1', sessionId }];
      },
    },
  });
  const service = createService([
    createProvider('claude', claudeRuntime),
    createProvider('cursor', createRuntime()),
  ]);
  const decision = { allow: true, message: 'approved' };

  service.resolveToolApproval('request-1', decision);

  assert.deepEqual(decisions, [['request-1', decision]]);
  assert.deepEqual(service.getPendingApprovalsForSession('session-1'), [
    { requestId: 'request-1', sessionId: 'session-1' },
  ]);
});

/**
 * Builds the gateway over a resident-shaped driver, so `startedQueuedCommands` can be asked the
 * questions only a real resident routing can answer.
 *
 * `driver` is the whole `hostDriver`, so one call can leave the verb out entirely; `hostDriver.run`
 * is what makes the entry a resident turn entry, and `claude`'s own declared `lifecycleModes`
 * (`['per-run','resident']`, read through the REAL capability table) is what lets the stored mode be
 * honoured. Only the mode and the live host are parameters, because those are the two facts that
 * decide whether a reading may be taken at all.
 */
function createResidentService(
  driver: Record<string, unknown>,
  options: { mode?: 'resident' | 'per-run'; live?: boolean; sessionId?: string } = {},
) {
  const sessionId = options.sessionId ?? 'session-1';
  const provider = createProvider('claude', createRuntime());
  (provider as unknown as Record<string, unknown>).hostDriver = driver;
  return createProviderRuntimeService({
    listProviders: () => [provider],
    resolveProvider: () => provider,
    resolveProviderSessionId: (id) => (id ? `native-${id}` : null),
    resolveSessionLifecycleMode: () => options.mode ?? 'resident',
    sessionHostManager: {
      liveHostForSession: (id: string): ProcessHost | null =>
        (options.live ?? true) && id === sessionId ? ({ pid: 4242 } as ProcessHost) : null,
    } as unknown as SessionHostManager,
  });
}

/**
 * THE COMMAND LIFECYCLE READING — the fence's source for "the resident process already dequeued
 * this sentence" (SPEC §18.3 R-4.3), and the sibling of `pendingQueuedInputs` over the same driver
 * record.
 *
 * Two things are pinned. First, the reading really travels: driver → gateway → caller, as a COPY
 * (a caller must not be able to reach back into host state), for a session the driver hosts. Second,
 * `null` is the answer to every way it cannot be taken — a session that is not resident, a host that
 * is gone, a driver with no such verb, a driver that throws — because a caller must read those as
 * "cannot say" rather than as "nothing has started".
 *
 * AND THE EMPTY LIST IS NOT ONE OF THEM. A live process that has dequeued nothing answers `[]`, and
 * `[]` is a reading; collapsing it into the same `null` as an unreadable host is exactly the
 * conflation the two answers exist to keep apart (the composition root's `hostCommandLifecycle` seam
 * depends on it — `server/index.ts`).
 */
test('reads the resident command lifecycle through the driver, and answers null for every "cannot say"', () => {
  const started = ['cmd-1', 'cmd-2'];
  const reading = createResidentService({
    async run() {
      return undefined;
    },
    startedQueuedCommands(sessionId: string): readonly string[] | null {
      return sessionId === 'session-1' ? started : null;
    },
  });

  assert.deepEqual(
    reading.startedQueuedCommands('claude', 'session-1'),
    ['cmd-1', 'cmd-2'],
    'the driver`s own dequeued list reaches the caller',
  );
  assert.deepEqual(
    reading.startedQueuedCommands('claude', 'session-1'),
    ['cmd-1', 'cmd-2'],
    'and again — the reading is repeatable, not consumed by the first call',
  );
});

test('the command lifecycle reading is a detached copy, not the driver`s own array', () => {
  const started = ['cmd-1'];
  const reading = createResidentService({
    async run() {
      return undefined;
    },
    startedQueuedCommands(): readonly string[] | null {
      return started;
    },
  });

  const first = reading.startedQueuedCommands('claude', 'session-1') as string[];
  first.push('cmd-injected');
  assert.deepEqual(started, ['cmd-1'], 'a caller cannot reach into host state through the reading');
  assert.deepEqual(reading.startedQueuedCommands('claude', 'session-1'), ['cmd-1']);
});

test('the command lifecycle reading answers an EMPTY list for a live host that dequeued nothing — not null', () => {
  const reading = createResidentService({
    async run() {
      return undefined;
    },
    startedQueuedCommands(): readonly string[] | null {
      return [];
    },
  });

  assert.deepEqual(
    reading.startedQueuedCommands('claude', 'session-1'),
    [],
    'a real reading of an idle queue, distinct from the `null` below',
  );
});

test('the command lifecycle reading answers null for a session that is not resident, a host that is gone, a driver without the verb, and a driver that throws', () => {
  const withVerb = {
    async run() {
      return undefined;
    },
    startedQueuedCommands(): readonly string[] | null {
      return ['cmd-1'];
    },
  };
  const withoutVerb = {
    async run() {
      return undefined;
    },
  };
  const throwing = {
    async run() {
      return undefined;
    },
    startedQueuedCommands(): readonly string[] | null {
      throw new Error('the host is unreachable');
    },
  };

  assert.equal(
    createResidentService(withVerb, { mode: 'per-run' }).startedQueuedCommands('claude', 'session-1'),
    null,
    'a per-run session has no `command_lifecycle` to read',
  );
  assert.equal(
    createResidentService(withVerb, { live: false }).startedQueuedCommands('claude', 'session-1'),
    null,
    'a host that is gone answers nothing rather than an empty queue',
  );
  assert.equal(
    createResidentService(withoutVerb).startedQueuedCommands('claude', 'session-1'),
    null,
    'a driver that carries no such verb cannot answer',
  );
  assert.equal(
    createResidentService(throwing).startedQueuedCommands('claude', 'session-1'),
    null,
    'a throw is a "cannot say", never an empty reading',
  );
  assert.equal(
    createResidentService(withVerb).startedQueuedCommands('claude', 'another-session'),
    null,
    'a session the driver is not hosting is answered by the driver itself, and reaches the caller as null',
  );
});

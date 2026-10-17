/**
 * AC-234 criterion — the run source is recorded from what the caller *is*, not
 * inferred from whether a socket happens to be attached.
 *
 * The claim, and the reading each half is graded on:
 *
 *   (a) a run the control service dispatches for `via: 'mcp'` is recorded
 *       `source === 'mcp'`;
 *   (b) a run it dispatches for `via: 'websocket'` is recorded `'user'`, and
 *       one for `via: 'scheduled'` is recorded `'scheduled'` — read on separate
 *       sessions;
 *   (c) a run the host layer opens (`openUnattendedRun`) is still `'unattended'`;
 *   (d) `startRun` called with no source keeps its old default verbatim — a
 *       connection means `'user'`, no connection means `'scheduled'`;
 *   (e) `ChatRunSource` really contains `'mcp'`, proven by the exhaustive
 *       `Record<ChatRunSource, true>` below, which `npm run typecheck` rejects
 *       the moment the union gains or loses a member.
 *
 * The `via`→source mapping is *load-bearing*, and the fixture makes that
 * visible: `send` always dispatches with `ws = null` and a null connection
 * override, so a run filed by the connection-derived default could only ever be
 * `'scheduled'`. Readings (a) and (b) therefore cannot pass on the old default;
 * they pass only because the control service states the source explicitly.
 *
 * No `WebSocket` is ever built and no socket is attached: the transport-free
 * control entry and the registry are exercised directly. The fixture mirrors
 * `chat-control-send.test.ts` (a temporary `DATABASE_PATH` + `initializeDatabase`
 * + `sessionsDb.createSession` with an injected, controllable runtime gateway),
 * with the one addition of a minimal in-memory connection object for reading
 * (d) — a plain object with `readyState`/`send`, not a socket.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createChatControlService } from '@/modules/websocket/services/chat-control.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import type {
  AnyRecord,
  ChatRunSource,
  LLMProvider,
  RealtimeClientConnection,
} from '@/shared/types.js';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`control-source ${line}`);
}

/**
 * Exhaustive fixture over `ChatRunSource` — reading (e).
 *
 * A `Record<ChatRunSource, true>` lists every union member by construction, so
 * `npm run typecheck` fails if the union and this constant disagree. That is
 * what makes `'mcp'` a *checked* member of the type rather than a string some
 * call site happens to use.
 */
const _exhaustive: Record<ChatRunSource, true> = {
  user: true,
  scheduled: true,
  unattended: true,
  mcp: true,
  voice: true,
};

/**
 * A minimal in-memory connection for reading (d): the two members
 * `RealtimeClientConnection` requires, and nothing that stands in for a live
 * socket. The default arm only needs "a connection exists", so no frame is ever
 * sent through it here.
 */
class FakeConnection implements RealtimeClientConnection {
  readyState = 1;
  send(_data: string): void {
    // Intentionally unused: no event is emitted in this criterion.
  }
}

/** The session ids this criterion reads, one run per session so the reads never race. */
const MCP_SESSION = 'control-source-mcp';
const WEBSOCKET_SESSION = 'control-source-websocket';
const SCHEDULED_SESSION = 'control-source-scheduled';
const UNATTENDED_SESSION = 'control-source-unattended';
const DEFAULT_WITH_CONNECTION_SESSION = 'control-source-default-connection';
const DEFAULT_NO_CONNECTION_SESSION = 'control-source-default-no-connection';

/**
 * A runtime gateway that parks every run until the harness releases it, so the
 * run stays `running` and its recorded source is read as a stable state rather
 * than after a background completion. `hasRuntime` is always true: this
 * criterion never drives the unsupported-provider arm.
 */
type ParkingRuntime = {
  /** Releases every parked run so no promise is left pending across the file. */
  releaseAll(): void;
  runtime: ProviderRuntimeGateway;
};

function createParkingRuntime(): ParkingRuntime {
  const parked: Array<(value?: unknown) => void> = [];
  const state: ParkingRuntime = {
    releaseAll: () => {
      while (parked.length > 0) {
        parked.pop()?.();
      }
    },
    runtime: null as unknown as ProviderRuntimeGateway,
  };

  state.runtime = {
    hasRuntime: () => true,
    run: (_provider: LLMProvider, _command: string, _options: AnyRecord) =>
      new Promise<unknown>((resolve) => {
        parked.push(resolve);
      }),
    abort: async () => false,
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
  };

  return state;
}

/**
 * Boots the control service against an isolated database with one row per
 * session this criterion reads and the parking runtime. No socket is created.
 */
async function withHarness(
  run: (context: {
    control: ReturnType<typeof createChatControlService>;
    runtime: ParkingRuntime;
  }) => Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-control-source-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  let runtime: ParkingRuntime | undefined;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    for (const sessionId of [
      MCP_SESSION,
      WEBSOCKET_SESSION,
      SCHEDULED_SESSION,
      UNATTENDED_SESSION,
      DEFAULT_WITH_CONNECTION_SESSION,
      DEFAULT_NO_CONNECTION_SESSION,
    ]) {
      sessionsDb.createSession(sessionId, 'claude', tempDirectory, `Source ${sessionId}`, now, now, null);
    }

    runtime = createParkingRuntime();
    const control = createChatControlService({ runtime: runtime.runtime });

    await run({ control, runtime });
  } finally {
    runtime?.releaseAll();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// ------------------------------------------------------- (a) + (b) -------------
test('the control service records each caller.via as its own run source', async () => {
  await withHarness(async ({ control }) => {
    // (a) A run opened through the MCP gateway. `send` dispatches with no
    // connection, so 'mcp' can only come from the explicit mapping.
    const mcp = await control.send({ userId: 1, via: 'mcp' }, { sessionId: MCP_SESSION, content: 'from mcp' });
    const mcpSource = chatRunRegistry.getRun(MCP_SESSION)?.source;
    say(`(a) mcp: result=${JSON.stringify({ ok: mcp.ok })} source=${mcpSource}`);
    assert.ok(mcp.ok, `an MCP send must register a run (got ${JSON.stringify(mcp)})`);
    assert.equal(mcpSource, 'mcp', 'an MCP-dispatched run must be recorded as mcp');

    // (b) The same entry, WebSocket and scheduled fronts. Each on its own
    // session so the two reads cannot collide.
    const web = await control.send(
      { userId: 1, via: 'websocket' },
      { sessionId: WEBSOCKET_SESSION, content: 'from a socket' },
    );
    const webSource = chatRunRegistry.getRun(WEBSOCKET_SESSION)?.source;
    assert.ok(web.ok, `a WebSocket send must register a run (got ${JSON.stringify(web)})`);

    const scheduled = await control.send(
      { userId: 1, via: 'scheduled' },
      { sessionId: SCHEDULED_SESSION, content: 'from a timer' },
    );
    const scheduledSource = chatRunRegistry.getRun(SCHEDULED_SESSION)?.source;
    say(`(b) websocket=${webSource} scheduled=${scheduledSource}`);
    assert.ok(scheduled.ok, `a scheduled send must register a run (got ${JSON.stringify(scheduled)})`);
    assert.equal(webSource, 'user', 'a WebSocket-dispatched run must be recorded as user');
    assert.equal(scheduledSource, 'scheduled', 'a scheduled-dispatched run must be recorded as scheduled');
  });
});

// ------------------------------------------------------------ (c) --------------
test('a host-opened run is still recorded unattended', async () => {
  await withHarness(async () => {
    const handle = chatRunRegistry.openUnattendedRun({
      appSessionId: UNATTENDED_SESSION,
      provider: 'claude',
      providerSessionId: null,
      userId: 1,
    });
    const source = chatRunRegistry.getRun(UNATTENDED_SESSION)?.source;
    say(`(c) unattended: opened=${handle !== null} source=${source}`);
    assert.ok(handle, 'openUnattendedRun must register a run');
    assert.equal(source, 'unattended', 'a host-opened run must stay unattended');
  });
});

// ------------------------------------------------------------ (d) --------------
test('startRun with no source keeps its old default: connection => user, none => scheduled', async () => {
  await withHarness(async () => {
    const withConnection = chatRunRegistry.startRun({
      appSessionId: DEFAULT_WITH_CONNECTION_SESSION,
      provider: 'claude',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: 1,
      // No `source`: this is the existing-caller shape.
    });
    assert.ok(withConnection, 'startRun must register when a connection is present');

    const withoutConnection = chatRunRegistry.startRun({
      appSessionId: DEFAULT_NO_CONNECTION_SESSION,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: 1,
      // No `source` either.
    });
    assert.ok(withoutConnection, 'startRun must register with no connection');

    say(`(d) defaultWithConnection=${withConnection.source} defaultNoConnection=${withoutConnection.source}`);
    assert.equal(withConnection.source, 'user', 'the old default records a connected run as user');
    assert.equal(withoutConnection.source, 'scheduled', 'the old default records an unconnected run as scheduled');
  });
});

// ------------------------------------------------------------ (e) --------------
test('(e) ChatRunSource contains mcp, proven by the exhaustive fixture', () => {
  const members = Object.keys(_exhaustive).sort();
  say(`(e) exhaustiveMembers=${JSON.stringify(members)}`);
  assert.deepEqual(
    members,
    ['mcp', 'scheduled', 'unattended', 'user', 'voice'],
    'ChatRunSource must carry mcp and the Live Voice origin alongside the three pre-existing values',
  );
});

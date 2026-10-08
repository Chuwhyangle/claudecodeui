/**
 * The shared rig for the `ui_*` navigation-tool criteria
 * (gap-mcp-ui-focus-turn-show-diff-open-task).
 *
 * `ui_open_session`, `ui_focus_turn`, `ui_show_diff` and `ui_open_task` run the
 * SAME body ({@link ./mcp-ui-navigation.js}'s `buildUiNavigation`) and differ only
 * in the target they reveal, so their criteria share this rig rather than copying
 * it four times: the real navigation service over fake browsers, the principal
 * factory, the refusal assert, and the real `/mcp` mount that drives the transport
 * scope check. Each tool's own `*.test.ts` adds the legs that read ITS target.
 *
 * The module is NOT a `*.test.ts`, so the runner never executes it directly; the
 * criteria import its bindings.
 *
 * The environment is set at module load and every application module is pulled in
 * dynamically AFTER it, because `auth.middleware.ts` resolves the JWT secret at
 * module-load time and `shared/utils.ts` freezes IS_PLATFORM on first import. A
 * criterion therefore imports THIS module first, then `await import`s its own tool
 * module.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type {
  AnyRecord,
  RealtimeClientConnection,
  UiClientDevice,
  UiNavigationAck,
  UiNavigationRecord,
} from '@/shared/types.js';
import type { McpPrincipal } from '../mcp-gateway.auth.js';
import type { UiNavigationRateLimiter, UiNavigationToolDeps } from '../mcp-ui-navigation.js';
import type { McpUiVisibleContextDeps } from '../mcp-ui-visible-context.js';
import type { UiNavigationService } from '@/modules/websocket/index.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased application module is pulled in.
process.env.JWT_SECRET = 'mcp-ui-navigation-harness-secret';
delete process.env.VITE_IS_PLATFORM;

// The audited wrapper writes one `mcp_audit_log` row per call, so the mount leg
// needs a database with the CURRENT schema.
const dbDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-ui-navigation-'));
process.env.DATABASE_PATH = path.join(dbDirectory, 'audit.db');

export const { accessTokensDb, closeConnection, getConnection, initializeDatabase, oauthClientsDb } =
  await import('@/modules/database/index.js');
await initializeDatabase();

export const { ACCESS_TOKEN_SCOPES } = await import('@/modules/oauth/index.js');
export const {
  createUiNavigationService,
  WS_OPEN_STATE,
  UI_NAVIGATION_MAX_RECORDS,
  UI_NAVIGATION_RETENTION_MS,
} = await import('@/modules/websocket/index.js');
export const { buildUiVisibleContext } = await import('../mcp-ui-visible-context.js');
export const { MCP_ERROR_CODES, McpToolError } = await import('../mcp-error-envelope.js');
export const { MCP_GATEWAY_PATH, MCP_STAGE4_WRITE_TOOLS, mountMcpGateway } = await import('../index.js');
// The ONE principal-name resolution and its fixed labels, imported so a criterion
// can assert the bar's requester is that resolution's output, not a test-local echo.
export const { MCP_CLIENT_NAME_MAX_LENGTH, PERSONAL_TOKEN_LABEL } = await import(
  '../mcp-write-notification.js'
);

/** `navigate` is the sixth scope, appended last so the five positional reads keep their index. */
export const NAVIGATE_SCOPE = ACCESS_TOKEN_SCOPES[5] as string;

/** The temporary database the mount leg writes its audit rows into; a criterion removes it in `after`. */
export const HARNESS_DB_DIRECTORY = dbDirectory;

/** Closes the database connection and removes the temporary directory. A criterion calls this in `after`. */
export function cleanupHarness(): void {
  closeConnection();
  rmSync(dbDirectory, { recursive: true, force: true });
}

/** A principal as the transport hands it to the handler. */
export function principal(overrides: Partial<McpPrincipal> = {}): McpPrincipal {
  return { userId: 1, tokenId: 1, clientId: 'client-1', scopes: [...ACCESS_TOKEN_SCOPES], ...overrides };
}

/** The tool error as a TYPE, since {@link McpToolError} is imported as a value. */
export type ToolError = InstanceType<typeof McpToolError>;

/** Asserts a rejected build is an {@link McpToolError} with `code`, returning it. */
export async function refusal(run: () => Promise<unknown>, code: string): Promise<ToolError> {
  let captured: ToolError | null = null;
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof McpToolError, `expected an McpToolError, got ${String(error)}`);
    assert.equal(error.code, code, `expected code ${code}`);
    captured = error;
    return true;
  });
  assert.ok(captured !== null, 'assert.rejects must have produced a tool error');
  return captured;
}

// =====================================================================
// the in-process rig: the real navigation service over fake browsers
// =====================================================================

/** One fake browser tab: the connection the server writes to, and what it answers with. */
export type FakeTab = {
  /** The identity the registry announced for this tab. */
  identity: { deviceId: string; tabId: string; deviceName: string };
  /** When this tab's identity reached the server, ordering a device's tabs. */
  connectedAt: number;
  /** The live connection; `readyState` follows {@link FakeTab.closed}. */
  connection: RealtimeClientConnection;
  /** Every `ui.navigate` frame the server wrote to this tab, in order. */
  frames: AnyRecord[];
  /** The delivery ack this tab answers with; null makes it silent (the timeout arm). */
  ack: UiNavigationAck | null;
  /** A closed tab is never written to and never acks. */
  closed: boolean;
};

/** One fake tab with a live connection object. */
export function makeTab(
  identity: FakeTab['identity'],
  overrides: Partial<Pick<FakeTab, 'connectedAt' | 'ack' | 'closed'>> = {},
): FakeTab {
  const tab: FakeTab = {
    identity,
    connectedAt: overrides.connectedAt ?? 1,
    frames: [],
    // `overrides.ack ?? 'applied'` would turn an explicit null (the silent arm)
    // back into 'applied'; the property's PRESENCE is what selects the default.
    ack: 'ack' in overrides ? overrides.ack ?? null : 'applied',
    closed: overrides.closed ?? false,
    connection: { readyState: WS_OPEN_STATE, send: () => undefined },
  };
  tab.connection.readyState = tab.closed ? 3 : WS_OPEN_STATE;
  return tab;
}

/** The rig: the fake browsers, the real service, and the deps the tool is built from. */
export type Rig = {
  tabs: FakeTab[];
  service: UiNavigationService;
  deps: UiNavigationToolDeps;
  /** The roster the tool resolves `client` against, built from the tabs. */
  listUiClients: () => UiClientDevice[];
};

/** The roster, built from the tabs the way the real registry builds it. */
export function roster(tabs: FakeTab[]): UiClientDevice[] {
  const byDevice = new Map<string, UiClientDevice>();
  for (const tab of tabs) {
    let device = byDevice.get(tab.identity.deviceId);
    if (!device) {
      device = { deviceId: tab.identity.deviceId, deviceName: tab.identity.deviceName, tabs: [] };
      byDevice.set(tab.identity.deviceId, device);
    }
    device.tabs.push({
      tabId: tab.identity.tabId,
      deviceName: tab.identity.deviceName,
      connectedAt: tab.connectedAt,
    });
  }
  for (const device of byDevice.values()) {
    device.tabs.sort((left, right) => left.connectedAt - right.connectedAt);
  }
  return [...byDevice.values()];
}

/**
 * Builds a rig over the real navigation service.
 *
 * The `send` seam records the frame on the tab and, for a responding tab, acks it
 * on a microtask through the service's own `handleAck` — the same asynchronous
 * shape a real browser has, so "return at the delivery ack" is exercised rather
 * than "return synchronously". A silent tab records the frame and never answers,
 * which is what drives the timeout arm.
 */
export function createRig(
  tabs: FakeTab[],
  options: {
    recordApplied?: (sessionId: string, at: number) => void;
    now?: () => number;
    rateLimiter?: UiNavigationRateLimiter;
  } = {},
): Rig {
  const now = options.now ?? (() => Date.now());
  let service!: UiNavigationService;
  service = createUiNavigationService({
    listTargets: (deviceId) =>
      tabs
        .filter((tab) => tab.identity.deviceId === deviceId)
        .map((tab) => ({ connection: tab.connection, ...tab.identity, connectedAt: tab.connectedAt })),
    now,
    recordApplied: options.recordApplied,
    send: (connection, frame) => {
      const tab = tabs.find((candidate) => candidate.connection === connection);
      if (!tab) {
        return;
      }
      const written = frame as AnyRecord;
      tab.frames.push(written);
      if (tab.ack === null) {
        return;
      }
      const status = tab.ack;
      queueMicrotask(() => {
        service.handleAck(connection, {
          type: 'ui.navigate_ack',
          navigationId: written.navigationId,
          deviceId: tab.identity.deviceId,
          tabId: tab.identity.tabId,
          status,
        });
      });
    },
  });

  const listUiClients = (): UiClientDevice[] => roster(tabs);
  return {
    tabs,
    service,
    listUiClients,
    deps: {
      listUiClients,
      navigate: (request) => service.navigate(request),
      rateLimiter: options.rateLimiter,
    },
  };
}

/** The `navigations[]` reading, built exactly as the server builds it (the rig's log). */
export async function visibleNavigations(rig: Rig): Promise<AnyRecord[]> {
  const contextDeps: McpUiVisibleContextDeps = {
    listUiClients: rig.listUiClients,
    requestUiState: async () => [],
    listNavigations: (navigationId) => rig.service.listNavigations(navigationId),
  };
  const context = await buildUiVisibleContext(contextDeps, {});
  return context.navigations as unknown as AnyRecord[];
}

// =====================================================================
// the real `/mcp` mount: the transport scope check and the absent guard
// =====================================================================

/** The SDK client's `fetch`, over `node:http`, so a port undici refuses cannot red these criteria. */
export const nodeFetch: FetchLike = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(String(url));
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const body = init?.body === undefined || init?.body === null ? null : String(init.body);

    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders.set(key, value);
            } else if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(key, entry);
              }
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: responseHeaders }));
        });
      },
    );
    request.on('error', reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });

/** A live gateway write tool on the target session — the maximal self-target turn. */
const LIVE_SELF_TARGET_TURN = {
  phase: 'tool' as const,
  toolName: 'mcp__anything__session_send',
  toolDurationMs: 5,
};

/**
 * Boots one real `/mcp` mount with ONE navigation tool wired to a recorder, behind
 * a principal stamped with `scopes`. The self-target guard is configured with this
 * very tool in its write-tool set and a LIVE tool turn on the target — the maximal
 * setup a guard would need to refuse it — so a call that is not refused proves the
 * tool is deliberately outside both the protected-op set and the `protect` wrapper.
 *
 * `depsKey` is the write-tools deps field this tool reads (`uiFocusTurn`, …);
 * `toolName` is the name the client calls.
 */
export async function withNavigationGateway(options: {
  toolName: string;
  depsKey: string;
  navigate?: (request: {
    deviceId: string;
    deviceName: string;
    sessionId: string;
    at: unknown;
    requestedBy: string | null;
  }) => Promise<UiNavigationRecord>;
  scopes: readonly string[];
  run: (call: (args: AnyRecord) => Promise<AnyRecord>, navigateCalls: AnyRecord[]) => Promise<void>;
}): Promise<void> {
  const navigateCalls: AnyRecord[] = [];
  const authorize: RequestHandler = (_req, res, next) => {
    res.locals.mcpPrincipal = { userId: 1, tokenId: 1, clientId: 'client-1', scopes: [...options.scopes] };
    next();
  };
  const navigate =
    options.navigate ??
    (async (request) => {
      navigateCalls.push({ ...request });
      return {
        navigationId: 'nav-1',
        deviceId: request.deviceId,
        deviceName: request.deviceName,
        tabId: 't-1',
        sessionId: request.sessionId,
        at: request.at as UiNavigationRecord['at'],
        requestedBy: request.requestedBy,
        requestedAt: 1,
        updatedAt: 1,
        status: 'applied',
      };
    });
  const deps: UiNavigationToolDeps = {
    listUiClients: () => [
      { deviceId: 'dev-1', deviceName: 'Laptop', tabs: [{ tabId: 't-1', deviceName: 'Laptop', connectedAt: 1 }] },
    ],
    navigate,
  };

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize,
    writeTools: { [options.depsKey]: deps } as never,
    selfTarget: {
      readTurn: () => LIVE_SELF_TARGET_TURN,
      writeToolNames: [...MCP_STAGE4_WRITE_TOOLS.map((tool) => tool.name), options.toolName],
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`), {
    fetch: nodeFetch,
  });
  // Never lists tools, so the SDK's output-validator cache stays cold and an error
  // envelope (which does not match the tool's output schema) is returned rather
  // than thrown as `-32602`.
  const client = new Client({ name: 'ui-navigation-probe', version: '0.0.0' });
  await client.connect(transport);

  try {
    await options.run(async (args) => {
      const result = await client.callTool({
        name: options.toolName,
        arguments: args,
      } as Parameters<Client['callTool']>[0]);
      return result as unknown as AnyRecord;
    }, navigateCalls);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

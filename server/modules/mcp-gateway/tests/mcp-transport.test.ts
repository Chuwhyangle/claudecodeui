import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express, { type RequestHandler, type Response } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import ts from 'typescript';

import { createStaticAssetsMiddleware } from '@/modules/static-assets/index.js';

import { MCP_GATEWAY_PATH, mountMcpGateway } from '../index.js';

/**
 * The criterion for AC-240: `/mcp` is a STATELESS Streamable HTTP endpoint,
 * gated by `MCP_ENABLED` (default off), mounted before the static-assets
 * middleware so it answers JSON-RPC rather than the SPA's `text/html`.
 *
 * The readings, and why each needs its own leg:
 *
 *  - **(a) statelessness.** Two `tools/list` requests from one client, neither
 *    sending an `Mcp-Session-Id`, both succeeding with a `result`, and NEITHER
 *    response minting a session id. A stateful transport would either demand an
 *    `initialize` first or hand back a session id; this leg moves when the
 *    transport stops being stateless.
 *  - **(b) the answer is JSON-RPC, not the shell.** The gateway is mounted with
 *    the REAL static-assets middleware behind it, exactly as `server/index.ts`
 *    assembles them, so "not `text/html`" is measured against the SPA catch-all
 *    the endpoint must precede rather than asserted in a vacuum.
 *  - **(c) the gate decides at mount time.** Off means the path is ABSENT — a
 *    404, not a 401 and not a 200 — and the same `mountMcpGateway` with
 *    `MCP_ENABLED=true` turns it back into a real endpoint (positive control).
 *  - **(d) mount order is read off the real `server/index.ts`** with the
 *    TypeScript parser, not restated by hand, plus a reversed synthetic source
 *    fed to the same scanner so the scanner is shown to be sensitive to order.
 *  - **(e) the SDK recipe still runs on this repo's express 4.21.** The SDK's
 *    `mcpAuthRouter` (with a minimal in-memory provider) and the stateless
 *    transport are mounted on a real express app and read over real HTTP, so an
 *    SDK/express incompatibility surfaces here rather than at runtime.
 *
 * Requests go over `node:http`, never `fetch`: undici refuses a fixed list of
 * ports and this host hands out ephemeral ports across the whole 1024–65535
 * range, so `listen(0)` lands on a refused port often enough to red a suite run
 * at random. `node:http` has no such list.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const INDEX_PATH = path.join(REPO_ROOT, 'server', 'index.ts');

/** The transport measured alone: AC-241 owns real token auth and replaces this. */
const passthrough: RequestHandler = (_req, _res, next) => next();

/** The Accept a Streamable HTTP client must send; without it the transport answers 406. */
const MCP_ACCEPT = 'application/json, text/event-stream';

type HttpReading = {
  label: string;
  method: string;
  requestPath: string;
  status: number;
  contentType: string | null;
  /** The `Mcp-Session-Id` this client SENT, or null. */
  requestSessionId: string | null;
  /** The `Mcp-Session-Id` the server ANSWERED with, or null. */
  responseSessionId: string | null;
  body: string;
  bodyHead: string;
};

type Exchange = { reading: HttpReading; json: Record<string, unknown> | null };

// --------------------------- HTTP ---------------------------

function request(
  baseUrl: string,
  method: string,
  requestPath: string,
  options: { label: string; body?: unknown; accept?: string; headers?: Record<string, string> } = { label: '' },
): Promise<Exchange> {
  const url = new URL(requestPath, baseUrl);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers: Record<string, string> = { ...options.headers };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (options.accept) {
    headers.accept = options.accept;
  }

  return new Promise<Exchange>((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          const reading: HttpReading = {
            label: options.label,
            method,
            requestPath,
            status: res.statusCode ?? 0,
            contentType: (res.headers['content-type'] as string | undefined) ?? null,
            requestSessionId: (headers['mcp-session-id'] as string | undefined) ?? null,
            responseSessionId: (res.headers['mcp-session-id'] as string | undefined) ?? null,
            body,
            bodyHead: body.slice(0, 120).replace(/\s+/g, ' '),
          };
          resolve({ reading, json: parseJsonRpc(body, reading.contentType) });
        });
      },
    );

    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

/** A JSON-RPC envelope from either wire shape: a JSON body or an SSE `data:` frame. */
function parseJsonRpc(body: string, contentType: string | null): Record<string, unknown> | null {
  let text = body;
  if ((contentType ?? '').includes('text/event-stream')) {
    const dataLine = body.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return null;
    }
    text = dataLine.slice('data:'.length).trim();
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hasResult(exchange: Exchange): boolean {
  return exchange.json !== null && 'result' in exchange.json;
}

function isJsonRpcContentType(contentType: string | null): boolean {
  const value = contentType ?? '';
  return value.includes('application/json') || value.includes('text/event-stream');
}

function toolsListRequest(baseUrl: string, label: string, id: number): Promise<Exchange> {
  return request(baseUrl, 'POST', MCP_GATEWAY_PATH, {
    label,
    accept: MCP_ACCEPT,
    body: { jsonrpc: '2.0', id, method: 'tools/list', params: {} },
  });
}

function describeHttp(reading: HttpReading): string {
  return `[${reading.label}] ${reading.method} ${reading.requestPath} -> ${reading.status} ${reading.contentType ?? '<no content-type>'} reqSessionId=${reading.requestSessionId ?? '<none>'} resSessionId=${reading.responseSessionId ?? '<none>'} :: ${JSON.stringify(reading.bodyHead)}`;
}

async function listen(app: express.Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Mounts the REAL static layer (SPA catch-all) the way `server/index.ts` does. */
function mountStaticLayer(app: express.Express): { scratch: string; cleanup: () => void } {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'mcp-transport-static-'));
  writeFileSync(path.join(scratch, 'index.html'), '<!doctype html><title>spa shell</title>');
  app.use(
    createStaticAssetsMiddleware({
      distDir: scratch,
      publicDir: scratch,
      onMissingIndex: (_req, res) => res.status(500).send('no built index'),
    }),
  );

  return { scratch, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

// --------------------------- (d) mount-order scanner ---------------------------

type MountOrderReading = {
  mountFound: boolean;
  staticMountFound: boolean;
  mountLine: number | null;
  staticLine: number | null;
  mountBeforeStatic: boolean;
};

/**
 * Reads `server/index.ts` (or any source) and decides whether the
 * `mountMcpGateway` call precedes the `app.use(createStaticAssetsMiddleware(...))`
 * call. Pure over its argument so the negative control can feed it a reversed
 * synthetic source and the same code must flag it.
 */
function checkMountOrder(sourceText: string): MountOrderReading {
  const sourceFile = ts.createSourceFile('mount-order.ts', sourceText, ts.ScriptTarget.Latest, true);
  let mountPosition: number | null = null;
  let staticPosition: number | null = null;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (mountPosition === null && ts.isIdentifier(node.expression) && node.expression.text === 'mountMcpGateway') {
        mountPosition = node.getStart(sourceFile);
      }

      const wrapsStaticMiddleware =
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'use' &&
        node.arguments.some(
          (argument) =>
            ts.isCallExpression(argument) &&
            ts.isIdentifier(argument.expression) &&
            argument.expression.text === 'createStaticAssetsMiddleware',
        );
      if (staticPosition === null && wrapsStaticMiddleware) {
        staticPosition = node.getStart(sourceFile);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const mount = mountPosition;
  const staticCall = staticPosition;
  const lineOf = (position: number | null): number | null =>
    position === null ? null : sourceFile.getLineAndCharacterOfPosition(position).line + 1;

  return {
    mountFound: mount !== null,
    staticMountFound: staticCall !== null,
    mountLine: lineOf(mount),
    staticLine: lineOf(staticCall),
    mountBeforeStatic: mount !== null && staticCall !== null && mount < staticCall,
  };
}

/** The reversed order the scanner must reject: the static mount comes first. */
const REVERSED_MOUNT_SOURCE = [
  "import express from 'express';",
  "import { createStaticAssetsMiddleware } from './modules/static-assets/index.js';",
  "import { mountMcpGateway } from './modules/mcp-gateway/index.js';",
  'const app = express();',
  "app.use(createStaticAssetsMiddleware({ distDir: 'dist', publicDir: 'public', onMissingIndex: () => {} }));",
  'const reading = mountMcpGateway(app);',
].join('\n');

// --------------------------- (e) minimal OAuth provider ---------------------------

const OAUTH_CLIENT: OAuthClientInformationFull = {
  client_id: 'mcp-transport-guard-client',
  client_id_issued_at: Math.floor(Date.now() / 1000),
  redirect_uris: ['http://127.0.0.1/callback'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
};

/**
 * The smallest in-memory `OAuthServerProvider` `mcpAuthRouter` accepts. The
 * metadata endpoints read `clientsStore` only; the token paths are never
 * exercised by this guard, so they refuse loudly rather than pretending.
 */
class MinimalOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId: string) => (clientId === OAUTH_CLIENT.client_id ? OAUTH_CLIENT : undefined),
  };

  async authorize(_client: OAuthClientInformationFull, _params: AuthorizationParams, res: Response): Promise<void> {
    res.status(400).end('authorize is not exercised by this guard');
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, _code: string): Promise<string> {
    return '';
  }

  async exchangeAuthorizationCode(): Promise<OAuthTokens> {
    throw new Error('exchangeAuthorizationCode is not exercised by this guard');
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error('exchangeRefreshToken is not exercised by this guard');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return { token, clientId: OAUTH_CLIENT.client_id, scopes: [] };
  }
}

function readExpressVersion(): string {
  const raw = readFileSync(path.join(REPO_ROOT, 'node_modules', 'express', 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
}

// --------------------------- criteria ---------------------------

test('(a)(b) /mcp is a stateless Streamable HTTP endpoint answering JSON-RPC, not the SPA shell', async () => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  const mounted = mountMcpGateway(app, { env: { MCP_ENABLED: 'true' }, authorize: passthrough });
  const staticLayer = mountStaticLayer(app);
  const { baseUrl, close } = await listen(app);

  try {
    const first = await toolsListRequest(baseUrl, 'tools/list #1', 1);
    const second = await toolsListRequest(baseUrl, 'tools/list #2', 2);
    // The readings a mount-after-static build WOULD swallow: the static layer's
    // SPA entry is a `router.get('*')`, so only a GET/DELETE `/mcp` is
    // intercepted by it — a POST falls through to a later-mounted POST route.
    // These two legs are therefore what makes the mount ORDER measurable.
    const getReading = await request(baseUrl, 'GET', MCP_GATEWAY_PATH, { label: 'GET /mcp', accept: MCP_ACCEPT });
    const deleteReading = await request(baseUrl, 'DELETE', MCP_GATEWAY_PATH, { label: 'DELETE /mcp', accept: MCP_ACCEPT });

    console.log(
      [
        `[mount] mounted=${mounted.mounted} (${mounted.reason})`,
        `[static] SPA catch-all mounted AFTER the gateway (as server/index.ts does)`,
        describeHttp(first.reading),
        describeHttp(second.reading),
        describeHttp(getReading.reading),
        describeHttp(deleteReading.reading),
        `[json] #1=${JSON.stringify(first.json)}`,
        `[json] #2=${JSON.stringify(second.json)}`,
      ].join('\n'),
    );

    assert.equal(mounted.mounted, true, 'MCP_ENABLED=true must mount the gateway');

    // (a) stateless: neither request carried a session id, both succeeded, and
    // neither answer minted one.
    assert.equal(first.reading.requestSessionId, null, 'request #1 must not send an Mcp-Session-Id');
    assert.equal(second.reading.requestSessionId, null, 'request #2 must not send an Mcp-Session-Id');
    assert.equal(first.reading.status, 200, `request #1 must answer 200: ${describeHttp(first.reading)}`);
    assert.equal(second.reading.status, 200, `request #2 must answer 200: ${describeHttp(second.reading)}`);
    assert.ok(hasResult(first), `request #1 must carry a JSON-RPC result: ${JSON.stringify(first.json)}`);
    assert.ok(hasResult(second), `request #2 must carry a JSON-RPC result: ${JSON.stringify(second.json)}`);
    assert.equal(first.reading.responseSessionId, null, 'a stateless answer must not mint an Mcp-Session-Id');
    assert.equal(second.reading.responseSessionId, null, 'a stateless answer must not mint an Mcp-Session-Id');

    // (b) JSON-RPC content-type, never the SPA's text/html.
    assert.ok(
      isJsonRpcContentType(first.reading.contentType),
      `request #1 must answer JSON-RPC: ${describeHttp(first.reading)}`,
    );
    assert.ok(
      isJsonRpcContentType(second.reading.contentType),
      `request #2 must answer JSON-RPC: ${describeHttp(second.reading)}`,
    );
    assert.equal(
      (first.reading.contentType ?? '').includes('text/html'),
      false,
      `the answer must not be the SPA shell: ${describeHttp(first.reading)}`,
    );

    // (b) continued — GET/DELETE `/mcp` answer JSON-RPC 405, not the SPA shell.
    // These are the mount-order-sensitive readings: with the static layer first,
    // its `router.get('*')` answers `200 text/html` here.
    for (const exchange of [getReading, deleteReading]) {
      assert.equal(exchange.reading.status, 405, `${exchange.reading.label} must answer 405: ${describeHttp(exchange.reading)}`);
      assert.ok(
        isJsonRpcContentType(exchange.reading.contentType),
        `${exchange.reading.label} must answer JSON-RPC, not the SPA shell: ${describeHttp(exchange.reading)}`,
      );
      assert.equal(
        (exchange.reading.contentType ?? '').includes('text/html'),
        false,
        `${exchange.reading.label} must not fall through to the SPA shell: ${describeHttp(exchange.reading)}`,
      );
    }
  } finally {
    await close();
    staticLayer.cleanup();
  }
});

test('(c) the gate decides at mount time: off attaches nothing (404), on attaches the endpoint', async () => {
  async function probeMount(env: NodeJS.ProcessEnv, label: string): Promise<{ mounted: boolean; reason: string; exchange: Exchange }> {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    const reading = mountMcpGateway(app, { env, authorize: passthrough });
    const { baseUrl, close } = await listen(app);
    try {
      const exchange = await toolsListRequest(baseUrl, label, 1);
      return { mounted: reading.mounted, reason: reading.reason, exchange };
    } finally {
      await close();
    }
  }

  const offUnset = await probeMount({}, 'off (unset)');
  const offFalse = await probeMount({ MCP_ENABLED: 'false' }, 'off (false)');
  const onTrue = await probeMount({ MCP_ENABLED: 'true' }, 'on (true)');

  console.log(
    [
      `[off/unset] mounted=${offUnset.mounted} (${offUnset.reason}) ${describeHttp(offUnset.exchange.reading)}`,
      `[off/false] mounted=${offFalse.mounted} (${offFalse.reason}) ${describeHttp(offFalse.exchange.reading)}`,
      `[on/true ] mounted=${onTrue.mounted} (${onTrue.reason}) ${describeHttp(onTrue.exchange.reading)}`,
    ].join('\n'),
  );

  for (const [label, probe] of [
    ['unset', offUnset],
    ['false', offFalse],
  ] as const) {
    assert.equal(probe.mounted, false, `MCP_ENABLED=${label} must attach nothing`);
    assert.equal(probe.exchange.reading.status, 404, `MCP_ENABLED=${label}: the path must be absent (404): ${describeHttp(probe.exchange.reading)}`);
    assert.notEqual(probe.exchange.reading.status, 401, `MCP_ENABLED=${label}: absent is not forbidden`);
    assert.notEqual(probe.exchange.reading.status, 200, `MCP_ENABLED=${label}: absent is not a served endpoint`);
  }

  // The positive control: the same function, same code, only the env differs.
  assert.equal(onTrue.mounted, true, 'MCP_ENABLED=true must attach the endpoint');
  assert.notEqual(onTrue.exchange.reading.status, 404, 'with the gate open the path must no longer be absent');
  assert.equal(onTrue.exchange.reading.status, 200, `with the gate open the transport must serve the request: ${describeHttp(onTrue.exchange.reading)}`);
});

test('(d) server/index.ts mounts /mcp before the static-assets middleware, and the scanner is order-sensitive', () => {
  const realSource = readFileSync(INDEX_PATH, 'utf8');
  const real = checkMountOrder(realSource);
  const reversed = checkMountOrder(REVERSED_MOUNT_SOURCE);

  console.log(
    [
      `[real]     mountMcpGateway at line ${real.mountLine}, createStaticAssetsMiddleware app.use at line ${real.staticLine} -> mountBeforeStatic=${real.mountBeforeStatic}`,
      `[reversed] mountMcpGateway at line ${reversed.mountLine}, createStaticAssetsMiddleware app.use at line ${reversed.staticLine} -> mountBeforeStatic=${reversed.mountBeforeStatic}`,
      `[reversed source]\n${REVERSED_MOUNT_SOURCE}`,
    ].join('\n'),
  );

  assert.equal(real.mountFound, true, 'server/index.ts must call mountMcpGateway');
  assert.equal(real.staticMountFound, true, 'server/index.ts must call app.use(createStaticAssetsMiddleware(...))');
  assert.equal(
    real.mountBeforeStatic,
    true,
    `server/index.ts must mount /mcp BEFORE the static layer (mount line ${real.mountLine}, static line ${real.staticLine})`,
  );

  // The negative control: the same scanner on a source with the order reversed
  // must report the violation — so a green above is order-sensitivity, not a
  // scanner that always answers true.
  assert.equal(reversed.mountFound, true, 'the synthetic source does call mountMcpGateway');
  assert.equal(reversed.staticMountFound, true, 'the synthetic source does call the static middleware');
  assert.equal(
    reversed.mountBeforeStatic,
    false,
    `the reversed source must be flagged as violating the order (mount line ${reversed.mountLine}, static line ${reversed.staticLine})`,
  );
});

test('(e) the SDK auth router and the stateless transport run on this repo’s express 4.21', async () => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(mcpAuthRouter({ provider: new MinimalOAuthProvider(), issuerUrl: new URL('http://127.0.0.1/mcp') }));
  app.post(MCP_GATEWAY_PATH, async (req, res) => {
    const server = new McpServer({ name: 'mcp-transport-guard', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const { baseUrl, close } = await listen(app);

  try {
    const authMetadata = await request(baseUrl, 'GET', '/.well-known/oauth-authorization-server', {
      label: 'authorization-server metadata',
    });
    const resourceMetadata = await request(baseUrl, 'GET', '/.well-known/oauth-protected-resource/mcp', {
      label: 'protected-resource metadata',
    });
    const tools = await toolsListRequest(baseUrl, 'tools/list (auth guard)', 1);
    const expressVersion = readExpressVersion();

    console.log(
      [
        `[express] ${expressVersion}`,
        describeHttp(authMetadata.reading),
        describeHttp(resourceMetadata.reading),
        describeHttp(tools.reading),
        `[json] tools/list=${JSON.stringify(tools.json)}`,
      ].join('\n'),
    );

    assert.equal(authMetadata.reading.status, 200, `authorization-server metadata must answer 200: ${describeHttp(authMetadata.reading)}`);
    assert.ok(
      (authMetadata.reading.contentType ?? '').includes('application/json'),
      `authorization-server metadata must be JSON: ${describeHttp(authMetadata.reading)}`,
    );
    assert.equal(resourceMetadata.reading.status, 200, `protected-resource metadata must answer 200: ${describeHttp(resourceMetadata.reading)}`);
    assert.ok(
      (resourceMetadata.reading.contentType ?? '').includes('application/json'),
      `protected-resource metadata must be JSON: ${describeHttp(resourceMetadata.reading)}`,
    );
    assert.equal(tools.reading.status, 200, `tools/list must answer 200 on this express: ${describeHttp(tools.reading)}`);
    assert.ok(hasResult(tools), `tools/list must carry a result: ${JSON.stringify(tools.json)}`);
  } finally {
    await close();
  }
});

test('(f) the initialize handshake advertises the Cloudpit identity the client displays', async () => {
  // The pre-3.0 name `claudecodeui-mcp-gateway` survived the Cloudpit brand sweep:
  // that sweep renamed the client-side config key (`cloudpit`) and the token env
  // var, not this wire identity, and no test pinned it — an MCP client such as
  // Gemini therefore kept displaying "Claudecodeui Mcp Gateway". This leg pins the
  // handshake itself, over real HTTP, so the next sweep cannot miss it again.
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, { env: { MCP_ENABLED: 'true' }, authorize: passthrough });
  const { baseUrl, close } = await listen(app);

  try {
    const initialize = await request(baseUrl, 'POST', MCP_GATEWAY_PATH, {
      label: 'initialize',
      accept: MCP_ACCEPT,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'mcp-transport-guard', version: '0.0.0' },
        },
      },
    });

    console.log(`[initialize] ${describeHttp(initialize.reading)}\n[json] ${JSON.stringify(initialize.json)}`);

    assert.equal(initialize.reading.status, 200, `initialize must answer 200: ${describeHttp(initialize.reading)}`);
    const result = initialize.json?.result as
      | { serverInfo?: { name?: unknown; title?: unknown; version?: unknown } }
      | undefined;
    const serverInfo = result?.serverInfo;
    assert.ok(serverInfo && typeof serverInfo === 'object', `the initialize result must carry serverInfo: ${JSON.stringify(initialize.json)}`);
    assert.equal(
      serverInfo.name,
      'cloudpit-mcp-gateway',
      `serverInfo.name is what an MCP client displays; it must be the Cloudpit identity: ${JSON.stringify(serverInfo)}`,
    );
    assert.equal(
      serverInfo.title,
      'Cloudpit',
      `serverInfo.title must give clients a human-readable Cloudpit name: ${JSON.stringify(serverInfo)}`,
    );
    assert.equal(
      typeof serverInfo.name === 'string' && serverInfo.name.includes('claudecodeui'),
      false,
      `the legacy name must not survive in the handshake: ${JSON.stringify(serverInfo)}`,
    );
    // The advertised version is the package's, not a literal that drifts from `package.json`.
    const packageVersion = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: unknown })
      .version;
    assert.equal(
      serverInfo.version,
      packageVersion,
      `serverInfo.version must be the running package version: ${JSON.stringify(serverInfo)} vs package.json ${String(packageVersion)}`,
    );
  } finally {
    await close();
  }
});

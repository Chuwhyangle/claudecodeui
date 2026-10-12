import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import ts from 'typescript';

import { createStaticAssetsMiddleware } from '@/modules/static-assets/index.js';

import { mountOAuthMetadata, readMcpDcrMode, readOAuthMetadataGate } from '../index.js';

/**
 * The criterion for AC-262: the two OAuth discovery documents are published as
 * JSON when the switch is on, are ABSENT when it is off, advertise `S256` PKCE
 * and the DCR registration endpoint conditionally, and are mounted before the
 * static layer so the SPA catch-all cannot swallow them.
 *
 * Every field is read back over real HTTP from a real express 4 app, not off the
 * route function: "the handler was called" is not the claim, "a client sees this
 * JSON at this path" is.
 *
 * Requests go over `node:http`, never `fetch` — undici refuses a fixed set of
 * ports and `listen(0)` draws from the whole 1024–65535 range, so a `fetch` here
 * would red the suite at random (same reason as AC-240's criterion).
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const INDEX_PATH = path.join(SERVER_DIR, 'index.ts');

const WELL_KNOWN_AS = '/.well-known/oauth-authorization-server';
const WELL_KNOWN_PRM = '/.well-known/oauth-protected-resource/mcp';

/** The https origin every positive leg advertises. */
const BASE = 'https://mcp.example.test';

type Reading = {
  label: string;
  method: string;
  requestPath: string;
  status: number;
  contentType: string | null;
  body: string;
  json: Record<string, unknown> | null;
};

/** One GET over `node:http`, parsed into JSON when the body allows it. */
function get(baseUrl: string, requestPath: string, label: string): Promise<Reading> {
  const url = new URL(requestPath, baseUrl);

  return new Promise<Reading>((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          let json: Record<string, unknown> | null = null;
          try {
            const parsed = JSON.parse(body) as unknown;
            if (typeof parsed === 'object' && parsed !== null) {
              json = parsed as Record<string, unknown>;
            }
          } catch {
            json = null;
          }
          resolve({
            label,
            method: 'GET',
            requestPath,
            status: res.statusCode ?? 0,
            contentType: (res.headers['content-type'] as string | undefined) ?? null,
            body,
            json,
          });
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

function describeReading(reading: Reading): string {
  return `[${reading.label}] ${reading.method} ${reading.requestPath} -> ${reading.status} ${reading.contentType ?? '<no content-type>'} :: ${JSON.stringify(reading.body.slice(0, 200))}`;
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
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oauth-metadata-static-'));
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

/** A server with only the metadata mount — no static layer — for the field legs. */
async function withMetadataApp(
  env: NodeJS.ProcessEnv,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  const mounted = mountOAuthMetadata(app, { env });
  assert.equal(mounted.mounted, true, `the metadata mount must attach for env ${JSON.stringify(env)}`);
  const { baseUrl, close } = await listen(app);
  try {
    await run(baseUrl);
  } finally {
    await close();
  }
}

// --------------------------- mount-order scanner ---------------------------

type CallOrderReading = {
  firstFound: boolean;
  secondFound: boolean;
  firstLine: number | null;
  secondLine: number | null;
  firstBeforeSecond: boolean;
};

/**
 * Reads any source and decides whether the `firstName` call precedes the
 * `secondName` call. Pure over its argument, so the negative control can feed it
 * a reversed synthetic source and the SAME code must flag the order.
 */
function checkCallOrder(sourceText: string, firstName: string, secondName: string): CallOrderReading {
  const sourceFile = ts.createSourceFile('call-order.ts', sourceText, ts.ScriptTarget.Latest, true);
  let firstPosition: number | null = null;
  let secondPosition: number | null = null;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (firstPosition === null && node.expression.text === firstName) {
        firstPosition = node.getStart(sourceFile);
      }
      if (secondPosition === null && node.expression.text === secondName) {
        secondPosition = node.getStart(sourceFile);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const first = firstPosition;
  const second = secondPosition;
  const lineOf = (position: number | null): number | null =>
    position === null ? null : sourceFile.getLineAndCharacterOfPosition(position).line + 1;

  return {
    firstFound: first !== null,
    secondFound: second !== null,
    firstLine: lineOf(first),
    secondLine: lineOf(second),
    firstBeforeSecond: first !== null && second !== null && first < second,
  };
}

/** The reversed order the scanner must reject: the static mount comes first. */
const REVERSED_MOUNT_SOURCE = [
  "import express from 'express';",
  "import { createStaticAssetsMiddleware } from './modules/static-assets/index.js';",
  "import { mountOAuthMetadata } from './modules/mcp-gateway/index.js';",
  'const app = express();',
  "app.use(createStaticAssetsMiddleware({ distDir: 'dist', publicDir: 'public', onMissingIndex: () => {} }));",
  'const metadata = mountOAuthMetadata(app);',
].join('\n');

// --------------------------- literal-count walk ---------------------------

/**
 * The prefix the suite's own transient copies carry: `<prefix><label>-{base,mut}-<pid>.ts`,
 * written beside `server/modules/voice/` by the sibling `*.false-forms.test.ts` criteria (they
 * must sit in the module's own directory for its relative imports to resolve) and removed again
 * when each case ends. A whole-tree scan has to leave them out of the reading for two reasons: a
 * copy is not product source, and because the suite runs those files concurrently, a copy can
 * vanish between the `readdir` below and the `readFileSync` in `countLiteral` — which, unguarded,
 * aborts this criterion with ENOENT. `voice-dashscope-settings.test.ts`'s `collectSourceFiles`
 * excludes the same prefix by name for the same reason.
 */
const TRANSIENT_COPY_PREFIX = '__criterion-falsify-';

/**
 * Every `.ts` file under `root`, walked directly (not through tsconfig) so the
 * criterion measures the tree as it is on disk. The suite's transient
 * `__criterion-falsify-*` copies are skipped by name (see
 * `TRANSIENT_COPY_PREFIX`), so a neighbour's in-flight copy is neither counted
 * nor read.
 */
function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.startsWith(TRANSIENT_COPY_PREFIX)
      ) {
        out.push(full);
      }
    }
  }

  return out;
}

/** Occurrences of `literal` across the tree, optionally skipping `/tests/`. */
function countLiteral(root: string, literal: string, options: { excludeTests?: boolean } = {}): {
  count: number;
  files: string[];
} {
  const files = walkTsFiles(root).filter(
    (file) => !options.excludeTests || !file.includes(`${path.sep}tests${path.sep}`),
  );
  let count = 0;
  const hits: string[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      // A file the walk listed can be gone by the time it is read: a sibling
      // criterion's transient copy (see `TRANSIENT_COPY_PREFIX`) or anything
      // else a concurrent process churns under the tree does this. An absent
      // file contributes nothing to a literal count, so skipping it reads the
      // tree that remains rather than aborting the whole criterion with ENOENT.
      // Any other error is a real failure and is re-thrown.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const occurrences = text.split(literal).length - 1;
    if (occurrences > 0) {
      count += occurrences;
      hits.push(`${path.relative(REPO_ROOT, file)}:${occurrences}`);
    }
  }

  return { count, files: hits };
}

// --------------------------- criteria ---------------------------

test('(a) enabled on an https origin advertises issuer, S256-only PKCE and the /mcp resource', async () => {
  await withMetadataApp({ MCP_OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: BASE }, async (baseUrl) => {
    const as = await get(baseUrl, WELL_KNOWN_AS, 'authorization-server metadata');
    const prm = await get(baseUrl, WELL_KNOWN_PRM, 'protected-resource metadata');
    const asJson = as.json ?? {};
    const prmJson = prm.json ?? {};

    console.log(
      [
        describeReading(as),
        describeReading(prm),
        `[as]  issuer=${JSON.stringify(asJson.issuer)} code_challenge_methods_supported=${JSON.stringify(asJson.code_challenge_methods_supported)}`,
        `[prm] resource=${JSON.stringify(prmJson.resource)} authorization_servers=${JSON.stringify(prmJson.authorization_servers)}`,
      ].join('\n'),
    );

    // Authorization-server metadata.
    assert.equal(as.status, 200, `AS metadata must answer 200: ${describeReading(as)}`);
    assert.ok(
      (as.contentType ?? '').startsWith('application/json'),
      `AS metadata must be application/json: ${describeReading(as)}`,
    );
    assert.equal(asJson.issuer, BASE, `issuer must equal the base URL: ${JSON.stringify(asJson.issuer)}`);
    assert.deepEqual(
      asJson.code_challenge_methods_supported,
      ['S256'],
      `PKCE methods must be exactly ['S256']: ${JSON.stringify(asJson.code_challenge_methods_supported)}`,
    );

    // Protected-resource metadata.
    assert.equal(prm.status, 200, `PRM must answer 200: ${describeReading(prm)}`);
    assert.ok(
      (prm.contentType ?? '').startsWith('application/json'),
      `PRM must be application/json: ${describeReading(prm)}`,
    );
    assert.equal(prmJson.resource, `${BASE}/mcp`, `resource must be base + /mcp: ${JSON.stringify(prmJson.resource)}`);
    assert.ok(
      Array.isArray(prmJson.authorization_servers) && prmJson.authorization_servers.includes(BASE),
      `authorization_servers must contain the issuer: ${JSON.stringify(prmJson.authorization_servers)}`,
    );
  });
});

test('(b) both documents are mounted before the static layer, and the scanner is order-sensitive', async () => {
  const app = express();
  const mounted = mountOAuthMetadata(app, { env: { MCP_OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: BASE } });
  const staticLayer = mountStaticLayer(app);
  const { baseUrl, close } = await listen(app);

  try {
    const as = await get(baseUrl, WELL_KNOWN_AS, 'authorization-server metadata (static behind)');
    const prm = await get(baseUrl, WELL_KNOWN_PRM, 'protected-resource metadata (static behind)');
    const swallowed = await get(baseUrl, '/definitely-missing', 'SPA-swallowed control path');

    console.log(
      [
        `[mount] mounted=${mounted.mounted} (${mounted.reason})`,
        `[static] SPA catch-all mounted AFTER the metadata, as server/index.ts does`,
        describeReading(as),
        describeReading(prm),
        describeReading(swallowed),
      ].join('\n'),
    );

    assert.equal(mounted.mounted, true, 'the metadata mount must attach');
    for (const reading of [as, prm]) {
      assert.equal(reading.status, 200, `${reading.label} must answer 200: ${describeReading(reading)}`);
      assert.ok(
        (reading.contentType ?? '').startsWith('application/json'),
        `${reading.label} must be JSON, not the SPA shell: ${describeReading(reading)}`,
      );
      assert.equal(
        (reading.contentType ?? '').includes('text/html'),
        false,
        `${reading.label} must not fall through to the SPA shell: ${describeReading(reading)}`,
      );
    }

    // The positive control: the SPA catch-all IS mounted and really does swallow
    // unmatched paths, so the JSON above is the metadata mount winning — not a
    // missing static layer.
    assert.equal(swallowed.status, 200, `the SPA control path must answer 200: ${describeReading(swallowed)}`);
    assert.ok(
      (swallowed.contentType ?? '').includes('text/html'),
      `the SPA control path must be text/html: ${describeReading(swallowed)}`,
    );
  } finally {
    await close();
    staticLayer.cleanup();
  }

  const realSource = readFileSync(INDEX_PATH, 'utf8');
  const real = checkCallOrder(realSource, 'mountOAuthMetadata', 'createStaticAssetsMiddleware');
  const reversed = checkCallOrder(REVERSED_MOUNT_SOURCE, 'mountOAuthMetadata', 'createStaticAssetsMiddleware');

  console.log(
    [
      `[real]     mountOAuthMetadata at line ${real.firstLine}, createStaticAssetsMiddleware at line ${real.secondLine} -> firstBeforeSecond=${real.firstBeforeSecond}`,
      `[reversed] mountOAuthMetadata at line ${reversed.firstLine}, createStaticAssetsMiddleware at line ${reversed.secondLine} -> firstBeforeSecond=${reversed.firstBeforeSecond}`,
      `[reversed source]\n${REVERSED_MOUNT_SOURCE}`,
    ].join('\n'),
  );

  assert.equal(real.firstFound, true, 'server/index.ts must call mountOAuthMetadata');
  assert.equal(real.secondFound, true, 'server/index.ts must call createStaticAssetsMiddleware');
  assert.equal(
    real.firstBeforeSecond,
    true,
    `server/index.ts must mount the metadata BEFORE the static layer (mount line ${real.firstLine}, static line ${real.secondLine})`,
  );

  // The negative control: the same scanner on a source with the order reversed
  // must report the violation — so a green above is order-sensitivity, not a
  // scanner that always answers true.
  assert.equal(reversed.firstFound, true, 'the synthetic source does call mountOAuthMetadata');
  assert.equal(reversed.secondFound, true, 'the synthetic source does call the static middleware');
  assert.equal(
    reversed.firstBeforeSecond,
    false,
    `the reversed source must be flagged as violating the order (mount line ${reversed.firstLine}, static line ${reversed.secondLine})`,
  );
});

test('(c) registration_endpoint appears only when MCP_DCR is not off', async () => {
  const cases: Array<{ label: string; env: NodeJS.ProcessEnv }> = [
    { label: 'unset', env: { MCP_OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: BASE } },
    { label: 'allowlist', env: { MCP_OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: BASE, MCP_DCR: 'allowlist' } },
    { label: 'open', env: { MCP_OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: BASE, MCP_DCR: 'open' } },
  ];

  const readings: Array<{ label: string; hasKey: boolean; value: unknown }> = [];
  for (const probe of cases) {
    await withMetadataApp(probe.env, async (baseUrl) => {
      const as = await get(baseUrl, WELL_KNOWN_AS, `AS metadata (MCP_DCR=${probe.label})`);
      const json = as.json ?? {};
      readings.push({ label: probe.label, hasKey: 'registration_endpoint' in json, value: json.registration_endpoint });
    });
  }

  console.log(readings.map((r) => `[dcr=${r.label}] registration_endpoint present=${r.hasKey} value=${JSON.stringify(r.value)}`).join('\n'));

  // Positive control: off genuinely OMITS the key (not merely an undefined value).
  assert.equal(readings[0].hasKey, false, 'with MCP_DCR off the key must be absent');
  assert.equal(readings[0].value, undefined, 'with MCP_DCR off the value must be undefined');
  assert.equal(readings[1].hasKey, true, 'with MCP_DCR=allowlist the key must be present');
  assert.equal(readings[1].value, `${BASE}/oauth/register`, `allowlist registration_endpoint: ${JSON.stringify(readings[1].value)}`);
  assert.equal(readings[2].hasKey, true, 'with MCP_DCR=open the key must be present');
  assert.equal(readings[2].value, `${BASE}/oauth/register`, `open registration_endpoint: ${JSON.stringify(readings[2].value)}`);

  // The reader's fail-closed mapping, pinned directly (AC-264 will reuse it).
  assert.equal(readMcpDcrMode({}), 'off', 'an unset MCP_DCR must be off');
  assert.equal(readMcpDcrMode({ MCP_DCR: ' OPEN ' }), 'open', 'trim+lowercase must recognise OPEN');
  assert.equal(readMcpDcrMode({ MCP_DCR: 'nonsense' }), 'off', 'an unrecognised MCP_DCR must fail closed to off');
});

test('(d) switch off publishes nothing, switch on answers 200', async () => {
  async function probe(env: NodeJS.ProcessEnv, label: string): Promise<{ mounted: boolean; reason: string; as: Reading; prm: Reading }> {
    const app = express();
    const reading = mountOAuthMetadata(app, { env });
    const { baseUrl, close } = await listen(app);
    try {
      return {
        mounted: reading.mounted,
        reason: reading.reason,
        as: await get(baseUrl, WELL_KNOWN_AS, `${label} AS metadata`),
        prm: await get(baseUrl, WELL_KNOWN_PRM, `${label} PRM`),
      };
    } finally {
      await close();
    }
  }

  const offUnset = await probe({}, 'off (unset)');
  const offFalse = await probe({ MCP_OAUTH_ENABLED: 'false' }, 'off (false)');
  const onTrue = await probe({ MCP_OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: BASE }, 'on (true)');

  const hasIssuer = (reading: Reading): boolean => reading.body.includes('issuer');
  console.log(
    [
      `[off/unset] mounted=${offUnset.mounted} (${offUnset.reason}) AS=${offUnset.as.status} hasIssuer=${hasIssuer(offUnset.as)} PRM=${offUnset.prm.status} hasIssuer=${hasIssuer(offUnset.prm)}`,
      `[off/false] mounted=${offFalse.mounted} (${offFalse.reason}) AS=${offFalse.as.status} hasIssuer=${hasIssuer(offFalse.as)} PRM=${offFalse.prm.status} hasIssuer=${hasIssuer(offFalse.prm)}`,
      `[on/true ] mounted=${onTrue.mounted} (${onTrue.reason}) AS=${onTrue.as.status} hasIssuer=${hasIssuer(onTrue.as)} PRM=${onTrue.prm.status} hasIssuer=${hasIssuer(onTrue.prm)}`,
    ].join('\n'),
  );

  for (const [label, reading] of [
    ['unset', offUnset],
    ['false', offFalse],
  ] as const) {
    assert.equal(reading.mounted, false, `MCP_OAUTH_ENABLED=${label} must attach nothing`);
    assert.equal(reading.as.status, 404, `MCP_OAUTH_ENABLED=${label}: AS path must be absent (404): ${describeReading(reading.as)}`);
    assert.equal(reading.prm.status, 404, `MCP_OAUTH_ENABLED=${label}: PRM path must be absent (404): ${describeReading(reading.prm)}`);
    assert.equal(hasIssuer(reading.as), false, `MCP_OAUTH_ENABLED=${label}: the AS 404 body must not carry an issuer`);
    assert.equal(hasIssuer(reading.prm), false, `MCP_OAUTH_ENABLED=${label}: the PRM 404 body must not carry an issuer`);
  }

  // Positive control: same code, only the env differs.
  assert.equal(onTrue.mounted, true, 'MCP_OAUTH_ENABLED=true must attach the documents');
  assert.equal(onTrue.as.status, 200, `with the switch on the AS path must answer 200: ${describeReading(onTrue.as)}`);
  assert.equal(onTrue.prm.status, 200, `with the switch on the PRM path must answer 200: ${describeReading(onTrue.prm)}`);
  assert.equal(hasIssuer(onTrue.as), true, 'with the switch on the AS body must carry an issuer');
});

test('(e) base URL validation names PUBLIC_BASE_URL, with localhost exempt', () => {
  const missing = { MCP_OAUTH_ENABLED: 'true' };
  const empty = { MCP_OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: '   ' };
  const nonLocalHttp = { MCP_OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: 'http://example.com' };
  const localhost = { MCP_OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: 'http://localhost:3001' };
  const loopback = { MCP_OAUTH_ENABLED: 'true', PUBLIC_BASE_URL: 'http://127.0.0.1:3001' };

  function capture(env: NodeJS.ProcessEnv): string | null {
    try {
      readOAuthMetadataGate(env);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  const missingMessage = capture(missing);
  const emptyMessage = capture(empty);
  const nonLocalMessage = capture(nonLocalHttp);

  console.log(
    [
      `[missing]       threw=${missingMessage !== null} message=${JSON.stringify(missingMessage)}`,
      `[empty]         threw=${emptyMessage !== null} message=${JSON.stringify(emptyMessage)}`,
      `[http non-local] threw=${nonLocalMessage !== null} message=${JSON.stringify(nonLocalMessage)}`,
    ].join('\n'),
  );

  assert.ok(missingMessage !== null, 'a missing base URL must throw');
  assert.ok(missingMessage.includes('PUBLIC_BASE_URL'), `the missing-base error must name the variable: ${missingMessage}`);
  assert.ok(emptyMessage !== null, 'an empty base URL must throw');
  assert.ok(emptyMessage.includes('PUBLIC_BASE_URL'), `the empty-base error must name the variable: ${emptyMessage}`);
  assert.ok(nonLocalMessage !== null, 'a non-local http base URL must throw');
  assert.ok(
    nonLocalMessage.includes('PUBLIC_BASE_URL'),
    `the non-local-http error must name the variable: ${nonLocalMessage}`,
  );

  const localhostReading = readOAuthMetadataGate(localhost);
  const loopbackReading = readOAuthMetadataGate(loopback);
  console.log(
    [
      `[http://localhost]  ${JSON.stringify(localhostReading)}`,
      `[http://127.0.0.1]  ${JSON.stringify(loopbackReading)}`,
    ].join('\n'),
  );

  assert.equal(localhostReading.enabled, true, 'http://localhost must be admitted');
  assert.equal(localhostReading.enabled && localhostReading.baseUrl, 'http://localhost:3001');
  assert.equal(loopbackReading.enabled, true, 'http://127.0.0.1 must be admitted');
  assert.equal(loopbackReading.enabled && loopbackReading.baseUrl, 'http://127.0.0.1:3001');

  // The throw must be reachable from the real startup assembly: server/index.ts
  // calls the mount that calls the gate.
  const real = checkCallOrder(readFileSync(INDEX_PATH, 'utf8'), 'mountOAuthMetadata', 'createStaticAssetsMiddleware');
  assert.equal(real.firstFound, true, 'server/index.ts must call mountOAuthMetadata, so a bad base URL aborts startup');
});

test('(f) the loopback reader stays the only production reader of the OAuth switch', () => {
  const production = countLiteral(SERVER_DIR, 'MCP_OAUTH_ENABLED', { excludeTests: true });
  const includingTests = countLiteral(SERVER_DIR, 'MCP_OAUTH_ENABLED');

  console.log(
    [
      `[production] count=${production.count} files=${JSON.stringify(production.files)}`,
      `[with tests] count=${includingTests.count} files=${JSON.stringify(includingTests.files)}`,
    ].join('\n'),
  );

  // Exactly one production reader, in the loopback guard's module.
  assert.equal(production.count, 1, `production must read the switch exactly once: ${JSON.stringify(production.files)}`);
  assert.deepEqual(
    production.files,
    ['server/modules/mcp-gateway/mcp-gateway.loopback.ts:1'],
    `the single production reader must be the loopback guard: ${JSON.stringify(production.files)}`,
  );

  // Positive control: the walk is not returning zero for everything — the
  // criterion itself (which lives under /tests/) uses the literal, so widening
  // the scan must count strictly more.
  assert.ok(
    includingTests.count >= 2,
    `including tests the count must rise (this criterion uses the literal): ${JSON.stringify(includingTests.files)}`,
  );
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express, { type RequestHandler } from 'express';

import {
  ensureProviderWatchRoots,
  providerRegistry,
  resolveProviderWatchPaths,
} from '@/modules/providers/index.js';
import { createStaticAssetsMiddleware } from '@/modules/static-assets/index.js';

import {
  DEBUG_AGENT_CONTROL_PLANE_PATH,
  DEBUG_AGENT_PROVIDER_ID,
  mountDebugAgentControlPlane,
  readDebugAgentGate,
} from '../debug-agent.gate.js';

/**
 * The criterion for ADR-003 decision 3, as narrowed to three faces by
 * adjudication B: with the gate closed the debug agent does not exist in the
 * registry, in the watcher's observation set, or on the router — and the three
 * faces reach that conclusion independently.
 *
 * Why this file re-executes itself. The gate is evaluated once per process and
 * an evaluated ESM module cannot be re-evaluated, so "read the gate with
 * `DEBUG_AGENT` unset, then read it again with the variable set" is impossible
 * inside one process. Every reading below therefore comes from a CHILD process,
 * one per gate state, printed as a single JSON line. Re-importing with a
 * cache-busting query string would measure the cache, not the gate.
 *
 * What each face is observed through:
 *
 *  1. registry — the seam that writes the key (`registerDebugAgentProvider`)
 *     plus resolution of the id against resolution of a typo. The provider
 *     object itself is a separate task's deliverable, so this criterion
 *     registers the real claude instance and asserts identity: what is under
 *     test is whether the key is written at all.
 *  2. watcher — the resolved observation set and the `mkdir` step that would
 *     materialise it.
 *  3. routes — an express application assembled the way `server/index.ts`
 *     assembles it (control plane, then the SPA catch-all), mounted and driven
 *     over a real socket.
 */

// Spelled through constants so this file never becomes a second reader of the
// gate variable: AC4 below asserts that, outside the gate module, `server/`
// contains no direct read of it, and this file must pass its own check.
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';
const PROBE_VAR = 'DEBUG_AGENT_GATE_PROBE';
const PROBE_MARKER = '__DEBUG_AGENT_GATE_READING__';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SELF = fileURLToPath(import.meta.url);
const SERVER_SRC = path.join(REPO_ROOT, 'server');
const GATE_MODULE_RELATIVE = 'server/modules/debug-agent/debug-agent.gate.ts';

const MISSING_INDEX_STATUS = 500;

type FailureReading = { errorName: string; code: string | null; statusCode: number | null; message: string };

type Outcome = { ok: true; sameObjectAsClaude: boolean } | ({ ok: false } & FailureReading);

type ResponseReading = { path: string; status: number | null; contentType: string | null; bodyHead: string };

type ProbeReading = {
  gate: { enabled: boolean; home: string | null; reason: string };
  env: { gateVar: string | null; gateHome: string | null };
  registry: {
    registered: boolean;
    debug: Outcome;
    typo: Outcome;
    /** The failures with the requested id blanked out, for a literal comparison. */
    debugNormalized: string | null;
    typoNormalized: string | null;
  };
  watcher: {
    roots: Array<{ provider: string; rootPath: string }>;
    fixtureRoot: string;
    fixtureListed: boolean;
    fixtureCreated: boolean;
    productRoots: string[];
    productRootsCreated: string[];
  };
  routes: {
    mounted: boolean;
    layersAdded: number;
    layerNames: string[];
    extensionless: ResponseReading;
    suffixed: ResponseReading;
  };
};

// --------------------------- child process ---------------------------

/**
 * The object registered under the runtime id. It is the real claude provider
 * instance: this criterion is about the registry seam (is the key written at
 * all), not about the debug agent's own provider, which another task delivers.
 */
function probe(): Promise<ProbeReading> {
  const claudeStandIn = providerRegistry.resolveProvider('claude');
  const gate = readDebugAgentGate();
  const fixtureHome = process.env[GATE_HOME_VAR] ?? '';
  const fixtureRoot = path.join(fixtureHome, '.claude', 'projects');

  // ---- Face 1: registry ----
  const registered = providerRegistry.registerDebugAgentProvider(claudeStandIn);
  const debug = outcomeOf(() => providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID), claudeStandIn);
  const typo = outcomeOf(() => providerRegistry.resolveProvider('claud'), claudeStandIn);

  // ---- Face 2: watcher ----
  const roots = resolveProviderWatchPaths();

  return ensureProviderWatchRoots().then((created) => {
    const createdPaths = created
      .map(({ rootPath }) => rootPath)
      .filter((rootPath) => fs.existsSync(rootPath));

    // ---- Face 3: routes ----
    return readRoutes().then((routes) => {
      const reading: ProbeReading = {
        gate,
        env: { gateVar: process.env[GATE_VAR] ?? null, gateHome: process.env[GATE_HOME_VAR] ?? null },
        registry: {
          registered,
          debug,
          typo,
          debugNormalized: normalizeFailure(debug, DEBUG_AGENT_PROVIDER_ID),
          typoNormalized: normalizeFailure(typo, 'claud'),
        },
        watcher: {
          roots: roots.map(({ provider, rootPath }) => ({ provider, rootPath })),
          fixtureRoot,
          fixtureListed: roots.some(({ rootPath }) => path.resolve(rootPath) === path.resolve(fixtureRoot)),
          fixtureCreated: fixtureHome !== '' && fs.existsSync(fixtureRoot),
          productRoots: roots
            .map(({ rootPath }) => rootPath)
            .filter((rootPath) => fixtureHome === '' || !path.resolve(rootPath).startsWith(path.resolve(fixtureHome))),
          productRootsCreated: createdPaths.filter(
            (rootPath) => fixtureHome === '' || !path.resolve(rootPath).startsWith(path.resolve(fixtureHome)),
          ),
        },
        routes,
      };

      return reading;
    });
  });
}

function outcomeOf(run: () => unknown, standIn: unknown): Outcome {
  try {
    return { ok: true, sameObjectAsClaude: run() === standIn };
  } catch (error) {
    const typed = error as { name?: string; code?: string; statusCode?: number; message?: string };
    return {
      ok: false,
      errorName: typed.name ?? 'Error',
      code: typeof typed.code === 'string' ? typed.code : null,
      statusCode: typeof typed.statusCode === 'number' ? typed.statusCode : null,
      message: typed.message ?? String(error),
    };
  }
}

/** Blanks the requested id out of a failure message, so two failures can be compared literally. */
function normalizeFailure(outcome: Outcome, requestedId: string): string | null {
  return outcome.ok ? null : outcome.message.replaceAll(requestedId, '<id>');
}

/**
 * Boots an application assembled the way `server/index.ts` assembles it: the
 * control plane first (if the gate lets it attach), then the real static-assets
 * module with its SPA catch-all, and drives two paths over a real socket.
 *
 * The auth middleware here is a stand-in with the shape the control plane's own
 * criterion pins down (401 + JSON when no token is presented). It stands in
 * because this face is about whether anything is ATTACHED, and importing the
 * real middleware would evaluate the app-config database at import time for a
 * reading that does not depend on it.
 */
async function readRoutes(): Promise<ProbeReading['routes']> {
  const app = express();
  const authenticate: RequestHandler = (_req, res) => {
    res.status(401).json({ error: 'Access denied. No token provided.', code: 'AUTH_TOKEN_INVALID' });
  };

  const stackBefore = middlewareStack(app).length;
  const mounted = mountDebugAgentControlPlane(app, authenticate);
  const addedLayers = middlewareStack(app).slice(stackBefore);

  const staticDir = mkdtempSync(path.join(os.tmpdir(), 'debug-agent-gate-static-'));
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>spa shell</title>');
  app.use(
    createStaticAssetsMiddleware({
      distDir: staticDir,
      publicDir: staticDir,
      onMissingIndex: (_req, res) => res.status(MISSING_INDEX_STATUS).send('no built index'),
    }),
  );

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    return {
      mounted,
      layersAdded: addedLayers.length,
      layerNames: addedLayers.map((layer) => layer.name ?? '<anonymous>'),
      // The same control-plane path, written both ways: extension-less (what the
      // SPA catch-all renders `index.html` for) and with an extension (what it
      // 404s). Printing both is what keeps this face from degenerating into a
      // status-code assertion — see the check below.
      extensionless: await readPath(baseUrl, DEBUG_AGENT_CONTROL_PLANE_PATH),
      suffixed: await readPath(baseUrl, `${DEBUG_AGENT_CONTROL_PLANE_PATH}/scenarios.json`),
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(staticDir, { recursive: true, force: true });
  }
}

type MiddlewareLayer = { name?: string };

/**
 * The application's own middleware stack. Express 4 keeps it on `_router` and
 * express 5 renames it to `router`.
 *
 * The v5 name is read through a property DESCRIPTOR, never by touching
 * `app.router`: in express 4 that name is a deprecated getter that throws, so
 * probing it directly would blow up the very reading it is meant to take — and
 * it throws exactly when `_router` is still undefined, which is the closed-gate
 * case this face is about. A bare `_router` absent on a future express simply
 * reads as "no layers", which fails the open-gate control loudly rather than
 * silently passing.
 */
function middlewareStack(app: express.Express): MiddlewareLayer[] {
  const internal = app as unknown as Record<string, unknown>;
  const container = (internal._router ?? Object.getOwnPropertyDescriptor(internal, 'router')?.value) as
    | { stack?: MiddlewareLayer[] }
    | undefined;
  return container?.stack ?? [];
}

async function readPath(baseUrl: string, requestPath: string): Promise<ResponseReading> {
  const response = await fetch(`${baseUrl}${requestPath}`);
  const body = await response.text();
  return {
    path: requestPath,
    status: response.status,
    contentType: response.headers.get('content-type'),
    bodyHead: body.slice(0, 60).replace(/\s+/g, ' '),
  };
}

// --------------------------- parent process ---------------------------

type GateState = 'closed' | 'closed-unrecognised-value' | 'open' | 'open-without-root';

/**
 * Runs one child in the given gate state. `HOME` is redirected into a scratch
 * directory for every state so the watcher's `mkdir` step can never touch the
 * real home — including in the states where it is supposed to run.
 *
 * The CLOSED state deliberately carries `DEBUG_AGENT_HOME` anyway: the gate
 * variable is what decides, so the fixture root is available in the environment
 * and must still not be listed, created or mounted. A closed child with no root
 * anywhere would satisfy faces 2 and 3 vacuously — there would be nothing to
 * observe and the tamper case ("keep the root, drop the gate") could not exist.
 */
function runChild(state: GateState): { reading: ProbeReading; scratch: string; home: string; fixtureHome: string } {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `debug-agent-gate-${state}-`));
  const home = path.join(scratch, 'home');
  const fixtureHome = path.join(scratch, 'fixture');
  mkdirSync(home, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, [PROBE_VAR]: '1' };
  delete env[GATE_VAR];
  delete env[GATE_HOME_VAR];

  if (state === 'closed') {
    env[GATE_HOME_VAR] = fixtureHome;
  } else if (state === 'open') {
    env[GATE_VAR] = 'on';
    env[GATE_HOME_VAR] = fixtureHome;
  } else if (state === 'open-without-root') {
    env[GATE_VAR] = 'on';
  } else if (state === 'closed-unrecognised-value') {
    env[GATE_VAR] = 'enabled'; // not a recognised value: a typo must not open the gate
    env[GATE_HOME_VAR] = fixtureHome;
  }

  const stdout = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', 'server/tsconfig.json', SELF], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  const line = stdout
    .split('\n')
    .filter((entry) => entry.startsWith(PROBE_MARKER))
    .pop();

  assert.ok(line, `probe child (${state}) printed no reading; stdout was:\n${stdout}`);
  return { reading: JSON.parse(line.slice(PROBE_MARKER.length)) as ProbeReading, scratch, home, fixtureHome };
}

function describe(reading: ProbeReading): string {
  return [
    `[gate] ${reading.gate.enabled ? 'OPEN' : 'CLOSED'} (${reading.gate.reason}); home=${reading.gate.home ?? '<none>'}`,
    `[face 1 registry] registered=${reading.registry.registered} resolve('${DEBUG_AGENT_PROVIDER_ID}')=${
      reading.registry.debug.ok ? 'resolved' : `${reading.registry.debug.errorName}/${reading.registry.debug.code}/${reading.registry.debug.statusCode}`
    } resolve('claud')=${
      reading.registry.typo.ok ? 'resolved' : `${reading.registry.typo.errorName}/${reading.registry.typo.code}/${reading.registry.typo.statusCode}`
    }`,
    `[face 2 watcher] fixtureRoot=${reading.watcher.fixtureRoot} listed=${reading.watcher.fixtureListed} created=${reading.watcher.fixtureCreated} productRoots=${reading.watcher.productRoots.length} productRootsCreated=${reading.watcher.productRootsCreated.length}`,
    `[face 3 routes] mounted=${reading.routes.mounted} layersAdded=${reading.routes.layersAdded} layers=${JSON.stringify(reading.routes.layerNames)}`,
    `[face 3 routes] extension-less ${reading.routes.extensionless.path} -> ${reading.routes.extensionless.status} ${reading.routes.extensionless.contentType} ${JSON.stringify(reading.routes.extensionless.bodyHead)}`,
    `[face 3 routes] with-extension  ${reading.routes.suffixed.path} -> ${reading.routes.suffixed.status} ${reading.routes.suffixed.contentType} ${JSON.stringify(reading.routes.suffixed.bodyHead)}`,
  ].join('\n');
}

// Spelled with backticks so this file never contains the literal the scan looks
// for; the scan itself is what defines the target.
const ENV_READ_PATTERN = new RegExp(`process\\.env\\.(${GATE_VAR}|${GATE_HOME_VAR})\\b`);

/**
 * Every authored source file under `dir`.
 *
 * `node_modules/` is pruned: it holds vendored packages and this project's own
 * compiled e2e server bundle (`server/node_modules/.cache/quay-e2e-build/`),
 * neither of which is a read point somebody wrote. The bundle is compiled FROM
 * this tree, so counting it would report the gate module's own read back as a
 * second, independent decision — the exact thing this scan exists to rule out.
 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      found.push(...sourceFiles(absolute));
    } else if (/\.(ts|js|mts|cts|mjs|cjs)$/.test(entry.name)) {
      found.push(absolute);
    }
  }

  return found;
}

if (process.env[PROBE_VAR] === '1') {
  // Child mode: take the readings, print one line, exit without registering tests.
  const reading = await probe();
  console.log(`${PROBE_MARKER}${JSON.stringify(reading)}`);
} else {
  registerCriteria();
}

function registerCriteria(): void {
  test('closed gate: the debug agent does not exist in any of the three faces', () => {
    const { reading, scratch } = runChild('closed');

    try {
      console.log(describe(reading));

      // ---- Face 1 ----
      assert.equal(reading.gate.enabled, false, 'the gate must be closed with the variable unset');
      assert.equal(reading.registry.registered, false, 'face 1: the key must not be written while the gate is closed');
      assert.equal(reading.registry.debug.ok, false, 'face 1: the runtime id must not resolve while the gate is closed');
      assert.equal(reading.registry.typo.ok, false, 'the typo control must also fail');

      // "Indistinguishable from a typo": same error class, same code, same
      // status, and a message that differs only by the id that was asked for.
      const debugFailure = reading.registry.debug as { ok: false } & FailureReading;
      const typoFailure = reading.registry.typo as { ok: false } & FailureReading;
      assert.equal(debugFailure.errorName, typoFailure.errorName, 'face 1: a closed gate must fail like a typo (error class)');
      assert.equal(debugFailure.code, typoFailure.code, 'face 1: a closed gate must fail like a typo (code)');
      assert.equal(debugFailure.statusCode, typoFailure.statusCode, 'face 1: a closed gate must fail like a typo (status)');
      assert.equal(
        reading.registry.debugNormalized,
        reading.registry.typoNormalized,
        'face 1: the failure message must be identical once the requested id is blanked out',
      );

      // ---- Face 2 ----
      // The premise, asserted rather than assumed: this child HAD a fixture root
      // in its environment. Without this line the two readings below would pass
      // for a build that never resolved a root at all.
      assert.equal(reading.env.gateVar, null, 'the closed child must not have the gate variable set');
      assert.ok(reading.env.gateHome, 'the closed child must still carry the fixture root, or this face proves nothing');
      assert.ok(reading.watcher.fixtureRoot.length > 0, 'face 2: the fixture root must be well defined');

      assert.equal(reading.watcher.fixtureListed, false, 'face 2: the fixture root must not be in the observation set');
      assert.equal(reading.watcher.fixtureCreated, false, 'face 2: the fixture root must not be created');

      // The general form of the same reading, so the face is not satisfied by a
      // watcher that merely looks somewhere *else*: no root may be attributed to
      // the debug agent at all, whatever path it names.
      assert.deepEqual(
        reading.watcher.roots.filter(({ provider }) => provider === DEBUG_AGENT_PROVIDER_ID),
        [],
        'face 2: no root may be attributed to the debug agent while the gate is closed',
      );

      // Positive control: the same run must show the product roots being listed
      // AND created, otherwise "the fixture root was not created" would be
      // satisfied by a mkdir step that never ran at all.
      assert.ok(reading.watcher.productRoots.length > 0, 'face 2 control: the product roots must be listed');
      assert.equal(
        reading.watcher.productRootsCreated.length,
        reading.watcher.productRoots.length,
        'face 2 control: every listed product root must have been created by the mkdir step',
      );

      // ---- Face 3 ----
      assert.equal(reading.routes.mounted, false, 'face 3: the control plane must not attach while the gate is closed');
      assert.equal(reading.routes.layersAdded, 0, 'face 3: no middleware layer may be added at the control-plane path');

      // The discriminating reading: an unmounted `/api/...` path is served the
      // SPA shell as `200 text/html`, NOT 404 and NOT the control plane's answer.
      assert.equal(reading.routes.extensionless.status, 200, 'face 3: an unmounted API path is served the SPA shell');
      assert.ok(
        (reading.routes.extensionless.contentType ?? '').startsWith('text/html'),
        `face 3: the SPA shell is text/html, got ${reading.routes.extensionless.contentType}`,
      );
      assert.notEqual(reading.routes.extensionless.status, 401, 'face 3: the control plane must not answer here');
      assert.ok(
        !(reading.routes.extensionless.contentType ?? '').includes('json'),
        'face 3: the disabled path must not answer with the control plane JSON',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('open gate: all three faces exist (control arm)', () => {
    const { reading, scratch } = runChild('open');

    try {
      console.log(describe(reading));

      assert.equal(reading.gate.enabled, true, 'the gate must be open with a recognised value and a root');
      assert.equal(reading.registry.registered, true, 'face 1 control: the key must be written while the gate is open');
      assert.equal(reading.registry.debug.ok, true, 'face 1 control: the runtime id must resolve');
      assert.equal(
        (reading.registry.debug as { ok: true; sameObjectAsClaude: boolean }).sameObjectAsClaude,
        true,
        'face 1 control: resolution must return the registered object',
      );
      assert.equal(reading.registry.typo.ok, false, 'face 1 control: a typo must still fail');

      assert.equal(reading.watcher.fixtureListed, true, 'face 2 control: the fixture root must be observed');
      assert.equal(reading.watcher.fixtureCreated, true, 'face 2 control: the fixture root must be created');
      assert.deepEqual(
        reading.watcher.roots.filter(({ provider }) => provider === DEBUG_AGENT_PROVIDER_ID).map(({ rootPath }) => rootPath),
        [reading.watcher.fixtureRoot],
        'face 2 control: exactly the fixture root, attributed to the debug agent',
      );

      assert.equal(reading.routes.mounted, true, 'face 3 control: the control plane must attach');
      // The mount contributes exactly two layers, and their ORDER is the reading:
      // the auth middleware, then the router. (A fresh express app also gets its
      // own two bootstrap layers — `query` and `expressInit` — pushed lazily by
      // the first `use`, so the count is not the thing to assert.)
      assert.deepEqual(
        reading.routes.layerNames.slice(-2),
        ['authenticate', 'router'],
        'face 3 control: the path must gain the auth layer in front of the control-plane router',
      );
      assert.equal(reading.routes.extensionless.status, 401, 'face 3 control: the mounted path must not serve the SPA shell');
      assert.ok(
        (reading.routes.extensionless.contentType ?? '').includes('json'),
        'face 3 control: the control plane answers JSON',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('fail-closed: an unrecognised value, or an enabled gate with no root, both close and say why', () => {
    for (const state of ['closed-unrecognised-value', 'open-without-root'] as const) {
      const { reading, scratch } = runChild(state);

      try {
        console.log(`--- ${state} ---\n${describe(reading)}`);

        assert.equal(reading.gate.enabled, false, `${state}: the gate must be closed`);
        assert.ok(reading.gate.reason.length > 0, `${state}: a closed gate must print WHY it is closed`);
        assert.equal(reading.registry.registered, false, `${state}: face 1 must stay closed`);
        assert.equal(reading.routes.mounted, false, `${state}: face 3 must stay closed`);
        assert.equal(reading.routes.extensionless.status, 200, `${state}: face 3 must serve the SPA shell, not a control answer`);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  test('face 3 is not a status-code assertion: the same path is printed both ways', () => {
    const { reading, scratch } = runChild('closed');

    try {
      console.log(describe(reading));

      // Written with an extension, the SPA catch-all 404s (a real missing file);
      // written without one, it renders the shell. A criterion that asserted
      // "404" for this face would therefore be red against a correct
      // implementation AND blind to a gate that stayed mounted — the two
      // readings must differ, and it is the extension-less one that carries the
      // verdict.
      assert.equal(reading.routes.suffixed.status, 404, 'the suffixed variant is a genuinely missing file');
      assert.equal(reading.routes.extensionless.status, 200, 'the extension-less variant is the SPA shell');
      assert.notEqual(
        reading.routes.suffixed.status,
        reading.routes.extensionless.status,
        'the two writings must be distinguishable, or this face cannot be asserted at all',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('the gate has exactly one read point under server/', () => {
    const hits: string[] = [];

    for (const file of sourceFiles(SERVER_SRC)) {
      const relative = path.relative(REPO_ROOT, file);
      if (relative === GATE_MODULE_RELATIVE) {
        continue;
      }

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (ENV_READ_PATTERN.test(line)) {
          hits.push(`${relative}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    console.log(
      hits.length === 0
        ? `no direct gate reads outside ${GATE_MODULE_RELATIVE}`
        : `direct gate reads outside ${GATE_MODULE_RELATIVE}:\n${hits.join('\n')}`,
    );
    assert.deepEqual(hits, [], 'a consumer that parsed the gate variable itself would be a second, independently-wrong decision');
  });

  test('the server entrypoint is wired to the mount seam rather than left to remember it', () => {
    const entrypoint = fs.readFileSync(path.join(SERVER_SRC, 'index.ts'), 'utf8');
    const call = entrypoint
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .find(({ line }) => line.startsWith('if (mountDebugAgentControlPlane(app, authenticateToken))'));

    console.log(call ? `server/index.ts:${call.number}: ${call.line}` : 'server/index.ts does not call mountDebugAgentControlPlane');
    assert.ok(
      call,
      'the entrypoint must make the mount decision through the gate, with the real auth middleware in front of the router',
    );
  });
}

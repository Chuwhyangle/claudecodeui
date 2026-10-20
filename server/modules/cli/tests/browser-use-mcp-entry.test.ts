/**
 * AC (d) of `gap-server-root-browser-use-cycle-relocate-mcp-entry` — the MCP stdio entrypoint
 * still starts, and it still installs the server root's environment bootstrap.
 *
 * The task moved the entry from `server/modules/browser-use/browser-use-mcp.ts` into
 * `server/modules/cli/` so that `modules/browser-use` no longer imports the root bootstrap (the
 * `.` ↔ `modules/browser-use` SCC). A relocation that quietly dropped the `../../load-env.js`
 * import would satisfy the import-cycle ratchet and break the feature — the bootstrap supplies
 * `.env` and the default `DATABASE_PATH` the executable reads on start-up — so this criterion
 * drives the entry as a real subprocess instead of reading the file's text:
 *
 *   · leg 1 spawns the entry, writes ONE newline-delimited JSON-RPC `initialize` request to its
 *     stdin, and asserts the reply's `serverInfo.name`;
 *   · leg 2 imports the entry in a child that does NOT set `DATABASE_PATH` and asserts the
 *     bootstrap's user-level default (`~/.cloudcli/auth.db`) is in `process.env`, which is the
 *     deterministic observable of "load-env ran" — the presence of a `.env` file is not
 *     guaranteed, so the bootstrap itself cannot be observed through it.
 *
 * Both legs run the TypeScript source through `tsx` from the repository root: the entry is an
 * ESM module whose relative `../../load-env.js` resolves the same way from source and from the
 * built tree.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const APPLICATION_ROOT = path.resolve(TEST_DIRECTORY, '..', '..', '..', '..');
const TSX_CLI = path.join(APPLICATION_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SERVER_TSCONFIG = path.join(APPLICATION_ROOT, 'server', 'tsconfig.json');
const ENTRY_PATH = path.join(APPLICATION_ROOT, 'server', 'modules', 'cli', 'browser-use-mcp.ts');

/** The expected MCP server identity, pinned at `browser-use-mcp.ts`'s `initialize` handler. */
const EXPECTED_SERVER_NAME = 'cloudcli-browser';

/** The default the root bootstrap installs when `DATABASE_PATH` is unset (`server/load-env.ts`). */
const EXPECTED_DEFAULT_DATABASE_PATH = path.join(os.homedir(), '.cloudcli', 'auth.db');

/** Prepended to leg 2's probe output so it is locatable in a stream that may carry other lines. */
const BOOTSTRAP_PROBE_MARKER = '__CLOUDCLI_MCP_BOOTSTRAP__';

/** A child environment with no inherited `DATABASE_PATH` — leg 2 needs the unset shape. */
function environmentWithoutDatabasePath(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.DATABASE_PATH;
  return environment;
}

/** spawn()s `tsx <entry>`; the caller owns the child. */
function spawnWithTsx(scriptPath: string, environment: NodeJS.ProcessEnv) {
  return spawn(process.execPath, [TSX_CLI, '--tsconfig', SERVER_TSCONFIG, scriptPath], {
    cwd: APPLICATION_ROOT,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Leg 1: starts the entry exactly as a host would, asks `initialize`, and returns the whole
 * reply line as well as its parsed `result` (the raw line is what the task asks to paste).
 */
function requestInitialize(timeoutMs = 60_000): Promise<{ rawLine: string; result: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawnWithTsx(ENTRY_PATH, environmentWithoutDatabasePath());
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error: Error | null, value?: { rawLine: string; result: Record<string, unknown> }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(value as { rawLine: string; result: Record<string, unknown> });
    };

    const timer = setTimeout(() => {
      finish(new Error(`the MCP entry did not answer initialize within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // Not a JSON-RPC frame (e.g. an interleaved diagnostic); keep reading.
        }
        const frame = parsed as { result?: Record<string, unknown>; error?: unknown };
        if (frame.result) finish(null, { rawLine: line, result: frame.result });
        if (frame.error) finish(new Error(`the MCP entry answered initialize with an error: ${line}`));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.on('exit', (code) => {
      finish(new Error(`the MCP entry exited (code ${String(code)}) before answering initialize\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });

    // MCP stdio framing: one JSON-RPC message per line, no Content-Length header.
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'browser-use-mcp-entry-smoke', version: '0.0.0' },
      },
    })}\n`);
  });
}

/**
 * Leg 2: imports the entry in a fresh child, then prints what the bootstrap left in the
 * environment. The probe is a `.mts` file in a temp directory because `tsx` only transforms
 * files, not `--eval` strings, and it must not be collected by the suite's `*.test.ts` walk.
 */
async function readBootstrapEnvironment(): Promise<{ databasePath: string | null }> {
  const probeDirectory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-mcp-bootstrap-'));
  try {
    const probePath = path.join(probeDirectory, 'bootstrap-probe.mts');
    const probeSource = [
      `import ${JSON.stringify(pathToFileURL(ENTRY_PATH).href)};`,
      '',
      '// The entry listens on stdin for JSON-RPC frames. Reading the environment and exiting is the',
      '// probe\'s whole job, so it must not wait for a frame that will never arrive.',
      `process.stdout.write(${JSON.stringify(BOOTSTRAP_PROBE_MARKER)} + JSON.stringify({`,
      '  databasePath: process.env.DATABASE_PATH ?? null,',
      `}) + "\\n");`,
      'process.exit(0);',
      '',
    ].join('\n');
    await writeFile(probePath, probeSource, 'utf8');

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawnWithTsx(probePath, environmentWithoutDatabasePath());
      let collected = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`the bootstrap probe did not finish within 60s\nstdout:\n${collected}\nstderr:\n${stderr}`));
      }, 60_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        collected += chunk;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(collected);
        else reject(new Error(`the bootstrap probe exited with code ${String(code)}\nstdout:\n${collected}\nstderr:\n${stderr}`));
      });
    });

    const markerLine = stdout.split('\n').find((line) => line.includes(BOOTSTRAP_PROBE_MARKER));
    assert.ok(markerLine, `the bootstrap probe printed nothing — the entry never finished importing\nstdout:\n${stdout}`);
    return JSON.parse(markerLine.slice(markerLine.indexOf(BOOTSTRAP_PROBE_MARKER) + BOOTSTRAP_PROBE_MARKER.length)) as {
      databasePath: string | null;
    };
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
  }
}

test('the relocated MCP entry answers initialize as cloudcli-browser', async () => {
  const reply = await requestInitialize();
  console.log(`(d) initialize reply: ${reply.rawLine}`);

  const serverInfo = reply.result.serverInfo as { name?: unknown; version?: unknown } | undefined;
  assert.ok(serverInfo && typeof serverInfo === 'object', `the initialize result must carry serverInfo: ${reply.rawLine}`);
  assert.equal(serverInfo.name, EXPECTED_SERVER_NAME, `serverInfo.name must stay ${EXPECTED_SERVER_NAME}: ${reply.rawLine}`);
  assert.equal(reply.result.protocolVersion, '2024-11-05', 'the MCP protocol version must stay pinned');
});

test('the relocated MCP entry still installs the root environment bootstrap', async () => {
  const reading = await readBootstrapEnvironment();
  console.log(`(d) bootstrap DATABASE_PATH=${String(reading.databasePath)} expected=${EXPECTED_DEFAULT_DATABASE_PATH}`);
  console.log(`(d) probe legs: entry=${path.relative(APPLICATION_ROOT, ENTRY_PATH)}, DATABASE_PATH unset in the child`);

  // NOTE: this assertion is exact on purpose. It holds when neither the child environment nor a
  // repository `.env` sets DATABASE_PATH; no `.env` is committed (`git check-ignore .env`), and the
  // suite runs in worktrees that carry none, so the bootstrap's default is the only source.
  assert.equal(
    reading.databasePath,
    EXPECTED_DEFAULT_DATABASE_PATH,
    'importing the entry must run server/load-env.ts, which installs the user-level default DATABASE_PATH',
  );
});

/**
 * The staged probe: what it measures and how it reports a bad answer.
 *
 * Every case runs against a LOCAL http server wearing the gateway's shape, so
 * the numbers are real socket timings rather than mocked constants, and the
 * deployment's own gateway is never contacted:
 *   ① a delayed response surfaces in `firstByteMs`, not in `uploadMs`;
 *   ② a streaming answer reports the first content delta (`firstTokenMs`);
 *   ③ a 5xx keeps its timings and is reported `ok: false`;
 *   ④ a missing credential never opens a socket and names no machine path;
 *   ⑤ the CLI's context suffix is stripped before the model reaches the wire.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/api-latency/tests/api-latency-probe.test.ts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type { ResolvedApiLatencyGateway } from '@/shared/types.js';

import { createApiLatencyProbe } from '../api-latency-probe.service.js';
import {
  resolveApiLatencyGateway,
  stripContextSuffix,
} from '../api-latency-settings.service.js';

const MODEL = 'test-model';

function gatewayAt(
  baseUrl: string,
  token: string | null = 'test-token',
): (model?: string) => Promise<ResolvedApiLatencyGateway> {
  return async (model?: string) => ({
    baseUrl,
    host: new URL(baseUrl).host,
    model: model ?? MODEL,
    hasCredential: token !== null,
    credentialSource: token ? 'env' : null,
    token,
  });
}

async function withGateway(
  handler: http.RequestListener,
  run: (baseUrl: string, server: Server) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, server);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A fresh, non-pooling agent keeps the local server from being held open between cases. */
function probeFor(baseUrl: string, token: string | null = 'test-token') {
  return createApiLatencyProbe({
    resolveGateway: gatewayAt(baseUrl, token),
    agent: new http.Agent({ keepAlive: false }),
  });
}

test('a delayed answer lands in firstByteMs, not in uploadMs', async () => {
  await withGateway(
    (req, res) => {
      req.resume();
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg', content: [{ type: 'text', text: 'ok' }] }));
        }, 120);
      });
    },
    async (baseUrl) => {
      const result = await probeFor(baseUrl)({ mode: 'ping', stream: false });

      assert.equal(result.ok, true);
      assert.equal(result.status, 200);
      assert.ok(
        result.timings.firstByteMs >= 100,
        `firstByteMs ${result.timings.firstByteMs} should include the 120 ms wait`,
      );
      assert.ok(
        result.timings.uploadMs < 100,
        `uploadMs ${result.timings.uploadMs} should not absorb the gateway wait`,
      );
      assert.ok(result.timings.totalMs >= result.timings.firstByteMs);
      assert.equal(result.firstTokenMs, null);
    },
  );
});

test('a streaming answer reports the first content delta separately from the first byte', async () => {
  await withGateway(
    (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        setTimeout(() => {
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n');
          res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        }, 80);
      });
    },
    async (baseUrl) => {
      const result = await probeFor(baseUrl)({ mode: 'ping', stream: true });

      assert.equal(result.ok, true);
      assert.ok(result.firstTokenMs !== null, 'firstTokenMs must be recorded for a streaming probe');
      assert.ok(
        (result.firstTokenMs ?? 0) > result.timings.firstByteMs,
        `firstTokenMs ${result.firstTokenMs} should come after firstByteMs ${result.timings.firstByteMs}`,
      );
    },
  );
});

test('a 5xx keeps its timings and is reported as a failure', async () => {
  await withGateway(
    (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end('{"error":"bad gateway"}');
      });
    },
    async (baseUrl) => {
      const result = await probeFor(baseUrl)({ mode: 'ping', stream: false });

      assert.equal(result.ok, false);
      assert.equal(result.status, 502);
      assert.equal(result.error, null);
      assert.ok(result.timings.totalMs >= 0);
      assert.ok(result.responseBytes > 0);
    },
  );
});

test('upload mode sends a body that shows up as real bytes', async () => {
  await withGateway(
    (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"msg"}');
      });
    },
    async (baseUrl) => {
      const result = await probeFor(baseUrl)({ mode: 'upload', stream: false, uploadBytes: 64 * 1024 });

      assert.equal(result.ok, true);
      assert.ok(
        result.requestBytes >= 64 * 1024,
        `requestBytes ${result.requestBytes} should carry the synthetic upload`,
      );
      assert.ok(result.timings.uploadMs >= 0);
    },
  );
});

test('without a credential the probe fails before opening a socket', async () => {
  let touched = false;
  await withGateway(
    (req, res) => {
      touched = true;
      req.resume();
      res.writeHead(200).end('{}');
    },
    async (baseUrl) => {
      const result = await probeFor(baseUrl, null)({ mode: 'ping', stream: false });

      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /credential/i);
      // The sentence a user sees must not embed a machine path.
      assert.doesNotMatch(result.error ?? '', /\/home\/|\/Users\/|C:\\\\/);
      assert.equal(result.status, null);
    },
  );
  assert.equal(touched, false);
});

test('the CLI context suffix is stripped before the name reaches the gateway', () => {
  assert.equal(stripContextSuffix('deepseek-v4-pro-anthropic[1M]'), 'deepseek-v4-pro-anthropic');
  assert.equal(stripContextSuffix('deepseek-v4-pro-anthropic[1m]'), 'deepseek-v4-pro-anthropic');
  assert.equal(stripContextSuffix('claude-sonnet-4-5'), 'claude-sonnet-4-5');
});

test('the request carries the stripped model name', async () => {
  let receivedBody = '';
  await withGateway(
    (req, res) => {
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        receivedBody += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    },
    async (baseUrl) => {
      await probeFor(baseUrl)({ mode: 'ping', stream: false, model: 'deepseek-v4-pro-anthropic[1M]' });
    },
  );

  const parsed = JSON.parse(receivedBody) as { model: string };
  assert.equal(parsed.model, 'deepseek-v4-pro-anthropic');
});

// The resolver is the one place a deployment's gateway is read. These two cases
// pin its priority order and the browser-safe projection, without touching the
// real home: `homeDir` points at a temp directory that holds a settings file.
test('the gateway resolver prefers the process env over the CLI settings file', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = await mkdtemp(path.join(os.tmpdir(), 'api-latency-home-'));
  try {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://from-settings.example',
          ANTHROPIC_AUTH_TOKEN: 'settings-token',
          ANTHROPIC_MODEL: 'settings-model',
        },
      }),
      'utf8',
    );

    const fromSettings = await resolveApiLatencyGateway(undefined, { env: {}, homeDir: home });
    assert.equal(fromSettings.baseUrl, 'https://from-settings.example');
    assert.equal(fromSettings.host, 'from-settings.example');
    assert.equal(fromSettings.model, 'settings-model');
    assert.equal(fromSettings.credentialSource, 'settings.json');
    assert.equal(fromSettings.hasCredential, true);

    const fromEnv = await resolveApiLatencyGateway('env-model[1M]', {
      env: { ANTHROPIC_BASE_URL: 'https://from-env.example', ANTHROPIC_AUTH_TOKEN: 'env-token' },
      homeDir: home,
    });
    assert.equal(fromEnv.baseUrl, 'https://from-env.example');
    assert.equal(fromEnv.credentialSource, 'env');
    // A requested model wins, and its context suffix never reaches the wire.
    assert.equal(fromEnv.model, 'env-model');

    const bare = await resolveApiLatencyGateway(undefined, { env: {}, homeDir: home });
    assert.equal(bare.hasCredential, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

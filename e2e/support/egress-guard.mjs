// e2e/support/egress-guard.mjs
//
// WHY THIS EXISTS — the replay's "local only" property was configured, not enforced.
//
// `playwright.config.ts` makes the Live Voice replay local by choosing the environment (`VOICE_REALTIME_ENDPOINT`
// pointed at the spec's own loopback stand-in, `DASHSCOPE_API_KEY` blanked, the debug agent standing in for
// Claude). The webServer's environment is the runner's own `...process.env` plus those overrides, so it inherits
// every ambient variable this shell happens to carry. Nothing then WATCHES the server: a new code path — a
// telemetry ping, a font/CDN fetch, a model-gateway probe, a context-package warm-up — could dial the cloud
// during the replay and the criterion would not notice. The only existing reading of "zero cloud calls" is
// indirect: the upstream dial carried no `authorization` header.
//
// THIS MODULE IS THE MISSING WATCHER, for the server process only. Loaded with Node's `--import` in the voice
// realtime selection's webServer (see `playwright.config.ts`), it wraps the socket and name-resolution entry
// points the server could leave through and, for any target that is not loopback, (a) appends one JSON line to
// this run's `egress.jsonl` — when it happened, where to, through which call, and the first calling frame — and
// (b) REFUSES the dial with `ECONNREFUSED`, so the connection cannot complete. It covers `net.connect` /
// `net.createConnection` / `net.Socket.prototype.connect`, `tls.connect` (undici's https connector and the `ws`
// library both go through these) and the `dns` name-resolution functions; undici's own TCP/TLS connectors call
// the same `net`/`tls` entry points, so nothing needs a second, undici-specific hook.
//
// WHAT "LOOPBACK" MEANS HERE. `127.0.0.0/8`, `::1`, `localhost` and an absent host (a unix-domain path, or the
// `net.connect(port)` form whose default host is `localhost`). Everything else is external and is refused. The
// guard is a TEST-ONLY instrument: it never touches product code, and it is inert unless
// `QUAY_E2E_EGRESS_GUARD_LOG` is set in the process environment.
//
// THE LOG IS BOTH THE READING AND THE PROOF THE GUARD RAN. On install the guard CREATES the log file if it is
// absent (an empty file) and never truncates it. So the spec can tell the two states apart: "the file exists and
// is empty" is a real zero-egress reading (the guard was live and nothing left), while "the file is missing" is
// the guard never having loaded — which a `readFileSync(...).filter(Boolean) === []` would have reported as a
// vacuous pass.
//
// SELF-TEST. Run directly (`node e2e/support/egress-guard.mjs`) and it exercises itself: a loopback connect is
// allowed through, an external `net.connect` and an external `dns.lookup` are each recorded and refused. The
// exit code is the verdict. This is the AC2 reading; it needs no browser and no server.

import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

/** The environment variable that both selects the log path and switches the guard on, in the guarded process. */
export const EGRESS_GUARD_LOG_ENV = 'QUAY_E2E_EGRESS_GUARD_LOG';

/** The reason string on every refused dial, so a reader can tell a guarded refusal from a real connection error. */
export const EGRESS_BLOCKED_MARKER = 'EGRESS BLOCKED';

/**
 * The DNS entry points that resolve a NAME to an address. Wrapped as a group because undici, `ws` and raw
 * `net`/`tls` dials all reach one of them, and a name that leaves the loopback is the same event as a socket
 * that does.
 */
const DNS_FUNCTIONS = Object.freeze([
  'lookup',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
]);

/** Whether a host string names the loopback interface (or is absent — a unix path / the `net.connect(port)` default). */
export function isLoopbackHost(host) {
  if (host === null || host === undefined || host === '') return true;
  let h = String(host).trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped loopback, e.g. ::ffff:127.0.0.1
  if (h === '::ffff:127.0.0.1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.every((n) => n <= 255)) return octets[0] === 127;
    return false;
  }
  // Any IPv6 loopback form is covered by the `::1` test above; everything else is external.
  return false;
}

/** Whether a URL string targets the loopback interface (used by the browser-side check in the replay spec). */
export function isLoopbackUrl(url) {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The error a refused dial fails with — shaped like a real connection refusal so callers' error paths run as usual. */
function egressError(target) {
  const error = new Error(`${EGRESS_BLOCKED_MARKER}: the server tried to reach ${target}`);
  error.code = 'ECONNREFUSED';
  error.errno = -111;
  error.syscall = 'connect';
  return error;
}

/** The first stack frame outside this module — where in the server the dial was attempted. */
function firstCallingFrame() {
  const lines = (new Error().stack ?? '').split('\n').slice(1);
  for (const line of lines) {
    if (!line.includes('egress-guard.mjs')) return line.trim();
  }
  return lines[lines.length - 1]?.trim() ?? '';
}

/** Read the `(host, port)` a `net`/`tls` connect call is aimed at, across the module's overloads. */
function hostPortOf(args) {
  const [a, b] = args;
  if (typeof a === 'object' && a !== null) {
    return { host: a.host ?? a.hostname, port: a.port };
  }
  if (typeof a === 'number') {
    // net.connect(port, host?, cb?) — a string second argument is the host; anything else leaves the default (localhost).
    return { host: typeof b === 'string' ? b : undefined, port: a };
  }
  // A string first argument is a unix-domain socket path (local); the `{ path }` object form is handled above.
  return { host: undefined, port: undefined };
}

/**
 * The installed guard. Module-scoped so a double `--import` in one process cannot install twice.
 *
 * @type {{ restore: () => void, logPath: string, record: (via: string, host: unknown, port: unknown) => void } | null}
 */
let installed = null;

/**
 * Install the guard, writing refused dials to `logPath`.
 *
 * @param {{ logPath: string }} options
 * @returns {NonNullable<typeof installed>}
 */
export function installEgressGuard({ logPath } = {}) {
  if (typeof logPath !== 'string' || logPath.length === 0) {
    throw new Error('installEgressGuard: a logPath is required');
  }
  if (installed) return installed;

  // The file's EXISTENCE is the "the guard is live" reading; it starts empty and is never truncated, so a
  // record written by an earlier process (tsx re-spawns) survives.
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '');
  } catch {
    /* the guard must never keep the server from starting; a log it cannot create still refuses dials */
  }

  const record = (via, host, port) => {
    const target = port === undefined || port === null ? String(host) : `${host}:${port}`;
    const line = {
      at: new Date().toISOString(),
      via,
      target,
      frame: firstCallingFrame(),
    };
    try {
      fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`);
    } catch {
      /* see above: a failed write is silent, the refusal below still stands */
    }
  };

  const loopbackConnect = (via, args, delegate) => {
    const { host, port } = hostPortOf(args);
    if (isLoopbackHost(host)) return delegate(...args);
    record(via, host, port);
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(egressError(port === undefined || port === null ? String(host) : `${host}:${port}`)));
    return socket;
  };

  const originalNetConnect = net.connect;
  const originalNetCreateConnection = net.createConnection;
  const originalSocketConnect = net.Socket.prototype.connect;
  const originalTlsConnect = tls.connect;
  const originalDns = new Map();
  const originalDnsPromises = new Map();

  net.connect = function guardedConnect(...args) {
    return loopbackConnect('net.connect', args, originalNetConnect.bind(net));
  };
  net.createConnection = function guardedCreateConnection(...args) {
    return loopbackConnect('net.createConnection', args, originalNetCreateConnection.bind(net));
  };
  net.Socket.prototype.connect = function guardedSocketConnect(...args) {
    const { host, port } = hostPortOf(args);
    if (isLoopbackHost(host)) return originalSocketConnect.apply(this, args);
    const target = port === undefined || port === null ? String(host) : `${host}:${port}`;
    record('net.Socket.prototype.connect', host, port);
    process.nextTick(() => this.destroy(egressError(target)));
    return this;
  };
  tls.connect = function guardedTlsConnect(...args) {
    return loopbackConnect('tls.connect', args, originalTlsConnect.bind(tls));
  };

  for (const name of DNS_FUNCTIONS) {
    const original = dns[name];
    if (typeof original !== 'function') continue;
    originalDns.set(name, original);
    dns[name] = function guardedDns(...args) {
      const hostname = args[0];
      if (isLoopbackHost(hostname)) return original.apply(dns, args);
      record(`dns.${name}`, hostname, undefined);
      const callback = [...args].reverse().find((arg) => typeof arg === 'function');
      if (typeof callback === 'function') {
        process.nextTick(() => callback(egressError(String(hostname))));
        return undefined;
      }
      return original.apply(dns, args);
    };
  }

  if (dns.promises && typeof dns.promises === 'object') {
    for (const name of DNS_FUNCTIONS) {
      const original = dns.promises[name];
      if (typeof original !== 'function') continue;
      originalDnsPromises.set(name, original);
      dns.promises[name] = function guardedDnsPromise(...args) {
        const hostname = args[0];
        if (isLoopbackHost(hostname)) return original.apply(dns.promises, args);
        record(`dns.promises.${name}`, hostname, undefined);
        return Promise.reject(egressError(String(hostname)));
      };
    }
  }

  const restore = () => {
    net.connect = originalNetConnect;
    net.createConnection = originalNetCreateConnection;
    net.Socket.prototype.connect = originalSocketConnect;
    tls.connect = originalTlsConnect;
    for (const [name, original] of originalDns) dns[name] = original;
    for (const [name, original] of originalDnsPromises) dns.promises[name] = original;
    installed = null;
  };

  installed = { restore, logPath, record };
  return installed;
}

// ---- self-test -------------------------------------------------------------------------------

/** One self-test assertion, printed for the reader. */
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${label}${detail ? ` :: ${detail}` : ''}`);
  return ok;
};

/**
 * Exercise the guard end to end without a server or a browser: loopback passes, external is recorded and refused.
 *
 * @returns {Promise<number>} the process exit code
 */
async function selfTest() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'egress-guard-selftest-'));
  const logPath = path.join(dir, 'egress.jsonl');
  const guard = installEgressGuard({ logPath });
  const results = [];

  // 1. A loopback connect is ALLOWED (a real local server accepts it).
  const local = net.createServer((socket) => socket.end());
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const localPort = local.address().port;
  const allowed = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: localPort }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
  results.push(check('loopback connect is allowed', allowed === true));
  await new Promise((resolve) => local.close(resolve));

  // 2. An EXTERNAL net.connect is recorded and refused.
  const externalNet = await new Promise((resolve) => {
    const socket = net.connect({ host: 'example.com', port: 443 });
    socket.on('error', (error) => resolve(error));
    socket.on('connect', () => {
      socket.destroy();
      resolve(new Error('the external connect was NOT refused'));
    });
  });
  results.push(
    check(
      'external net.connect is refused with ECONNREFUSED',
      externalNet instanceof Error && externalNet.code === 'ECONNREFUSED',
      externalNet?.message,
    ),
  );

  // 3. An EXTERNAL dns.lookup is recorded and refused.
  const externalDns = await new Promise((resolve) => {
    dns.lookup('example.com', (error, address) => resolve(error ?? new Error(`resolved to ${address} instead of refusing`)));
  });
  results.push(
    check(
      'external dns.lookup is refused',
      externalDns instanceof Error && externalDns.code === 'ECONNREFUSED',
      externalDns?.message,
    ),
  );

  // 4. The log carries exactly the two refusals and names the external target.
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  results.push(check('exactly the two external attempts were recorded', lines.length === 2, `lines=${lines.length}`));
  results.push(
    check(
      'each recorded target names example.com',
      lines.length === 2 && lines.every((line) => String(line.target).includes('example.com')),
      lines.map((line) => `${line.via}:${line.target}`).join(' | '),
    ),
  );
  results.push(
    check(
      'each record carries the first calling frame',
      lines.every((line) => typeof line.frame === 'string' && line.frame.length > 0),
      lines[0]?.frame,
    ),
  );

  guard.restore();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((ok) => !ok).length;
  console.log(`\nself-test: ${results.length - failed}/${results.length} passed`);
  return failed === 0 ? 0 : 1;
}

// ---- auto-install when preloaded -------------------------------------------------------------

const preloadLog = process.env[EGRESS_GUARD_LOG_ENV];
if (typeof preloadLog === 'string' && preloadLog.length > 0) {
  installEgressGuard({ logPath: preloadLog });
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && process.argv[1].length > 0 && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  selfTest().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error('self-test crashed:', error);
      process.exitCode = 1;
    },
  );
}

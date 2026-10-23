import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  createQuayFleetCliReader,
  locateQuayFleetCli,
  quayFleetBinPath,
  QUAY_FLEET_BIN_ENV,
  QUAY_FLEET_HANDSHAKE_TTL_MS,
  type QuayFleetCliCommandResult,
  type QuayFleetCliExec,
} from '../quay-fleet-locator.js';

/**
 * The single fleet-CLI locator and its contract handshake.
 *
 * THE LOOKUP ORDER IS THE CONTRACT: an explicit `QUAY_FLEET_BIN` wins, then `PATH`, then the
 * stable `~/.quay-fleet/bin/quay-fleet` symlink. Three consumers used to parse this themselves
 * and disagreed; these criteria drive the ONE implementation with injected environment, PATH
 * and filesystem probes, so they measure the production order rather than a reimplementation.
 *
 * THE HANDSHAKE IS THE CONTRACT, NOT THE VERSION STRING: `contracts` decides compatibility.
 * A CLI that does not answer `--version` (`no-handshake`) stays usable during the transition;
 * a CLI that answers with a different contract is `incompatible` and names the contract.
 *
 * RUNNER NOTE: a server test, run through `tsx --test` (see `scripts/test.sh`); vitest's
 * include is `src/**` and would find no tests here.
 */

/** The handshake this CloudCLI build speaks. */
const SUPPORTED = { wallUri: 'v0', registry: 1, interfaceSession: 'v0' } as const;

/** A `quay-fleet --version --json` document. */
function handshakeDocument(
  contracts: { wallUri?: string; registry?: number; interfaceSession?: string } = SUPPORTED,
  version = '1.4.0',
): string {
  return JSON.stringify({ name: 'quay-fleet', version, contracts });
}

function okResult(stdout: string): QuayFleetCliCommandResult {
  return { ok: true, code: 0, stdout, stderr: '' };
}

/** An exec seam that records every file/argv it was handed and answers with one document. */
function recordingExec(result: QuayFleetCliCommandResult): {
  exec: QuayFleetCliExec;
  calls: { file: string; args: readonly string[] }[];
} {
  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: QuayFleetCliExec = async (file, args) => {
    calls.push({ file, args: [...args] });
    return result;
  };
  return { exec, calls };
}

/** A reader whose host has no fleet at all: every lookup probe answers false. */
function absentReader(extra: Parameters<typeof createQuayFleetCliReader>[0] = {}) {
  let spawned = false;
  const exec: QuayFleetCliExec = async () => {
    spawned = true;
    throw new Error('a missing CLI must not be spawned');
  };
  const reader = createQuayFleetCliReader({
    env: {},
    pathEnv: '',
    homeDir: path.resolve('/home/operator'),
    isExecutable: () => false,
    exec,
    ttlMs: 0,
    ...extra,
  });
  return { reader, spawned: () => spawned };
}

test('AC1: QUAY_FLEET_BIN is used verbatim, ahead of PATH and the home symlink', async () => {
  const { exec, calls } = recordingExec(okResult(handshakeDocument()));
  const reader = createQuayFleetCliReader({
    env: { [QUAY_FLEET_BIN_ENV]: '/opt/fleet-checkout/bin/quay-fleet' },
    pathEnv: '/usr/local/bin',
    homeDir: path.resolve('/home/operator'),
    // Everything on PATH and in the home directory is executable too: the env override must
    // still win, so the assertion measures precedence rather than availability.
    isExecutable: () => true,
    exec,
  });

  const reading = await reader.read();

  assert.equal(reading.binPath, '/opt/fleet-checkout/bin/quay-fleet');
  assert.deepEqual(calls.map((call) => call.file), ['/opt/fleet-checkout/bin/quay-fleet']);
  assert.deepEqual(calls[0]?.args, ['--version', '--json']);
  assert.equal(reading.state, 'ok');
});

test('AC1: with no override, the first executable quay-fleet on PATH wins', async () => {
  const empty = path.resolve('/opt/empty/bin');
  const wanted = path.resolve('/opt/fleet/bin', 'quay-fleet');
  const { exec, calls } = recordingExec(okResult(handshakeDocument()));
  const reader = createQuayFleetCliReader({
    env: {},
    pathEnv: [empty, path.resolve('/opt/fleet/bin')].join(path.delimiter),
    homeDir: path.resolve('/home/operator'),
    // Only the second directory holds an executable, and the home symlink is absent.
    isExecutable: (candidate) => candidate === wanted,
    exec,
  });

  const reading = await reader.read();

  assert.equal(reading.binPath, wanted);
  assert.deepEqual(calls.map((call) => call.file), [wanted]);
  assert.equal(reading.state, 'ok');
});

test('AC1: with no override and no PATH hit, ~/.quay-fleet/bin/quay-fleet is the fallback', async () => {
  const home = path.resolve('/home/operator');
  const wanted = path.join(home, '.quay-fleet', 'bin', 'quay-fleet');
  const { exec, calls } = recordingExec(okResult(handshakeDocument()));
  const reader = createQuayFleetCliReader({
    env: {},
    pathEnv: path.resolve('/opt/empty/bin'),
    homeDir: home,
    isExecutable: (candidate) => candidate === wanted,
    exec,
  });

  const reading = await reader.read();

  assert.equal(reading.binPath, wanted);
  assert.deepEqual(calls.map((call) => call.file), [wanted]);
  // The pure lookup reports the source too, so an operator can tell WHERE it came from.
  assert.deepEqual(locateQuayFleetCli({
    env: {},
    pathEnv: path.resolve('/opt/empty/bin'),
    homeDir: home,
    isExecutable: (candidate) => candidate === wanted,
  }), { binPath: wanted, source: 'home' });
});

test('AC1: none of the three sources ⇒ missing, and nothing is spawned', async () => {
  const { reader, spawned } = absentReader();

  const reading = await reader.read();

  assert.equal(reading.state, 'missing');
  assert.equal(reading.available, false);
  assert.equal(reading.binPath, null);
  assert.equal(reading.version, null);
  assert.equal(reading.contracts, null);
  assert.ok((reading.reason ?? '').length > 0, 'a missing CLI must state where it looked');
  assert.equal(spawned(), false, 'a lookup miss must not fork a child that cannot exist');
  // The spawn-name helper still names the bare command for an injected exec seam.
  assert.equal(quayFleetBinPath({ env: {}, pathEnv: '', homeDir: '', isExecutable: () => false }), 'quay-fleet');
});

test('AC2: matching contracts read ok, with the CLI version reported for logs', async () => {
  const { exec } = recordingExec(okResult(handshakeDocument(SUPPORTED, '2.0.1')));
  const reader = createQuayFleetCliReader({
    env: { [QUAY_FLEET_BIN_ENV]: '/opt/fleet/bin/quay-fleet' },
    exec,
    ttlMs: 0,
  });

  const reading = await reader.read();

  assert.equal(reading.state, 'ok');
  assert.equal(reading.available, true);
  assert.equal(reading.version, '2.0.1');
  assert.deepEqual(reading.contracts, { wallUri: 'v0', registry: 1, interfaceSession: 'v0' });
  assert.equal(reading.reason, null);
});

test('AC2: a newer wallUri is incompatible, and the reason names wallUri', async () => {
  const { exec } = recordingExec(
    okResult(handshakeDocument({ ...SUPPORTED, wallUri: 'v1' })),
  );
  const reader = createQuayFleetCliReader({
    env: { [QUAY_FLEET_BIN_ENV]: '/opt/fleet/bin/quay-fleet' },
    exec,
    ttlMs: 0,
  });

  const reading = await reader.read();

  assert.equal(reading.state, 'incompatible');
  assert.equal(reading.available, false);
  assert.match(reading.reason ?? '', /wallUri/, 'the reason must name the contract that differs');
  assert.doesNotMatch(reading.reason ?? '', /registry|interfaceSession/, 'only the differing contract is named');
  // The binary and version are still reported: "wrong contracts" is not "not installed".
  assert.equal(reading.binPath, '/opt/fleet/bin/quay-fleet');
  assert.equal(reading.version, '1.4.0');
});

test('AC2: an older fleet without --version reads no-handshake, still available', async () => {
  const { exec } = recordingExec({
    ok: false,
    code: 1,
    stdout: '',
    stderr: 'quay-fleet: unknown command: --version',
  });
  const reader = createQuayFleetCliReader({
    env: { [QUAY_FLEET_BIN_ENV]: '/opt/fleet/bin/quay-fleet' },
    exec,
    ttlMs: 0,
  });

  const reading = await reader.read();

  assert.equal(reading.state, 'no-handshake');
  assert.equal(reading.available, true, 'an un-upgraded fleet must keep working during the transition');
  assert.equal(reading.binPath, '/opt/fleet/bin/quay-fleet');
  assert.equal(reading.contracts, null);
  assert.match(reading.reason ?? '', /unknown command/, 'the CLI\'s own refusal is the stated reason');
});

test('AC2: a timed-out handshake is its own reason (not missing) and never throws', async () => {
  const { exec } = recordingExec({
    ok: false,
    code: null,
    stdout: '',
    stderr: '',
    error: 'quay-fleet --version timed out: killed after 10000ms',
  });
  const reader = createQuayFleetCliReader({
    env: { [QUAY_FLEET_BIN_ENV]: '/opt/fleet/bin/quay-fleet' },
    exec,
    ttlMs: 0,
  });

  const reading = await reader.read();

  assert.equal(reading.state, 'no-handshake');
  assert.notEqual(reading.state, 'missing');
  assert.equal(reading.available, true);
  assert.match(reading.reason ?? '', /timed out/, 'the timeout must be the reason, distinct from "missing"');
});

test('AC2: a throwing exec seam is a value, not a rejected promise', async () => {
  const exec: QuayFleetCliExec = async () => {
    throw new Error('spawn EACCES');
  };
  const reader = createQuayFleetCliReader({
    env: { [QUAY_FLEET_BIN_ENV]: '/opt/fleet/bin/quay-fleet' },
    exec,
    ttlMs: 0,
  });

  const reading = await reader.read();

  assert.equal(reading.state, 'no-handshake');
  assert.match(reading.reason ?? '', /EACCES/);
});

test('AC2: one handshake is reused for its TTL, then asked again', async () => {
  let now = 1_000_000;
  let spawns = 0;
  const exec: QuayFleetCliExec = async () => {
    spawns += 1;
    return okResult(handshakeDocument());
  };
  const reader = createQuayFleetCliReader({
    env: { [QUAY_FLEET_BIN_ENV]: '/opt/fleet/bin/quay-fleet' },
    exec,
    now: () => now,
    ttlMs: QUAY_FLEET_HANDSHAKE_TTL_MS,
  });

  await reader.read();
  assert.equal(spawns, 1);
  now += 1_000;
  await reader.read();
  assert.equal(spawns, 1, 'inside the TTL the handshake is reused');
  now += QUAY_FLEET_HANDSHAKE_TTL_MS;
  await reader.read();
  assert.equal(spawns, 2, 'past the TTL an upgraded fleet is re-read');
});

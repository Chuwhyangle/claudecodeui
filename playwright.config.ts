import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { defineConfig } from '@playwright/test';

import { fsAvailableBytes, resolveE2eDataDir } from './scripts/e2e-data-dir-selection.mjs';
import { prepareServerBundle } from './scripts/e2e-server-bundle.mjs';
import { reclaimDataDirs } from './scripts/e2e-data-dir-retention.mjs';
import { resolveClientRoot } from './scripts/e2e-client-root.mjs';
import { webServerStderrLogs, withStderrLog } from './scripts/e2e-web-server-stderr.mjs';
import {
  ASSEMBLY_TEMP_ROOT_ENV,
  PROBE_FILE_NAME,
  assemblyTempCandidates,
  planAssembly,
} from './scripts/e2e-assembly-budget.mjs';

/**
 * This config's own directory.
 *
 * The file is loaded as an ES module, where `__dirname` does not exist — referencing it throws before a single test
 * is collected, so the fallback path below has to be derived from the module's own URL instead. It is the same
 * directory Playwright itself resolves `testDir` against, which is why the fallback and the config agree.
 */
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The archived Silence Tail Suppression spec (GOAL-044 / AC-364).
 *
 * A human ruling on 2026-10-14 (「STS 已证实无效，取消生产调用」), landed by
 * `gap-live-voice-sts-production-disconnect` (commit `b6b60a95a`), removed the `silenceTail` seam from the
 * production assembly (`buildVoiceRealtimeSeams` in `server/index.ts` never hands the gate to the proxy, under
 * any env), so `createSilenceTailGate` is unreachable in a real server process. The spec's e2e leg measures
 * exactly that — the gate the REAL server process assembles — and that gate no longer exists, so the leg is
 * unsatisfiable by design and AC-364 was retired (`superseded`) rather than turned green.
 *
 * The spec file is archived BYTE-FOR-BYTE (never rewritten to assert "no suppression") and stays nameable: it
 * is only taken out of the DEFAULT collection (`testIgnore` below, keyed on whether this invocation named it on
 * the command line). Naming it explicitly still runs it.
 */
const ARCHIVED_SILENCE_TAIL_SPEC = 'voice-realtime-silence-tail-suppression.spec.ts';

/**
 * When this file started being evaluated — the first moment of the run that can be observed from here.
 *
 * The watchdog below reports its elapsed time against this, so the number it prints covers config evaluation
 * and seeding as well as everything Playwright does afterwards.
 */
const runStartedAt = Date.now();

/**
 * The same instant, published so a spec can print the wall clock of the run it is part of.
 *
 * A criterion's ceiling is on the whole `npx playwright test` invocation — config evaluation, seeding, server
 * boot, browser launch — while a spec can only see itself: a spec that timed its own body would report a number
 * whose shortfall against the ceiling is the part it could not observe. Workers re-evaluate this file, so the
 * guard matters: without it each worker would overwrite the owner's reading with its own start and the printed
 * number would again be "since this worker began". The value set here is the earliest this file has ever run.
 */
if (!process.env.QUAY_E2E_RUN_STARTED_AT) {
  process.env.QUAY_E2E_RUN_STARTED_AT = String(runStartedAt);
}

// Everything the servers persist lives under one throwaway directory so the run never touches real user data.
// Exported through the environment so worker processes (which re-evaluate this file) share the directory and the spec can put a project workspace inside it.
//
// Which directory that is — and whether there is room for it — is decided in `scripts/e2e-data-dir-selection.mjs`,
// not by an unconditional `mkdtempSync(path.join(os.tmpdir(), …))`. `os.tmpdir()` reads `TMPDIR`, the driver's
// environment does not set it, and so every run on this host used to land on the root filesystem whatever its
// remaining space was: when the run did not fit, it failed as `ENOSPC` / `net::ERR_INSUFFICIENT_RESOURCES` *inside*
// a case that was measuring something else entirely. The selection reads each candidate's filesystem at the moment
// it chooses, prints the three numbers it chose by, and refuses to start the run when nothing has room — see the
// module for the readings that fix its shape.
const dataDirSelection = resolveE2eDataDir();
const dataDir = dataDirSelection.dataDir;
/** True only in the process that created the directory: workers re-evaluate this file with it already set. */
const isDataDirOwner = !dataDirSelection.explicit;
process.env.QUAY_E2E_DATA_DIR = dataDir;
/**
 * ...and the same reading published, because the assignment above destroys the evidence for it: every worker
 * inherits `QUAY_E2E_DATA_DIR` set, so asking the question again inside a spec would answer "someone else owns
 * this directory" for a run that created it. Guarded for the same reason the run clock is — the owner's answer is
 * the first one, and the workers re-evaluate this file with it already in the environment.
 */
if (process.env.QUAY_E2E_DATA_DIR_OWNER === undefined) {
  process.env.QUAY_E2E_DATA_DIR_OWNER = String(isDataDirOwner);
}

/**
 * Reclaims the run directories earlier runs left behind, before this run starts writing.
 *
 * Every run creates a directory under the parent the selector chose and nothing used to remove it, so
 * the parent grew at the run rate forever. Measured on this host on 2026-09-28: `~/.cache/quay-e2e-tmp`
 * held 1794 directories / 103 GB, all created within 24 hours — and the pool is a *user quota*, not a
 * filesystem size, so `df` still reported 3.3 TB free while writes failed with `EDQUOT` (`errno -122`).
 * The failures landed before any test started (Playwright's own transform-cache `open`, a `copyfile` of
 * the auth database, an `mkdtemp` of the next run's directory), which is what made a green criterion
 * report as red for reasons none of its own assertions could name.
 *
 * Only the owner sweeps: a worker re-evaluates this file long after the run is under way, and its
 * `dataDir` is the directory being protected, not one to reclaim against. The directory this run just
 * created is excluded, so the sweep can never remove the run it is part of — and it is passed as an
 * absolute path, which the module reduces to the name it compares against.
 *
 * The work is bounded (2 s by default) and never fatal: the module reports what it could not read or
 * remove instead of throwing, because a run that died of its own housekeeping would be the defect this
 * closes arriving from the other side. The bound drains the pool over runs rather than all at once: at
 * the ~89 ms measured for a 3371-file directory it reclaims ~20 directories per run, against the one
 * directory a run creates. `scripts/e2e-data-dir-retention.mjs` is the module; `npm run e2e:reclaim`
 * is the same sweep as a manual entry, unbounded and with the byte count reported.
 */
if (isDataDirOwner) {
  reclaimDataDirs({
    parent: path.dirname(dataDir),
    exclude: [dataDir],
    log: (line) => console.log(line),
  });
}

/**
 * The dependency cache this run's Vite is told to use, under the run's own throwaway directory.
 *
 * Vite's default is `<cwd>/node_modules/.vite`, and that default is one mutable directory shared by every
 * checkout on the machine: `dispatch-worktree-setup.sh` links each task worktree's `node_modules` to the main
 * checkout's, so the symlink resolves to the same directory for all of them. Sharing alone would only be a
 * hazard; what makes it a defect is that Vite is *guaranteed* to rewrite it. Its staleness check compares a
 * `configHash` that includes `root`, `root` defaults to the process cwd, and a worktree's cwd is by
 * construction a different path from the main checkout's — so a run in a worktree finds the cache another root
 * wrote "stale because vite config has changed" and re-optimizes it. Re-optimizing swaps the `browserHash`
 * that is baked into every dependency URL, and a page another run already has in flight is holding the old
 * hash: each of its requests then answers `504 (Outdated Optimize Dep)`, the pre-bundled `react` chunk and its
 * siblings arrive from two different builds, React's dispatcher is null by the time a hook runs, and the app's
 * own error boundary replaces the chat interface. Pointing each run at a directory of its own removes the
 * shared mutable state rather than widening anyone's tolerances.
 */
const viteCacheDir = path.join(dataDir, 'vite-cache');

/**
 * Where this run's scratch space goes — and whether it can be prepared before the browser needs it.
 *
 * The data directory above was moved off `os.tmpdir()`; the rest of the run's scratch was not. Chromium's
 * user-data directory, `tsx`'s transform cache, Node's compile cache and Playwright's own transform cache are
 * all created under `os.tmpdir()`, which reads `TMPDIR`, which the driver's environment does not set — so
 * every run on this host writes them onto the root filesystem, shared with the whole fleet. The criterion this
 * config serves is bounded at 35 s for its whole leg, assembly included; when that shared filesystem is under
 * the load a fleet puts on it, the first page load does not finish inside that budget and the leg dies in
 * `expandProject()` with a bare `Test timeout of 35000ms exceeded` — the same failure a broken replay pair
 * would produce, and with none of the criterion's own wording to tell them apart. Measured on this host on
 * 2026-09-26: six concurrent runs of the criterion with `TMPDIR` unset failed 6/6 that way, and the same six
 * with each run's scratch on the 4 TB volume passed 6/6.
 *
 * So the run's scratch is pointed at a directory of its own, inside the directory that was already chosen for
 * having room, and the choice is made by `scripts/e2e-assembly-budget.mjs` under a budget so that a
 * preparation that cannot finish is refused *here* — before any server or browser starts, naming the target —
 * rather than surfacing later as a case that timed out for reasons it cannot see. `TMPDIR` itself is set
 * rather than passed to the children alone: this is the same variable the whole process tree reads, and the
 * browser is launched from it.
 *
 * Re-evaluation is free by construction: a worker inherits `TMPDIR` already pointed at the owner's directory,
 * and the probe file left by the owner's warm-up is what `isWarmed` reads, so the second evaluation prepares
 * nothing.
 */
const probePath = (target: string) => path.join(target, PROBE_FILE_NAME);
const assemblyPlan = planAssembly({
  candidates: assemblyTempCandidates({ env: process.env, dataDir }),
  availableBytes: fsAvailableBytes,
  isWarmed: (target) => fs.existsSync(probePath(target)),
  warm: (target) => {
    fs.mkdirSync(target, { recursive: true });
    // The probe is written, not merely the directory created: a directory that exists is equally what
    // someone else's run, or a run that died, leaves behind — "prepared" has to be about this run's own
    // writing for a worker's re-evaluation to be able to trust it.
    fs.writeFileSync(probePath(target), `${new Date().toISOString()} ${process.pid}\n`);
  },
});
if (!assemblyPlan.ok) {
  // Ending the run here, synchronously, for the reason the data-directory refusal gives above: on a pipe
  // `console.error` hands the line off asynchronously, and the refusal text is the whole product of the path.
  fs.writeSync(2, `${assemblyPlan.reason}\n`);
  process.exit(1);
}
const [assemblyTarget] = assemblyPlan.targets.length > 0 ? assemblyPlan.targets : assemblyPlan.prepared;
const assemblyReading = 'warmed' in assemblyPlan ? assemblyPlan.warmed[0] : undefined;
process.env.TMPDIR = assemblyTarget;
process.env[ASSEMBLY_TEMP_ROOT_ENV] = assemblyTarget;
console.log(
  `[e2e] assembly-scratch=${assemblyTarget} prepared=${assemblyPlan.skipped ? 'already' : 'now'}`
    + ` elapsed-ms=${assemblyPlan.elapsedMs}`
    + ` available-bytes=${assemblyReading?.availableBytes ?? 'n/a'}`,
);

/**
 * Asks the kernel for two free TCP ports, held at the same time so it cannot hand back the same one twice,
 * and releases them on the way out.
 *
 * The ports cannot be literals. A port is a machine-wide resource, not a checkout-wide one: with two fixed
 * numbers, any second e2e run — another spec in a sibling worktree, another agent, the fleet's own re-runs —
 * races this one for the same pair, and the loser dies during server boot with "is already used" instead of
 * reporting anything about the code under test. One kernel-assigned pair per run gives each run its own.
 *
 * `listen(0)` is asynchronous and Playwright evaluates this file synchronously, so the lookup runs in a
 * short-lived child process. Closing before the webServer binds leaves a window that is small and, without
 * handing Playwright a listening socket it cannot accept, unavoidable.
 */
const freePortPair = (): [number, number] => {
  const stdout = execFileSync(
    process.execPath,
    [
      '-e',
      `const net = require('node:net');
const listen = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
(async () => {
  const first = await listen();
  const second = await listen();
  process.stdout.write([first.address().port, second.address().port].join(' '));
  await Promise.all([first, second].map((server) => new Promise((done) => server.close(done))));
})().catch((error) => { console.error(error.message); process.exit(1); });`,
    ],
    // Bounded: this call blocks the event loop, so a child that never exits would also stop the watchdog
    // below from firing — a config lookup with no deadline is the same defect this file keeps closing.
    { encoding: 'utf8', timeout: 10_000 },
  );
  const [serverPort, clientPort] = stdout.trim().split(/\s+/).map(Number);
  return [serverPort, clientPort];
};

/**
 * One kernel-assigned port, for a server the SPEC hosts rather than this file.
 *
 * The same reasoning as `freePortPair`, with one extra consequence: a spec that
 * binds a socket has to be told which port, so the value travels through the
 * environment (published below) rather than being read back by the spec. Kept
 * separate from the pair because it is the stand-in upstream the voice criterion
 * dials — the server holding it and the client holding the browser are both
 * already addressed by the pair above.
 */
const freePort = (): number => {
  const stdout = execFileSync(
    process.execPath,
    [
      '-e',
      `const net = require('node:net');
const server = net.createServer();
server.once('error', (error) => { console.error(error.message); process.exit(1); });
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port));
  server.close();
});`,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  return Number(stdout.trim());
};

/**
 * Workers re-evaluate this file, and `baseURL` is read there — so the pair has to travel through the
 * environment like `dataDir` does, or a worker would address a server nobody started. Only the process that
 * allocated publishes it, and only that process announces it.
 */
const chosePorts = process.env.QUAY_E2E_SERVER_PORT === undefined;
const [serverPort, clientPort] = chosePorts
  ? freePortPair()
  : [Number(process.env.QUAY_E2E_SERVER_PORT), Number(process.env.QUAY_E2E_CLIENT_PORT)];
process.env.QUAY_E2E_SERVER_PORT = String(serverPort);
process.env.QUAY_E2E_CLIENT_PORT = String(clientPort);
if (chosePorts) {
  // On stdout rather than in a log file: it lands in the run's own captured output, so a red recorded from
  // this run can be read back as "which pair did it hold", which the stderr-head excerpt cannot answer.
  console.log(`[e2e] server=${serverPort} client=${clientPort}`);
}

/**
 * Reports which of `ports` cannot be bound right now. Runs in a child process for the same reason
 * `freePortPair` does: `listen` is asynchronous and this file is evaluated synchronously.
 */
const findTakenPorts = (ports: number[]): number[] => {
  const stdout = execFileSync(
    process.execPath,
    [
      '-e',
      `const net = require('node:net');
const probe = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(port));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(0)));
});
(async () => {
  const taken = (await Promise.all([${ports.join(', ')}].map(probe))).filter(Boolean);
  process.stdout.write(taken.join(' '));
})().catch((error) => { console.error(error.message); process.exit(1); });`,
    ],
    // Bounded for the same reason `freePortPair`'s is: this is a synchronous block, and the watchdog cannot
    // fire while the event loop is held.
    { encoding: 'utf8', timeout: 10_000 },
  );
  return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
};

/**
 * Refuses to hand Playwright ports this run cannot bind, before it is given them.
 *
 * Playwright asks each webServer URL whether something is already serving it *before* it spawns the command,
 * and that probe has no deadline and no timeout of its own: a listener that accepts the connection but never
 * answers makes the check wait forever. The run then never reaches `webServer.timeout` below, never exits, and
 * the goal gate that caps the criterion at 60s kills it as an unattributable timeout — leaving the servers it
 * did start holding their ports into the next run. Binding each port once here turns the same condition into an
 * immediate failure that names the port, which is what a red run has to say to be actionable.
 *
 * This check is a *snapshot*, taken here, and Playwright's probe happens after it: a port that gets taken in
 * between is let through by this check and still hangs the probe. That window is closed by the watchdog below,
 * which is the run's own ceiling and names whatever stage it finds the run stuck in.
 *
 * Only the process that is about to start the servers probes. Workers re-evaluate this file long after both
 * are listening, so a probe there would report the run's own servers as the conflict; the flag rides the same
 * environment channel as `dataDir` and the port pair, which workers are already known to inherit.
 */
if (process.env.QUAY_E2E_PORTS_VERIFIED === undefined) {
  const taken = findTakenPorts([serverPort, clientPort]);
  if (taken.length > 0) {
    throw new Error(
      `e2e port(s) ${taken.join(', ')} are already in use by another process, so this run's servers cannot bind them. `
        + 'Failing now, naming the port, rather than waiting on a health check that has no deadline.',
    );
  }
  process.env.QUAY_E2E_PORTS_VERIFIED = '1';
}

/**
 * The url each webServer is told to serve, declared once so the watchdog probes exactly what Playwright was
 * given rather than a second copy of the same two strings that could drift away from it.
 */
const SERVER_HEALTH_URL = `http://127.0.0.1:${serverPort}/health`;
const CLIENT_URL = `http://127.0.0.1:${clientPort}`;
const RUN_SERVERS = [
  { name: 'server', url: SERVER_HEALTH_URL },
  { name: 'client', url: CLIENT_URL },
];

/**
 * What one spec's own run is allowed to take, and what the run's ceiling is assembled from: the specs this
 * invocation was actually asked to run, each carrying its own budget.
 *
 * The gate's 60s kill is what `SINGLE_SPEC_CEILING_MS` is derived against — see the block below — and it binds a
 * *criterion*, which is one file. A full-tree `npx playwright test` is not that invocation: it is every spec in
 * the directory, one after another, and the eleven that shipped before this task measured ~5 minutes on this
 * host. A ceiling derived for one file applied to that run kills it mid-tree, which reads exactly like a hang —
 * the failure mode this whole watchdog exists to make legible, arriving from the watchdog itself. So the bound is
 * per-file and summed over the selection, and the shipped single-file value becomes the *default* every spec
 * keeps unless it declares otherwise. Every invocation that names no declaring spec — one file, often narrowed
 * further with `-g` — computes `SINGLE_SPEC_CEILING_MS` and is bounded exactly as before; a spec that declares a
 * budget keeps it for every selection of it, `-g` included, because the startup the declaration is about is not
 * what a grep removes.
 *
 * The budgets are declarations, not guesses, and the reason they are a table rather than a formula is that
 * runtime is a property of the file: a quiet spec costs a handful of seconds and one that records audio twice
 * per viewport costs minutes. Each declared entry's own comment names the run it was measured against and the
 * headroom it leaves, which is the same kind of reading `SINGLE_SPEC_CEILING_MS` is sized from (voice-trim's
 * ~42s against 55s).
 */
const SINGLE_SPEC_CEILING_MS = 55_000;
/** Per-spec budgets that differ from `SINGLE_SPEC_CEILING_MS`. Keyed by basename so the rule holds from any cwd. */
const SPEC_BUDGET_MS: Record<string, number> = {
  // The architecture tab's geometry criterion: cases in one worker, each
  // driving a real page (two viewports of the main arm, the semantic-zoom
  // readings, and control arms that inject a defect style and re-read).
  // Measured 2026-10-22 on this worktree: `4 passed (35.2s)` for the whole
  // invocation — boot, both servers and the browser launch included — against
  // the 55 s single-file default. Re-measured 2026-10-23 with the text-selection
  // legs (three canvas gestures + the dock leg in the PC main arm, and control
  // arm E's inject/restore round trip): `8 passed (54.2s)`, still inside the
  // entry below. Re-measured again 2026-10-23 with the semantic-zoom polish
  // (title collision, ghost-label, `×N` halo and stroke-width readings, plus
  // control arm F's avoidance-off injection): `9 passed (1.0m)`. Re-measured
  // 2026-10-23 with the mobile density legs (the phone readout/cluster rows,
  // the too-small hint + package-tap round trip, and control arm G's forced
  // vertical cluster): `10 passed (1.1m)`. 120_000 is what the sibling
  // interaction-heavy entries below declare; it keeps a load-slowed fan-in run
  // from being killed mid-case by the watchdog while leaving ~50% headroom over
  // the measured wall clock (boot, both servers and the browser launch included).
  // Raised to 240_000 for the semantic-zoom rewrite (2026-10-23): the main arm
  // now walks five zoom levels on BOTH viewports and the control arm injects
  // four defects, which adds two real pages and ten readings to the same
  // invocation. 240_000 is the value the other interaction-heavy entries below
  // declare; the measured wall clock is recorded in the task's Evidence.
  // Re-measured 2026-10-23 after the semantic-polish defects: the main arm reads
  // the CLASS diagram for two fixture shapes on both viewports at six zoom
  // levels, plus the pinned-entity round trip and two new control arms:
  // `12 passed (2.2m)` for the whole invocation (boot + both servers + browser
  // launch included), and `8 passed (58.0s)` for the `--grep "control arm"`
  // selection. 240_000 still clears the full-file measurement ~1.8x, so the
  // entry stays; the numbers above are the readings it was checked against.
  // Raised to 360_000 on 2026-10-23 for the two render regressions: the file now
  // also drives the perimeter-routing fixture and the interleaved-member fixture
  // on both viewports at the five negotiated levels plus the 100 % baseline, and
  // the control arm crops/restores the viewBox and swaps/restores member rows.
  // Measured full-file wall clock (boot + both servers + browser launch + 14
  // cases): `14 passed (3.7m)` on this worktree, 2026-10-23. 360_000 keeps ~1.6x
  // over that reading while leaving the earlier 240_000 ceiling behind.
  // Re-measured 2026-10-23 with the "Show all" / folded-fit cases: the function
  // fixture's 396-box drawing is laid out TWICE per case on a real ELK main
  // thread (once to widen, once to Fit), in the main arm and again in the
  // control arm. MEASURED twice: `19 passed (4.1m)` and `19 passed (3.8m)` for
  // the whole invocation, and `11 passed (1.4m)` for the `--grep "control arm"`
  // selection. 480_000 keeps ~2.1x over the slower reading — the headroom the
  // 360_000 entry held, which a load-slowed fan-in reload needs.
  // Re-measured 2026-10-23 with the panel-visibility legs (an expanded Scope
  // cleanup panel in its own fixture workspace, three hover readings, three
  // preset switches plus a page reload, and a drill round trip; the control arm
  // replays a stale graph body through `page.route` and toggles a kind): the
  // whole invocation is `21 passed (5.1m)` and the `--grep "control arm"`
  // selection is `12 passed (2.0m)`. The two new cases are 34.5 s and 32.5 s of
  // that. 660_000 restores the ~2.1x headroom over the whole-file reading.
  // Re-measured 2026-10-23 with the chrome/drawer/paper/banner legs (the phone
  // drawer arm, the PC project-search arm, and the one control arm carrying the
  // four injected chrome defects): the whole invocation is `24 passed (5.4m)`
  // and the `--grep "control arm"` selection is `13 passed (2.0m)`; the three
  // new cases took 10.9 s, 6.8 s and 11.4 s of that. 660_000 still clears the
  // 5.4m reading ~2.0x.
  // Re-measured 2026-10-23 on the tree that also carries the node-size legs (a
  // main arm at both viewports that opens the Inspector and the Text page, and
  // a control arm drawing the same fixture WITHOUT the member caps through the
  // DEV-only lever): `26 passed (5.6m)` for the whole invocation. 660_000 still
  // clears that reading ~2.0x, so the entry stays.
  // Re-measured 2026-10-23 with the layout-orientation legs (a two-entity chain
  // whose DOWN layout is a narrow column: main arm at PC+phone, the control
  // arm's forced-DOWN round trip through a fresh page, and the wider-viewport /
  // >150-entity looks): `29 passed (6.8m)` for the whole invocation. 660_000
  // still clears that reading ~1.6x, so the entry stays.
  // Re-measured 2026-10-24 with the landscape-phone legs (a 844×390 touch page
  // that reads the 240px canvas floor, the 30% default zoom and the in-flow
  // side column, plus its two control arms): the file now declares 31 cases.
  // Under concurrent host load (several sibling Playwright runs were live) one
  // whole-file run crossed the old 660_000ms ceiling at case 26/31 and the
  // watchdog ended it there; the ceiling — not a hang — was the limit. The
  // two new cases cost ~29s together when run alone. 1_200_000 is the value
  // that lets a load-slowed run finish while remaining a ceiling (a quiet
  // 31-case run is expected around 7.3m from the 6.8m / 29-case reading).
  // Re-measured 2026-10-24 with the portrait-phone chrome matrix (one page per
  // S/M/L/Quay fit-contract shape, which also arms four extra sessions, plus
  // the two-arm control test) and the four stale Focus-era legs repaired to the
  // single-scale contract: the file declares 33 cases and the whole invocation
  // MEASURED `33 passed (7.0m)` on this worktree (boot, both servers and the
  // browser launch included); the `--grep "control arm"` selection measured
  // `17 passed (2.8m)`. 1_200_000 keeps ~2.9x over the full-file reading, so
  // the entry stays. The 396-box cases also carry their own 300 s per-test
  // ceilings: a load-shared host pushed them past the old 180 s.
  'architecture-canvas-layout.spec.ts': 1_200_000,
  // The four-doors criterion: two real pages (PC and phone), each opening the
  // architecture tab and walking the same four entry points — inspector,
  // context menu, tray, Text page — with a tab round trip and a draft clear
  // between each. MEASURED 2026-10-23 on this worktree: `4 passed (35.8s)` for
  // the whole invocation — config evaluation, both webServers' boot, the
  // browser launch, the fixture and both viewports included; the four cases
  // (four doors and the two-entity legs, PC and phone) took 7.7 s, 8.1 s,
  // 7.6 s and 6.3 s. 240_000 is what the sibling architecture
  // entry above declares and clears that measurement more than tenfold, which
  // leaves room for a load-slowed fan-in run without changing what is measured.
  'architecture-send-to-chat.spec.ts': 240_000,
  // The keyboard criterion: one real page that Tabs into the class drawing,
  // enters the entity-navigation state, walks it with arrow keys, selects and
  // multi-selects, pins and undoes, and runs the aria-activedescendant control
  // arm. MEASURED on this worktree 2026-10-23: the whole invocation (config
  // evaluation, both webServers' boot, the browser launch, the 120-entity
  // fixture and its scenario) took `1 passed (16.3s)`; the case body itself
  // reported `elapsed=16136ms` from the run's start. 240_000 is the sibling
  // architecture entries' value and clears that measurement ~14x, leaving room
  // for a load-slowed fan-in run without changing what is measured.
  'architecture-keyboard.spec.ts': 240_000,
  // The fullscreen criterion: three real pages (PC 1440×765, phone portrait
  // 390×844, phone landscape 844×390), each opening the class drawing,
  // selecting an entity, entering the overlay, reading the drawing host's box
  // against the viewport, exiting and re-reading the restored layout — plus a
  // fourth page that starts a real turn, exits the overlay with Escape and
  // re-runs the same reading with `stopPropagation` removed (the control arm).
  // MEASURED 2026-10-23 on this worktree: `4 passed (31.7s)` for the whole
  // invocation — config evaluation, both webServers' boot, the browser launch,
  // the fixture and all four cases included. 240_000 is the sibling
  // architecture entries' value and clears that measurement ~7.5x, which leaves
  // room for a load-slowed fan-in run without changing what is measured.
  'architecture-fullscreen.spec.ts': 240_000,
  // The standalone-page criterion: ONE case that drives three real standalone
  // pages and the workspace page in one context — open-in-new-tab, the two-page
  // pin/Adjusted reading, a cross-tab send into the composer, a BroadcastChannel
  // control arm that must leave the composer empty, the clipboard fallback after
  // the workspace tab closes, and an `?entity=` deep link. The two deliberate
  // 1.5 s fallback waits plus a 2 s control wait are part of what it measures.
  // MEASURED on this worktree 2026-10-24 over three consecutive runs: the whole
  // invocation read `1 passed (23.9s)`, `1 passed (17.2s)` and `1 passed
  // (31.1s)` — config evaluation, both webServers' boot, browser launch, the
  // fixture and every leg included (the last case body reported
  // `elapsed=30841ms` from the run's start). 240_000 clears the slowest reading
  // ~7.7x and leaves a load-slowed fan-in run the same headroom as the sibling
  // architecture entries.
  'architecture-standalone.spec.ts': 240_000,
  // The single-scale / fit contract drives FOUR fixtures (2, 26, 55 and 19
  // entities) on FOUR viewports, reading the canvas after load, Fit, a window
  // resize, fullscreen and the Inspector on each — sixteen page/state matrices
  // in one case, plus three control arms that inject a defect and re-read.
  // MEASURED on this worktree 2026-10-24: the whole invocation read
  // `5 passed (2.8m)` — config evaluation, both webServers' boot, browser
  // launch, the four fixtures and every reading included; the per-viewport
  // cases closed at 41.9s / 74.6s / 115.1s / 152.3s and the control arms at
  // 167.6s. 600_000 keeps ~3.6x over that reading, the same load-slowed
  // fan-in headroom the sibling architecture criteria declare.
  'architecture-fit-contract.spec.ts': 600_000,
  // This file holds three describes and five cases, each driving a real browser
  // against a real debug-agent turn and running serially in one worker. The 55s
  // single-file default is sized for one such case; applied to this whole file it
  // kills a healthy run mid-case. Measured 2026-10-09, the whole file took 64.9s
  // (AC-184 14.5s, AC-185 1.3s, this file's own ceiling self-check 1ms, AC-188
  // 17.4s, AC-187 16.0s, plus ~16s of config evaluation, both webServers' boot,
  // the browser launch and the three `beforeAll` startup paths). 240_000 is the
  // same value the other entries here declare for a run whose ceiling is not the
  // goal gate's 60s kill, and clears that measurement ~3.7x.
  'activity-dock-truthful.spec.ts': 240_000,
  'mobile-workspace-composer-layout.spec.ts': 240_000,
  // The landing criterion takes 24 real-mouse jumps (eight per viewport) and
  // holds each one still for 1.5s before moving on, so its measured run is
  // ~1-2 minutes — past the 55s single-file default, and declared here rather
  // than left to be killed by the watchdog mid-case.
  'transcript-jump-landing.spec.ts': 240_000,
  // The live VAD reading takes an A/B over real corpus samples: it decodes and
  // segments L3-sparse (274 s) and L4-nonstop (141 s) in the page, uploads the
  // pieces to a stand-in recogniser, and runs two fake-microphone legs — several
  // multi-megabyte page loads past the 55s single-file default. Declared here,
  // for the same reason as the entry above: a watchdog kill mid-case says
  // nothing about what it was measuring.
  'voice-live-vad-ab.spec.ts': 240_000,
  // The unanswered-turn criterion (gap-live-voice-upstream-stall-no-answer): its arm has to CROSS
  // the bridge's own 8s stall deadline before the late answer lands, so the first of its two cases
  // costs ~14s that no other voice case pays. Measured 2026-10-11, `2 passed (26.4s)` for the cases
  // with the whole invocation at 27.3s against the 55s single-file default — enough headroom to
  // declare rather than discover. 120_000 clears that measurement ~4.4x and, unlike the entries
  // above, still fits the goal gate's 60s kill, so the criterion can run this file alone.
  'voice-realtime-turn-unanswered.spec.ts': 120_000,
  // This file's last case drives a real voice queue: six `session_send` calls against a session held
  // mid-turn by its own scenario, to fill the relay's bound and read the refusal. It cannot be made
  // faster — the relay's coalescing window is a hardcoded 2.5 s with no env seam, so every queued
  // message costs a full window (that case alone measured 15.7 s on this host). With the file's other
  // five cases (~27.5 s together) and its boot (~11 s) the default 55 s single-file ceiling kills a
  // healthy run mid-case, which is a watchdog red saying nothing about what it was measuring. 240_000
  // is the same value the entries above declare.
  'voice-realtime-upload-fixture.spec.ts': 240_000,
  // This file's eight cases each drive a real browser against ONE shared scripted upstream. Two of them
  // HOLD a run open on its own scenario clock (the interrupt case and the leave case, the latter waiting
  // for a row written 20 s into the run), and the queue case pays the relay's hardcoded 2.5 s coalescing
  // window per queued instruction — the same costs the upload-fixture entry above declares. Measured
  // 2026-10-11: `8 passed (1.2m)`, the cases alone summing to 62.9 s (1.6 + 0.0 + 2.8 + 17.3 + 2.0 + 6.7
  // + 25.7 + 6.8) plus ~11 s of config evaluation, boot and browser launch. The default 55 s single-file
  // ceiling kills a healthy run mid-case: it did, at 55 000 ms, reported stuck in "browser-launch-or-cases"
  // after six of the eight cases had passed. 240_000 is the same value the entries above declare and clears
  // this measurement ~2.9x.
  'voice-realtime-scripted-scenarios.spec.ts': 240_000,
  // The 2026-10-12 segmented-session replay: three scripted replays of one recorded Live Voice
  // session in one beforeAll (two branches + an attribution variant), one of which must CROSS the
  // bridge's 8 s stall deadline, plus two 2.5 s coalescing windows per branch. Estimated ~2 min
  // with boot; 360_000 leaves room for the per-red worker restarts (each re-reads the cached replay).
  'voice-realtime-segmented-replay-20261012.spec.ts': 360_000,
  // The one case here walks a scenario clock: three `unattended-turn` steps 25 s apart (each of which the
  // case waits on, because the app's run registry holds one run per session and the turn in front of each
  // spoken sentence is what makes the send a PUSH), then an `await-release` barrier and the queue steps —
  // ~81 s of engine time, plus the app's boot and the browser launch. The 55 s single-file ceiling kills a
  // healthy run mid-case. Measured 2026-10-12 on the merged tree (worktree `…-pending-utterance-withdraw`,
  // `with-memory-cap.sh`, one worker): the case reported 1.4 min and the whole invocation 1.5 min (90 s),
  // boot and browser launch included — see the task's `## Notes`. 240_000 is the value the sibling
  // resident/voice entries above declare, and clears that measurement ~2.7x.
  'voice-pending-utterance-withdraw.spec.ts': 240_000,
  // The continuous-experience baseline (GOAL-044 / AC-361): one 12.1 s fake-mic timeline played at the
  // capture's own cadence, with the scripted endpoint's acoustic detector closing an utterance per
  // spoken run, plus a resident session held busy across the first 3 s of each delivery's own turn.
  // The audio is real time by construction — the whole point is that the app receives it while
  // streaming — so the floor is the timeline itself, not a guess. Measured 2026-10-12 on this worktree:
  // 32.3 / 32.7 / 31.5 s of test time over three consecutive runs (see the task's `## Notes`). 240_000
  // clears that ~7x, the same value the sibling voice entries declare.
  'voice-realtime-continuous-experience.spec.ts': 240_000,
  // The intent-control criterion (gap-live-voice-intent-control-browser-e2e / AC-345, GOAL-041), plus the
  // busy-release criterion's end-to-end arm (gap-live-voice-busy-release-quiet-window-next-priority / AC6,
  // which shares this file's busy walk because the busy hold's browser readings already live here): eight
  // cases against ONE shared scripted upstream and ONE shared browser. Every case enters and leaves Live
  // Voice at least once, several do it twice, and each pays the relay's hardcoded 2.5 s coalescing window
  // per queued instruction — the same costs the entries above declare. That cost is spread over eight
  // cases rather than concentrated in one, so each case stays well inside `test.describe`'s own 120 s
  // budget while the FILE does not fit the default 55 s single-file ceiling, which is what this map
  // overrides.
  //
  // 240_000 was copied from the sibling resident/voice entries above, not measured on THIS file, and it
  // did not hold. The file has grown from six cases to eight, and its wall clock climbs with host load:
  // on 2026-10-21 the criterion recorded 10 consecutive passes between 04:29:44Z and 05:24:27Z (trees
  // 2a6e927a ×5, 56634553 ×2, 568a1212, f96f8cf5, d60fe1d0), with rounds 1186-1190 reporting
  // 105.8 / 134.6 / 121.3 / 147.9 / 174.1 s; the next run, inside a fan-in full-suite window, crossed
  // 240_000 and was SIGKILLed mid-case — gate event `ffe23041-b229-41cb-a944-5bdfe3ba3cca`,
  // 2026-10-21T05:30:43.688Z, tree `34fc0d7b1dcec5430eae37c965f359ef1a0aa6ab`, with `loadavg`
  // 55.79-71.02 across the suite that covered it and 65.77-129.14 across the overlapping AC-194 one,
  // on this 128-core host, and seven of the eight cases already passed (`test-results/` held one
  // failure directory). The red was the watchdog's budget, not an assertion.
  //
  // 360_000 is that red window's 240 s crossing × 1.5. It also leaves the record's own gate threshold
  // (`goals/AC-345-…md`, `timeoutMs: 420000`) ≥ 60 s of headroom for the watchdog to write its state
  // file, print its line and reclaim its servers before the gate's kill lands — the ordering the boot
  // ceiling's comment above spells out for the 60 s cap, at this budget's scale.
  'voice-realtime-intent-control.spec.ts': 360_000,
  // The silence-tail suppression criterion (GOAL-044 / AC-364): one 4.2 s fake-mic timeline — a short
  // spoken run, three seconds of digital silence, a second spoken run — played at the capture's own
  // cadence, because the silence has to be a DURATION the relay can pay a tail across rather than a
  // missing burst. Smaller than every sibling voice entry's timeline; the entry exists because the
  // file is also gated by the runner's boot, so it does not fit `SINGLE_SPEC_CEILING_MS`. MEASURED
  // 2026-10-13 on this worktree: `node_modules/.bin/playwright test
  // e2e/voice-realtime-silence-tail-suppression.spec.ts` → `4 passed (14.8s)` — the spec is a few
  // seconds of that, the rest is the shared server boot. 240_000 keeps the same headroom as the
  // sibling voice entries rather than pinning a tight per-file ceiling to a boot-dominated reading.
  'voice-realtime-silence-tail-suppression.spec.ts': 240_000,
  // The double-drop browser criterion (GOAL-043 / AC-368): TWO real-browser branches — the six-segment
  // segmented timeline driven through a double socket death, and the permanent disconnect — each with
  // its own account, scenario arm, page boot and voice entry, plus the 1.15 s waits the fault plan
  // names. Roughly two sibling timelines in one file, so the budget is the sibling 240_000 rather than
  // the segmented-replay entry's 360_000: the criterion reads a single run under 100 s and this file
  // has been measured inside it.
  'voice-realtime-double-drop.spec.ts': 240_000,
  // The stream-representation criterion (gap-live-voice-stream-delivery-not-command): one continuous-wire
  // timeline — a scripted final transcription, the settle window, the busy hold's card, the quiet-window
  // release and a scenario turn that writes the consumed message — against one shared server boot. The
  // settle window is 2.5 s of the timeline and the hold's quiet window is another 2 s, so the file does
  // not fit the default 55 s single-file ceiling; 240_000 is the sibling voice entries' value.
  'live-voice-stream-representation.spec.ts': 240_000,
  // The E0 end-to-end replay harness (voice-output-e2e-harness): one frozen corpus window is played
  // through the fake capture graph in REAL TIME (the default sample's window is ~19.5 s), then the
  // relay round trip, the TTS request and the browser's own playback are waited on. The file is
  // therefore floor-bound by the recording itself, not by a fixture of a few seconds; 240_000 is the
  // sibling voice entries' value and clears the ~40 s the run was measured at.
  'voice-output-e2e-harness.spec.ts': 240_000,
  // The composer-embedded bar criterion (GOAL-035 / AC-323): seven serial cases against ONE shared debug
  // agent and one shared scripted upstream, each entering and leaving Live Voice at least once. Two of them
  // wait on a REAL delivery round trip (the transcript row the session writes back) and one holds a
  // disconnected bar for 6 s of wall clock to read that no auto-reconnect happens, so the file is
  // floor-bound by round trips rather than by fixture lengths. It shipped without a budget entry because
  // its single-file run then measured 17.6–25.5 s; it has since grown to seven cases and
  // now crosses the 55 s default mid-case, where the watchdog ends the run with a red that says nothing
  // about what it was measuring (measured 2026-10-21: killed at 55 006 ms with three of seven cases done).
  // With this entry the same invocation reports `7 passed (56.6s)`, 57.4 s wall clock — 240_000 is the
  // sibling voice entries' value and clears that measurement ~4.2x.
  'voice-realtime-composer-embedded.spec.ts': 240_000,
  // The UI scenario runner criterion: TWO scenario families, each with a green arm and a control
  // arm whose report must name the failing step. The Quay wall family opens the Quay view and
  // drives six steps; the cockpit family navigates session → cockpit → back to the same session
  // through the product's mode switch. Every arm launches its own Chromium and its own runner, so
  // the file is several real page boots deep before its own assertions — and the wall family is
  // explicitly skipped on a host whose quay-fleet registry does not know the temporary fixture
  // project (it publishes no view contract there). MEASURED 2026-10-24 on this worktree, wall
  // family skipped: `1 passed, 1 skipped (13.1s)`, the whole invocation 13.5 s (config evaluation,
  // both servers' boot and the runner launches included); the earlier one-family run was
  // `1 passed (10.1s)`. 240_000 is the sibling interaction-heavy entries' value and clears those
  // measurements; it is declared rather than left to the 55 s single-file default so a
  // load-slowed fan-in run is not killed mid-case by the watchdog.
  'ui-scenario-runner.spec.ts': 240_000,
  // The cockpit's reading hierarchy: one browser, two cases — the fleet stage's ordinal label
  // measured off its COMPUTED style (font size against the body text, WCAG AA contrast resolved
  // from the painted colours), the board rail's task-id/title naming, then the control arm that
  // injects the small-light-type defect onto the same element and re-reads through the same
  // function. MEASURED 2026-10-23 on this worktree: `2 passed (15.2s)` and `2 passed (16.8s)` over
  // two consecutive runs — the whole invocation, config evaluation, both servers and the browser
  // launch included. 120_000 is the sibling interaction-heavy entries' value and clears that
  // measurement ~7x with room for a load-slowed fan-in run, rather than leaving the file to the
  // 55 s single-file default.
  'cockpit-visual.spec.ts': 120_000,
  // The phone remote driving the desktop stage: two cases, each opening two real browser
  // contexts (a desktop stage and a phone remote) against one hub. The main arm waits for the
  // display's visible-set report, presses the phone's direction pad, then submits a phrase and
  // waits for the desktop's view to follow; the control arm mints a second user's token against
  // the run's own database and asserts that user's remote moves only its own hub. MEASURED
  // 2026-10-23 on this worktree: `2 passed (17.2s–19.7s)` across runs for the whole
  // invocation — config evaluation, both servers and the browser launches included. 240_000 is the sibling
  // interaction-heavy entries' value and clears that measurement with room for a load-slowed
  // fan-in run, rather than leaving the file to the 55 s single-file default.
  'cockpit-remote.spec.ts': 240_000,
  // The observation wall's layout criterion: three real pages (PC 1440×900, phone 390×844, and
  // the phone control arm) against the stubbed wall, each reading computed typography, contrast,
  // tap targets and the last tile's box against the bottom bar — plus the control arm that
  // injects a fixed transparent bar and re-reads through the same function) and two DoD
  // walkthroughs (pin five objects, open a preview, watch the delta clear, browser-back; then
  // the same path on a phone). MEASURED on this worktree 2026-10-24: `5 passed (19.5s)` for the
  // whole invocation (config evaluation, both webServers' boot and all five browser launches
  // included; the three layout cases alone read 16.9s). 240_000 is the sibling cockpit entries'
  // value and clears that measurement ~12x, leaving room for a load-slowed fan-in run.
  'cockpit-observation-wall.spec.ts': 240_000,
};

/**
 * The flags whose value is the token *after* them, so a value can never be mistaken for a spec path. Short of
 * listing them, `-g e2e/foo.spec.ts` would read its own grep pattern as a second file to run.
 */
const VALUE_TAKING_FLAGS = new Set([
  '-g',
  '--grep',
  '--grep-invert',
  '-c',
  '--config',
  '--reporter',
  '--project',
  '--workers',
  '-j',
  '--timeout',
  '--global-timeout',
  '--output',
  '--retries',
  '--repeat-each',
  '--max-failures',
  '-x',
  '--shard',
  '--last-failed',
]);

/** The `*.spec.ts` files inside a directory, or `[]` when it is not one. Empty rather than throwing: a ceiling is not a reason for a run to die. */
const specFilesIn = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir).filter((entry) => entry.endsWith('.spec.ts'));
  } catch {
    return [];
  }
};

/**
 * The spec files this invocation NAMES on the command line — `[]` when it names none.
 *
 * This is the raw named-token reading, without the full-tree fallback `selectedSpecFiles()` applies, because
 * one caller (the `testIgnore` that keeps the archived spec out of the default collection) must tell "the
 * operator named this file" apart from "the fallback swept up every spec in `testDir`". Playwright's own
 * selection language is wider than this (globs, `--project`, `--last-failed`); the shapes that exist in this
 * checkout are "one file, maybe with `-g`" and the bare full-tree invocation, both covered here.
 */
const namedSpecFiles = (): string[] =>
  process.argv
    .slice(1)
    .filter((token, index, all) => !token.startsWith('-') && !VALUE_TAKING_FLAGS.has(all[index - 1] ?? ''))
    .filter((token) => token.endsWith('.spec.ts'))
    .flatMap((token) => {
      const target = path.resolve(process.cwd(), token);
      return fs.existsSync(target) && fs.statSync(target).isDirectory() ? specFilesIn(target) : [path.basename(target)];
    });

/**
 * Whether this invocation named the archived Silence Tail spec on the command line.
 *
 * Keyed on the RAW named tokens (not `selectedSpecFiles()`): the default no-argument run has an empty named set
 * and must EXCLUDE the archived spec, while naming it explicitly must still resolve it. This is the single
 * predicate behind the `testIgnore` below, so the two readings cannot drift apart.
 */
const archivedSilenceTailSelected = namedSpecFiles().includes(ARCHIVED_SILENCE_TAIL_SPEC);

/**
 * The spec files this invocation names on the command line, or every spec in `testDir` when it names none.
 *
 * The full-tree fallback drops the archived Silence Tail spec: it is red by design after the 2026-10-14
 * ruling (see `ARCHIVED_SILENCE_TAIL_SPEC`) and must not colour a default run's ceiling or its selection
 * seams. It is still reached whenever an invocation names it — the named branch above is untouched.
 */
const selectedSpecFiles = (): string[] => {
  const resolved = namedSpecFiles();
  return resolved.length > 0
    ? resolved
    : specFilesIn(path.join(CONFIG_DIR, 'e2e')).filter((file) => file !== ARCHIVED_SILENCE_TAIL_SPEC);
};

const RUN_CEILING_MS = selectedSpecFiles().reduce(
  (total, file) => total + (SPEC_BUDGET_MS[file] ?? SINGLE_SPEC_CEILING_MS),
  0,
);

/**
 * True only when this invocation is the MCP-settings criterion and nothing else.
 *
 * `mcp-settings.spec.ts` boots its OWN stack: one Vite client and, per `MCP_ENABLED` state, one API server — all on
 * the two ports this run was told to serve. Playwright's `webServer` pair below would be a second, unused server and
 * client holding exactly those two ports, so for this selection the pair is not started and the spec binds both ports
 * itself. `mcpSettingsOnlySelection` is the one predicate behind both consequences of that shape: the dropped pair
 * (below) and the watchdog arming directly on the run ceiling instead of on a boot ceiling that would have no
 * webServer to bound (see the arming block further down).
 *
 * Scoped to the criterion's own one-file invocation — the shape its AC names — rather than to
 * `selectedSpecFiles().includes(...)`, the seam every other selection uses: a full-tree run names every spec, so the
 * one-file test is what keeps the pair (and the boot ceiling) in place for it. Both entries and both ceilings stay
 * for every other selection, byte-for-byte.
 */
const mcpSettingsOnlySelection = (() => {
  const selected = selectedSpecFiles();
  return selected.length === 1 && selected[0] === 'mcp-settings.spec.ts';
})();

/**
 * The run's own ceilings — the bounds above which nothing else in this file bounds anything.
 *
 * The gate that runs this criterion kills it at 60s and records the kill as `verdict: fail`, the same shape a
 * real failure has, so a run that crosses 60s is a red nobody can read. Two ceilings already exist under these
 * and neither covers the whole run: `webServer[].timeout` bounds only the wait *after* a server is spawned, and
 * the filter spec's own `test.describe.configure({ timeout: 120_000 })` raises the per-test budget to twice the
 * gate's cap. What is left over is everything outside both — most sharply Playwright's *pre-spawn* availability
 * probe (the note above), which asks each webServer url once with no deadline of its own, so a listener that
 * completes the TCP handshake and then never writes a byte makes it wait forever.
 *
 * The unboundedness is not spread evenly, so neither is the bound. Before both webServers answer, a run is on
 * the path nothing bounds, and `BOOT_CEILING_MS` bounds it there. Once both answer, the run is inside browser
 * launch and the cases, where the spec's own per-test timeout is the bound that already exists — so that stage
 * gets `RUN_CEILING_MS` instead, the largest value that still beats the gate's kill. A watchdog that used the
 * tight value for both stages would kill a perfectly healthy run of any spec in this checkout that load had
 * merely slowed past it — a bound lower than a sibling spec's own runtime turns a load artifact into a lost
 * run, and one already did: `e2e/voice-trim.spec.ts` runs 41.1-41.3s here and was killed mid-case at 45s.
 *
 * Both fire by *explaining themselves*: each reads back which stage the run is stuck in, writes one line naming
 * that stage and the milliseconds elapsed, ends any server process this run left behind, and exits non-zero. A
 * watchdog that only said "too slow" would leave the next reader exactly where the 60s kill does.
 *
 * The values are derived rather than guessed. A quiet run's stages measure ~0.6s config evaluation and seeding,
 * ~2.9s server boot, ~0.9s vite, ~8s browser launch plus `beforeAll`, and ~12s across the five cases — ~24s in
 * total, and a run under six concurrent sibling specs measured 23.6s. `BOOT_CEILING_MS` must clear every boot
 * that is already bounded (2 × 30s webServer waits, but serially — the first expiry ends the run, so ~31s), and
 * it is 9× the quiet boot. `SINGLE_SPEC_CEILING_MS` must clear the longest healthy run in this checkout
 * (voice-trim, ~42s) and still land its line before the gate's kill: 55s + the 2s diagnosis probe + ~0.6s of
 * process start-up puts the line on stdout at ~57.6s, ~2.4s inside 60s.
 *
 * The 0.6s config-evaluation-and-seeding reading is re-measured when a new seed is added, because a seeding
 * stage that grew could push a run's start past the ceilings above. Adding `seedTranscriptJumpTranscript` (a
 * 1200-turn, 1.66 MB JSONL) measured, as the median of 7 fresh config evaluations on 2026-10-04: 0.465s without
 * it, 0.472s with it — a ~7ms delta, against the 2s the seed task budgets for this stage.
 *
 * `seedForkAnchorTranscript` (a 7-row JSONL plus one `realpathSync`) was measured the same way on 2026-10-07:
 * a median 496ms without it and 491ms with it — a delta inside the spread of the seven samples themselves
 * (464-561ms), which is the reading: this seed is smaller than the noise floor of the stage it joins, not
 * merely smaller than a budget.
 *
 * The run ceiling itself is the sum of the selected specs' budgets, computed above; for the one-file invocation
 * the gate makes, that sum is `SINGLE_SPEC_CEILING_MS` and nothing about it changed.
 */
const BOOT_CEILING_MS = 40_000;
/** How long the watchdog waits for an answer before it calls a bound port silent. Deliberately short: this is a reading, not a wait. */
const WATCHDOG_PROBE_MS = 2_000;

/**
 * How long each `webServer` entry is given to answer before Playwright gives up on it.
 *
 * This is the bound a goal-gate run names when it is killed during boot: `Error: Timed out waiting
 * <this>ms from config.webServer.` It is also the run's *earliest* ceiling, reached before any spec
 * body executes — so a value that is too small reds the criterion during boot, with no geometry
 * reading to explain the red.
 *
 * The shipped `30_000` was sized off "boot costs ~8s on a loaded machine, so 30s is ~3x the observed
 * worst case rather than a tight fit". That "~8s worst case" does not hold under the fan-in the gate
 * runs at. Measured on 2026-10-09 on a 128-core host, this selection's own boot: ~2.9s quiet, 6.0-18.5s
 * under 28 concurrent sibling e2e lanes (`load1` peaking 146), and past 30s under 48 lanes (`load1`
 * peaking 206) — where the run died on this bound, `Error: Timed out waiting 30000ms from
 * config.webServer.`, before a single reading. 3x of 8s was never a cushion against that; it was a
 * cushion against the quiet number. `35_000` gives the boot ~12x its quiet cost and ~1.9x the worst boot
 * measured at the DoD's lane floor.
 *
 * `WEB_SERVER_TIMEOUT_MS` (35s) < `BOOT_CEILING_MS` (40s) < `SINGLE_SPEC_CEILING_MS` (55s) < the 60s the
 * gate kills at. The 5s gap to `BOOT_CEILING_MS` is load-bearing: a boot that still cannot answer is
 * then reported by *this* bound — Playwright's own line, naming the wait — rather than by the watchdog,
 * which ends the run without it. So this value must not be lifted to or past `BOOT_CEILING_MS`. Both
 * entries share it because Playwright waits on both, and a pair that expired at different moments would
 * only move which entry a red names.
 */
const WEB_SERVER_TIMEOUT_MS = 35_000;

/**
 * Asks one of the run's ports a single HTTP request, with a deadline, and reports which of three states it is
 * in: `answered` (something served it), `silent` (the port is bound and nothing came back), or `closed`
 * (nothing is listening).
 *
 * This is the one reading the watchdog needs and the reading Playwright's own probe cannot give: it waits on
 * the same socket with no deadline, which is what the run is stuck on in the first place. So this one hangs up
 * rather than waits — it must be impossible for the thing that explains a hang to hang.
 */
const probePort = (target: string): Promise<'answered' | 'silent' | 'closed'> =>
  new Promise((resolve) => {
    const url = new URL(target);
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    let settled = false;
    const settle = (state: 'answered' | 'silent' | 'closed') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(WATCHDOG_PROBE_MS);
    socket.on('connect', () => socket.write(`GET ${url.pathname} HTTP/1.0\r\nHost: ${url.host}\r\n\r\n`));
    socket.on('data', () => settle('answered'));
    socket.on('timeout', () => settle('silent'));
    socket.on('error', () => settle('closed'));
  });

/**
 * Which stage the run is in, read back from the ports at the moment a ceiling is crossed.
 *
 * The stage is returned as data and not only as prose because it decides what happens next: a run still in
 * `webServer-start` is on the unbounded path and ends here, while a run past it is merely slow and is handed
 * the looser ceiling instead. Reading it back out of the message would make the message load-bearing.
 *
 * A port that is bound but silent is the sharpest reading of the three: it is the listener whose handshake
 * succeeds and whose answer never comes, which is precisely the condition Playwright's pre-spawn probe cannot
 * survive. Naming it turns "the run timed out" into "this process is holding this port and not answering".
 */
type Stall = {
  readonly stage: 'webServer-start' | 'browser-launch-or-cases';
  readonly detail: string;
  /**
   * The ports the probe got no HTTP answer from, named without a claimed cause. Absent when the probe itself
   * failed and so read nothing.
   *
   * `detail` below carries a *cause* for the boot-ceiling path ("Playwright's pre-spawn availability probe …
   * has no deadline"), and that cause is only true of a run that never answered. Once both ports have been
   * observed answering, a silent sample is a busy server missing the probe's own deadline, not a stuck
   * pre-spawn probe — so the run-ceiling path re-words the reading from these names instead of reusing that
   * sentence (`classifyRunCeilingCrossing` in the `isDataDirOwner` block).
   */
  readonly unanswered?: readonly string[];
};

const describeStall = async (): Promise<Stall> => {
  const readings = await Promise.all(
    RUN_SERVERS.map(async (server) => ({ ...server, state: await probePort(server.url), port: new URL(server.url).port })),
  );
  const silent = readings.filter((reading) => reading.state === 'silent');
  if (silent.length > 0) {
    const named = silent.map((reading) => `port ${reading.port} (${reading.name}) accepts TCP but never answers an HTTP request`).join(', ');
    return {
      stage: 'webServer-start',
      detail: `${named} — Playwright's pre-spawn availability probe for ${silent[0].url} has no deadline, so it cannot return`,
      unanswered: silent.map((reading) => `port ${reading.port} (${reading.name})`),
    };
  }
  const closed = readings.filter((reading) => reading.state === 'closed');
  if (closed.length > 0) {
    const named = closed.map((reading) => `port ${reading.port} (${reading.name}) is not listening`).join(', ');
    return { stage: 'webServer-start', detail: named, unanswered: closed.map((reading) => `port ${reading.port} (${reading.name})`) };
  }
  return {
    stage: 'browser-launch-or-cases',
    detail: 'both webServers answered, so this run is past boot and inside browser launch or a test case',
    unanswered: [],
  };
};

/**
 * The direct children of this process, read from `/proc`.
 *
 * Playwright spawns every webServer `detached`, so each direct child leads its own process group and
 * `process.kill(-pid, ...)` reaches the whole `sh -c` -> `npx` -> `tsx` -> server chain. Signalling the leader
 * alone would leave its children reparented and still holding the ports — the orphan this run must not leave.
 */
const childPids = (): number[] => {
  const pids: number[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // `pid (comm) state ppid ...`, and `comm` may itself contain spaces and parentheses, so the fields are
      // read from after its closing one.
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === process.pid) pids.push(Number(entry));
    } catch {
      // Exited between the directory listing and the read: not a child left to clean up.
    }
  }
  return pids;
};

/**
 * Where this run records whether its watchdog was armed, and whether it ever fired.
 *
 * The `[e2e] watchdog:` line is written to *this* process's stdout, which a criterion that runs the suite from
 * outside cannot read — and "no watchdog line in the output" is exactly what the voice-error criterion has to
 * assert. A spec observing only that the line is absent would accept a run whose watchdog was never armed at
 * all, so the two facts the line encodes are also written here, in the run's own data directory, where the spec
 * can read them: `armed:true` is the positive control that the ceiling really existed, and `fired:true` is what
 * a run that crossed one leaves behind. Both readings are joined by the file's absence meaning "no run wrote
 * here", which is why the spec fails on a missing file rather than treating it as a quiet watchdog.
 *
 * `stage`/`stall` are the third and fourth readings, and they are written **only when a ceiling was crossed**:
 * "the watchdog fired" says a run died, and says nothing about *why* it died. `detail` alone cannot answer that
 * either — a fired boot ceiling is written as `boot ceiling crossed at 40001ms` whether the run was stuck on a
 * listener that accepts TCP and never answers or merely on a server that had not finished binding, and those two
 * need opposite next actions. The classification does exist, but only in `describeStall()`'s return value, which
 * used to reach stdout alone; a criterion run from outside keeps stderr, so the one sentence that could classify
 * the crossing was the one discarded. Persisting the same two readings here is what makes a crossing classifiable
 * from the run's own artifacts, with no re-run — which is why the keys are absent (rather than empty) on a run
 * that never crossed anything: their presence *is* the claim that a stage was read at the moment of the crossing.
 */
const WATCHDOG_STATE_FILE = path.join(dataDir, 'watchdog-state.json');
const writeWatchdogState = (state: {
  armed: boolean;
  fired: boolean;
  ceilingMs: number;
  detail: string;
  stage?: Stall['stage'];
  stall?: string;
}): void => {
  try {
    fs.writeFileSync(WATCHDOG_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // The reading is what is lost here; the watchdog's own behaviour never depends on this file.
  }
};

/**
 * Ends the run with a line explaining it, and takes this run's server processes with it.
 *
 * Only the process that allocated the data directory arms these. Workers re-evaluate this file, and a worker's
 * own lifetime is short and already bounded by the runner — a ceiling armed there would fire on the runner's
 * run, not on the worker's, and report the wrong elapsed time.
 */
if (isDataDirOwner) {
  const endRun = (label: string, ceiling: number, crossedAt: number, stall: Stall): void => {
    const elapsed = Date.now() - runStartedAt;
    // Recorded before anything can exit this process, and before the line below, so a run killed from outside
    // still leaves the evidence that its watchdog had fired. `stage`/`stall` ride along because this is the only
    // moment they exist: the run is about to `process.exit`, and the ports they were read from are about to be
    // released, so a reader arriving after the fact has exactly one place left to learn why this run died.
    writeWatchdogState({
      armed: true,
      fired: true,
      ceilingMs: ceiling,
      detail: `${label} crossed at ${crossedAt}ms`,
      stage: stall.stage,
      stall: stall.detail,
    });
    // `fs.writeSync` rather than `console.log`: on POSIX a pipe is written asynchronously, so a line handed to
    // `process.stdout` is not flushed before `process.exit` — and the one line that explains the red would be
    // the one lost. The fallback covers a pipe that will not take the write right now; a lost line is bad but
    // not as bad as an exception on the way out swallowing the cleanup below.
    const line = `[e2e] watchdog: this run crossed its own ${ceiling}ms ${label} at ${crossedAt}ms and is ending here with exit 1 at ${elapsed}ms — stuck at stage "${stall.stage}": ${stall.detail}.\n`;
    // BOTH streams, not stdout with stderr as a fallback. The fallback is about a pipe refusing a write; it is not
    // a fan-out, and the distinction matters here: the goal gate that judges this criterion keeps only the run's
    // *stderr* in its `payload.reason`, so a line written to stdout alone reaches every reader except the one that
    // records the verdict. Measured on AC-173's two boot-ceiling crossings (2026-10-13T16:37:26Z, 17:19:33Z): both
    // `payload.reason` values contain the webServer's stderr and no reading of any kind from the spec or the
    // watchdog. Writing the same sentence twice is what puts the classification into the verdict as well.
    for (const fd of [1, 2]) {
      try {
        fs.writeSync(fd, line);
      } catch {
        // This stream is not taking writes right now; the other one, and the non-zero exit below, still say it.
      }
    }
    for (const pid of childPids()) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone, or not a group leader; either way there is nothing here to signal.
      }
    }
    process.exit(1);
  };

  /**
   * The moment this run was first *observed* past boot — both webServers answering — or `null` while it has never
   * been seen out of the boot stage.
   *
   * This is a latch, not a sample, and the difference is the whole of this change. The boot ceiling exists to end
   * a run stuck on Playwright's deadline-less pre-spawn probe. It used to decide that from `describeStall()` alone,
   * at the instant it fired: one reading of the two ports, by the only instrument here, and that instrument cannot
   * tell "still in boot" from "past boot, and this port did not answer inside the watchdog's own
   * `WATCHDOG_PROBE_MS`". Both come back `silent` — a stage that ends the run. So a run that was seconds past boot
   * and mid-case, whose server happened to be busy for those two seconds, was ended at 40s and labelled "boot
   * ceiling crossed": a load artifact written as a lost run, which is the outcome the ceiling's own comment above
   * forbids.
   *
   * AC-173's recorded crossing is that shape rather than a boot stall. In `quay-e2e-Rxhh8s`, the spec's own fixture
   * sessions (`Running view — in flight / idle a / idle b / control / resident turn`, the titles declared at
   * `e2e/resident-running-view.spec.ts:104-108`) were written into `<dataDir>/debug-agent-home/
   * resident-running-view-workspace` — the path the spec builds at line 790 — with mtimes spanning t=+9.1s to
   * t=+33.5s, and the stderr the gate kept shows Vite already transforming `react-scan.js?v=8b9f973b` at t=+12.2s.
   * Both are well inside the 40s the boot ceiling allowed and a full 7s before it fired. The run was in its cases,
   * not in its boot. (t is measured from `runStartedAt`: the state file's own mtime minus the 40001ms it reports.)
   * Latching the fact makes the boot ceiling fire only for a run that was never once seen past boot, which is the
   * class it was built for; the run ceiling still bounds every run either way.
   */
  let bootCompletedAt: number | null = null;
  /** The pending boot-ceiling timer, held so that reaching the boot line cancels it instead of racing it. */
  let bootTimer: NodeJS.Timeout | null = null;
  /** The standing probe that sets the latch above. Cleared on the first tick where both ports answer. */
  let bootProbe: NodeJS.Timeout | null = null;
  let bootProbeInFlight = false;

  /**
   * How a crossing is reported once this run has been *observed* past boot.
   *
   * `describeStall()` is the only instrument at the crossing, and its two-second sample cannot tell a run still
   * in boot from one that is seven cases into a spec on a server that happened to miss the probe's deadline: both
   * read `silent`. Reported through `describeStall()`'s boot wording, the second shape is written as
   * `stage: "webServer-start"` with "Playwright's pre-spawn availability probe … has no deadline, so it cannot
   * return" — a sentence that is true of a run that never answered and false of this one. That is the reading
   * defect behind gate event `ffe23041-b229-41cb-a944-5bdfe3ba3cca` (2026-10-21T05:30:43.688Z, tree
   * `34fc0d7b1dcec5430eae37c965f359ef1a0aa6ab`): a run whose first seven cases passed, killed at the 240 s
   * ceiling inside a fan-in suite window (`loadavg` 55.8-69.1), recorded as a pre-spawn probe that cannot return.
   *
   * The latch above is a fact this run established, so it outranks the sample: once set, the stage is
   * `browser-launch-or-cases`, and the sample's port names are kept in `detail` as a reading rather than a cause.
   */
  const classifyRunCeilingCrossing = (sampled: Stall): Stall => {
    if (bootCompletedAt === null) return sampled;
    const reading = sampled.unanswered
      ? sampled.unanswered.length > 0
        ? `the ${WATCHDOG_PROBE_MS}ms probe at the crossing got no answer from ${sampled.unanswered.join(', ')} — a loaded server missing the probe's own deadline, not a run stuck in boot`
        : `both webServers answered the ${WATCHDOG_PROBE_MS}ms probe at the crossing`
      : 'the crossing probe itself failed, so it read no port state';
    return {
      stage: 'browser-launch-or-cases',
      detail: `observed past boot at ${bootCompletedAt - runStartedAt}ms, so this run was inside browser launch or a case; ${reading}`,
      unanswered: sampled.unanswered,
    };
  };

  /**
   * Arms one ceiling, and at the boot one hands a run that turns out to be past boot to the run ceiling instead
   * of firing. The reading costs the probe below; the run receiving it is still starting up, so the two
   * ceilings stay two independent readings rather than one budget split between them — and a healthy run that
   * load has slowed down is never the one a boot bound ends.
   *
   * Returns its timer so the latch below can cancel a boot ceiling the run has already outgrown.
   */
  const arm = (ceiling: number, label: string, mayReArm: boolean): NodeJS.Timeout => {
    const watchdog = setTimeout(() => {
      // Read before the probe below, so the moment the ceiling was crossed is reported as itself and the probe's
      // own cost is not folded into it — otherwise the line would name a 55s ceiling and an elapsed of 57s.
      const crossedAt = Date.now() - runStartedAt;
      describeStall()
        .catch(
          (): Stall => ({
            stage: 'webServer-start',
            detail: 'the port probe itself failed, so the stage could not be read',
          }),
        )
        .then((stall) => {
          // Either reading is enough to say this run is past boot: the latch is a fact the run established once,
          // and the sample is what a run that never set it can still show at the deadline.
          if (mayReArm && (bootCompletedAt !== null || stall.stage === 'browser-launch-or-cases')) {
            arm(RUN_CEILING_MS, 'ceiling', false);
            return;
          }
          endRun(label, ceiling, crossedAt, classifyRunCeilingCrossing(stall));
        });
      // Measured from the run's own start rather than from this call, so the second arming lands on the run
      // ceiling itself and not on the boot ceiling plus it.
    }, Math.max(0, runStartedAt + ceiling - Date.now()));
    // Not referenced: a run that finishes on its own must not be held open by this timer. It can only fire while
    // something else is genuinely keeping the event loop alive — which is exactly the condition it exists for.
    watchdog.unref();
    return watchdog;
  };

  /**
   * Records that both webServers answered, and hands the run to the run ceiling from that moment.
   *
   * Called only by the standing probe below. Idempotent, because the first tick that sees both ports is the only
   * one that may set the latch and the interval is cleared here rather than by its caller.
   */
  const latchBootCompletion = (): void => {
    if (bootCompletedAt !== null) return;
    bootCompletedAt = Date.now();
    if (bootProbe) {
      clearInterval(bootProbe);
      bootProbe = null;
    }
    if (bootTimer) {
      clearTimeout(bootTimer);
      bootTimer = null;
    }
    arm(RUN_CEILING_MS, 'ceiling', false);
    // Re-stated with the moment it happened, so a reader can tell a run that crossed the boot line from one that
    // never reached it without re-running anything — the same reason the crossing writes `stage`/`stall`.
    writeWatchdogState({
      armed: true,
      fired: false,
      ceilingMs: RUN_CEILING_MS,
      detail: `boot completed at ${bootCompletedAt - runStartedAt}ms, re-armed to ${RUN_CEILING_MS}ms`,
    });
  };

  // The boot ceiling bounds one specific unboundedness: Playwright's *pre-spawn* availability probe over
  // `webServer`'s urls, which has no deadline of its own. A run that starts no webServer has no such probe to
  // bound, and the one-file MCP-settings selection starts none (`mcpSettingsOnlySelection`): the spec boots its own
  // stack under its own bounded waits, each failing with the child's log tail. Arming the boot ceiling there would
  // bound nothing while misreading that spec's own port hand-off — the brief window between one state's server
  // process and the next, where the shared server port is deliberately unbound — as a stalled `webServer-start`,
  // and end a healthy run at 40s. So it arms only when there is a webServer to boot; the run ceiling still bounds
  // the whole run either way, and every other selection is byte-for-byte unchanged.
  if (mcpSettingsOnlySelection) {
    arm(RUN_CEILING_MS, 'ceiling', false);
  } else {
    bootTimer = arm(BOOT_CEILING_MS, 'boot ceiling', true);
    // One probe at a time, a `WATCHDOG_PROBE_MS`-derived interval apart, and only until the latch is set: "has this
    // run ever been past boot?" is a fact about the run, and a single sample taken at the deadline cannot answer
    // it. The interval is derived from the probe's own deadline rather than introduced as a fresh number, so it
    // cannot drift out of step with the reading it schedules. Unref'd, so a run that finishes on its own is not
    // held open by it.
    bootProbe = setInterval(
      () => {
        if (bootProbeInFlight) return;
        bootProbeInFlight = true;
        void Promise.all(RUN_SERVERS.map((server) => probePort(server.url)))
          .then((states) => {
            if (states.every((state) => state === 'answered')) latchBootCompletion();
          })
          .catch(() => {
            // A probe that threw read nothing; the next tick reads again.
          })
          .finally(() => {
            bootProbeInFlight = false;
          });
      },
      Math.max(1, Math.floor(WATCHDOG_PROBE_MS / 2)),
    );
    bootProbe.unref();
  }
  // Written after the arming calls rather than inside `arm`, so the record describes the run's watchdog as a
  // whole — the boot ceiling and the run ceiling it hands over to — instead of whichever arming happened last.
  writeWatchdogState({
    armed: true,
    fired: false,
    ceilingMs: RUN_CEILING_MS,
    detail: mcpSettingsOnlySelection
      ? `${RUN_CEILING_MS}ms, armed directly: this selection starts no webServer, so there is no unbounded pre-spawn probe for a boot ceiling to bound`
      : `boot ${BOOT_CEILING_MS}ms, re-armed to ${RUN_CEILING_MS}ms once past boot`,
  });
}

/** Workspace e2e/session-filter.spec.ts creates its project in; its own directory so no other spec picks these sessions up. */
const SESSION_FILTER_WORKSPACE = path.join(dataDir, 'session-filter-workspace');
/** Names the filter spec's rule is written against — it re-declares them, and failing to see all of them is how a drift shows up. */
const SESSION_FILTER_SESSIONS = [
  'role-1-task-worker',
  'role-2-selector',
  'role-3-fix-worker',
  'role-4-task-worker',
  'human-alpha',
  'human-beta',
  'human-gamma',
];

/**
 * Seeds the transcripts e2e/session-filter.spec.ts filters on, here rather than from the spec itself.
 *
 * The backend scans ~/.claude/projects at boot and only then starts its file watcher with `ignoreInitial`.
 * Transcripts written while the test runs are therefore picked up by the watcher instead, which broadcasts a
 * session_upserted per file; each one lands on a session the browser is not viewing, which the sidebar
 * correctly reads as "needs attention" — and an attention-flagged session is deliberately kept visible under a
 * name filter. Writing them before the server boots means the boot scan indexes them and the watcher never
 * sees them at all, so the only session that earns an attention flag during the run is the one the spec flags
 * on purpose.
 *
 * Seeding must not happen in a worker: workers re-evaluate this file, so writing again there would land the
 * files on disk long after boot and hand the watcher exactly the storm this is avoiding.
 */
const seedSessionFilterTranscripts = () => {
  fs.mkdirSync(SESSION_FILTER_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'session-filter-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  for (const name of SESSION_FILTER_SESSIONS) {
    const sessionId = `e2e-${name}`;
    // The synchronizer reads sessionId and cwd from the first record it can parse and the display name from
    // the last custom-title event, so one transcript has to carry both.
    const records = [
      {
        type: 'user',
        sessionId,
        cwd: SESSION_FILTER_WORKSPACE,
        timestamp,
        message: { role: 'user', content: [{ type: 'text', text: `prompt for ${name}` }] },
      },
      { type: 'custom-title', sessionId, cwd: SESSION_FILTER_WORKSPACE, timestamp, customTitle: name },
    ];
    fs.writeFileSync(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
  }
};

/** Workspace e2e/session-filter-conversations-live.spec.ts drives; its own directory so no other spec picks these sessions up. */
const SESSION_FILTER_LIVE_WORKSPACE = path.join(dataDir, 'session-filter-live-workspace');
/** The one session that spec starts from: a row already in the Conversations feed for it to rename into a rule. */
const SESSION_FILTER_LIVE_SEED = 'live-seed-human';

/**
 * Seeds the single transcript e2e/session-filter-conversations-live.spec.ts loads its feed with.
 *
 * This one is here for the opposite reason to its sibling's: the spec's whole subject is what a
 * transcript written *while the app is running* does to the Conversations list, so its own sessions
 * have to be written by the spec, mid-run, and picked up by the file watcher. That path broadcasts
 * `session_upserted` for a session the browser is not viewing, which the sidebar reads as "needs
 * attention" — and attention is exactly the exemption the Projects list keeps visible under a name
 * filter. On the Conversations side there is no such exemption: the feed is judged with the server's
 * own rules and nothing else, so the flag costs this spec nothing. What it does need is one row
 * already on screen before it writes anything, which is what is seeded here, before boot.
 */
const seedSessionFilterLiveTranscript = () => {
  fs.mkdirSync(SESSION_FILTER_LIVE_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'session-filter-live-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const sessionId = `e2e-${SESSION_FILTER_LIVE_SEED}`;
  const timestamp = new Date().toISOString();
  // Same two records as the filter spec's seed: the synchronizer reads the id and cwd from the first
  // record it can parse and the display name from the last custom-title event.
  const records = [
    {
      type: 'user',
      sessionId,
      cwd: SESSION_FILTER_LIVE_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: `prompt for ${SESSION_FILTER_LIVE_SEED}` }] },
    },
    { type: 'custom-title', sessionId, cwd: SESSION_FILTER_LIVE_WORKSPACE, timestamp, customTitle: SESSION_FILTER_LIVE_SEED },
  ];
  fs.writeFileSync(
    path.join(transcriptDir, `${sessionId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/transcript-follow.spec.ts opens; its own directory so no other spec picks this session up. */
const TRANSCRIPT_FOLLOW_WORKSPACE = path.join(dataDir, 'transcript-follow-workspace');
/** Session id that spec addresses, and the display name it looks its sidebar row up by. */
const TRANSCRIPT_FOLLOW_SESSION_ID = 'e2e-transcript-follow';
const TRANSCRIPT_FOLLOW_SESSION_NAME = 'transcript-follow';
/**
 * Turns the seeded transcript carries. Long enough to be many screens tall — the spec scrolls it for real in
 * both directions — and within ChatMessagesPane's 30-row initial-mount band, so every row starts with its
 * real height instead of a placeholder estimate and the geometry does not settle underneath the test.
 */
const TRANSCRIPT_FOLLOW_TURNS = 24;

/**
 * Seeds the transcript e2e/transcript-follow.spec.ts measures, here rather than from the spec itself.
 *
 * Same reason as the filter spec's: the backend scans ~/.claude/projects at boot and only then starts its
 * file watcher with `ignoreInitial`, so a transcript written while the test runs is picked up by the watcher
 * and broadcast as a session_upserted instead.
 *
 * The bodies are plain paragraphs on purpose — no code blocks, no images, nothing that highlights or loads
 * asynchronously — because that spec asserts on pixel geometry, and a late reflow would move it.
 */
const seedTranscriptFollowTranscript = () => {
  fs.mkdirSync(TRANSCRIPT_FOLLOW_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'transcript-follow-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });

  const startedAt = Date.now();
  const records: Record<string, unknown>[] = [];
  let parentUuid: string | null = null;
  for (let turn = 0; turn < TRANSCRIPT_FOLLOW_TURNS; turn += 1) {
    // Even counts of turns, so the last message row is an assistant row.
    const role = turn % 2 === 0 ? 'user' : 'assistant';
    const uuid = `e2e-transcript-follow-turn-${turn}`;
    records.push({
      type: role,
      uuid,
      parentUuid,
      sessionId: TRANSCRIPT_FOLLOW_SESSION_ID,
      cwd: TRANSCRIPT_FOLLOW_WORKSPACE,
      timestamp: new Date(startedAt + turn * 60_000).toISOString(),
      message: {
        role,
        content: [{
          type: 'text',
          text: `Turn ${turn}. ${'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt. '.repeat(8)}`,
        }],
      },
    });
    parentUuid = uuid;
  }
  records.push({
    type: 'custom-title',
    sessionId: TRANSCRIPT_FOLLOW_SESSION_ID,
    cwd: TRANSCRIPT_FOLLOW_WORKSPACE,
    timestamp: new Date(startedAt + TRANSCRIPT_FOLLOW_TURNS * 60_000).toISOString(),
    customTitle: TRANSCRIPT_FOLLOW_SESSION_NAME,
  });

  fs.writeFileSync(
    path.join(transcriptDir, `${TRANSCRIPT_FOLLOW_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace the long-session seed owns; its own directory so no other spec's project list picks this session up. */
const TRANSCRIPT_JUMP_WORKSPACE = path.join(dataDir, 'transcript-jump-workspace');
/** Session id the long-session criteria address, and the display name they look its sidebar row up by. */
const TRANSCRIPT_JUMP_SESSION_ID = 'e2e-transcript-jump';
const TRANSCRIPT_JUMP_SESSION_NAME = 'transcript-jump';
/** User turns the fixture carries — far past the "longer than the first screen" premise of GOAL-017's criteria. */
const TRANSCRIPT_JUMP_TURNS = 1200;
/**
 * The displayed number of the first of the two adjacent user turns that share one millisecond.
 *
 * 1-indexed, matching the row text ("Turn 600. …"): the 600th turn and the 601st are the tie. The smoke spec
 * reads the pair back and asserts one timestamp with two ids.
 */
const TRANSCRIPT_JUMP_TIE_TURN = 600;

/**
 * Seeds the long transcript e2e/transcript-long-session-seed.spec.ts measures, here rather than from a spec.
 *
 * Same reason as every seed above: the backend scans ~/.claude/projects at boot and only then starts its file
 * watcher with `ignoreInitial`, so a transcript written while a test runs is picked up by the watcher and
 * broadcast as a session_upserted instead of being indexed quietly.
 *
 * One user turn draws FOUR rows: the prompt, the assistant's reply text, an assistant thinking row, and an
 * assistant tool call whose `tool_result` is carried back on the call (a separate record, which the history
 * reader folds into its call rather than drawing a second time — see `prepareTranscriptMessages`). That density
 * is deliberate. `total` from `GET /api/providers/sessions/:id/messages` is 4 × turns = 4800, exactly the floor
 * the smoke spec asserts and the mutation AC breaks by lowering the turn count. A sparse cadence (the "every
 * 7th tool / every 50th thinking" shape) draws only ~2.2 rows per turn — ~2600 at this turn count — which cannot
 * clear a 4800 floor, so here every turn carries the work rows and the floor is met by construction.
 *
 * Turns are 1-indexed in the row text, and the 600th and 601st carry the same millisecond so a same-instant
 * locator has a real tie to find; their ids stay distinct, which is what lets the criterion tell "same instant"
 * apart from "same row". The file is a real Claude JSONL, indexed by the backend's own synchronizer — no request
 * is stubbed. Bodies are plain paragraphs (no code blocks, no images) so nothing reflows after the first paint.
 */
const seedTranscriptJumpTranscript = () => {
  fs.mkdirSync(TRANSCRIPT_JUMP_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'transcript-jump-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });

  const startedAt = Date.now();
  const paragraph = 'The transcript keeps a short paragraph here so no late reflow moves a measurement. ';
  const records: Record<string, unknown>[] = [];
  let parentUuid: string | null = null;
  let tick = 0;

  /** One JSONL record. `timestampOverride` is how the tie pair shares a millisecond without sharing an id. */
  const append = (
    role: 'user' | 'assistant',
    content: Record<string, unknown>[],
    timestampOverride?: string,
  ) => {
    const uuid = `e2e-transcript-jump-${tick}`;
    const timestamp = timestampOverride ?? new Date(startedAt + tick * 1_000).toISOString();
    records.push({
      type: role,
      uuid,
      parentUuid,
      sessionId: TRANSCRIPT_JUMP_SESSION_ID,
      cwd: TRANSCRIPT_JUMP_WORKSPACE,
      timestamp,
      message: { role, content },
    });
    parentUuid = uuid;
    tick += 1;
    return timestamp;
  };

  let tieTimestamp: string | null = null;
  for (let turn = 0; turn < TRANSCRIPT_JUMP_TURNS; turn += 1) {
    const display = turn + 1;
    // The tie: the 601st turn's prompt reuses the 600th's millisecond. Its uuid — and so its message id — is
    // still its own, which is the whole of what the criterion reads.
    const userTimestamp = display === TRANSCRIPT_JUMP_TIE_TURN + 1 && tieTimestamp !== null
      ? tieTimestamp
      : new Date(startedAt + tick * 1_000).toISOString();
    append('user', [{ type: 'text', text: `Turn ${display}. ${paragraph}` }], userTimestamp);
    if (display === TRANSCRIPT_JUMP_TIE_TURN) {
      tieTimestamp = userTimestamp;
    }

    const toolId = `e2e-transcript-jump-tool-${display}`;
    append('assistant', [
      { type: 'text', text: `Reply ${display}. ${paragraph}` },
      { type: 'thinking', thinking: `Considering turn ${display} before answering.` },
      { type: 'tool_use', id: toolId, name: 'Bash', input: { command: `echo turn-${display}` } },
    ]);
    append('user', [{ type: 'tool_result', tool_use_id: toolId, content: `turn-${display} output` }]);
  }

  records.push({
    type: 'custom-title',
    sessionId: TRANSCRIPT_JUMP_SESSION_ID,
    cwd: TRANSCRIPT_JUMP_WORKSPACE,
    timestamp: new Date(startedAt + tick * 1_000).toISOString(),
    customTitle: TRANSCRIPT_JUMP_SESSION_NAME,
  });

  fs.writeFileSync(
    path.join(transcriptDir, `${TRANSCRIPT_JUMP_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace the tall-row seed owns; its own directory so no other spec's project list picks this session up. */
const TRANSCRIPT_JUMP_TALL_WORKSPACE = path.join(dataDir, 'transcript-jump-tall-workspace');
/** Session id the tall-row criterion addresses, and the display name it looks its sidebar row up by. */
const TRANSCRIPT_JUMP_TALL_SESSION_ID = 'e2e-transcript-jump-tall';
const TRANSCRIPT_JUMP_TALL_SESSION_NAME = 'transcript-jump-tall';
/**
 * User turns the tall fixture carries.
 *
 * Short of the shared long fixture's 1200 on purpose: this criterion clicks a
 * real mouse at eight positions per viewport, and every jump is one `?around=`
 * read plus a commit — 1200 turns would buy nothing the estimate cares about and
 * only widen the window the tick column has to be walked across.
 */
const TRANSCRIPT_JUMP_TALL_TURNS = 300;
/**
 * The displayed number of the first of the two adjacent user turns that share
 * one millisecond — the same tie the shared fixture carries, so the criterion's
 * id-addressed landing is measured on a long-row session too.
 */
const TRANSCRIPT_JUMP_TALL_TIE_TURN = 150;

/**
 * Seeds the tall-row transcript e2e/transcript-jump-landing.spec.ts measures.
 *
 * The rows have to be tall and their placeholders short for the jump's own
 * landing to be the thing under test. Every turn draws exactly two rows — the
 * prompt and one assistant text — and the assistant text carries six markdown
 * paragraphs, so at a tablet width it lays out around 250px against the 100px
 * flat placeholder the pane used to stand in for it. A jump that centres on the
 * tall row against those short stand-ins therefore has to be corrected by
 * hundreds of pixels, which is the premise of the criterion.
 *
 * Every fifth turn adds a tool call (and its folded result, which the history
 * reader attaches to the call rather than drawing again), so a drawn window is
 * not uniformly text. The texts are plain paragraphs — no code blocks, tables or
 * images — so nothing reflows after first paint and a measured height stays put.
 * Nothing is stubbed: the file is a real Claude JSONL indexed by the backend's
 * own synchronizer at boot, exactly like the shared long fixture beside it.
 */
const seedTranscriptJumpTallTranscript = () => {
  fs.mkdirSync(TRANSCRIPT_JUMP_TALL_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'transcript-jump-tall-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });

  const startedAt = Date.now();
  // Long enough to wrap to a second line in the transcript's ~836px text column,
  // so six of them read as the ~250px row the criterion needs; varied so a
  // paragraph is not mistaken for its neighbour.
  const paragraphs = [
    'The transcript keeps a full paragraph of ordinary prose here, long enough that it wraps to a second line in the message column and contributes real height to the row that carries it. ',
    'A second paragraph continues the thought without adding anything the layout has to reflow around, so the measured height of this row is stable from the first frame it is drawn in. ',
    'Words accumulate one after another in the way prose does, and none of them is a code fence, a table, an image or a heading, so nothing about this row can change its shape after it has been measured. ',
    'The third paragraph exists so the assistant turn is unmistakably taller than a single line of text and stands well clear of the flat placeholder that used to stand in for it before the row was measured. ',
    'A fourth paragraph keeps the row tall while staying entirely plain: no emphasis that changes metrics, no links that reflow, no inline code whose font could shift the line box by a pixel or two. ',
    'The fifth and sixth paragraphs close the turn, so every assistant row in this fixture is a multi-paragraph block and the running average the pane estimates from is dominated by tall rows rather than by prompts. ',
  ];
  const records: Record<string, unknown>[] = [];
  let parentUuid: string | null = null;
  let tick = 0;

  /** One JSONL record. `timestampOverride` is how the tie pair shares a millisecond without sharing an id. */
  const append = (
    role: 'user' | 'assistant',
    content: Record<string, unknown>[],
    timestampOverride?: string,
  ) => {
    const uuid = `e2e-transcript-jump-tall-${tick}`;
    const timestamp = timestampOverride ?? new Date(startedAt + tick * 1_000).toISOString();
    records.push({
      type: role,
      uuid,
      parentUuid,
      sessionId: TRANSCRIPT_JUMP_TALL_SESSION_ID,
      cwd: TRANSCRIPT_JUMP_TALL_WORKSPACE,
      timestamp,
      message: { role, content },
    });
    parentUuid = uuid;
    tick += 1;
    return timestamp;
  };

  let tieTimestamp: string | null = null;
  for (let turn = 0; turn < TRANSCRIPT_JUMP_TALL_TURNS; turn += 1) {
    const display = turn + 1;
    // The tie: the 151st turn's prompt reuses the 150th's millisecond, with a uuid of its own.
    const userTimestamp = display === TRANSCRIPT_JUMP_TALL_TIE_TURN + 1 && tieTimestamp !== null
      ? tieTimestamp
      : new Date(startedAt + tick * 1_000).toISOString();
    append('user', [{ type: 'text', text: `Turn ${display}. ${paragraphs[0]}` }], userTimestamp);
    if (display === TRANSCRIPT_JUMP_TALL_TIE_TURN) {
      tieTimestamp = userTimestamp;
    }

    // ONE text block with interior blank lines: the history reader draws one row
    // per block, and the row's markdown is what lays the paragraphs out.
    append('assistant', [
      { type: 'text', text: paragraphs.map((paragraph) => `${paragraph}(Turn ${display}.)`).join('\n\n') },
    ]);

    if (display % 5 === 0) {
      const toolId = `e2e-transcript-jump-tall-tool-${display}`;
      append('assistant', [
        { type: 'tool_use', id: toolId, name: 'Bash', input: { command: `echo tall-${display}` } },
      ]);
      append('user', [{ type: 'tool_result', tool_use_id: toolId, content: `tall-${display} output` }]);
    }
  }

  records.push({
    type: 'custom-title',
    sessionId: TRANSCRIPT_JUMP_TALL_SESSION_ID,
    cwd: TRANSCRIPT_JUMP_TALL_WORKSPACE,
    timestamp: new Date(startedAt + tick * 1_000).toISOString(),
    customTitle: TRANSCRIPT_JUMP_TALL_SESSION_NAME,
  });

  fs.writeFileSync(
    path.join(transcriptDir, `${TRANSCRIPT_JUMP_TALL_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/ui-visible-context-range.spec.ts opens; its own directory so no other spec's project list picks this session up. */
const UI_VISIBLE_CONTEXT_WORKSPACE = path.join(dataDir, 'ui-visible-context-workspace');
/** Session id that spec addresses, and the display name it looks its sidebar row up by. */
const UI_VISIBLE_CONTEXT_SESSION_ID = 'e2e-ui-visible-context';
const UI_VISIBLE_CONTEXT_SESSION_NAME = 'ui-visible-context';
/**
 * Paragraphs the single assistant answer carries.
 *
 * The criterion's premise is an answer TALLER than the transcript pane on both viewports, so
 * that a reader scrolled into the middle of it has a full pane of one answer on screen and no
 * other row. Measured against the shipped layout (the pane is ~668px tall at 390×844 and
 * ~830px at 1280×1000; a paragraph is ~60px): 24 keeps the answer well past either pane.
 */
const UI_VISIBLE_CONTEXT_ANSWER_PARAGRAPHS = 24;

/**
 * Seeds the transcript e2e/ui-visible-context-range.spec.ts reads its visible range from.
 *
 * Same reason as every seed above: the backend scans `~/.claude/projects` at boot and only then
 * starts its file watcher with `ignoreInitial`, so a transcript written while a test runs is
 * picked up by the watcher and broadcast as a `session_upserted` instead.
 *
 * The shape is the reported defect's own: ONE user prompt followed by ONE answer many screens
 * tall. A reader scrolled into the middle of that answer sees only that answer's row, which is
 * exactly the real state a phone lands in constantly and the state the visible-range reader has
 * to answer for. It is deliberately NOT a cadence of alternating short turns — such a fixture
 * always keeps a prompt row on screen and cannot express the defect at all.
 */
const seedUiVisibleContextTranscript = () => {
  fs.mkdirSync(UI_VISIBLE_CONTEXT_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'ui-visible-context-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });

  const startedAt = Date.now();
  const paragraph =
    'This paragraph exists so the answer is taller than any viewport the criterion measures, and it is ordinary prose so nothing about it reflows after the first paint. ';
  const answerText = Array.from(
    { length: UI_VISIBLE_CONTEXT_ANSWER_PARAGRAPHS },
    (_, index) => `Paragraph ${index + 1}. ${paragraph.repeat(5)}`,
  ).join('\n\n');
  const records: Record<string, unknown>[] = [
    {
      type: 'user',
      uuid: 'e2e-ui-visible-context-prompt',
      parentUuid: null,
      sessionId: UI_VISIBLE_CONTEXT_SESSION_ID,
      cwd: UI_VISIBLE_CONTEXT_WORKSPACE,
      timestamp: new Date(startedAt).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'Turn 1. Describe the layout in detail.' }] },
    },
    {
      type: 'assistant',
      uuid: 'e2e-ui-visible-context-answer',
      parentUuid: 'e2e-ui-visible-context-prompt',
      sessionId: UI_VISIBLE_CONTEXT_SESSION_ID,
      cwd: UI_VISIBLE_CONTEXT_WORKSPACE,
      timestamp: new Date(startedAt + 1_000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: answerText }] },
    },
    {
      type: 'custom-title',
      sessionId: UI_VISIBLE_CONTEXT_SESSION_ID,
      cwd: UI_VISIBLE_CONTEXT_WORKSPACE,
      timestamp: new Date(startedAt + 2_000).toISOString(),
      customTitle: UI_VISIBLE_CONTEXT_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${UI_VISIBLE_CONTEXT_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/voice-identifier-repair.spec.ts records into; its own directory so no other spec picks this session up. */
const VOICE_IDENTIFIER_WORKSPACE = path.join(dataDir, 'voice-identifier-workspace');
/** Session id that spec opens the composer in, and the display name it looks its sidebar row up by. */
const VOICE_IDENTIFIER_SESSION_ID = 'e2e-voice-identifier';
const VOICE_IDENTIFIER_SESSION_NAME = 'voice-identifier';
/**
 * The project file the utterance names, written into the seeded workspace.
 *
 * The spec does not carry this name as a literal: it lists the workspace and takes the name it finds there, so
 * the identifier it asserts on is one the project really has. A `## Touches`-level constant on both sides
 * would agree with itself whether or not the file exists.
 */
const VOICE_IDENTIFIER_FILE = 'voice.routes.ts';
/**
 * How the recogniser hears that name.
 *
 * The fixture has to arrive before the repair, not after it. With the file name spelled correctly here, the
 * claim "the composer holds the project's real file name" is true whether or not anything repairs it — the
 * criterion is then green in the world where no repair exists, which is the world it is meant to catch.
 *
 * `voice.rouse.ts` is an observed shape, not an invented one: AC-113's recovery corpus records the recogniser
 * answering `voice.rouse.ts` for `voice.routes.ts` (zh-d02).
 */
const VOICE_SPOKEN_IDENTIFIER = 'voice.rouse.ts';
/** What the fake microphone is saying. The recogniser stand-in the spec points the voice settings at answers with this same string. */
const VOICE_UTTERANCE = `please open ${VOICE_SPOKEN_IDENTIFIER} and fix the proxy`;
/**
 * Where the fake microphone reads its samples from, published so the spec's launch args can name the file.
 * Written below, in the config, because Chromium opens it at browser launch — a spec that wrote it in
 * `beforeAll` would be writing it after the browser that is meant to play it already exists.
 */
const VOICE_AUDIO_FILE = path.join(dataDir, 'voice-utterance.wav');
process.env.QUAY_E2E_VOICE_UTTERANCE = VOICE_UTTERANCE;
process.env.QUAY_E2E_VOICE_SPOKEN_IDENTIFIER = VOICE_SPOKEN_IDENTIFIER;
process.env.QUAY_E2E_VOICE_AUDIO = VOICE_AUDIO_FILE;

/**
 * Writes the audio the fake microphone plays as a 16-bit PCM WAV.
 *
 * There is no offline speech-to-text in this checkout, so the utterance cannot be a recording of a person
 * saying the identifier; what can be real is the *path*. Chromium decodes this file and hands the samples to
 * `getUserMedia`, the app's own `MediaRecorder` encodes what it hears, and the browser uploads those bytes —
 * so the recording the recogniser stand-in receives is produced by the real capture chain, not by the test.
 *
 * The waveform is derived character by character from the text it stands for, so the spoken fixture and the
 * answer the stand-in gives are two encodings of one utterance rather than two unrelated constants. It is
 * deliberately not a single tone: `MediaRecorder` has to produce a container whose bytes are worth uploading,
 * and a file whose audio is one unbroken sine is the one signal a broken capture chain also produces.
 */
const writeVoiceUtterance = (filePath: string, text: string): void => {
  const sampleRate = 48_000;
  const samples: number[] = [];

  const silence = (ms: number) => {
    samples.push(...new Array<number>(Math.round((ms / 1000) * sampleRate)).fill(0));
  };
  const burst = (frequency: number, ms: number) => {
    const count = Math.round((ms / 1000) * sampleRate);
    for (let index = 0; index < count; index += 1) {
      // A raised-sine envelope at both ends: a burst that starts and stops at full amplitude clicks, and a
      // click is broadband noise the encoder has to spend bytes on.
      const envelope = Math.sin((Math.PI * index) / count);
      samples.push(Math.round(0.4 * envelope * Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 32767));
    }
  };

  for (const character of text) {
    if (character === ' ') {
      silence(70);
      continue;
    }
    // A per-character pitch, so the file's spectrum really depends on the utterance it stands for.
    burst(200 + ((character.codePointAt(0) ?? 0) % 18) * 24, 55);
    silence(6);
  }
  silence(200);

  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], 44 + index * 2);
  }

  fs.writeFileSync(filePath, buffer);
};

/**
 * Seeds the workspace e2e/voice-identifier-repair.spec.ts records in.
 *
 * Same reason as the two above: the backend scans ~/.claude/projects at boot and only then starts its file
 * watcher with `ignoreInitial`, so a transcript written while the test runs is picked up by the watcher and
 * broadcast as a session_upserted instead — which the sidebar correctly reads as "needs attention".
 *
 * It also writes the file the utterance names. That is what makes "the project's real file name" checkable:
 * the spec reads the name back off the disk rather than restating it, so a fixture that stopped writing this
 * file would fail the criterion instead of quietly agreeing with it.
 *
 * The WAV is written here too, and for the same class of reason: it has to exist before the browser that
 * plays it is launched, and this function runs once, in the process that owns the data directory, before
 * `webServer` starts anything.
 */
const seedVoiceIdentifierWorkspace = () => {
  fs.mkdirSync(VOICE_IDENTIFIER_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(VOICE_IDENTIFIER_WORKSPACE, VOICE_IDENTIFIER_FILE),
    '// Seeded by playwright.config.ts so the voice spec has a real project file to assert against.\n',
    'utf8',
  );
  writeVoiceUtterance(VOICE_AUDIO_FILE, VOICE_UTTERANCE);

  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'voice-identifier-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // The synchronizer reads the session id and cwd from the first record it can parse, so one transcript has to
  // carry both a turn and a title.
  const records = [
    {
      type: 'user',
      sessionId: VOICE_IDENTIFIER_SESSION_ID,
      cwd: VOICE_IDENTIFIER_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the voice check' }] },
    },
    {
      type: 'custom-title',
      sessionId: VOICE_IDENTIFIER_SESSION_ID,
      cwd: VOICE_IDENTIFIER_WORKSPACE,
      timestamp,
      customTitle: VOICE_IDENTIFIER_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${VOICE_IDENTIFIER_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/voice-trim.spec.ts records into; its own directory so no other spec picks this session up. */
const VOICE_TRIM_WORKSPACE = path.join(dataDir, 'voice-trim-workspace');
/** Session id that spec opens the composer in, and the display name it looks its sidebar row up by. */
const VOICE_TRIM_SESSION_ID = 'e2e-voice-trim';
const VOICE_TRIM_SESSION_NAME = 'voice-trim';
/** The rate the fixture is written at; the capture device plays it whether or not the browser runs at this rate. */
const VOICE_TRIM_SAMPLE_RATE = 48_000;

/**
 * The fixture's timeline: a wait for the mic, one phrase, the pause while the talker thinks, a
 * second phrase.
 *
 * The 1.6 s pause is the fixture's whole point. The shipped pause table keeps 0.18 s of a gap that
 * long, so a recording of this file has roughly 40 % of its duration removed by the trim — a
 * saving far too large for the spec's "the trimmed upload is shorter" assertion to be met by
 * jitter. The phrases are pitched differently so the two are distinguishable in the waveform, not
 * that anything here depends on it.
 */
const VOICE_TRIM_TIMELINE: readonly { readonly silenceMs: number; readonly phraseMs: number; readonly baseHz: number }[] = [
  { silenceMs: 300, phraseMs: 300, baseHz: 180 },
  { silenceMs: 1600, phraseMs: 300, baseHz: 240 },
];
/** Silence after the last phrase, before the file loops. */
const VOICE_TRIM_TAIL_MS = 100;

/**
 * The samples of that timeline, as a 48 kHz mono waveform.
 *
 * Each phrase is a stack of harmonics under a raised-sine envelope rather than one sine: a single
 * unbroken tone is the signal a broken capture chain also produces, and the energy detector the
 * trim runs needs something with a loudness envelope to measure.
 */
const voiceTrimFixture = (): Float32Array => {
  const samples: number[] = [];
  const pushSilence = (ms: number) => {
    samples.push(...new Array<number>(Math.round((ms / 1000) * VOICE_TRIM_SAMPLE_RATE)).fill(0));
  };
  const pushPhrase = (ms: number, baseHz: number) => {
    const count = Math.round((ms / 1000) * VOICE_TRIM_SAMPLE_RATE);
    for (let index = 0; index < count; index += 1) {
      const envelope = Math.sin((Math.PI * index) / count);
      const wave =
        0.5 * Math.sin((2 * Math.PI * baseHz * index) / VOICE_TRIM_SAMPLE_RATE)
        + 0.3 * Math.sin((2 * Math.PI * baseHz * 2.7 * index) / VOICE_TRIM_SAMPLE_RATE)
        + 0.2 * Math.sin((2 * Math.PI * baseHz * 5.1 * index) / VOICE_TRIM_SAMPLE_RATE);
      samples.push(0.4 * envelope * wave);
    }
  };

  for (const segment of VOICE_TRIM_TIMELINE) {
    pushSilence(segment.silenceMs);
    pushPhrase(segment.phraseMs, segment.baseHz);
  }
  pushSilence(VOICE_TRIM_TAIL_MS);
  return Float32Array.from(samples);
};

/** The fixture itself, built here because its length IS the duration the spec compares against. */
const VOICE_TRIM_SAMPLES = voiceTrimFixture();
/**
 * How long a recording of that fixture is when it is played once.
 *
 * Derived from the samples rather than declared beside them: the spec records for exactly this long
 * and then asserts the untrimmed upload is this long, so a number written down twice is a number
 * that can disagree with the audio it is supposed to describe.
 */
const VOICE_TRIM_FIXTURE_SEC = VOICE_TRIM_SAMPLES.length / VOICE_TRIM_SAMPLE_RATE;
/**
 * Where the fake microphone reads its samples from, published so the spec's launch args can name it.
 * Written below, before `webServer` starts, because Chromium opens it at browser launch.
 */
const VOICE_TRIM_AUDIO_FILE = path.join(dataDir, 'voice-trim-utterance.wav');
process.env.QUAY_E2E_VOICE_TRIM_AUDIO = VOICE_TRIM_AUDIO_FILE;
process.env.QUAY_E2E_VOICE_TRIM_FIXTURE_SEC = String(VOICE_TRIM_FIXTURE_SEC);

/** Writes `samples` as a 16-bit PCM WAV. Same header the fixture generator in the voice identifier spec writes. */
const writeVoiceTrimFixture = (filePath: string, samples: Float32Array): void => {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(VOICE_TRIM_SAMPLE_RATE, 24);
  buffer.writeUInt32LE(VOICE_TRIM_SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(Math.round(samples[index] * 32767), 44 + index * 2);
  }
  fs.writeFileSync(filePath, buffer);
};

/** The project file the seeded workspace holds, so the project is a directory the app has really seen. */
const VOICE_TRIM_FILE = 'dictation.notes.md';

/**
 * Seeds the workspace e2e/voice-trim.spec.ts records in.
 *
 * Same reason as the three above: the backend scans ~/.claude/projects at boot and only then starts
 * its file watcher with `ignoreInitial`, so a transcript written while the test runs would be
 * picked up by the watcher and broadcast as a session_upserted — which the sidebar correctly reads
 * as "needs attention".
 *
 * The workspace holds one plain-prose file and nothing else. The spec's utterances are ordinary
 * sentences with no identifier in them, so the repair has nothing to rewrite them against; leaving
 * the workspace empty would also do, but a project the app has never seen a file in is not the
 * shape a real one has.
 */
const seedVoiceTrimWorkspace = () => {
  fs.mkdirSync(VOICE_TRIM_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(VOICE_TRIM_WORKSPACE, VOICE_TRIM_FILE),
    'Notes kept in the workspace the voice trim spec records in.\nNothing here is named by the spoken fixture.\n',
    'utf8',
  );
  writeVoiceTrimFixture(VOICE_TRIM_AUDIO_FILE, VOICE_TRIM_SAMPLES);

  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'voice-trim-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // The synchronizer reads the session id and cwd from the first record it can parse, so one
  // transcript has to carry both a turn and a title.
  const records = [
    {
      type: 'user',
      sessionId: VOICE_TRIM_SESSION_ID,
      cwd: VOICE_TRIM_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the trim check' }] },
    },
    {
      type: 'custom-title',
      sessionId: VOICE_TRIM_SESSION_ID,
      cwd: VOICE_TRIM_WORKSPACE,
      timestamp,
      customTitle: VOICE_TRIM_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${VOICE_TRIM_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/voice-dashscope-written.spec.ts records into; its own directory so no other spec picks this session up. */
const VOICE_DASHSCOPE_WORKSPACE = path.join(dataDir, 'voice-dashscope-workspace');
/** Session id that spec opens the composer in, and the display name it looks its sidebar row up by. */
const VOICE_DASHSCOPE_SESSION_ID = 'e2e-voice-dashscope';
const VOICE_DASHSCOPE_SESSION_NAME = 'voice-dashscope';
/** The project file the seeded workspace holds, so the project is a directory the app has really seen. */
const VOICE_DASHSCOPE_FILE = 'recognition.notes.md';
/**
 * What the fake microphone is saying.
 *
 * An ordinary sentence with no identifier in it: the recogniser this spec points the settings at is a stand-in
 * under the test's own control, and what it answers is what lands in the composer — so the spoken fixture only
 * has to be *something* the capture chain can encode, not the text under assertion. It is spelled out rather
 * than borrowed from another spec's fixture because the two specs assert on different answers, and one file
 * serving both would make a change to either look like a change to both.
 */
const VOICE_DASHSCOPE_UTTERANCE = 'the workspace recogniser writes down the sentence it hears';
/**
 * Where the fake microphone reads its samples from, published so the spec's launch args can name the file.
 * Written below, before `webServer` starts, because Chromium opens it at browser launch.
 */
const VOICE_DASHSCOPE_AUDIO_FILE = path.join(dataDir, 'voice-dashscope-utterance.wav');
process.env.QUAY_E2E_VOICE_DASHSCOPE_AUDIO = VOICE_DASHSCOPE_AUDIO_FILE;

/**
 * Seeds the workspace e2e/voice-dashscope-written.spec.ts records in.
 *
 * Same reason as the seeds above: the backend scans ~/.claude/projects at boot and only then starts its file
 * watcher with `ignoreInitial`, so a transcript written while the test runs would be picked up by the watcher
 * and broadcast as a session_upserted — which the sidebar correctly reads as "needs attention".
 *
 * The WAV is written here for the same class of reason as the identifier seed's: it has to exist before the
 * browser that plays it is launched, and this function runs once, in the process that owns the data directory,
 * before `webServer` starts anything.
 */
const seedVoiceDashscopeWorkspace = () => {
  fs.mkdirSync(VOICE_DASHSCOPE_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(VOICE_DASHSCOPE_WORKSPACE, VOICE_DASHSCOPE_FILE),
    'Notes kept in the workspace the voice provider spec records in.\nNothing here is named by the spoken fixture.\n',
    'utf8',
  );
  writeVoiceUtterance(VOICE_DASHSCOPE_AUDIO_FILE, VOICE_DASHSCOPE_UTTERANCE);

  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'voice-dashscope-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // The synchronizer reads the session id and cwd from the first record it can parse, so one transcript has to
  // carry both a turn and a title.
  const records = [
    {
      type: 'user',
      sessionId: VOICE_DASHSCOPE_SESSION_ID,
      cwd: VOICE_DASHSCOPE_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the provider check' }] },
    },
    {
      type: 'custom-title',
      sessionId: VOICE_DASHSCOPE_SESSION_ID,
      cwd: VOICE_DASHSCOPE_WORKSPACE,
      timestamp,
      customTitle: VOICE_DASHSCOPE_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${VOICE_DASHSCOPE_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/voice-error-messages.spec.ts records into; its own directory so no other spec picks this session up. */
const VOICE_ERROR_WORKSPACE = path.join(dataDir, 'voice-error-messages-workspace');
/** Session id that spec opens the composer in, and the display name it anchors its sidebar row and its locators to. */
const VOICE_ERROR_SESSION_ID = 'e2e-voice-error-messages';
const VOICE_ERROR_SESSION_NAME = 'voice-error-messages';
/** The project file the seeded workspace holds, so the project is a directory the app has really seen. */
const VOICE_ERROR_FILE = 'failure.notes.md';
/**
 * What the fake microphone is saying.
 *
 * The same shape as the dashscope seed's fixture and for the same reason: the recogniser this spec points the
 * settings at is a stand-in under the test's own control, and every answer it gives on this spec's legs is a
 * failure envelope, so the spoken fixture only has to be something the capture chain can really encode. Spelled
 * out rather than borrowed from the seed above because the two specs assert on different answers, and one file
 * serving both would make a change to either look like a change to both.
 */
const VOICE_ERROR_UTTERANCE = 'the recogniser answers this recording with a failure about the request';
/**
 * Where the fake microphone reads its samples from, published so the spec's launch args can name the file.
 * Written below, before `webServer` starts, because Chromium opens it at browser launch.
 */
const VOICE_ERROR_AUDIO_FILE = path.join(dataDir, 'voice-error-messages-utterance.wav');
process.env.QUAY_E2E_VOICE_ERROR_AUDIO = VOICE_ERROR_AUDIO_FILE;

/**
 * Seeds the workspace e2e/voice-error-messages.spec.ts records in.
 *
 * Same reason as the seeds above: the backend scans ~/.claude/projects at boot and only then starts its file
 * watcher with `ignoreInitial`, so a transcript written while the test runs would be picked up by the watcher
 * and broadcast as a session_upserted instead — which the sidebar correctly reads as "needs attention". That
 * matters more for this spec than for its neighbours, because its own session row has to be told apart from the
 * rows every other seed in this file put in the same sidebar.
 *
 * The WAV is written here for the same class of reason as the identifier seed's: it has to exist before the
 * browser that plays it is launched, and this function runs once, in the process that owns the data directory,
 * before `webServer` starts anything.
 */
const seedVoiceErrorMessageWorkspace = () => {
  fs.mkdirSync(VOICE_ERROR_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(VOICE_ERROR_WORKSPACE, VOICE_ERROR_FILE),
    'Notes kept in the workspace the voice failure-message spec records in.\nNothing here is named by the spoken fixture.\n',
    'utf8',
  );
  writeVoiceUtterance(VOICE_ERROR_AUDIO_FILE, VOICE_ERROR_UTTERANCE);

  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'voice-error-messages-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // The synchronizer reads the session id and cwd from the first record it can parse, so one transcript has to
  // carry both a turn and a title.
  const records = [
    {
      type: 'user',
      sessionId: VOICE_ERROR_SESSION_ID,
      cwd: VOICE_ERROR_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the failure-message check' }] },
    },
    {
      type: 'custom-title',
      sessionId: VOICE_ERROR_SESSION_ID,
      cwd: VOICE_ERROR_WORKSPACE,
      timestamp,
      customTitle: VOICE_ERROR_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${VOICE_ERROR_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/mobile-composer-send-key.spec.ts opens its composer in. */
const MOBILE_SEND_KEY_WORKSPACE = path.join(dataDir, 'mobile-send-key-workspace');
/** Session id that spec's project is registered by, and the display name it looks the row up by. */
const MOBILE_SEND_KEY_SESSION_ID = 'e2e-mobile-send-key';
const MOBILE_SEND_KEY_SESSION_NAME = 'mobile-send-key';

/**
 * Seeds the workspace e2e/mobile-composer-send-key.spec.ts drives the composer in.
 *
 * The spec needs a project to select, not a session to read, and indexing a session is what registers its
 * project — so one plain turn is enough. Same reason as the four above for placing it here rather than in
 * the spec: the backend scans ~/.claude/projects at boot and only then starts its file watcher with
 * `ignoreInitial`, so a transcript written while the test runs is picked up by the watcher and broadcast as
 * a session_upserted, which the sidebar correctly reads as "needs attention".
 */
const seedMobileSendKeyWorkspace = () => {
  fs.mkdirSync(MOBILE_SEND_KEY_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'mobile-send-key-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // The synchronizer reads the session id and cwd from the first record it can parse, so one transcript has to
  // carry both a turn and a title.
  const records = [
    {
      type: 'user',
      sessionId: MOBILE_SEND_KEY_SESSION_ID,
      cwd: MOBILE_SEND_KEY_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the send-key check' }] },
    },
    {
      type: 'custom-title',
      sessionId: MOBILE_SEND_KEY_SESSION_ID,
      cwd: MOBILE_SEND_KEY_WORKSPACE,
      timestamp,
      customTitle: MOBILE_SEND_KEY_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${MOBILE_SEND_KEY_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/mobile-workspace-composer-layout.spec.ts reads its mobile cells in. */
const MOBILE_LAYOUT_WORKSPACE = path.join(dataDir, 'mobile-layout-workspace');
/** Session id that file navigates to, and the display name its header has to hold. */
const MOBILE_LAYOUT_SESSION_ID = 'e2e-mobile-layout';
/**
 * The name is deliberately long.
 *
 * The matrix asserts that the workspace header is a single row below the breakpoint, and the row it has to hold
 * holds this name next to the selector that replaced the tablist. A short name — every other seeded session in
 * this file has one — would fit whether or not the header had been collapsed, so the cell that reads the header
 * would pass against the layout it exists to rule out.
 */
const MOBILE_LAYOUT_SESSION_NAME = 'mobile workspace and composer layout session with a name long enough to truncate';

/**
 * Seeds the long-title session the viewport matrix's mobile cells read, in a workspace of its own.
 *
 * A workspace of its own for the same reason the four specs above have one: the header's dialog lists the
 * workspaces a run has, and a session added to one already in use is a new row in lists that other specs read
 * with unscoped locators. Placed here rather than in the spec for the reason the note above gives — the backend
 * starts its watcher with `ignoreInitial` only after the boot scan, so a transcript written mid-run is broadcast
 * as a session_upserted and read as "needs attention".
 */
const seedMobileLayoutWorkspace = () => {
  fs.mkdirSync(MOBILE_LAYOUT_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'mobile-layout-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const records = [
    {
      type: 'user',
      sessionId: MOBILE_LAYOUT_SESSION_ID,
      cwd: MOBILE_LAYOUT_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the layout matrix' }] },
    },
    {
      type: 'custom-title',
      sessionId: MOBILE_LAYOUT_SESSION_ID,
      cwd: MOBILE_LAYOUT_WORKSPACE,
      timestamp,
      customTitle: MOBILE_LAYOUT_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${MOBILE_LAYOUT_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/transcript-work-segments.spec.ts opens; its own directory so no other spec picks this session up. */
const WORK_SEGMENT_WORKSPACE = path.join(dataDir, 'work-segment-workspace');
/** Session id that spec addresses, and the display name it looks its sidebar row up by. */
const WORK_SEGMENT_SESSION_ID = 'e2e-work-segment';
const WORK_SEGMENT_SESSION_NAME = 'work-segment';
/**
 * The one phrase the spec searches for.
 *
 * It is deliberately longer than the 80 characters `searchTargetLocator.normalizeSearchSnippet` keeps, and it
 * is a single run of plain letters and spaces, so the fragment the sidebar search hands back survives JSON
 * encoding byte-for-byte inside the tool call's input. The phrase is written into two places on purpose: the
 * hidden tool call's input (a segment member, where the hit has to land) and the assistant's closing text (a
 * text row the conversation search — which only indexes `text` blocks — can actually find). The member comes
 * first in file order, so the locator resolves the hit to the member, not to the text row that quotes it.
 */
const WORK_SEGMENT_HIT_PHRASE =
  'The quick brown fox jumps over the lazy dog near the riverbank at dawn while the beacon glows amber';

/**
 * Seeds the transcript e2e/transcript-work-segments.spec.ts measures, here rather than from the spec itself.
 *
 * Same reason as every seed above: the backend scans ~/.claude/projects at boot and only then starts its file
 * watcher with `ignoreInitial`, so a transcript written while the test runs is picked up by the watcher and
 * broadcast as a session_upserted instead of being indexed quietly.
 *
 * The shape is one turn of work. A user prompt, then three maximal runs of thinking/tool rows separated by
 * short assistant text rows, then a closing assistant row. Written one part per JSONL record, so every row
 * carries a timestamp of its own — the transcript's search jump locates a row by timestamp alone, and a run
 * whose members shared one would leave the jump unable to tell the hit apart from the segment's anchor. The
 * runs are 7, 8 and 5 members (20 work rows); with the four text rows that is 24 rows before any merging,
 * and the collapsed default draws 3 segment headers plus those 4 text rows.
 *
 * This is a plain-claude fixture and NOT a debug-agent one. The debug seam's scenario dialect is a closed set
 * whose `row` only carries `{role, text}` — it cannot express a thinking or tool-use row — while a work
 * segment's members are exactly those row types. There is no way to build this fixture through that gate, so
 * the two readings below must not be attributed to it; §Debug-agent gate below registers the spec for a
 * different reason (see its own comment).
 */
const seedWorkSegmentTranscript = () => {
  fs.mkdirSync(WORK_SEGMENT_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'work-segment-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });

  const startedAt = Date.now();
  let tick = 0;
  let parentUuid: string | null = null;
  const records: Record<string, unknown>[] = [];

  const append = (role: 'user' | 'assistant', part: Record<string, unknown>) => {
    const uuid = `e2e-work-segment-${tick}`;
    records.push({
      type: role,
      uuid,
      parentUuid,
      sessionId: WORK_SEGMENT_SESSION_ID,
      cwd: WORK_SEGMENT_WORKSPACE,
      // One second apart, so a row's timestamp names exactly one row.
      timestamp: new Date(startedAt + tick * 1_000).toISOString(),
      message: { role, content: [part] },
    });
    parentUuid = uuid;
    tick += 1;
  };

  const prompt = (text: string) => append('user', { type: 'text', text });
  const thinking = (text: string) => append('assistant', { type: 'thinking', thinking: text });
  const bash = (id: string, command: string) =>
    append('assistant', { type: 'tool_use', id, name: 'Bash', input: { command } });
  const say = (text: string) => append('assistant', { type: 'text', text });

  prompt('Show me the release notes for the work segment browser.');

  // First run: 7 members, no hit.
  thinking('Scanning the notes directory.');
  bash('seg-tool-1', 'ls -la notes/');
  thinking('Listing the note files it found.');
  bash('seg-tool-2', 'wc -l notes/release-notes.md');
  thinking('Counting the lines to size the read.');
  bash('seg-tool-3', 'head -n 20 notes/release-notes.md');
  thinking('Reading the opening of the notes.');

  say('First pass complete.');

  // Second run: 8 members; the hit is the second member (a tool call whose input carries the phrase).
  bash('seg-tool-4', 'cat notes/index.txt');
  bash('seg-tool-5', `grep -n "${WORK_SEGMENT_HIT_PHRASE}" notes/release-notes.md`);
  thinking('The grep found the passage I was looking for.');
  bash('seg-tool-6', 'sed -n 40,60p notes/release-notes.md');
  thinking('Reading the surrounding section.');
  bash('seg-tool-7', 'tail -n 15 notes/release-notes.md');
  thinking('Checking the closing lines.');
  bash('seg-tool-8', 'sort notes/release-notes.md | uniq | head');

  say('Second pass complete.');

  // Third run: 5 members, no hit.
  thinking('Summarising what the notes contain.');
  bash('seg-tool-9', 'grep -c TODO notes/release-notes.md');
  thinking('Counting the open items.');
  bash('seg-tool-10', 'grep -n FIXME notes/release-notes.md');
  thinking('Listing the fixes still pending.');

  say(WORK_SEGMENT_HIT_PHRASE);

  records.push({
    type: 'custom-title',
    sessionId: WORK_SEGMENT_SESSION_ID,
    cwd: WORK_SEGMENT_WORKSPACE,
    timestamp: new Date(startedAt + tick * 1_000).toISOString(),
    customTitle: WORK_SEGMENT_SESSION_NAME,
  });

  fs.writeFileSync(
    path.join(transcriptDir, `${WORK_SEGMENT_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/transcript-fork-from-answer.spec.ts opens; its own directory so no other spec picks this session up. */
const FORK_ANCHOR_WORKSPACE = path.join(dataDir, 'fork-anchor-workspace');
/**
 * Session the fork fixture belongs to, and — unlike every seed above — a real UUID.
 *
 * The other seeds name their session with a readable string, which is enough for a transcript the app
 * only has to *read*. This one has to be *forked*: `forkSession` in the Claude Agent SDK looks the
 * transcript up as `<projects>/<sanitized cwd>/<session id>.jsonl` and copies it, so the id has to be
 * the shape a Claude session really has, and the fixture has to sit where a real one would. The two
 * row uuids the spec forks at are UUIDs for the same reason, and sharper: the SDK validates
 * `upToMessageId` against a uuid pattern and throws `Invalid upToMessageId` before it ever looks at
 * the transcript, so a readable anchor would make the fork fail rather than exercise it.
 */
const FORK_ANCHOR_SESSION_ID = '99999999-9999-4999-8999-999999999999';

/** The two turn-ending answers, and the prompt that opens the second turn. Read by the spec off the page. */
const FORK_ANCHOR_FIRST_ANSWER = 'The first answer, about the release notes.';
const FORK_ANCHOR_SECOND_PROMPT = 'Now summarise the second section.';
const FORK_ANCHOR_SECOND_ANSWER = 'The second answer, about the changelog.';

/**
 * Seeds the two-turn transcript e2e/transcript-fork-from-answer.spec.ts forks.
 *
 * Same reason as every seed above: the backend scans ~/.claude/projects at boot and only then starts
 * its file watcher with `ignoreInitial`, so a transcript written while the test runs is picked up by
 * the watcher and broadcast as a `session_upserted` instead of being indexed quietly.
 *
 * ONE DEPARTURE FROM THE SEEDS ABOVE: this transcript is written into `<projects>/<sanitize(cwd)>/`
 * rather than a readable directory name. The directory a transcript sits in is not what the app reads
 * it from — the claude provider scans every subdirectory of `~/.claude/projects` — so every other seed
 * names its directory after the spec. But the SDK's fork resolves the source by *path*: it computes
 * `<CLAUDE_CONFIG_DIR ?? ~/.claude>/projects/<cwd.replace(/[^a-zA-Z0-9]/g,'-')>/<id>.jsonl` and reads
 * exactly that. Naming the directory anything else makes the fork report "Session not found in project
 * directory" while the transcript is sitting right there. `cwd` is therefore the *realpath* of the
 * workspace, and the directory name is that sanitized — the same value the SDK will compute, which
 * also keeps the fork's own output landing beside its source.
 *
 * The shape is two turns. The first is a turn that calls a tool — an assistant thinking row, an
 * assistant tool_use row, and the user tool_result row answering it — so a fork cut at its answer has
 * a tool call behind it to leave behind (a dangling tool_use is exactly what that is for). The second
 * turn is plain text, so the branch has something it must *not* contain. The assistant text row that
 * closes each turn is the row the product stamps `forkAnchorId` on.
 */
const seedForkAnchorTranscript = () => {
  fs.mkdirSync(FORK_ANCHOR_WORKSPACE, { recursive: true });
  // The realpath, because that is what the SDK will resolve `dir` through before sanitizing it. A
  // dataDir under a symlinked `/tmp` would otherwise give the fork a directory the seed never wrote.
  const workspace = fs.realpathSync(FORK_ANCHOR_WORKSPACE);
  const projectDirName = workspace.replace(/[^a-zA-Z0-9]/g, '-');
  // The SDK caps a sanitized project directory at 200 characters and, past that, appends a hash of
  // the original path. Recomputing that hash is not possible from here, so a data directory long
  // enough to reach the cap is refused by name rather than silently seeded somewhere the fork will
  // never look.
  if (projectDirName.length > 200) {
    throw new Error(
      `the fork fixture's project directory name is ${projectDirName.length} characters; the SDK hashes past 200, so this seed cannot place the transcript where the fork looks`,
    );
  }
  const transcriptDir = path.join(dataDir, '.claude', 'projects', projectDirName);
  fs.mkdirSync(transcriptDir, { recursive: true });

  const startedAt = Date.now();
  let tick = 0;
  let parentUuid: string | null = null;
  const records: Record<string, unknown>[] = [];

  const append = (type: 'user' | 'assistant', uuid: string, content: unknown) => {
    records.push({
      type,
      uuid,
      parentUuid,
      sessionId: FORK_ANCHOR_SESSION_ID,
      cwd: workspace,
      // One second apart, so a row's timestamp names exactly one row.
      timestamp: new Date(startedAt + tick * 1_000).toISOString(),
      message: { role: type, content },
    });
    parentUuid = uuid;
    tick += 1;
  };

  append('user', '11111111-1111-4111-8111-111111111111', 'Show me the release notes.');
  append('assistant', 'aaaaaaaa-1111-4111-8111-111111111111', [
    { type: 'thinking', thinking: 'Reading the notes before summarising them.' },
  ]);
  append('assistant', 'bbbbbbbb-1111-4111-8111-111111111111', [
    { type: 'tool_use', id: 'fork-tool-1', name: 'Read', input: { file_path: 'notes/release-notes.md' } },
  ]);
  append('user', '33333333-3333-4333-8333-333333333333', [
    { type: 'tool_result', tool_use_id: 'fork-tool-1', content: 'release notes' },
  ]);
  // The first turn's answer, and the row the spec forks at.
  append('assistant', '44444444-4444-4444-8444-444444444444', [
    { type: 'text', text: FORK_ANCHOR_FIRST_ANSWER },
  ]);

  append('user', '55555555-5555-4555-8555-555555555555', FORK_ANCHOR_SECOND_PROMPT);
  append('assistant', '66666666-6666-4666-8666-666666666666', [
    { type: 'text', text: FORK_ANCHOR_SECOND_ANSWER },
  ]);

  fs.writeFileSync(
    path.join(transcriptDir, `${FORK_ANCHOR_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/**
 * Marks the cache directory this run is writing as this checkout's, by holding the working directory that
 * wrote it. Sits beside `deps`, never inside it, so no marker travels into a seeded cache.
 */
const VITE_CACHE_ROOT_MARKER = '.quay-e2e-root';

/**
 * The dependency cache this run should seed from, or undefined when nothing on this host can be valid for it.
 *
 * Vite keys the on-disk pre-bundle it finds by a `configHash` that includes `root`, and `root` defaults to
 * the process cwd — so a cache is only usable when it was written by the working directory now reading it,
 * and a cache from any other root is one Vite silently discards and re-optimizes. Nothing here has to
 * recompute that hash to know which is which: a run drops `VITE_CACHE_ROOT_MARKER` beside the cache it is
 * about to write, naming its own working directory, and a marker that matches is the proof the cache beside
 * it was written by this root.
 *
 * The sibling scan is what makes this work in a worktree. `dispatch-worktree-setup.sh` links every task
 * worktree's `node_modules` to the main checkout's, so the shared `node_modules/.vite` is written by the
 * *main* root and can never be valid for a worktree — copying it there costs the I/O and buys nothing. A
 * sibling run's private cache, written by this same worktree moments ago, can be valid, and the marker is
 * how it is found without guessing.
 *
 * The marker, and not a recency window, is the filter — measured, because the obvious rule fails exactly
 * where it matters. A first version kept the eight newest cache directories in the pool and looked for a
 * marker among them; in a 28-lane burst the eight newest are the eight siblings that are still optimizing,
 * so it reported `seed=none` in every lane of every burst while working perfectly on a quiet host. What is
 * bounded here instead is the work per directory — one small read, and a `stat` only for directories that
 * already carry this root's marker — which the pool's size sets and a burst does not.
 */
const dependencyCacheDonor = (): string | undefined => {
  const root = fs.realpathSync(process.cwd());
  const pool = path.dirname(dataDir);
  const mine = path.basename(dataDir);
  let newest: { deps: string; at: number } | undefined;
  try {
    for (const entry of fs.readdirSync(pool, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === mine) continue;
      const cache = path.join(pool, entry.name, 'vite-cache');
      let marker: string;
      try {
        marker = fs.readFileSync(path.join(cache, VITE_CACHE_ROOT_MARKER), 'utf8');
      } catch {
        continue; // Another tool's directory in the shared parent, or a run from another checkout.
      }
      if (marker !== root) continue;
      const deps = path.join(cache, 'deps');
      try {
        // Vite commits an optimize by renaming a temporary directory into place, and the copy below commits
        // the same way — so a `deps` that exists is complete, and a sibling still working has none.
        const at = fs.statSync(path.join(deps, '_metadata.json')).mtimeMs;
        if (!newest || at > newest.at) newest = { deps, at };
      } catch {
        // Marked, but no pre-bundle committed beside it yet. Not a donor yet.
      }
    }
  } catch {
    // An unreadable pool is not a reason to fail a run; it just leaves the shared cache as the only source.
  }
  if (newest) return newest.deps;

  // No sibling cache yet. The shared `node_modules/.vite` is worth copying only when it, too, was written by
  // this root — in the main checkout, where `node_modules` really is a directory inside this working
  // directory. Anywhere `node_modules` resolves elsewhere, the shared cache carries that other root's hash.
  const sharedDeps = path.resolve('node_modules', '.vite', 'deps');
  return path.dirname(fs.realpathSync('node_modules')) === root ? sharedDeps : undefined;
};

/**
 * Fills this run's own dependency cache with a pre-bundle Vite will accept, so `viteCacheDir` starts hot.
 *
 * Isolation is about who may *write* the cache, not about paying for a pre-bundle. The run keeps a private
 * directory and takes its *contents* from whichever cache on this host Vite will actually trust, chosen by
 * `dependencyCacheDonor` above: a sibling run's cache written by this same checkout, else the shared
 * `node_modules/.vite` when that too was written by this root, else nothing. Every failure below still simply
 * degrades to Vite optimizing into the private directory from scratch — correct, only slower.
 *
 * The copy has to be repaired on the way in, but only in one of its two path fields. Vite stores both as
 * paths *relative to the deps directory that wrote them* (`stringifyDepsOptimizerMetadata`) and resolves them
 * back against whichever directory it reads them from (`parseDepsOptimizerMetadata`) — so both have to be
 * right for the directory they now live in, and the two need opposite treatment:
 *
 *   `file` is the optimized chunk itself, which sits *inside* the deps directory (`getOptimizedDepPath`
 *   builds it from that directory), so it is stored as a bare name like `react.js` and the copy brought it
 *   along. Left alone it is already correct, and it must be: resolving it against the directory it came from
 *   would point this run's chunk requests back into the shared directory, so the run would read chunk bytes
 *   from the very thing it is supposed to be isolated from — a sibling's re-optimization could then rename
 *   them away mid-run and the 504s would be back.
 *
 *   `src` is the module in `node_modules` the chunk was built from, which the copy did *not* bring along
 *   (`../../react/index.js`, reaching out of the deps directory into the checkout). Relocated verbatim it
 *   would resolve against this run's throwaway directory instead — naming nothing, and making a nested
 *   dependency (`react-dom > scheduler`) unmatchable in `tryOptimizedResolve`, the one place a cached `src`
 *   is genuinely consulted. Recomputing it for the new directory is what makes the seeded metadata say
 *   exactly what Vite would have written had it optimized into this directory itself.
 *
 * This repair is what makes a worktree's pre-bundle possible at all: a seeded cache is only valid when it was
 * written by *this* root (`configHash` includes the root), and the shared cache never was — it belongs to
 * whichever checkout `node_modules` really lives in. So in a worktree the donor search, not the shared copy,
 * is the path that carries the pre-bundle; the shared copy stays for the main checkout, where it is valid.
 *
 * Ownership matters: workers re-evaluate this file, and the cache in their `dataDir` is the one the run's own
 * server is serving from — so the caller runs this once, before the servers start, and never again.
 */
const seedViteCache = (destination: string): void => {
  const seedStartedAt = Date.now();
  const destinationDeps = path.join(destination, 'deps');
  // Copied into a staging directory and renamed into place, the way Vite commits its own pre-bundle. A
  // sibling scanning this pool for a donor must find either no `deps` or a complete one, never the
  // half-written middle of a copy — whose `_metadata.json` is valid the moment it lands while the chunks it
  // names are still arriving, which is a cache Vite accepts and then fails to serve from.
  const staging = path.join(destination, `.quay-e2e-deps-${process.pid}`);
  fs.mkdirSync(destination, { recursive: true });
  try {
    // Written before the copy, and beside `deps` rather than inside it, so a run that seeds nothing still
    // leaves the marker: the *next* run in this checkout is the one that benefits from it.
    fs.writeFileSync(path.join(destination, VITE_CACHE_ROOT_MARKER), fs.realpathSync(process.cwd()));
  } catch {
    // An unmarkable cache is still a working cache; this run just cannot seed a later one.
  }

  const source = dependencyCacheDonor();
  if (!source) {
    // Said out loud because it is the one outcome that costs the run a pre-bundle: the boot below will pay
    // for it. A run that never prints this is reading a cache Vite accepts and will not touch.
    console.log(`[e2e] vite-cache seed=none in ${Date.now() - seedStartedAt}ms (vite must optimize)`);
    return;
  }
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(source, staging, { recursive: true });

    const metadataPath = path.join(staging, '_metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as {
      optimized?: Record<string, Record<string, unknown>>;
    };
    for (const entry of Object.values(metadata.optimized ?? {})) {
      // `file` is deliberately not touched — see above: it names a chunk the copy carried with it.
      const value = entry.src;
      if (typeof value === 'string') {
        // Resolved against the directory that *wrote* it — a donor's `deps`, or the shared one — and then
        // re-relativized to where this copy is about to live, not the staging path it was written from.
        // Correct for either source, and correct for a donor whose own `src` fields already point out at the
        // real `node_modules` rather than beside themselves.
        entry.src = path.relative(destinationDeps, path.resolve(source, value));
      }
    }
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    // The rename is the commit: until it lands there is no `deps` here for a sibling to read.
    fs.rmSync(destinationDeps, { recursive: true, force: true });
    fs.renameSync(staging, destinationDeps);
    console.log(`[e2e] vite-cache seed=${source} in ${Date.now() - seedStartedAt}ms`);
  } catch {
    // A cache being rewritten by a sibling run right now (the very race this closes) can hand back a torn or
    // unreadable copy. Keeping it would leave Vite a cache whose entries no longer describe the files beside
    // them, so the copy is discarded and Vite optimizes into the private directory from scratch.
    fs.rmSync(staging, { recursive: true, force: true });
    console.log(`[e2e] vite-cache seed=discarded in ${Date.now() - seedStartedAt}ms (vite must optimize)`);
  }
};

/**
 * Workspace `e2e/voice-continuous.spec.ts` records into.
 *
 * The spec synthesises the microphone in-page (a fake `AudioContext`/`AudioWorkletNode` graph, so it can
 * speak an exact timeline of speech and pauses), which is why this seed writes no audio file: the fixture
 * is the *session*, and the utterance is the spec's own PCM. The transcript still has to be written here,
 * before the servers boot, because the backend scans `~/.claude/projects` once at startup and never adopts
 * a transcript written later.
 */
const VOICE_CONTINUOUS_WORKSPACE = path.join(dataDir, 'voice-continuous-workspace');
const VOICE_CONTINUOUS_SESSION_ID = 'e2e-voice-continuous';
const VOICE_CONTINUOUS_SESSION_NAME = 'voice-continuous';
const seedVoiceContinuousWorkspace = () => {
  fs.mkdirSync(VOICE_CONTINUOUS_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(VOICE_CONTINUOUS_WORKSPACE, 'capture.notes.md'),
    'Notes kept in the workspace the continuous voice spec records in.\n',
    'utf8',
  );

  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'voice-continuous-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const records = [
    {
      type: 'user',
      sessionId: VOICE_CONTINUOUS_SESSION_ID,
      cwd: VOICE_CONTINUOUS_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the continuous capture check' }] },
    },
    {
      type: 'custom-title',
      sessionId: VOICE_CONTINUOUS_SESSION_ID,
      cwd: VOICE_CONTINUOUS_WORKSPACE,
      timestamp,
      customTitle: VOICE_CONTINUOUS_SESSION_NAME,
    },
  ];
  fs.writeFileSync(
    path.join(transcriptDir, `${VOICE_CONTINUOUS_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/**
 * Workspace `e2e/voice-live-vad-ab.spec.ts` opens its composer in; its own directory so no other spec picks this
 * session up — the same reason every other voice spec has one.
 *
 * The spec feeds its audio through the upload entry and, for the switch-off leg, the fake microphone, so no
 * audio file is seeded here: the fixture is the session, and the utterances are the spec's own bytes/corpus.
 * The transcript still has to be written before the servers boot, because the backend scans `~/.claude/projects`
 * once at startup and never adopts a transcript written later.
 */
const VOICE_LIVE_VAD_WORKSPACE = path.join(dataDir, 'voice-live-vad-workspace');
const VOICE_LIVE_VAD_SESSION_ID = 'e2e-voice-live-vad';
const VOICE_LIVE_VAD_SESSION_NAME = 'voice-live-vad';
const seedVoiceLiveVadWorkspace = () => {
  fs.mkdirSync(VOICE_LIVE_VAD_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(VOICE_LIVE_VAD_WORKSPACE, 'reading.notes.md'),
    'Notes kept in the workspace the live VAD reading spec records in.\n',
    'utf8',
  );

  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'voice-live-vad-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const records = [
    {
      type: 'user',
      sessionId: VOICE_LIVE_VAD_SESSION_ID,
      cwd: VOICE_LIVE_VAD_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the live VAD reading check' }] },
    },
    {
      type: 'custom-title',
      sessionId: VOICE_LIVE_VAD_SESSION_ID,
      cwd: VOICE_LIVE_VAD_WORKSPACE,
      timestamp,
      customTitle: VOICE_LIVE_VAD_SESSION_NAME,
    },
  ];
  fs.writeFileSync(
    path.join(transcriptDir, `${VOICE_LIVE_VAD_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

if (isDataDirOwner) {
  seedViteCache(viteCacheDir);
  seedSessionFilterTranscripts();
  seedSessionFilterLiveTranscript();
  seedTranscriptFollowTranscript();
  seedTranscriptJumpTranscript();
  seedTranscriptJumpTallTranscript();
  seedUiVisibleContextTranscript();
  seedVoiceIdentifierWorkspace();
  seedVoiceContinuousWorkspace();
  seedVoiceLiveVadWorkspace();
  seedVoiceTrimWorkspace();
  seedVoiceDashscopeWorkspace();
  seedVoiceErrorMessageWorkspace();
  seedMobileSendKeyWorkspace();
  seedMobileLayoutWorkspace();
  seedWorkSegmentTranscript();
  seedForkAnchorTranscript();
}

/**
 * The specs that drive the debug agent, and the fixture home the server gets when one of them is selected.
 *
 * The debug agent's provider is not a product provider: `provider.registry.ts` writes its key only while the gate
 * is open (`DEBUG_AGENT` + `DEBUG_AGENT_HOME`), so a server booted without those variables cannot arm a scenario,
 * cannot resolve provider `debug`, and mounts no control plane. Turning the gate on for every run would put a
 * fixture-writing provider and its HTTP face in front of every other spec's server — the face is authenticated but
 * it is still a surface nothing else asked for. `selectedSpecFiles()` is the seam that keeps that from happening:
 * the selection is this invocation's own command line, so the gate opens for exactly the runs that name one of the specs
 * below and the env object is byte-identical to what it was for every other selection.
 *
 * The home is a directory of its own under `dataDir`, and NOT `dataDir` itself, which it used to be. The reason is
 * a collision rather than a preference. `getDebugAgentProjectsRoot()` answers `<home>/.claude/projects`, and the
 * server's `HOME` is `dataDir` — so `home = dataDir` put the fixture transcripts inside `<HOME>/.claude/projects`,
 * which is exactly the tree the *claude* provider scans and watches. Both indexers then claimed every armed
 * transcript and the claude one, running from the watcher after the arming call, won: the row ended up stored
 * under provider `claude` while carrying the `resident` mode the debug seam had written, and `POST
 * /api/session-hosts/:sessionId/start` resolved the claude host driver for it — a driver that refuses to open a
 * resident host on demand, because for claude a resident host is born in the driver's run entry. The criterion
 * could not start the process it had armed.
 *
 * A home of its own keeps the two readers apart, and nothing is lost by it: arming indexes the transcript itself
 * (`synchronizeFile`) rather than waiting for a disk scan, so the session row, its project link and its stored
 * mode all exist regardless of where the file sits. The old comment's worry — "a home anywhere else would write
 * transcripts no listing could see" — describes a reader that no longer exists.
 */
// A list rather than one name: the fixture home is a *directory* under `dataDir`, so specs that ask for the
// gate share it, and each derives its own workspace beneath it. Splitting the home per spec would buy nothing —
// the collision the block above describes is between the fixture tree and the *claude* provider's scan root, not
// between two fixture users — and the specs never run in one invocation, since a selection names one file.
const DEBUG_AGENT_SPEC_FILES: readonly string[] = [
  // The architecture tab's geometry criterion. It needs the fixture home for two things the seam
  // exists for: a session whose transcript names the entities the reading is about (so the server's
  // seed extractor resolves them), and a project the client will offer the Architecture tab for. The
  // `.archguard` tree itself is written by the spec under this home before it arms the scenario.
  'architecture-canvas-layout.spec.ts',
  // The four-doors criterion: same fixture home, because it needs the same two
  // things — a session whose user text seeds the entities the message is about,
  // and a project with an `.archguard` cache so the Architecture tab exists. It
  // writes its own three-entity tree under that home.
  'architecture-send-to-chat.spec.ts',
  // The keyboard criterion: same fixture home (a session whose transcript seeds
  // the entities the reading is about, and a project with an `.archguard` cache
  // so the Architecture tab exists). It writes its own `.archguard` tree under
  // that home and needs no other channel.
  'architecture-keyboard.spec.ts',
  // The fullscreen criterion: same fixture home (a session whose transcript
  // seeds the entities the drawing is about, and a project with an `.archguard`
  // cache so the Architecture tab exists). It writes its own three-entity tree
  // under that home and needs no other channel.
  'architecture-fullscreen.spec.ts',
  // The standalone-page criterion: the same fixture home for the same two
  // reasons (a transcript naming the seeds, and a project that offers the
  // Architecture tab). It writes its own three-entity tree and drives TWO pages
  // in one context plus the BroadcastChannel between them.
  'architecture-standalone.spec.ts',
  // The single-scale / fit contract: the same fixture home is what gives it a
  // session whose transcript seeds the hub of each fixture and a project that
  // offers the Architecture tab. It writes four `.archguard` trees under it.
  'architecture-fit-contract.spec.ts',
  // The status bar's own criterion.
  'resident-status-bar.spec.ts',
  // The busy-send criterion: same provider, same control plane, same fixture home — a second
  // entry here rather than a second gate, so a run that selects only one of them boots one server.
  'resident-busy-send.spec.ts',
  // The running-view criterion: same provider and control plane again, so the same argument holds.
  'resident-running-view.spec.ts',
  // The layout criterion: same provider, same control plane and fixture home as the three above. It
  // arms two sessions off the same clock (one stored resident, one per-run) to read both the status
  // bar's geometry and the composer switch's presence and absence in one run, so it needs that plane.
  'resident-ui-layout.spec.ts',
  // The activity-dock truthfulness criterion: same provider and control plane again, and it needs one
  // extra thing from this selection — a server whose heartbeat beat and silence threshold are short
  // enough to watch a degrade inside the 60s gate. That override is applied to the server env below,
  // for this selection only; every other selection keeps the shipped 5000/15000.
  'activity-dock-truthful.spec.ts',
  // The work-segment density/search criterion. It is listed here because the criterion's contract asks for
  // the registration; it does NOT read the seam's fixture. Its transcript is a plain-claude seed (see the
  // work-segment seed above), because the seam's `row` vocabulary is `{role, text}` and cannot express the
  // thinking/tool rows a work segment is made of. So neither of that spec's readings is evidence about this
  // gate — the entry only pins that fact alongside the gate it is deliberately not using.
  'transcript-work-segments.spec.ts',
  // The global-stylesheet criterion: it renders a Markdown corpus (fenced code, a table, a tool result)
  // through the same seam and reads what the authored rules in src/index.css do to it.
  'css-global-rules.spec.ts',
  // The activity-dock background criterion (AC-194): it arms a scenario whose clock writes
  // task-lifecycle rows and a cron plan, then reads the dock's task/schedule panel, the transcript cards
  // and the activity snapshot on a real page — so it needs the same provider, control plane and fixture
  // home as the specs above, and the activity protocol's frames to reach the browser.
  'activity-dock-background.spec.ts',
  // The task-terminal-row criterion (gap-shell-terminal-row-only-true-background): it arms a scenario
  // whose clock writes four Bash calls — three foreground ones whose `tool_use` carries no
  // `run_in_background` and whose end is an announced `task-notification`, one background one that ends
  // silently on a `task-updated` — and reads the transcript rows and the work segment they land in. That
  // needs the same seam the entry above needs: the fixture-writing provider, its control plane, and the
  // run loop's frames reaching a real page.
  'transcript-task-terminal-row.spec.ts',
  // The voice-realtime criterion (GOAL-031 / AC-312): it arms a scenario so a
  // debug-agent session is readable and, more importantly, so a `session_send`
  // to that session writes its text as a real transcript row on disk — which is
  // the "the reply is in the transcript" half of the criterion. It needs this
  // seam for the same reason the entries above do.
  'voice-realtime-live-session-send.spec.ts',
  // The voice-realtime upload criterion (GOAL-031 / AC-315): the same session-
  // readable, session_send-writes-a-real-row seam as the entry above, driven
  // through the upload path instead of the (faked) microphone.
  'voice-realtime-upload-fixture.spec.ts',
  // The composer-embedded bar criterion (GOAL-035 / AC-323): the same seam again — it
  // arms a scenario so a `session_send` writes a real transcript row, which is what the
  // "the bar does not cover the newest row" reading needs — plus a model row of its own,
  // because the in-bar model selector is only rendered when the provider HAS model options.
  'voice-realtime-composer-embedded.spec.ts',
  // The unanswered-turn criterion (gap-live-voice-upstream-stall-no-answer): the same
  // session_send-writes-a-real-row seam as the three voice entries above. Its arm stalls the
  // endpoint past the bridge's own deadline and reads that the spoken turn has a destination on
  // screen while it is silent, so it needs the scenario-driven transcript the seam provides — the
  // row the late answer lands on is where the notice is spent.
  'voice-realtime-turn-unanswered.spec.ts',
  // The shared scripted-upstream criterion (gap-live-voice-e2e-scripted-upstream): the same
  // session_send-writes-a-real-row seam as the four voice entries above, driven from ONE shared
  // fake upstream instead of a per-file inline one. Its queue-full case parks a run in a `wait`
  // step far out on the walk's clock so the session's turn lease is held while the relay's queue
  // fills, which is exactly the `DEBUG_AGENT_HOME`-armed scenario the entries above need.
  'voice-realtime-scripted-scenarios.spec.ts',
  // The 2026-10-12 segmented-session replay: debug-agent stands in for Claude so S1/S5 land as rows.
  'voice-realtime-segmented-replay-20261012.spec.ts',
  // The per-utterance withdrawal criterion (gap-live-voice-pending-utterance-withdraw / AC-351, GOAL-041):
  // it needs the same seam as the voice entries above — a scripted upstream for the spoken sentences —
  // PLUS the debug agent's own command queue, because the sentence it withdraws has to be a command a
  // resident session is really holding (a `session_send` against a mid-turn resident session is a PUSH,
  // and `POST /clock`'s `cancel-ack`/`dequeue` steps are where the process acts on it). The fixture home
  // and the control plane are the same ones every entry above uses.
  'voice-pending-utterance-withdraw.spec.ts',
  // The continuous-experience baseline (GOAL-044 / AC-361): it needs the debug agent for the same
  // reason the entry above does — the bound session has to be a REAL session the relay can send into,
  // and its execution plane has to occupy a real turn (a resident `unattended-turn` the walk ends 3 s
  // in) so the alternate busy/idle readings are the product's own state and not a fixture's claim.
  'voice-realtime-continuous-experience.spec.ts',
  // The intent-control criterion (gap-live-voice-intent-control-browser-e2e / AC-345, GOAL-041): the same
  // seam the two entries above need, and for the same reason — its readings ARE the CLI's own queue, so
  // the `session_send` calls the model relays have to reach a real control plane holding a real resident
  // session's backlog. `debug-agent` stands in for Claude, its `queued` list is the order this file reads,
  // and the fixture home is the one every entry above uses.
  'voice-realtime-intent-control.spec.ts',
  // The silence-tail suppression criterion (GOAL-044 / AC-364): it needs a REAL session for the
  // browser socket to bind to, and the fixture workspace has to live under the fixture home the
  // control plane accepts — the same seam every entry above uses. It arms no walk: nothing is ever
  // sent into the session, so the debug agent's command queue plays no part in its readings.
  'voice-realtime-silence-tail-suppression.spec.ts',
  // The double-drop browser criterion (GOAL-043 / AC-368): the same seam as the segmented-replay entry
  // above and for the same reason — the two sentences that reach the model have to land as REAL rows,
  // so `session_send` calls relayed by the scripted endpoint must reach a real control plane behind a
  // real session. Both branches arm their own scenario through the fixture home every entry uses.
  'voice-realtime-double-drop.spec.ts',
  // The stream-representation criterion (gap-live-voice-stream-delivery-not-command): it needs the
  // debug agent for the same reason the two entries above do — the settled sentence must reach a REAL
  // resident session's queue, and the scenario's own `dequeue`/turn steps are how the substitute
  // process says it consumed it. Its voice delivery's `source` is read back off the activity snapshot,
  // which is published through the claude driver's ledger seam the debug provider is wired into.
  'live-voice-stream-representation.spec.ts',
  // The capture-ready criterion (gap-live-voice-listening-before-capture-ready): the voice socket has
  // to bind to a session the control plane knows, and the page has to reach that session through the
  // sidebar. The same fixture home and the same minimal armed scenario every voice entry above uses;
  // nothing is ever sent into the session, so the command queue plays no part in its readings.
  'voice-realtime-capture-ready-status.spec.ts',
  // The E0 end-to-end replay harness (voice-output-e2e-harness): the relayed `session_send` calls have
  // to reach a REAL resident session's control plane, exactly like the entries above, and the
  // read-aloud leg needs an assistant row the fixture wrote. The same fixture home and the same
  // resident scenario shape; the walk parks immediately so no held turn lease diverts deliveries.
  'voice-output-e2e-harness.spec.ts',
];
const debugAgentFixtureHome = selectedSpecFiles().some((file) => DEBUG_AGENT_SPEC_FILES.includes(file))
  ? path.join(dataDir, 'debug-agent-home')
  : null;
// The criterion that watches the dock degrade needs to see the server's beat and its silence budget
// inside one gate. Only this selection shortens them, and only on the *server*: the client reads the
// numbers the server announces in its hello, so the spec itself carries no threshold literal.
const shortenActivityHeartbeat = selectedSpecFiles().includes('activity-dock-truthful.spec.ts');

/**
 * Whether this run is the raw-corpus criterion, which needs the capture seam turned on for its server.
 *
 * `VOICE_CAPTURE=audio` makes the SERVER write each attempt's trimmed upload and its row — the
 * recogniser side of the corpus — and `VOICE_CAPTURE_RAW=1` makes it write the pre-VAD upload beside
 * it. Both are the DEPLOYMENT's environment, read once at server start-up, so the spec cannot set
 * them itself: they have to be in the server's own env, which is what this selection injects.
 *
 * `VOICE_API_BASE_URL` IS A DELIBERATELY DEAD ADDRESS. It exists only so the health payload reports a
 * configured backend and the microphone is rendered; the capture row and file are written for a
 * FAILED attempt too, so nothing downstream depends on the upstream answering. A live stand-in would
 * add a socket nothing here reads.
 */
const voiceRawCaptureSelection = selectedSpecFiles().includes('voice-raw-capture.spec.ts');

/**
 * Whether this run is the client-clock criterion (GOAL-037 / AC-329).
 *
 * Its diagnostic half asserts on the `[AuthReq] POST /api/auth/login` line the SERVER writes — the
 * `skew=` reading that says how far this browser's clock is from the server's — and Playwright
 * forwards a webServer's stdout to the RUNNER, not to the spec, so a spec with nothing to read
 * would have to infer the reading from circumstantial evidence, which is exactly the failure this
 * task exists to end. Teeing the server's output to a file in the data directory is what makes the
 * line observable. Same mechanism as the raw-corpus criterion above; its own file.
 */
const clientClockCaptureSelection = selectedSpecFiles().includes('client-clock-skew-session.spec.ts');
const CLIENT_CLOCK_SERVER_LOG = path.join(dataDir, 'client-clock-server.log');
if (clientClockCaptureSelection) {
  process.env.QUAY_E2E_CLIENT_CLOCK_SERVER_LOG = CLIENT_CLOCK_SERVER_LOG;
}

/**
 * Whether this run is the connected-apps criterion, which reads `/mcp`'s OAuth
 * authentication and the OAuth settings routes on the server PLAYWRIGHT started.
 *
 * `MCP_ENABLED` / `MCP_OAUTH_ENABLED` / `MCP_DCR` / `PUBLIC_BASE_URL` are the
 * DEPLOYMENT's environment — read once at server start-up, when the gateway,
 * the discovery documents, the registration endpoint and the `/mcp` OAuth seam
 * are mounted or not — so the spec cannot set them for itself. This selection is
 * the ONLY place they are injected, and every other selection's env object is
 * byte-for-byte unchanged (`MCP_OAUTH_ENABLED` absent, not empty), which is what
 * keeps `/mcp` unmounted for the rest of the suite exactly as it is today.
 *
 * `PUBLIC_BASE_URL` is the loopback literal the server itself binds (`HOST`
 * below): AC-262 permits http on `localhost` and `127.0.0.1` and requires the
 * advertised issuer to match, so the spec reads the audience back out of the
 * published protected-resource document rather than restating it.
 */
const connectedAppsSelection =
  selectedSpecFiles().includes('connected-apps-settings.spec.ts')
  // `ui-last-opened-session.spec.ts` calls `/mcp` too — a personal access token against the tool
  // the browser's own session-read route feeds — so its run needs the gateway mounted for the same
  // reason, and reads the same deployment environment. It uses no OAuth surface, but the four
  // variables are one block: mounting the gateway without its OAuth seam is a deployment this
  // config does not otherwise describe, and splitting them here would invent a fifth server shape
  // to save nothing. Every other selection's env object stays byte-for-byte unchanged.
  || selectedSpecFiles().includes('ui-last-opened-session.spec.ts')
  // `ui-visible-context-range.spec.ts` makes the same kind of reading — a PAT calling a stage-3
  // read tool over `/mcp` — for the `ui_visible_context` range, so it needs the gateway mounted and
  // reads the same deployment environment. Same reason, same one block of four variables.
  || selectedSpecFiles().includes('ui-visible-context-range.spec.ts')
  // `oauth-consent-page.spec.ts` drives the real authorization flow — `/oauth/authorize`'s 302,
  // the `/api/oauth/authorize/*` consent API, `/oauth/token` (PKCE), `/mcp` — through a client it
  // registers at the real `/oauth/register`. All of those are mounted by the same gate: without
  // `MCP_OAUTH_ENABLED` and `MCP_DCR=open` the server answers none of them, and the criterion's
  // Allow leg would have no endpoint to reach. Same block of four variables, same reason.
  || selectedSpecFiles().includes('oauth-consent-page.spec.ts');

/**
 * Where the raw-corpus criterion's server tees its own stdout.
 *
 * The rows that pair a listen live on the process's output, and Playwright forwards a webServer's
 * stdout to the RUNNER, not to the spec — so a spec that had to read them would have nothing to read.
 * Teeing the server's output to a file inside the data directory is what makes the pairing observable
 * from the spec, and it is why this selection differs from every other one: no other criterion asserts
 * on a line the server wrote.
 */
const VOICE_RAW_SERVER_LOG = path.join(dataDir, 'voice-raw-server.log');
if (voiceRawCaptureSelection) {
  process.env.QUAY_E2E_VOICE_RAW_SERVER_LOG = VOICE_RAW_SERVER_LOG;
}

/**
 * Whether this run is a voice-realtime criterion (GOAL-031 / AC-312 or AC-315, GOAL-035 / AC-323,
 * gap-live-voice-upstream-stall-no-answer).
 *
 * These specs stand up their OWN Realtime upstream — a WebSocket server speaking
 * DashScope's frames — and point the app server at it. A server cannot be
 * handed a socket the spec binds, so the port has to be chosen here, published
 * for the spec to bind, and injected into the server's environment as
 * `VOICE_REALTIME_ENDPOINT`. No other selection sets that variable, so every
 * other run's server dials the real upstream exactly as before.
 *
 * Allocated only by the process that first sees it unset: Playwright re-evaluates
 * this file in each worker, and a second allocation would hand the worker a port
 * nobody is listening on.
 */
const voiceRealtimeSelection =
  selectedSpecFiles().includes('live-voice-stream-representation.spec.ts') ||
  selectedSpecFiles().includes('voice-realtime-live-session-send.spec.ts') ||
  selectedSpecFiles().includes('voice-realtime-upload-fixture.spec.ts') ||
  selectedSpecFiles().includes('voice-realtime-composer-embedded.spec.ts') ||
  selectedSpecFiles().includes('voice-realtime-turn-unanswered.spec.ts') ||
  selectedSpecFiles().includes('voice-realtime-scripted-scenarios.spec.ts') ||
  selectedSpecFiles().includes('voice-realtime-segmented-replay-20261012.spec.ts') ||
  // The withdrawal criterion binds the scripted upstream too: its three spoken sentences are delivered
  // by the model's own `session_send` calls, so the app has to dial the spec's listener rather than the
  // network — the same `VOICE_REALTIME_ENDPOINT` + blanked-credential selection as the entries above.
  selectedSpecFiles().includes('voice-pending-utterance-withdraw.spec.ts') ||
  // The continuous-experience baseline (GOAL-044 / AC-361) binds the scripted upstream too, and it is
  // the only voice criterion that also needs the server in a NON-default mode — see
  // `voiceContinuousOnlySelection` below.
  selectedSpecFiles().includes('voice-realtime-continuous-experience.spec.ts') ||
  // The intent-control criterion binds the scripted upstream too — every sentence in it is the model's
  // own `session_send`/`session_interrupt` call, so the app has to dial the spec's listener rather than
  // the network. The same `VOICE_REALTIME_ENDPOINT` + blanked-credential selection as the entries above,
  // which is also what makes its zero-cloud reading (the upgrade carries no `authorization`) meaningful.
  selectedSpecFiles().includes('voice-realtime-intent-control.spec.ts') ||
  // The silence-tail suppression criterion (GOAL-044 / AC-364) binds the scripted upstream too — it
  // stamps the arrival of every `input_audio_buffer.append`, which is the reading the whole file is
  // built on, so the app has to dial the spec's listener rather than the network. Like the
  // continuous-experience entry above it also needs the server in a NON-default mode; see
  // `voiceContinuousOnlySelection`.
  selectedSpecFiles().includes('voice-realtime-silence-tail-suppression.spec.ts') ||
  // The double-drop browser criterion (GOAL-043 / AC-368) binds the scripted upstream too: both
  // branches are read off a real dial to the spec's own listener (the socket deaths are the spec
  // driving its own server), so the app has to dial that listener rather than the network — the same
  // `VOICE_REALTIME_ENDPOINT` + blanked-credential selection as every entry above.
  selectedSpecFiles().includes('voice-realtime-double-drop.spec.ts') ||
  // The capture-ready criterion (gap-live-voice-listening-before-capture-ready) binds the scripted
  // upstream too: its reading is the window between the proxy reporting `state: open` and the first
  // captured frame, so the app must dial the spec's listener (which answers `session.update`) rather
  // than the network — and its microphone is the spec's own delayed `getUserMedia` stand-in.
  selectedSpecFiles().includes('voice-realtime-capture-ready-status.spec.ts') ||
  // The E0 end-to-end replay harness binds the scripted upstream too — the replay's utterance
  // boundaries are the endpoint's acoustic detector, and the transcript it completes for each
  // utterance is the recording's own frozen recogniser output. Same `VOICE_REALTIME_ENDPOINT` +
  // blanked-credential selection as the entries above; the blank is what makes its zero-egress
  // reading meaningful.
  selectedSpecFiles().includes('voice-output-e2e-harness.spec.ts') ||
  // The scenario-runner browser surface (`gap-scenario-runner-playwright-executor-same-timeline`)
  // does NOT drive the voice wire — but it is selected here for the OTHER half of what this flag
  // arms: the server-side EGRESS GUARD. Its zero-egress criterion is "the guard's own log exists
  // for THIS run", and `QUAY_E2E_VOICE_REALTIME_EGRESS_LOG` is published only to this selection,
  // so without this entry that criterion could only re-run the guard in a child process and read
  // a log nobody's server wrote. It deliberately shares the whole selection rather than a second
  // narrower flag: a second flag would be one more thing to keep in step, and the endpoint/key
  // blanks it also applies are inert for a spec that never opens a voice session.
  selectedSpecFiles().includes('session-lifecycle-scenario.spec.ts');
if (voiceRealtimeSelection && process.env.QUAY_E2E_VOICE_REALTIME_PORT === undefined) {
  process.env.QUAY_E2E_VOICE_REALTIME_PORT = String(freePort());
}

/**
 * Whether this run is ONE continuous-wire criterion AND nothing else (GOAL-044 / AC-361, AC-364).
 *
 * Two files need the mode: the continuous-experience baseline, and the silence-tail suppression
 * criterion (suppression lives on the continuous wire only). Both are measured as the run's ONLY spec,
 * which is the property this guard keeps — the list is closed, and a run that also selected anything
 * else gets the default mode.
 *
 * `VOICE_REALTIME_MODE` is a DEPLOYMENT setting: `server/index.ts` resolves it once at start-up and
 * hands the answer to both the browser socket and the diagnosis route. One server process serves the
 * whole Playwright run, so arming `continuous` for a run that also selects a segmented criterion would
 * hand THAT criterion a server it was never written against — the framed wire it asserts on would be
 * gone. The strict single-file shape (the same one `mcpSettingsOnlySelection` uses) is therefore not a
 * convenience but the only correct guard: the escape hatch opens exactly when the continuous baseline
 * is the whole run, which is how its criterion invokes it.
 *
 * The resolved mode is published to the spec process beside the other handoff values, so a run that
 * lost this arming fails loudly at the top of the spec instead of quietly measuring the segmented path
 * and reporting it as the continuous baseline.
 */
const voiceContinuousOnlySelection = (() => {
  const selected = selectedSpecFiles();
  return (
    selected.length === 1 &&
    (selected[0] === 'voice-realtime-continuous-experience.spec.ts' ||
      // Silence Tail Suppression lives on the continuous wire only (the segmented relay cuts the audio
      // into committed segments and there is nothing between them to withhold), so its criterion needs
      // the same arming. It is added to the SAME strict single-file list rather than getting an escape
      // hatch of its own: the property that keeps this safe is "the mode is armed only when the whole
      // run is a continuous criterion", and that is preserved word for word.
      selected[0] === 'voice-realtime-silence-tail-suppression.spec.ts' ||
      // The settle producer lives on the CONTINUOUS wire: it is armed by the endpoint's final
      // transcriptions, and the segmented relay has no such span (its deliveries are keyed by `seq`).
      // The criterion therefore has to run this deployment in continuous mode, and — like the two
      // entries above — only when it is the whole selection, for the same one-server reason.
      selected[0] === 'live-voice-stream-representation.spec.ts' ||
      // The E0 replay harness is a continuous-wire criterion: its scripted endpoint decides the
      // utterance boundaries acoustically (`armVad`, `server_vad`), which is the continuous path's
      // contract. It is measured as the run's only spec, the same strict single-file shape.
      selected[0] === 'voice-output-e2e-harness.spec.ts')
  );
})();
if (voiceContinuousOnlySelection) {
  process.env.QUAY_E2E_VOICE_REALTIME_MODE = 'continuous';
}

/**
 * Whether this run is a SEGMENTED criterion (GOAL-043's replay and double-drop specs) and nothing else.
 *
 * `VOICE_REALTIME_MODE` now DEFAULTS TO `continuous` (the 2026-10-13 experience-first ruling, GOAL-044),
 * and `segmented` is the escape hatch `resolveVoiceRealtimeMode` reads. The two GOAL-043 criteria replay
 * the segmented journal frame for frame — their readings are keyed by `seq`/`itemId` and only exist on
 * the segmented wire — so their server must be started in that mode. One server process serves the
 * whole run, so the strict single-file guard is what keeps this arming from reaching any other
 * criterion: the replay and the double-drop are each measured as the run's ONLY spec.
 *
 * Not silent if it goes missing: each spec's own `ready{segmented-v1}` wait times out with that name in
 * its diagnostic instead of quietly replaying the continuous wire and passing for the wrong reason.
 */
const voiceSegmentedOnlySelection = (() => {
  const selected = selectedSpecFiles();
  return (
    selected.length === 1 &&
    (selected[0] === 'voice-realtime-segmented-replay-20261012.spec.ts' ||
      selected[0] === 'voice-realtime-double-drop.spec.ts')
  );
})();
if (voiceSegmentedOnlySelection) {
  process.env.QUAY_E2E_VOICE_REALTIME_MODE = 'segmented';
}

/**
 * Whether this run is the silence-tail criterion (GOAL-044 / AC-364).
 *
 * `VOICE_REALTIME_SILENCE_TAIL` is a DEPLOYMENT switch and the feature is OFF BY DEFAULT (decision doc
 * §10.5 H-S2), so a criterion that measures suppression has to arm it in the SERVER's environment —
 * a spec-time `process.env` write would never reach a process the runner spawns. It is armed for this
 * file and for no other: the continuous-experience baseline above measures the SAME server without
 * the gate, and turning it on there would change the readings that criterion exists to take.
 */
const silenceTailSelection = selectedSpecFiles().includes('voice-realtime-silence-tail-suppression.spec.ts');
// Published to the workers because the spec has to place its fixture project *inside* this directory:
// the control plane refuses a `projectPath` outside the fixture home, and the spec process does not
// inherit the server's own `DEBUG_AGENT_HOME`. Empty — not absent — for every other selection, which
// is also the value that tells the spec there is no fixture home to write under.
process.env.QUAY_E2E_DEBUG_AGENT_HOME = debugAgentFixtureHome ?? '';

/**
 * The root the voice criterion's APP SERVER is started from: a checkout with no `.env`.
 *
 * WHY THE SERVER NEEDS ITS OWN ROOT. The voice selection blanks the cloud credential by putting
 * `DASHSCOPE_API_KEY: ''` in the server's environment (below), and the transport reads an empty key
 * as "no credential" — the upgrade to the stand-in then carries no `Authorization` header. But
 * `server/load-env.ts` loads the checkout's `.env` at process start and backfills every key that is
 * FALSY in the environment (`!process.env[key]`), and the empty string is falsy. On a checkout whose
 * `.env` pins a real `DASHSCOPE_API_KEY` — a normal, untracked deployment state — the blank is
 * replaced by that real key, the server dials the stand-in WITH a credential, and the criterion's
 * "no cloud credential" reading ends up answering about the deployer's `.env` instead of the code.
 *
 * THE HARDENING. The server is started from a root that holds no `.env` at all, so the backfill has
 * nothing to find and the blank survives. A checkout without a `.env` (every worktree, and CI) IS
 * that root. One with a `.env` gets a hardlink copy as a SIBLING directory — same filesystem, so
 * `cp -al` cannot cross devices — with `.git`, `.env` and `node_modules` left out (node_modules is
 * symlinked so the install stays shared). The copy shares inodes with the checkout, so it is only
 * ever read and unlinked, never written; vite and the browser still run from the real checkout, so
 * ONLY the server's view of `.env` changes. This is the same construction the AC-148 criterion
 * (`scripts/voice-capture-process-check.mjs`) uses for the same reason.
 *
 * OWNERSHIP. The runner evaluates this file first and is the process that starts the servers;
 * workers re-evaluate it and must not each build a copy. The owner publishes the root's path — the
 * same first-writer-wins pattern `QUAY_E2E_RUN_STARTED_AT` uses above — and unlinks the copy when
 * it exits, so the copy is gone after a green leg, a red leg and a throw alike.
 */
const envFreeServerRoot = ((): string => {
  if (!voiceRealtimeSelection) return CONFIG_DIR;
  const published = process.env.QUAY_E2E_ENV_FREE_SERVER_ROOT;
  if (published !== undefined) return published;
  // No `.env` to defeat: the checkout is already a root the backfill cannot read from.
  if (!fs.existsSync(path.join(CONFIG_DIR, '.env'))) {
    process.env.QUAY_E2E_ENV_FREE_SERVER_ROOT = CONFIG_DIR;
    return CONFIG_DIR;
  }
  const shadow = fs.mkdtempSync(path.join(path.dirname(CONFIG_DIR), `.${path.basename(CONFIG_DIR)}-envfree-`));
  for (const entry of fs.readdirSync(CONFIG_DIR)) {
    if (entry === '.git' || entry === '.env' || entry === 'node_modules') continue;
    execFileSync('cp', ['-al', '--', path.join(CONFIG_DIR, entry), `${shadow}${path.sep}`], { stdio: 'ignore' });
  }
  fs.symlinkSync(path.join(CONFIG_DIR, 'node_modules'), path.join(shadow, 'node_modules'));
  process.env.QUAY_E2E_ENV_FREE_SERVER_ROOT = shadow;
  process.once('exit', () => {
    try {
      fs.rmSync(shadow, { recursive: true, force: true });
    } catch {
      /* the run is over; a leftover copy is inert */
    }
  });
  return shadow;
})();

/**
 * The root the CLIENT `webServer` serves: a run-scoped copy of this checkout's client tree.
 *
 * WHY THE CLIENT NEEDS ONE. The client entry below used to declare no `cwd`, so Playwright started
 * Vite in `CONFIG_DIR` — the checkout the config file lives in. That is the same checkout the goal
 * gate evaluates criteria in (`evaluationRoot`), and it is the same checkout fan-in's `ff` step lands
 * commits into. A landing that writes `src/` mid-run reaches Vite's watcher; for a module without
 * `import.meta.hot.accept` (e.g. `src/shared/api.ts`) the update bubbles to the entry and the page
 * fully reloads, and a case a few assertions in loses its page and fails on a reason none of its own
 * assertions can name. Recorded on AC-345: the discriminator wrote one comment line into the served
 * checkout's `src/shared/api.ts` during case 6 and the criterion went red at 41.0s with Vite's
 * `ws proxy error: write EPIPE` in the same second, while the untouched control run passed.
 *
 * The copy is REAL, not `cp -al`: a hardlink shares the inode, so fan-in's in-place write would
 * change the bytes Vite reads exactly as before. `node_modules` is the one symlink. The module
 * (`scripts/e2e-client-root.mjs`) owns the tree declaration, the first-writer-wins publication to
 * workers, and the cleanup on every exit path; `QUAY_E2E_CLIENT_ROOT=off` is the control arm that
 * degrades the root back to the checkout.
 *
 * SKIPPED WHERE THERE IS NO CLIENT SERVER. The one-file MCP-settings selection starts no webServer
 * pair (`mcpSettingsOnlySelection`) — its spec boots its own Vite — so a snapshot here would be
 * copied and never served. Every other selection, full-tree runs included, gets its own copy.
 */
const clientRoot = mcpSettingsOnlySelection
  ? CONFIG_DIR
  : resolveClientRoot({ configDir: CONFIG_DIR });

/**
 * Where this run's two `webServer` children put their stderr, and why it is not the runner's stderr.
 *
 * The goal gate records a failed criterion's reason from the run's STDERR, keeping its HEAD inside a
 * ~500-char budget. Playwright forwards every webServer child's stderr to the runner's stderr, while a
 * failing CASE's name and assertion go to the runner's STDOUT — so the gate's excerpt was always the
 * server's boot chatter (`No .env …`, `DEP0190`, Vite's `ws proxy error`) and never the failing test.
 * Measured on a green run of this checkout's AC-323 selection, 2026-10-21: 13 895 bytes of webServer
 * stderr against zero bytes the gate could attribute. Redirecting both children's stderr into the
 * run's own data directory leaves the runner's stderr carrying only Playwright's own failures, and
 * keeps every diagnostic line in `<dataDir>/server.stderr.log` / `<dataDir>/vite.stderr.log` (the
 * data directory is announced on stdout as `[e2e] data-dir=<D>`). `scripts/e2e-web-server-stderr.mjs`
 * owns the construction; the raw-capture and client-clock selections keep their `2>&1 | tee` branches
 * verbatim, because those forward the child's whole output to stdout for their specs to read.
 */
const webServerLogs = webServerStderrLogs(dataDir);

/**
 * The command the server `webServer` starts: this checkout's server graph pre-built into one file.
 *
 * WHY NOT `tsx` ANY MORE. A criterion's ceiling covers the whole `npx playwright test` invocation,
 * so every second the test runner spends before it prints `Running 1 test` is spent inside the wall
 * clock the criterion asserts on. `tsx` transforms each module it loads; measured on this checkout,
 * `tsx server/index.ts` reached `/health` in ~2.9s warm / 7.1s under load, while the same graph
 * bundled into one file reached it in ~0.75s. Under the burst AC-194 was red in, ~21.5s of the
 * criterion's 43.9s was pre-test boot, and the server's boot was the largest CPU block inside it.
 *
 * The fresh-source guarantee lives in the builder, not here: the bundle is named after a content
 * hash of the servers' sources, so editing `server/` selects a different file and a stale bundle is
 * unreachable (`scripts/e2e-server-bundle.mjs`). The build runs at config evaluation — ~9ms to hash
 * the sources, ~60ms for a first build per key, nothing on a hit — which is inside the measured
 * window too, and still two orders of magnitude below the boot it removes.
 *
 * `envFreeServerRoot` (not `CONFIG_DIR`) is the root the bundle is built under: the server resolves
 * its application root by walking up from its own module URL, so the bundle has to sit under the
 * same `server/` anchor the entry point would have resolved — including the env-free shadow the
 * voice selections run from, where the copy keeps `.env` out of the process exactly as before.
 */
const serverLaunchCommand = (() => {
  const bundlePath = prepareServerBundle(envFreeServerRoot);
  return `node ${JSON.stringify(path.relative(envFreeServerRoot, bundlePath))}`;
})();

/**
 * The server-side EGRESS GUARD, for the voice realtime selection only.
 *
 * `envFreeServerRoot` (above) makes the replay's cloud credential blank; the guard makes the ABSENCE of a
 * cloud dial an observed fact rather than a configuration someone trusts. `e2e/support/egress-guard.mjs` is
 * preloaded into THIS selection's app server with `--import` (through `NODE_OPTIONS`, which Node reads at the
 * tsx launcher too), where it refuses any dial that is not loopback with `ECONNREFUSED` and appends the target
 * to `egress.jsonl` in this run's throwaway data dir. The replay spec reads that file: an existing-but-empty
 * file is "the guard was live and nothing left". See the module's own header for the mechanism.
 *
 * THE PATH IS PUBLISHED FOR THE SPEC. `QUAY_E2E_VOICE_REALTIME_EGRESS_LOG` names the same file to the spec
 * process (the pattern the run's other cross-process paths use); the SERVER learns it through
 * `QUAY_E2E_EGRESS_GUARD_LOG`, which is also the switch that turns the guard on, so every other selection's
 * server is byte-for-byte the server it was before.
 */
const voiceRealtimeEgressLog = path.join(dataDir, 'egress.jsonl');
const egressGuardModule = path.join(CONFIG_DIR, 'e2e', 'support', 'egress-guard.mjs');
if (voiceRealtimeSelection) {
  process.env.QUAY_E2E_VOICE_REALTIME_EGRESS_LOG = voiceRealtimeEgressLog;
}

export default defineConfig({
  testDir: './e2e',
  // The archived Silence Tail spec is excluded from the DEFAULT collection — it reds by design after the
  // 2026-10-14 ruling (see `ARCHIVED_SILENCE_TAIL_SPEC`) and must not fail a bare `playwright test`. It comes
  // back the moment an invocation names it, which is what keeps it nameable. The file itself is untouched.
  testIgnore: archivedSilenceTailSelected ? [] : [`**/${ARCHIVED_SILENCE_TAIL_SPEC}`],
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  // Traces and failure contexts are written here. Under this run's own throwaway directory rather than the
  // shared `test-results/`, so two runs in one checkout stop overwriting each other's evidence (the loser of
  // that race used to fail at teardown on a directory the winner had already replaced).
  outputDir: path.join(dataDir, 'test-results'),
  use: {
    baseURL: `http://127.0.0.1:${clientPort}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  // Both ceilings are deliberately under the 60s a criterion may take: the goal gate that runs this command
  // kills it at 60s, and a run killed from outside reports nothing about why. A server that is spawned but
  // never answers therefore has to be given up on here, where the failure is still this run's to explain.
  // Each entry's `timeout:` is `WEB_SERVER_TIMEOUT_MS`, whose own doc comment carries the arithmetic that
  // keeps it strictly under `BOOT_CEILING_MS` below.
  webServer: [
    {
      // `node_modules/.bin` rather than `npx`: npx is a Node program that resolves the binary and *then*
      // spawns it, so every run pays a second interpreter startup per server — measured on this checkout at
      // ~270 ms of the server's boot alone, doubled across the pair and multiplied by whatever the host is
      // already running. The local bin is what npx would have found anyway, and it fails loudly rather than
      // reaching for a registry copy if it is missing.
      // The raw-corpus criterion tees its server's output to a file so the spec can read the capture
      // rows; every other selection runs the server plain, with its stderr redirected into this run's
      // data directory so it cannot crowd the failing case out of the gate's reason (`webServerLogs`).
      command: voiceRawCaptureSelection
        ? `${serverLaunchCommand} 2>&1 | tee ${JSON.stringify(VOICE_RAW_SERVER_LOG)}`
        : clientClockCaptureSelection
          ? `${serverLaunchCommand} 2>&1 | tee ${JSON.stringify(CLIENT_CLOCK_SERVER_LOG)}`
          : withStderrLog(serverLaunchCommand, webServerLogs.server),
      // The voice criterion's server is started from a root with no `.env`, so its blank
      // `DASHSCOPE_API_KEY` cannot be backfilled from the deployer's file. Every other selection
      // gets `CONFIG_DIR`, which is Playwright's own default — see `envFreeServerRoot`.
      cwd: envFreeServerRoot,
      url: SERVER_HEALTH_URL,
      reuseExistingServer: false,
      timeout: WEB_SERVER_TIMEOUT_MS,
      env: {
        SERVER_PORT: String(serverPort),
        HOST: '127.0.0.1',
        DATABASE_PATH: path.join(dataDir, 'auth.db'),
        HOME: dataDir,
        // The start-up sweep stops every orphaned session scope on the host, not only this run's; a
        // throwaway e2e server has no business reaping the operator's.
        CLAUDE_SESSION_SCOPE_SWEEP: 'off',
        // Absent — not empty — for every selection that names neither debug agent spec, so the gate stays
        // closed exactly as it does today. See `debugAgentFixtureHome` above.
        ...(debugAgentFixtureHome
          ? { DEBUG_AGENT: '1', DEBUG_AGENT_HOME: debugAgentFixtureHome }
          : {}),
        // The turn-run path (SPEC §6) is what stamps a delivery's ORIGIN onto the run's options
        // (`DELIVERY_SOURCE_OPTION`) — and the stream-representation criterion reads exactly that
        // origin back off the activity snapshot. It is the shipped deployment setting (the live
        // server runs with `RESIDENT_RUN_IS_TURN=1`); armed for this file's selection only, because
        // enabling it for every voice spec would change readings those specs were written against.
        ...(selectedSpecFiles().includes('live-voice-stream-representation.spec.ts')
          ? { RESIDENT_RUN_IS_TURN: '1' }
          : {}),
        // Sub-second beat and threshold, for the activity-dock criterion's selection only. The
        // shipped defaults (5000/15000) are the product's and are untouched everywhere else.
        ...(shortenActivityHeartbeat
          ? { ACTIVITY_HEARTBEAT_INTERVAL_MS: '300', ACTIVITY_UNREACHABLE_AFTER_MS: '900' }
          : {}),
        // The capture seam, for the raw-corpus criterion's selection only: every other selection
        // starts with both switches off, so nothing else writes recordings or a raw corpus.
        ...(voiceRawCaptureSelection
          ? {
              VOICE_CAPTURE: 'audio',
              VOICE_CAPTURE_RAW: '1',
              VOICE_API_BASE_URL: 'http://127.0.0.1:9/v1',
            }
          : {}),
        // The MCP gateway and its OAuth surface, for the connected-apps criterion's selection
        // only. Without this the gateway, the discovery documents, `/oauth/register` and the
        // `/mcp` OAuth seam are all absent from this server, and neither of that spec's `/mcp`
        // readings could tell a revocation from a live token. See `connectedAppsSelection`.
        ...(connectedAppsSelection
          ? {
              MCP_ENABLED: 'true',
              MCP_OAUTH_ENABLED: 'true',
              MCP_DCR: 'open',
              PUBLIC_BASE_URL: `http://127.0.0.1:${serverPort}`,
            }
          : {}),
        // The stand-in Realtime upstream's address, for the voice criterion's
        // selection only: the spec binds that port itself and speaks DashScope's
        // frames on it, so this run's `/voice-realtime` proxy dials the spec
        // rather than the network. See `voiceRealtimeSelection`.
        ...(voiceRealtimeSelection
          ? {
              VOICE_REALTIME_ENDPOINT: `ws://127.0.0.1:${process.env.QUAY_E2E_VOICE_REALTIME_PORT}`,
              // CLOUD API FORBIDDEN BY CONSTRUCTION. The spread above (`...process.env`) lets an
              // ambient `DASHSCOPE_API_KEY` reach this throwaway server; that would make a
              // mis-pointed endpoint dial the real DashScope instead of failing closed. Setting the
              // key to the EMPTY STRING here overrides any ambient value (the config's `env` wins
              // the merge), and the transport's own guard treats empty-key-with-a-factory as "no
              // credential": the upgrade then carries no `Authorization` header at all. So a wrong
              // endpoint can only ever dial an endpoint-less session, never bill the cloud.
              //
              // AN EMPTY VALUE IS ONLY AS STRONG AS THE ROOT IT IS READ IN. `server/load-env.ts`
              // backfills every FALSY key from the checkout's `.env` at process start, so in a
              // checkout whose `.env` pins a real key this blank would be replaced and the dial
              // would carry that key. This is why the server is started with `cwd` at
              // `envFreeServerRoot` above — a root with no `.env`, where the blank survives.
              DASHSCOPE_API_KEY: '',
              // The egress guard, preloaded into THIS server only. `NODE_OPTIONS` is appended to (not
              // replaced) so a runner that already carries its own preloads keeps them; the guard itself
              // is inert unless `QUAY_E2E_EGRESS_GUARD_LOG` is set, and it is set exactly here. See
              // `voiceRealtimeEgressLog` above.
              QUAY_E2E_EGRESS_GUARD_LOG: voiceRealtimeEgressLog,
              NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${pathToFileURL(egressGuardModule).href}`]
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .join(' '),
            }
          : {}),
        // THE MODE, and only for the two single-file selections that need a NON-default wire.
        // `resolveVoiceRealtimeMode` resolves an unset, empty or unknown value to `continuous` (the
        // 2026-10-13 experience-first ruling, GOAL-044): the continuous criteria arm that explicitly,
        // and the two segmented criteria (the GOAL-043 replay and double-drop) arm `segmented`. This is
        // the ONE point where the server's environment is assembled — a spec-time `process.env` write
        // would never reach a process the runner spawns. The strict single-file guards are the whole
        // safety of the entries: see `voiceContinuousOnlySelection` / `voiceSegmentedOnlySelection`.
        ...(voiceContinuousOnlySelection ? { VOICE_REALTIME_MODE: 'continuous' } : {}),
        ...(voiceSegmentedOnlySelection ? { VOICE_REALTIME_MODE: 'segmented' } : {}),
        // THE FEATURE SWITCH, for the run that measures suppression and no other. OFF is the shipped
        // default, and every other selection — including the continuous baseline this one shares its
        // mode with — starts with the gate unarmed. See `silenceTailSelection`.
        ...(silenceTailSelection ? { VOICE_REALTIME_SILENCE_TAIL: '1' } : {}),
      },
    },
    {
      // `--strictPort`: without it vite treats a taken port as a hint and silently serves on the next free one,
      // so the url checked below — the port the browser is sent to — would never answer and the run would sit
      // here until the ceiling instead of reporting the port. Strict, it fails at once and says which port.
      // Its stderr is redirected into this run's data directory for the same reason the server's is
      // (`webServerLogs`): Vite writes `ws proxy error: write EPIPE` on every page close, and that noise
      // used to fill the gate's 500-char stderr excerpt on every red.
      command: withStderrLog('node_modules/.bin/vite --host 127.0.0.1 --strictPort', webServerLogs.vite),
      // The run's own copy of the client tree — not `CONFIG_DIR`, which fan-in's `ff` writes while the gate
      // is running. Without this, one landing into `src/` reloads the page mid-case. See `clientRoot`.
      cwd: clientRoot,
      url: CLIENT_URL,
      reuseExistingServer: false,
      timeout: WEB_SERVER_TIMEOUT_MS,
      env: {
        SERVER_PORT: String(serverPort),
        VITE_PORT: String(clientPort),
        HOST: '127.0.0.1',
        // Read by vite.config.js as its `cacheDir`. Without it every run on this machine pre-bundles into the
        // one `node_modules/.vite` the worktree symlinks share, and a re-optimization there 504s whatever
        // another run already has in flight — the failure this whole file's comment above describes.
        VITE_CACHE_DIR: viteCacheDir,
        // The client's send deadline, shortened for the dock criterion's selection only. The spec fails a send
        // while the server is silent and reads the failure inside its own 5s budget, so the shipped 5s deadline
        // would sit exactly on that budget's edge; the criterion carries no deadline literal of its own, it
        // reads what the client was built with here. Every other selection keeps the shipped 5000ms.
        ...(shortenActivityHeartbeat ? { VITE_SEND_DELIVERY_TIMEOUT_MS: '600' } : {}),
      },
    },
    // Both entries are this run's two published ports, and the one-file MCP-settings criterion binds
    // them itself (see `mcpSettingsOnlySelection`) — so for that selection alone the pair is dropped
    // rather than started twice on ports the spec then has to wait for. Every other selection,
    // including a full-tree run, keeps both.
  ].filter(
    (entry) => !(mcpSettingsOnlySelection && RUN_SERVERS.some((server) => server.url === entry.url)),
  ),
});

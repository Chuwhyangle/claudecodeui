/**
 * Resident session cgroup scoping.
 *
 * A resident session is not one process: it is the CLI plus its MCP servers (and, when the CLI is
 * launched through an npm shim, a wrapper process on top), which on this host adds up to roughly
 * a gigabyte per idle session. The server used to spawn all of them into its own cgroup, where
 * `memory.max` is `max`, so a single runaway session — or one MCP it launched — was enough for the
 * kernel to reap the whole unit, server included. This module puts every session in its own
 * transient systemd scope with a hard `MemoryMax`, which confines that kill to the session.
 *
 * Two caps, both from configuration. The per-session cap is `MemoryMax` on the scope, and it is the
 * one that decides *whether* a runaway session dies. The second is a cap on the whole
 * {@link DEFAULT_RESIDENT_SLICE_NAME} slice the scopes are placed in — the level at which "the
 * resident processes together" is expressible — and it is what keeps the kernel choosing its
 * victim from among the residents rather than from the host. Both come from the environment
 * (`CLAUDE_SESSION_MEMORY_MAX`, `CLAUDE_RESIDENT_SLICE_MEMORY_MAX`) and both are injectable, so a
 * criterion can pin the mechanism without waiting for a production soak to pick the numbers.
 *
 * Provider neutral. Nothing here is about Claude beyond the file's history: the entry points are
 * named for the resident scope they create ({@link createResidentScopeSpawn} and the lifecycle
 * beside it), the slice name and the unit prefix are configuration, and a provider that owns a
 * resident process can use the same wrapper. The pre-promotion `claude*` names remain exported as
 * aliases so the runtime's wiring and the previous criterion keep their byte-identical contract.
 *
 * `systemd-run --user --scope` registers a transient scope and then `exec`s the target command in
 * the same PID, so stdio, PID and exit status are unchanged; `scripts/with-memory-cap.sh` already
 * relies on that property for test scopes.
 *
 * Environments without a usable systemd user manager (macOS, CI containers) must keep today's
 * behaviour byte for byte: {@link createResidentScopeSpawn} then returns `undefined` and the
 * caller does not install the spawn hook at all.
 *
 * Consumers:
 * - `claude-runtime.provider.js`'s `mapCliOptionsToSDK` installs the SDK `spawnClaudeCodeProcess`
 *   hook returned by {@link createResidentScopeSpawn}.
 * - `server/index.ts` starts up by sweeping orphaned scopes and shuts down by stopping the scopes
 *   this server owns; both calls arrive through `server/modules/providers/index.ts`.
 * - `server/modules/providers/tests/claude-session-scope.test.ts` drives the generated argv, the
 *   degradation path, the scope lifecycle and the OOM attribution.
 * - `server/modules/session-hosts/tests/process-containment.test.ts` drives the slice cap and
 *   {@link detectResidentScopeOomKill}, and lands the OOM fact as a host snapshot reading.
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import type { SpawnOptions as NodeSpawnOptions } from 'node:child_process';
import crypto from 'node:crypto';

import type { SpawnOptions as SdkSpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

/**
 * Prefix of every scope this module creates. It namespaces the unit so stop/sweep can address
 * exactly the sessions a claudecodeui server owns, and so an operator can find them by hand.
 *
 * The *value* is a compatibility contract, not a style choice: it is the glob an operator types at
 * `systemctl --user list-units`, the pattern `scripts/soak.sh` greps, and the literal the previous
 * criterion asserts. A provider that wants its own namespace changes this constant, not a config
 * knob: nothing sets one today, and an exported knob with no consumer is surface without a reader.
 */
const RESIDENT_SCOPE_PREFIX = 'claudecodeui-session-';

/**
 * Name of the slice every resident scope is placed in unless configured otherwise.
 *
 * One slice for every resident process this server starts, because the slice is the level at which
 * a *total* cap is expressible: per-scope `MemoryMax` decides which single session dies, and the
 * slice's `MemoryMax` decides what "all of them together" may consume. Placing the scopes here is
 * what lets the kernel pick a victim among the residents instead of among whatever else shares the
 * machine.
 */
export const DEFAULT_RESIDENT_SLICE_NAME = 'cloudcli-resident.slice';

/**
 * Default cap on the whole resident slice, or `null` for "no limit imposed".
 *
 * Deliberately unset. The number is a soak question — how much a fleet of resident processes
 * really holds over 24 hours — and this task pins the mechanism and its configurability, not the
 * value. `null` means the slice keeps whatever cap the operator gave it (by default `infinity`) and
 * only the per-session caps apply.
 */
export const DEFAULT_RESIDENT_SLICE_MEMORY_MAX: string | null = null;

/**
 * Default per-session memory cap. Measured on this host 2026-09-25: an idle session subtree (the
 * `claude` process plus its MCP servers) sits around 0.75-1.1 GB RSS, and a session doing real
 * work — a build, a suite run — goes well past that. 8G leaves an order of magnitude of headroom
 * over idle while still being far below the point where killing the session is preferable to the
 * kernel picking the server.
 */
export const DEFAULT_RESIDENT_MEMORY_MAX = '8G';

/** Substring systemd writes into a unit's journal when its cgroup cap reaped a process. */
const OOM_JOURNAL_MARKER = 'OOM killer';

/** How many times, and how far apart, the exit path re-asks the journal for the OOM verdict. */
const OOM_ATTRIBUTION_ATTEMPTS = 5;
const OOM_ATTRIBUTION_RETRY_MS = 200;

/** Bound on how long one `systemctl stop` may block the server's shutdown path. */
const UNIT_STOP_TIMEOUT_MS = 15_000;

/**
 * What the hook returns: the SDK's process contract, plus the optional `stderr` and `signalCode` a
 * Node `ChildProcess` carries. The SDK interface leaves both out, but the debug-forwarding path and
 * the tests' exit accounting need them.
 */
export type ResidentScopeProcess = SpawnedProcess & {
  readonly stderr?: NodeJS.ReadableStream | null;
  readonly signalCode?: NodeJS.Signals | null;
};

/**
 * The spawn implementation the hook calls. Node's `child_process.spawn` in production; a recording
 * stub in the tests, which is how the generated argv is pinned without launching a CLI.
 */
export type ResidentScopeSpawnImpl = (
  command: string,
  args: readonly string[],
  options: NodeSpawnOptions,
) => ResidentScopeProcess;

/**
 * Options of {@link createResidentScopeSpawn}; every field has a production default, and every
 * field is an injection point so a criterion can pin one reading at a time.
 */
export type ResidentScopeSpawnDeps = {
  /** Per-session cap in systemd size syntax. `undefined` reads the environment; `null` disables. */
  memoryMax?: string | null;
  /** Slice to place the scope in. `undefined` reads the environment; `null` places it nowhere. */
  sliceName?: string | null;
  /** Cap for the whole slice. `undefined` reads the environment; `null` imposes no slice cap. */
  sliceMemoryMax?: string | null;
  /** Owner encoded in the unit name, i.e. the server whose shutdown stops these scopes. */
  ownerPid?: number;
  /** Availability probe. Defaults to the cached real probe; pass `() => true` to skip it. */
  probe?: (memoryMax: string) => boolean;
  /** Spawn implementation. Defaults to `child_process.spawn`. */
  spawnImpl?: ResidentScopeSpawnImpl;
};

/**
 * Resolves the per-session memory cap from `CLAUDE_SESSION_MEMORY_MAX`.
 *
 * Unset or blank means {@link DEFAULT_RESIDENT_MEMORY_MAX}; `off` or `0` disables scope wrapping
 * entirely (`null`), which is the same shape as "no systemd user manager" and therefore travels the
 * same degraded path.
 *
 * Consumed by {@link createResidentScopeSpawn} and pinned by the session-scope tests, which need
 * the exact same read the runtime makes.
 */
export function resolveResidentMemoryMax(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = (env.CLAUDE_SESSION_MEMORY_MAX ?? '').trim();
  if (!raw) {
    return DEFAULT_RESIDENT_MEMORY_MAX;
  }
  if (raw === 'off' || raw === '0') {
    return null;
  }
  return raw;
}

/**
 * Resolves the slice every scope is placed in from `CLAUDE_RESIDENT_SLICE`.
 *
 * Unset or blank means {@link DEFAULT_RESIDENT_SLICE_NAME}; `off` or `0` means "do not place the
 * scope in a slice" (`null`), which leaves the scope in whatever cgroup the caller was in — the
 * pre-slice behaviour. Read by {@link createResidentScopeSpawn} and by the criterion, which must
 * see the same literal the wrapper puts on the command line.
 */
export function resolveResidentSliceName(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = (env.CLAUDE_RESIDENT_SLICE ?? '').trim();
  if (!raw) {
    return DEFAULT_RESIDENT_SLICE_NAME;
  }
  if (raw === 'off' || raw === '0') {
    return null;
  }
  return raw;
}

/**
 * Resolves the slice's total cap from `CLAUDE_RESIDENT_SLICE_MEMORY_MAX`.
 *
 * Unset or blank means {@link DEFAULT_RESIDENT_SLICE_MEMORY_MAX}, which is `null`: no cap is
 * imposed and the slice keeps the operator's own value. `off`, `0` and `infinity` all mean the same
 * "no cap", because that is the value `systemctl` itself reports for an uncapped unit and a config
 * that round-trips it must not be read as a number.
 */
export function resolveResidentSliceMemoryMax(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = (env.CLAUDE_RESIDENT_SLICE_MEMORY_MAX ?? '').trim();
  if (!raw) {
    return DEFAULT_RESIDENT_SLICE_MEMORY_MAX;
  }
  if (raw === 'off' || raw === '0' || raw === 'infinity') {
    return null;
  }
  return raw;
}

/**
 * Whether a starting server should sweep orphaned session scopes, from `CLAUDE_SESSION_SCOPE_SWEEP`.
 *
 * On unless the value is `off` or `0` (case- and whitespace-insensitive). The sweep is host-wide:
 * it stops every session scope whose owner pid is gone, not only the ones this server's
 * predecessor left. That is right for the operator's own server, and wrong for a throwaway server a
 * test, an e2e run or a soak boots on the same host, which has no business reaping anything. Those
 * harnesses turn it off.
 *
 * Consumed by `server/index.ts` at start-up, and by the harnesses that set the variable.
 */
export function resolveResidentScopeSweepEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.CLAUDE_SESSION_SCOPE_SWEEP ?? '').trim().toLowerCase();
  return raw !== 'off' && raw !== '0';
}

/**
 * Sets the slice's `MemoryMax`, returning whether systemd accepted it.
 *
 * `systemctl --user set-property` is a transient-unit write, so it lands on the live slice the
 * scopes are already running in and outlives every one of them: the cap has to be applied to the
 * slice, not passed to `systemd-run`, because a `-p` property on the run applies to the scope being
 * created and never to its parent.
 *
 * `null` restores `infinity`, which is what a caller that injected a cap uses to put the slice back
 * the way it found it. A failure is reported rather than thrown: a host where the operator's
 * user manager refuses the write still gets the per-session caps, and refusing to scope at all
 * would trade a partial protection for none.
 *
 * Consumed by {@link createResidentScopeSpawn} and by the process-containment criterion, which
 * injects a cap and reads it back.
 */
export function applyResidentSliceMemoryMax(sliceName: string, memoryMax: string | null): boolean {
  const result = spawnSync(
    'systemctl',
    ['--user', 'set-property', sliceName, `MemoryMax=${memoryMax ?? 'infinity'}`],
    { stdio: 'ignore' },
  );

  return result.status === 0;
}

/**
 * Reads the slice's `MemoryMax` back from systemd, as systemd reports it.
 *
 * The reading is systemd's own, not the string a caller wrote: `show` answers in bytes
 * (`100663296` for `96M`) or in the literal `infinity`, so a caller comparing against what it
 * injected has to compare values rather than spellings. Returns `null` when the slice does not
 * exist or systemd cannot be asked — an absent reading, never a guessed one.
 *
 * Consumed by the process-containment criterion, whose whole point is that the injected cap is the
 * cap systemd actually holds.
 */
export function readResidentSliceMemoryMax(sliceName: string): string | null {
  const result = spawnSync(
    'systemctl',
    ['--user', 'show', sliceName, '-p', 'MemoryMax', '--value'],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    return null;
  }
  const value = (result.stdout ?? '').trim();
  return value || null;
}

/**
 * Names one session's scope. The owner PID is encoded so a later process can tell whether the
 * server that created the scope is still alive — that is what makes sweep-after-SIGKILL possible.
 *
 * Paired with {@link parseResidentScopeOwnerPid}; the session-scope tests build names with this
 * function so the encoded contract has a single definition.
 */
export function buildResidentScopeUnitName(ownerPid: number, suffix: string): string {
  return `${RESIDENT_SCOPE_PREFIX}${ownerPid}-${suffix}`;
}

/**
 * Reads the owner PID back out of a scope unit name, or `null` when the name is not one of ours.
 * The inverse of {@link buildResidentScopeUnitName}; consumed by stop and sweep.
 */
export function parseResidentScopeOwnerPid(unitName: string): number | null {
  const match = new RegExp(`^${RESIDENT_SCOPE_PREFIX}(\\d+)-`).exec(unitName);
  if (!match) {
    return null;
  }
  const ownerPid = Number.parseInt(match[1], 10);
  return Number.isFinite(ownerPid) ? ownerPid : null;
}

/**
 * The argv the hook hands to `systemd-run` for one session.
 *
 * `--scope` keeps the target on the same PID (no forking wrapper), `--slice` places the scope in
 * the shared resident slice (so the slice's own cap applies to the whole set, and the kernel's
 * choice of victim is confined to it), `MemorySwapMax=0` stops a capped session from surviving on
 * swap, and `--` ends option parsing so a CLI argument can never be read as a systemd option.
 */
function buildResidentScopeArgv(params: {
  unitName: string;
  memoryMax: string;
  sliceName: string | null;
  command: string;
  args: readonly string[];
}): string[] {
  return [
    '--user',
    '--scope',
    '--quiet',
    `--unit=${params.unitName}`,
    ...(params.sliceName ? [`--slice=${params.sliceName}`] : []),
    '-p', `MemoryMax=${params.memoryMax}`,
    '-p', 'MemorySwapMax=0',
    '--',
    params.command,
    ...params.args,
  ];
}

/**
 * Runs one `true` inside a capped scope in the resident slice and reports whether that worked.
 *
 * The probe has to be a real execution: `systemd-run` failing (no user manager) and the command
 * failing (a cap too small to even fork) are indistinguishable by exit status, so nothing weaker
 * than a real capped run can tell us whether the wrapper is usable. `true` under a cap is the
 * cheapest command that still exercises scope creation, slice placement, accounting and exec.
 *
 * The slice is part of the probe because it is part of the wrapper: a host whose user manager
 * cannot create the slice has no usable wrapper either, and discovering that per session instead
 * would trade one honest degradation for a failing spawn per turn.
 *
 * Consumed by the cached default probe and asserted directly by the session-scope tests, which
 * must red rather than skip when this host cannot scope.
 */
export function probeSystemdUserScope(
  memoryMax: string,
  sliceName: string | null = resolveResidentSliceName(),
): boolean {
  const result = spawnSync('systemd-run', [
    '--user',
    '--scope',
    '--quiet',
    ...(sliceName ? [`--slice=${sliceName}`] : []),
    '-p', `MemoryMax=${memoryMax}`,
    '-p', 'MemorySwapMax=0',
    'true',
  ], { stdio: 'ignore' });

  return result.status === 0;
}

/**
 * Cached availability verdict. Probing costs a real process, and the answer cannot change while
 * this server lives, so it is settled once on first use.
 */
let cachedProbeResult: boolean | null = null;

/**
 * Drops the cached probe verdict so the next factory call probes again.
 *
 * Exists for the session-scope tests: the degradation case has to drive the probe with a failing
 * `systemd-run` earlier on `PATH`, and a verdict cached by an earlier case would mask it.
 */
export function resetResidentScopeProbeCache(): void {
  cachedProbeResult = null;
}

function probeOnce(memoryMax: string): boolean {
  if (cachedProbeResult === null) {
    cachedProbeResult = probeSystemdUserScope(memoryMax);
  }
  return cachedProbeResult;
}

/**
 * The record of which slice caps this process has already written, and the only owner of that
 * state.
 *
 * `mapCliOptionsToSDK` builds a hook per turn, so applying the cap unconditionally would be one
 * `systemctl set-property` per turn for a value that only changes when the configuration does.
 * {@link ensureSliceCapApplied} therefore remembers the pairs it has written. Whole-file private:
 * nothing outside this module reaches the set, and the state cannot be mutated except through the
 * method below.
 */
class ClaudeSessionScope {
  /**
   * Slice caps this instance has already written, as `<slice>\0<cap>` keys.
   *
   * Keyed by the pair rather than by the slice so a *different* cap is still applied — that is what
   * makes the write observable at all. A failed write is not recorded, so the next turn retries it.
   */
  private readonly appliedSliceCaps = new Set<string>();

  /**
   * Applies a slice's memory cap at most once per `<slice, cap>` pair, and reports whether the cap
   * is in place.
   *
   * `false` means a fresh write was attempted and systemd refused it; the pair is then left
   * unremembered so a later turn retries. Consumed by {@link createResidentScopeSpawn}, which logs
   * the refusal once rather than per turn.
   */
  ensureSliceCapApplied(sliceName: string, memoryMax: string): boolean {
    const key = `${sliceName}\u0000${memoryMax}`;
    if (this.appliedSliceCaps.has(key)) {
      return true;
    }
    if (!applyResidentSliceMemoryMax(sliceName, memoryMax)) {
      return false;
    }
    this.appliedSliceCaps.add(key);
    return true;
  }
}

/**
 * The process-wide instance that owns the slice caps this server has written.
 *
 * One per process on purpose: the dedupe outlives any single hook, because `mapCliOptionsToSDK`
 * builds a new hook each turn.
 */
const sessionScope = new ClaudeSessionScope();

/** Default spawn: Node's own, cast because `ChildProcess.stdin` is `Writable | null` in the typings. */
const defaultScopeSpawn: ResidentScopeSpawnImpl = (command, args, options) =>
  nodeSpawn(command, [...args], options) as unknown as ResidentScopeProcess;

/** Sleeps between journal retries. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Asks the unit's journal whether a memory-cap kill happened.
 *
 * The exit status alone cannot say: the OOM killer picks a victim inside the scope, so the CLI may
 * exit `1` (its own error path) or `137` (SIGKILL), and a cap too tight for a plain crash looks
 * identical. The journal is the only witness, which is the same conclusion `scripts/test.sh`
 * reached for capped test scopes.
 *
 * A scope placed in a slice is still the cgroup whose `memory.max` was hit, so systemd attributes
 * the kill to the scope — `A process of this unit has been killed by the OOM killer` — and this
 * stays the right unit to ask about.
 */
function journalReportsOomKill(unitName: string): boolean {
  const result = spawnSync('journalctl', ['--user', '-u', `${unitName}.scope`, '--no-pager'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.status !== 0 || !result.stdout) {
    return false;
  }
  return result.stdout.includes(OOM_JOURNAL_MARKER);
}

/**
 * Asks the journal until it answers, and runs `onOom` once when the answer is yes.
 *
 * The retry is not politeness: the journal write trails the scope's exit, so a single read races it
 * and reports "not an OOM" for a kill that is one line away from being recorded. Returns whether
 * the cap was blamed, so a caller can branch on the kernel fact instead of on an exit code.
 */
async function retryOomAttribution(unitName: string, onOom: () => void): Promise<boolean> {
  for (let attempt = 0; attempt < OOM_ATTRIBUTION_ATTEMPTS; attempt += 1) {
    if (journalReportsOomKill(unitName)) {
      onOom();
      return true;
    }
    await delay(OOM_ATTRIBUTION_RETRY_MS);
  }
  return false;
}

/**
 * Reports whether the kernel's memory cap is what ended this scope, for a caller that owns a host.
 *
 * This is the seam between the layer that can see the kernel fact — the scope, whose unit name and
 * journal this module knows — and the layer that owns the host record, which can only be told. A
 * driver whose process runs through {@link createResidentScopeSpawn} answers its exit path with
 * this and reports `sink.exited({ hostId, detail: 'oom' })`; the manager then records
 * `closeReason: 'exited'` with `closeDetail: 'oom'`, which is the reading a caller can act on.
 *
 * Deliberately a separate read from the logging path: a host driver needs the boolean, and the
 * line the logging path writes is for an operator, not for a decision. Both ask the same journal,
 * so neither can disagree with the other about the fact.
 */
export function detectResidentScopeOomKill(unitName: string): Promise<boolean> {
  return retryOomAttribution(unitName, () => undefined);
}

/**
 * Names the cap in one `console.error` line when a session was killed by it.
 *
 * Silent when the journal is unreadable or says nothing about an OOM: that is a known gap, and a
 * guess here would be worse than the silence. Consumed by the spawn hook's exit path.
 */
async function attributeResidentScopeOom(unitName: string, memoryMax: string): Promise<void> {
  await retryOomAttribution(unitName, () => {
    console.error(
      `[resident-scope] session killed by the memory cap ${memoryMax} (unit ${unitName}.scope)`,
    );
  });
}

/**
 * Closes out a session that exited non-zero: blame the cap when the journal says so, then clear
 * the `failed` record systemd leaves on the unit.
 *
 * The second half matters as much as the first: a killed scope is not collected like a finished
 * one, so without it every crashed session would leave a dead unit in `systemctl list-units`
 * forever, and the operator's view of "which sessions exist" would rot. Clearing the record does
 * not touch the journal, so the attribution above still reads the real verdict.
 */
async function finishFailedResidentScope(unitName: string, memoryMax: string): Promise<void> {
  await attributeResidentScopeOom(unitName, memoryMax);
  stopResidentScopeUnit(unitName);
}

/**
 * Builds the SDK's `spawnClaudeCodeProcess` hook, or `undefined` when sessions must not be scoped.
 *
 * `undefined` is the whole degradation contract: the caller then leaves the option unset and the
 * SDK spawns the CLI exactly as it does today. That happens when the cap is `off`, and when a real
 * capped probe fails — the environment has no usable systemd user manager.
 *
 * The returned hook rewrites the spawn into a transient scope inside the resident slice, applies
 * the slice's own cap once per configuration value, keeps `cwd`, `env` and the abort `signal`
 * untouched, and reports a cap kill once the session exits non-zero.
 *
 * Consumed by `mapCliOptionsToSDK` and by the session-scope and process-containment criteria.
 */
export function createResidentScopeSpawn(
  deps: ResidentScopeSpawnDeps = {},
): ((options: SdkSpawnOptions) => ResidentScopeProcess) | undefined {
  const memoryMax = deps.memoryMax === undefined ? resolveResidentMemoryMax() : deps.memoryMax;
  if (!memoryMax) {
    return undefined;
  }

  const probe = deps.probe ?? probeOnce;
  if (!probe(memoryMax)) {
    // One line, not one per session: the rest of the run keeps today's unscoped behaviour.
    console.log(
      '[resident-scope] no usable systemd user manager; resident sessions run uncapped',
    );
    return undefined;
  }

  const sliceName = deps.sliceName === undefined ? resolveResidentSliceName() : deps.sliceName;
  const sliceMemoryMax = deps.sliceMemoryMax === undefined
    ? resolveResidentSliceMemoryMax()
    : deps.sliceMemoryMax;

  if (sliceName && sliceMemoryMax) {
    if (!sessionScope.ensureSliceCapApplied(sliceName, sliceMemoryMax)) {
      console.error(
        `[resident-scope] could not cap slice ${sliceName} at ${sliceMemoryMax}; per-session caps still apply`,
      );
    }
  }

  const ownerPid = deps.ownerPid ?? process.pid;
  const spawnImpl = deps.spawnImpl ?? defaultScopeSpawn;
  // Mirrors the SDK's own default spawn: the CLI's stderr is dropped unless debugging is on.
  const pipedStderr = Boolean(process.env.DEBUG_CLAUDE_AGENT_SDK);

  return (spawnOptions: SdkSpawnOptions): ResidentScopeProcess => {
    const unitName = buildResidentScopeUnitName(
      ownerPid,
      crypto.randomBytes(4).toString('hex'),
    );

    const child = spawnImpl('systemd-run', buildResidentScopeArgv({
      unitName,
      memoryMax,
      sliceName,
      command: spawnOptions.command,
      args: spawnOptions.args,
    }), {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      signal: spawnOptions.signal,
      stdio: ['pipe', 'pipe', pipedStderr ? 'pipe' : 'ignore'],
      windowsHide: true,
    });

    if (pipedStderr) {
      child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    }

    // A non-zero exit is the only signal Node gives us that something went wrong; whether the cap
    // is what did it can only be answered by the journal, hence the follow-up.
    child.on('exit', (code) => {
      if (code !== 0) {
        void finishFailedResidentScope(unitName, memoryMax);
      }
    });

    return child;
  };
}

/**
 * Every resident scope systemd still knows about, from the command an operator would run.
 *
 * A cleanly finished scope is collected and drops off this list on its own, but one that was
 * killed — by its cap, by an abort, by a crash — stays listed as `failed` until it is explicitly
 * reset, and nothing about the failure removes it. So stop and sweep have to read the same list
 * the operator does, failed entries included, or a server that loses sessions to its cap would
 * leave a growing pile of dead units behind.
 *
 * The list is the whole host's, not this process's: that is what makes it the right input for stop
 * and sweep, whose job is to find *other* servers' orphans, and the wrong thing for an assertion to
 * compare against a fixed count.
 *
 * Consumed by stop, sweep and the criteria's emptiness assertions.
 */
export function listResidentScopeUnits(): string[] {
  const result = spawnSync('systemctl', [
    '--user',
    'list-units',
    `${RESIDENT_SCOPE_PREFIX}*`,
    '--no-legend',
    '--plain',
  ], { encoding: 'utf8' });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit) => unit.startsWith(RESIDENT_SCOPE_PREFIX) && unit.endsWith('.scope'));
}

/** True when a PID exists, including one this process may not signal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

/**
 * Makes one scope disappear from `systemctl list-units`.
 *
 * Two steps, because neither alone is enough: `stop` is a SIGTERM plus a wait (and the wait is
 * what could hang a shutdown path, so it is bounded), while a unit that died on its own stays
 * behind as `failed` and only `reset-failed` clears that record. A scope still standing after both
 * is force-killed — the point of stopping these is that nothing of this server's outlives it.
 */
function stopResidentScopeUnit(unitName: string): void {
  // The two callers name the unit differently — `systemd-run --unit=` takes it bare while the
  // listing returns it suffixed — and `systemctl` defaults a bare name to `.service`, so an
  // unnormalized bare name silently addresses a unit that does not exist.
  const unit = unitName.endsWith('.scope') ? unitName : `${unitName}.scope`;

  spawnSync('systemctl', ['--user', 'stop', unit], {
    stdio: 'ignore',
    timeout: UNIT_STOP_TIMEOUT_MS,
  });
  spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore' });

  if (!listResidentScopeUnits().includes(unit)) {
    return;
  }

  spawnSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit], { stdio: 'ignore' });
  spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' });
  spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore' });
}

/**
 * Stops every scope owned by `ownerPid`, and returns the units it stopped.
 *
 * Called from the server's shutdown path with the server's own PID. Scopes live outside the
 * server's cgroup, so nothing else would collect them: without this, `serve-scoped.sh stop` leaves
 * every session of that server running.
 *
 * Consumed by `server/index.ts` (through the providers barrel) and by the criteria.
 */
export function stopResidentScopes(ownerPid: number = process.pid): string[] {
  const stopped: string[] = [];

  for (const unitName of listResidentScopeUnits()) {
    if (parseResidentScopeOwnerPid(unitName) !== ownerPid) {
      continue;
    }
    stopResidentScopeUnit(unitName);
    stopped.push(unitName);
  }

  return stopped;
}

/**
 * Stops the scopes whose owning server no longer exists, and returns the units it stopped.
 *
 * The shutdown path cannot run when the server is SIGKILLed, so its sessions survive as orphans
 * that nothing would ever reap. This runs at start-up instead, and touches only scopes whose
 * encoded owner PID is gone — a live server's sessions are left alone.
 *
 * Consumed by `server/index.ts` (through the providers barrel) and by the criteria.
 */
export function sweepOrphanResidentScopes(): string[] {
  const swept: string[] = [];

  for (const unitName of listResidentScopeUnits()) {
    const ownerPid = parseResidentScopeOwnerPid(unitName);
    if (ownerPid === null || isProcessAlive(ownerPid)) {
      continue;
    }
    stopResidentScopeUnit(unitName);
    swept.push(unitName);
  }

  return swept;
}

// --------------------------- PRE-PROMOTION NAMES ------------
/**
 * The `claude*` names this module exported before it was promoted to provider neutrality, kept as
 * aliases so consumers written against the old surface keep working byte for byte.
 *
 * Two kinds of consumer pin them: `claude-runtime.provider.js` and `server/index.ts` import them
 * through the providers barrel, and the previous criterion
 * (`providers/tests/claude-session-scope.test.ts`) asserts against them — including the generated
 * argv and the literal unit-name shape — so the contract is not just a name but a reading. Nothing
 * new should be written against these; a new provider uses the neutral names above.
 */
export const createClaudeSessionScopeSpawn = createResidentScopeSpawn;
export const resolveClaudeSessionMemoryMax = resolveResidentMemoryMax;
export const resetClaudeSessionScopeProbeCache = resetResidentScopeProbeCache;
export const buildClaudeSessionScopeUnitName = buildResidentScopeUnitName;
export const parseClaudeSessionScopeOwnerPid = parseResidentScopeOwnerPid;
export const listClaudeSessionScopeUnits = listResidentScopeUnits;
export const stopClaudeSessionScopes = stopResidentScopes;
export const sweepOrphanClaudeSessionScopes = sweepOrphanResidentScopes;
export type ClaudeSessionScopeSpawnDeps = ResidentScopeSpawnDeps;
export type SessionScopeProcess = ResidentScopeProcess;
export type SessionScopeSpawnImpl = ResidentScopeSpawnImpl;
export { DEFAULT_RESIDENT_MEMORY_MAX as DEFAULT_CLAUDE_SESSION_MEMORY_MAX };

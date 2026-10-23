import { spawn } from 'node:child_process';

import type { QuayTaskCounts } from '@/shared/types.js';

import { locateQuayFleetCli } from './quay-fleet-locator.js';

/**
 * Dereferencing for the wall's `quay://` address space.
 *
 * Two independent jobs live here, joined by one public factory:
 *
 * 1. THE ADDRESS GRAMMAR (server side). The renderer mints references with
 *    `src/modules/quay/quayUri.ts`; the server parses the same five forms here. The two
 *    copies are deliberate: the server's TypeScript program excludes `src/`, so importing
 *    the renderer's helper would put frontend code in the backend build. The grammar is the
 *    contract, and both sides reject the same shapes.
 *
 * 2. THE READ PATH. quay-fleet is the sole owner of the L1 action enum and of the L2 summary
 *    ledger (`.quay/object-summaries.jsonl`), so the primary path forwards `wall resolve` and
 *    `wall summary` to it VERBATIM — the same project-scoped address
 *    (`quay://<project>/…`) the wall mints, because that is the only form the fleet parses.
 *    When that read port is unavailable, a TASK reference
 *    falls back to the snapshot CloudCLI already reads for the Quay panel, which is honest
 *    stored data — never a summary generated on the spot. `wall resolve` never consults the
 *    registry, so the fleet's `project-not-registered` refusal can only arrive from
 *    `wall summary`; it is read as its own fallback reason rather than as a broken reader.
 *
 * STORED, NOT GENERATED. The L2 read path has no generator argument and never synthesises a
 * summary; a missing ledger row is reported as `absent`. The snapshot fallback likewise
 * only relabels fields the snapshot already holds.
 */

//----------------- the quay:// address grammar ------------

/** The object kinds a `quay://` reference can address, per quay-fleet's v0 enum. */
export const QUAY_OBJECT_TYPES = ['task', 'goal', 'ledger', 'board'] as const;

/** One object kind the address grammar knows. */
export type QuayObjectType = (typeof QUAY_OBJECT_TYPES)[number];

/**
 * Why a string is not an addressable `quay://` reference. Each reason is a separate
 * reading: a project-less draft (`quay://task/<id>`) is not the same mistake as an
 * invented object kind, so a caller can tell them apart.
 */
export type QuayUriRejection =
  | 'not-a-quay-uri'
  | 'missing-project'
  | 'unknown-type'
  | 'empty-id'
  | 'malformed';

/** One parsed reference; the union is discriminated by the object kind. */
export type QuayUriAddress =
  | { type: 'task'; project: string; id: string; ac: number | null }
  | { type: 'goal'; project: string; id: string }
  | { type: 'ledger'; project: string; name: string; eventId: string }
  | { type: 'board'; project: string };

/** The outcome of {@link parseQuayAddress}; a rejected reference never throws. */
type QuayUriParseResult =
  | { ok: true; address: QuayUriAddress }
  | { ok: false; reason: QuayUriRejection };

const QUAY_URI_PREFIX = 'quay://';

/** A path segment is non-empty and carries no whitespace (slashes were already split away). */
function isSegment(segment: string): boolean {
  return segment !== '' && !/\s/.test(segment);
}

/** Every rejection path funnels through here, so a malformed reference can never throw. */
function reject(reason: QuayUriRejection): QuayUriParseResult {
  return { ok: false, reason };
}

/**
 * Parses one `quay://` reference into its L1 shape, or names why it is not one.
 *
 * The project segment is a quay-fleet REGISTRY ID (`claudecodeui`, `quay-fleet`), never
 * CloudCLI's internal project UUID — see `quay-fleet-project-id.ts` for the join.
 *
 * Accepted forms (project segment mandatory):
 *   quay://<fleet-project-id>/task/<id>
 *   quay://<fleet-project-id>/task/<id>#ac-<n>
 *   quay://<fleet-project-id>/goal/<id>
 *   quay://<fleet-project-id>/ledger/<name>/<eventId>
 *   quay://<fleet-project-id>/board
 */
function parseQuayAddress(uri: string): QuayUriParseResult {
  if (!uri.startsWith(QUAY_URI_PREFIX)) return reject('not-a-quay-uri');

  const rest = uri.slice(QUAY_URI_PREFIX.length);
  // A query string has no meaning in the address space; accepting one would let a
  // `?`-suffixed string read as a different object than the one it names.
  if (rest.includes('?')) return reject('malformed');

  const hashAt = rest.indexOf('#');
  const fragment = hashAt === -1 ? null : rest.slice(hashAt + 1);
  const path = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const segments = path.split('/');
  if (segments[0] === undefined || segments[0] === '') return reject('missing-project');

  const [project, kind, ...tail] = segments;
  if (!isSegment(project)) return reject('malformed');
  // The project-less draft form: `quay://task/<id>` parses the kind as the project.
  if ((QUAY_OBJECT_TYPES as readonly string[]).includes(project)) return reject('missing-project');
  if (kind === undefined) return reject('malformed');
  if (kind === '') return reject('malformed');
  if (!(QUAY_OBJECT_TYPES as readonly string[]).includes(kind)) return reject('unknown-type');

  switch (kind) {
    case 'task': {
      if (tail.length !== 1) return reject(tail.length === 0 || tail[0] === '' ? 'empty-id' : 'malformed');
      const [id] = tail;
      if (!isSegment(id)) return reject(id === '' ? 'empty-id' : 'malformed');
      if (fragment === null) return { ok: true, address: { type: 'task', project, id, ac: null } };
      const ac = /^ac-([1-9]\d*)$/.exec(fragment);
      if (ac === null) return reject('malformed');
      return { ok: true, address: { type: 'task', project, id, ac: Number(ac[1]) } };
    }
    case 'goal': {
      if (fragment !== null || tail.length !== 1) {
        return reject(tail.length === 1 && tail[0] === '' ? 'empty-id' : 'malformed');
      }
      const [id] = tail;
      if (!isSegment(id)) return reject(id === '' ? 'empty-id' : 'malformed');
      return { ok: true, address: { type: 'goal', project, id } };
    }
    case 'ledger': {
      if (fragment !== null || tail.length !== 2) {
        return reject(tail.length === 2 && (tail[0] === '' || tail[1] === '') ? 'empty-id' : 'malformed');
      }
      const [name, eventId] = tail;
      if (!isSegment(name) || !isSegment(eventId)) {
        return reject(name === '' || eventId === '' ? 'empty-id' : 'malformed');
      }
      return { ok: true, address: { type: 'ledger', project, name, eventId } };
    }
    case 'board':
      if (fragment !== null || tail.length !== 0) return reject('malformed');
      return { ok: true, address: { type: 'board', project } };
    default:
      // Unreachable: the kind was checked against QUAY_OBJECT_TYPES above. Kept so the
      // function is total for the compiler without widening the parsed union.
      return reject('unknown-type');
  }
}

/**
 * Formats a parsed address back into the canonical reference the wall mints.
 *
 * This is ALSO the address quay-fleet parses: the fleet requires the project segment
 * (`quay://<project>/task/<id>`) and refuses the superseded project-less draft with
 * `missing-project-segment`. The canonical string is therefore handed to the fleet read
 * port unchanged — there is no translation step, and none may be reintroduced.
 */
function formatQuayAddress(address: QuayUriAddress): string {
  switch (address.type) {
    case 'task':
      return `quay://${address.project}/task/${address.id}${
        address.ac === null ? '' : `#ac-${address.ac}`
      }`;
    case 'goal':
      return `quay://${address.project}/goal/${address.id}`;
    case 'ledger':
      return `quay://${address.project}/ledger/${address.name}/${address.eventId}`;
    case 'board':
      return `quay://${address.project}/board`;
  }
}

/** The `#ac-<n>` fragment quay-fleet attaches to a task reference, when one was named. */
function fragmentOf(address: QuayUriAddress): { kind: 'ac'; index: number } | undefined {
  return address.type === 'task' && address.ac !== null
    ? { kind: 'ac', index: address.ac }
    : undefined;
}

//----------------- the fleet read port ------------

/** One L1 reference, field-for-field the document `quay-fleet wall resolve --json` prints. */
export type QuayFleetL1 = {
  uri: string;
  type: string;
  label: string;
  actions: readonly string[];
  fragment?: { kind: 'ac'; index: number };
};

/**
 * One L2 reading: the last stored row for the URI, or `absent` when the write path has
 * never stored one. `absent` is a reading of the ledger, not a failure to look.
 */
export type QuayFleetL2 =
  | { state: 'ok'; uri: string; summary: string; generatedAt: string | null; sourceEventId: string | null }
  | { state: 'absent'; uri: string };

/**
 * The fleet's own refusal of a `wall summary` invocation that is a fact about the WORKSPACE,
 * not about the read port.
 *
 * `project-not-registered` — the fleet is up and answered, and it refuses to open any carrier
 * because no `registry.json` row joins the URI's project segment to a workspace root (and no
 * `--root` was given). That refusal is a real reading of the fleet's registry; reporting it
 * as an unreadable read port would blame the reader for an honest「这个项目没登记」.
 */
export type QuayFleetSummaryRefusal = { state: 'project-not-registered'; uri: string };

/**
 * What one `wall summary` call read: an L2 document, a workspace refusal, or — through the
 * reader's `null` — nothing at all.
 */
export type QuayFleetSummaryReading = QuayFleetL2 | QuayFleetSummaryRefusal;

/**
 * The fleet side of the wall (quay-fleet's `wall resolve` / `wall summary` read port).
 *
 * Both methods return `null` — never throw — when the port cannot be read: no binary is
 * configured, the child failed or timed out, or its document was unreadable. `null` is the
 * single "unavailable" reading that lets the resolver choose the snapshot fallback.
 *
 * `summary` has one more outcome: {@link QuayFleetSummaryRefusal}, for a non-zero exit whose
 * stated reason is a workspace fact. A non-zero exit for any other reason stays `null`.
 *
 * URIs are handed over in the wall's canonical project-scoped form (`quay://<project>/…`),
 * which is also the only form the fleet parses. `summary` additionally takes an OPTIONAL
 * `--root` consistency override — the root the fleet registry joined to the URI's project
 * segment, or `null` to let the segment alone select the workspace.
 */
export type QuayFleetWallReader = {
  resolve(uri: string): Promise<QuayFleetL1 | null>;
  summary(uri: string, projectRoot: string | null): Promise<QuayFleetSummaryReading | null>;
};

/**
 * The environment variable naming the fleet CLI a deployment wants the server to call.
 *
 * Re-exported from the shared locator so this module's public surface (and its criterion) keep
 * naming the same constant; the ACTUAL lookup lives in `quay-fleet-locator.ts` only.
 */
export { QUAY_FLEET_BIN_ENV } from './quay-fleet-locator.js';

/**
 * One call to the fleet CLI, normalized so the reader never sees child-process internals.
 * `stderr` is kept because a REFUSED invocation states its reason there (see
 * {@link readFleetSummaryRefusal}); it is only ever read when `ok` is false.
 */
type FleetCommandResult = { ok: boolean; stdout: string; stderr: string };

/**
 * How much of a failing child's stderr is kept. The reason this module reads is the first
 * line; the usage text quay-fleet appends after it is tens of kilobytes and is not a reading.
 * Bounding the buffer keeps a misbehaving child from growing the server's heap.
 */
const STDERR_CAPTURE_LIMIT = 8 * 1024;

/**
 * Runs the fleet CLI once with a hard wall-clock bound. It never rejects: a missing binary,
 * a timeout and a non-zero exit all read `ok: false`. The caller decides whether that failure
 * means "the read port is unavailable" (`null`) or carries a reason of its own.
 */
function runFleetCommand(binaryPath: string, args: readonly string[], timeoutMs: number): Promise<FleetCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (result: FleetCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binaryPath, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      settle({ ok: false, stdout: '', stderr: '' });
      return;
    }

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ ok: false, stdout: '', stderr: '' });
    }, timeoutMs);

    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // Drained even past the cap, so a chatty child cannot block on a full pipe.
      if (stderr.length < STDERR_CAPTURE_LIMIT) stderr += chunk;
    });
    child.on('error', () => settle({ ok: false, stdout: '', stderr: '' }));
    child.on('close', (code) => settle({ ok: code === 0, stdout, stderr }));
  });
}

/** Parses stdout as JSON, or `null` when it is not a JSON document at all. */
function parseFleetJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Reads one L1 document, or `null` when it does not carry the contract's shape. */
function readFleetL1(value: unknown): QuayFleetL1 | null {
  const record = asRecord(value);
  if (record === null || record.ok !== true) return null;
  const uri = readString(record.uri);
  const type = readString(record.type);
  const label = readString(record.label);
  if (uri === null || type === null || label === null || !Array.isArray(record.actions)) return null;
  const actions = record.actions.filter((action): action is string => typeof action === 'string');
  if (actions.length !== record.actions.length) return null;

  const fragmentRecord = asRecord(record.fragment);
  const fragment =
    fragmentRecord !== null
    && fragmentRecord.kind === 'ac'
    && typeof fragmentRecord.index === 'number'
    && Number.isInteger(fragmentRecord.index)
    && fragmentRecord.index > 0
      ? { kind: 'ac' as const, index: fragmentRecord.index }
      : undefined;

  return { uri, type, label, actions, ...(fragment === undefined ? {} : { fragment }) };
}

/**
 * The fleet's stable reason token for a REFUSED `wall summary`, read from the child's stderr.
 *
 * quay-fleet prints a refused invocation as `quay-fleet: wall summary: <reason> — <detail>`
 * and exits non-zero; `<detail>` and the usage text that follows never repeat the reason, so
 * anchoring to that line matches the reason and nothing else. Only `project-not-registered`
 * is a workspace fact worth a reading of its own — `root-not-a-directory`,
 * `registry-unreadable` and every other reason stay `null`, because for them the fleet could
 * not read a carrier at all.
 */
function readFleetSummaryRefusal(stderr: string): 'project-not-registered' | null {
  return /^quay-fleet: wall summary: project-not-registered(?:\s|$)/m.test(stderr)
    ? 'project-not-registered'
    : null;
}

/** Reads one L2 document, or `null` when it does not carry the contract's shape. */
function readFleetL2(value: unknown): QuayFleetL2 | null {
  const record = asRecord(value);
  if (record === null) return null;
  const uri = readString(record.uri);
  if (uri === null) return null;

  if (record.state === 'absent') return { state: 'absent', uri };
  if (record.state !== 'ok') return null;

  const summary = readString(record.summary);
  if (summary === null) return null;
  const generatedAt = readString(record.generatedAt);
  const sourceEventId = readString(record.sourceEventId);
  return { state: 'ok', uri, summary, generatedAt, sourceEventId };
}

/**
 * Builds the production read port over the fleet CLI, or `null` when no binary is
 * configured. Consumer: `quay.service.ts`, which passes the result to the resolver.
 *
 * `binaryPath` is the explicit seam: `null` disables the fleet path, an undefined value asks
 * the shared locator (`QUAY_FLEET_BIN` → `PATH` → `~/.quay-fleet/bin/quay-fleet`). A lookup
 * miss is `null` — the honest "no fleet read port here" reading that sends task references
 * down the snapshot fallback — rather than a guessed host path.
 */
export function createQuayFleetCliWallReader(options: {
  binaryPath?: string | null;
  timeoutMs: number;
}): QuayFleetWallReader | null {
  const configured = options.binaryPath !== undefined
    ? options.binaryPath
    : locateQuayFleetCli().binPath;
  if (configured === null || configured === '') return null;
  const binaryPath = configured;

  return {
    async resolve(uri: string): Promise<QuayFleetL1 | null> {
      const result = await runFleetCommand(binaryPath, ['wall', 'resolve', uri, '--json'], options.timeoutMs);
      return result.ok ? readFleetL1(parseFleetJson(result.stdout)) : null;
    },
    async summary(uri: string, projectRoot: string | null): Promise<QuayFleetSummaryReading | null> {
      // `--root` is an OPTIONAL override on the fleet side: without it the URI's project
      // segment is resolved through the fleet registry, which is the authority. The override
      // is only added when the caller has a root to pin (worktree / test), never guessed.
      const args = ['wall', 'summary', uri, ...(projectRoot === null ? [] : ['--root', projectRoot]), '--json'];
      const result = await runFleetCommand(binaryPath, args, options.timeoutMs);
      if (result.ok) return readFleetL2(parseFleetJson(result.stdout));
      // A non-zero exit normally means "the read port is unavailable", but the fleet also
      // refuses an UNREGISTERED project from a working read port. Its stated reason is what
      // separates the two; the exit code alone cannot.
      const refusal = readFleetSummaryRefusal(result.stderr);
      return refusal === null ? null : { state: refusal, uri };
    },
  };
}

//----------------- the resolver ------------

/**
 * The snapshot half of the fallback. Only `tasks` is read: the fallback answers for TASK
 * references, and `tasks.recent` is the same stored list the Quay panel renders.
 */
export type QuayUriSnapshotTasks = { tasks: QuayTaskCounts | null };

/** One task's stored fields, read back from the snapshot the panel already has. */
export type QuayUriSnapshotTask = {
  id: string;
  title: string;
  status: string;
  updatedAt: string | null;
};

/** Failure reason codes: the four parse rejections plus the read-path outcomes. */
export type QuayUriErrorCode =
  | QuayUriRejection
  /** The project segment is not a project the fleet registry knows (a UUID is the usual case). */
  | 'unknown-project'
  | 'snapshot-unavailable'
  | 'task-not-found'
  | 'fleet-unavailable';

/** Which side answered. The fallback names itself so a caller never mistakes it for fleet. */
export type QuayUriSource = 'fleet' | 'snapshot-fallback';

/**
 * Why the snapshot answered instead of the fleet. The three are different facts and the
 * caller acts differently on each:
 *
 * - `no-summary` — the fleet READ PORT IS UP but its write path has stored no L2 row for
 *   this reference (today that is every reference: the fleet's write path is not wired into
 *   the observe loop yet). That is not a reader failure.
 * - `project-not-registered` — the fleet READ PORT IS UP and refused the read as a workspace
 *   fact: no registry row joins the reference's project segment to a root. The project is
 *   unknown to the fleet; that is not the same fact as an unreadable reader.
 * - `reader-unavailable` — the fleet CLI is absent, exited non-zero for any other reason,
 *   timed out, or printed something that is not the read port's document. Nothing about the
 *   fleet could be read.
 */
export type QuayUriFallbackReason = 'no-summary' | 'project-not-registered' | 'reader-unavailable';

/** A resolved L1 reference. */
export type QuayUriResolveSuccess = {
  ok: true;
  uri: string;
  /**
   * The object kind. On the fleet path this is quay-fleet's own `type` string forwarded
   * verbatim (the fleet owns the enum); the snapshot fallback answers `'task'`.
   */
  type: string;
  label: string;
  /**
   * Fleet's action enum verbatim. It is `[]` only when the fleet's L1 could not be read at
   * all (there is then no enum to forward); a read-port summary miss keeps the L1 actions
   * because those still came from the fleet, not from this side.
   */
  actions: readonly string[];
  fragment?: { kind: 'ac'; index: number };
  source: QuayUriSource;
  /** Present when `source` is the snapshot fallback: which fallback this was. */
  reason?: QuayUriFallbackReason;
  /** The stored task fields, present only when the snapshot supplied the object's content. */
  task?: QuayUriSnapshotTask;
};

/** An L2 reading: a stored summary, `absent`, or a named failure. */
export type QuayUriSummarySuccess = {
  ok: true;
  uri: string;
  source: QuayUriSource;
  state: 'ok' | 'absent';
  /** Present when `source` is the snapshot fallback: which fallback this was. */
  reason?: QuayUriFallbackReason;
  summary?: string;
  generatedAt?: string | null;
  sourceEventId?: string | null;
};

/** A named failure; the route maps the code to a status and never answers 500. */
export type QuayUriFailure = {
  ok: false;
  error: { code: QuayUriErrorCode; message: string };
};

export type QuayUriResolveResult = QuayUriResolveSuccess | QuayUriFailure;
export type QuayUriSummaryResult = QuayUriSummarySuccess | QuayUriFailure;

/**
 * Where a reference's project segment points, as the fleet registry answers it.
 *
 * `root` is the registered workspace root the segment joins to. It is passed to `wall
 * summary` as its OPTIONAL `--root` consistency override; a blank root means the segment
 * alone selects the workspace. `projectId`
 * is the CloudCLI project at that root, when this instance knows one; the snapshot fallback
 * reads that project, and `null` means there is no snapshot to fall back to.
 */
export type QuayUriFleetProject = {
  root: string;
  projectId: string | null;
};

/** The injected seams the resolver reads through; all three are pure data edges. */
export type QuayUriResolveDependencies = {
  /** quay-fleet's L1/L2 read port, or `null` when no fleet CLI is configured. */
  fleetWallReader: QuayFleetWallReader | null;
  /**
   * Resolves a reference's project segment — a quay-fleet REGISTRY ID (`claudecodeui`), never
   * a CloudCLI project id — to the registered root and the CloudCLI project at it. `null` when
   * the registry does not know the segment.
   */
  resolveFleetProject(projectSegment: string): Promise<QuayUriFleetProject | null>;
  /**
   * The project's existing snapshot reading (Cache then load-on-demand is the service's
   * choice). `null` means there is no snapshot at all — the fallback then says so.
   */
  readSnapshot(projectId: string): Promise<QuayUriSnapshotTasks | null>;
  /**
   * Sink for the one consistency warning this module raises: a summary read whose project
   * segment has no registered root falls back to letting the segment alone select the
   * workspace. Optional (defaults to `console.warn`) so existing callers stay unchanged.
   */
  warn?: (message: string) => void;
};

/** The dereference entry point consumed by `quay.service.ts` / `quay.routes.ts`. */
export type QuayUriResolver = {
  resolve(uri: string): Promise<QuayUriResolveResult>;
  summary(uri: string): Promise<QuayUriSummaryResult>;
};

function failure(code: QuayUriErrorCode, message: string): QuayUriFailure {
  return { ok: false, error: { code, message } };
}

/** Finds one task's stored row in the snapshot's recent-tasks list. */
function findSnapshotTask(
  snapshot: QuayUriSnapshotTasks | null,
  taskId: string,
): QuayUriSnapshotTask | null {
  const recent = snapshot?.tasks?.recent ?? [];
  for (const row of recent) {
    if (row.id === taskId) {
      return { id: row.id, title: row.title, status: row.status, updatedAt: row.updatedAt };
    }
  }
  return null;
}

/**
 * Creates the resolver.
 *
 * The fleet L1/L2 read port is tried first. The snapshot answers only TASK references, and
 * only when the fleet could not supply that reference's CONTENT:
 *
 *  - L1 unreadable (no CLI, non-zero exit, unreadable document) → the snapshot supplies the
 *    task fields, `actions: []` (no enum was read), reason `reader-unavailable`;
 *  - L1 readable, L2 `absent` (the fleet's write path has stored no row) → the fleet's own
 *    type/actions/fragment are kept and the snapshot supplies the task fields, reason
 *    `no-summary`;
 *  - L1 readable, L2 refused with `project-not-registered` → the same keeping of the fleet's
 *    L1, reason `project-not-registered`: the fleet is up and named the workspace it does not
 *    know, which is not a reader failure.
 *
 * None of these paths generates an L2 summary.
 */
export function createQuayUriResolver(dependencies: QuayUriResolveDependencies): QuayUriResolver {
  const warn = dependencies.warn ?? ((message: string) => console.warn(message));

  /**
   * The optional `--root` consistency override for a summary read.
   *
   * The URI's PROJECT SEGMENT is authoritative: the fleet resolves it to a workspace root
   * through its own registry. CloudCLI knows a root only through that same registry join
   * ({@link QuayUriResolveDependencies.resolveFleetProject}), so the root passed here is by
   * construction the segment's own root — a consistency override, never a competing one. A
   * join without a root therefore sends no override (the segment alone selects the
   * workspace) and records the divergence instead of pinning a guessed directory.
   */
  const summaryRootFor = (address: QuayUriAddress, project: QuayUriFleetProject): string | null => {
    if (project.root.trim() !== '') return project.root;
    warn(
      `quay wall summary: project '${address.project}' has no registered root; the URI's project segment alone selects the workspace ('${formatQuayAddress(address)}')`,
    );
    return null;
  };

  /** The fleet's own L1 values, forwarded unchanged: this side never mints an action set. */
  const fleetAnswer = (
    address: QuayUriAddress,
    uri: string,
    reference: QuayFleetL1,
  ): QuayUriResolveSuccess => ({
    ok: true,
    uri,
    type: reference.type,
    label: reference.label,
    actions: reference.actions,
    ...(reference.fragment === undefined ? { fragment: fragmentOf(address) } : { fragment: reference.fragment }),
    source: 'fleet',
  });

  /**
   * The snapshot answer for one task reference. `reference` is the fleet's L1 when the read
   * port answered (a summary miss keeps its type/actions/fragment); it is absent when the
   * port could not be read, in which case no action set is forwarded.
   *
   * A registered fleet project CloudCLI has no project for still has an L1 reading; only the
   * fallback's CONTENT is missing, which is reported as `snapshot-unavailable`.
   */
  const resolveFromSnapshot = async (
    address: Extract<QuayUriAddress, { type: 'task' }>,
    project: QuayUriFleetProject,
    uri: string,
    reason: QuayUriFallbackReason,
    reference?: QuayFleetL1,
  ): Promise<QuayUriResolveResult> => {
    if (project.projectId === null) {
      return reference === undefined
        ? failure(
            'snapshot-unavailable',
            `fleet project '${address.project}' is registered but no CloudCLI project is open at '${project.root}'`,
          )
        : fleetAnswer(address, uri, reference);
    }
    const snapshot = await dependencies.readSnapshot(project.projectId);
    const task = snapshot === null ? null : findSnapshotTask(snapshot, address.id);
    if (task === null) {
      // The L1 reading is still valid even when no stored snapshot row supplies content.
      if (reference !== undefined) return fleetAnswer(address, uri, reference);
      return snapshot === null
        ? failure(
            'snapshot-unavailable',
            `the fleet read port is unavailable and project '${address.project}' has no snapshot reading`,
          )
        : failure('task-not-found', `task '${address.id}' is not in project '${address.project}' snapshot`);
    }
    const fragment = reference?.fragment ?? fragmentOf(address);
    return {
      ok: true,
      uri,
      type: reference?.type ?? 'task',
      label: reference?.label ?? task.id,
      actions: reference?.actions ?? [],
      ...(fragment === undefined ? {} : { fragment }),
      source: 'snapshot-fallback',
      reason,
      task,
    };
  };

  const resolve = async (uri: string): Promise<QuayUriResolveResult> => {
    const parsed = parseQuayAddress(uri);
    if (!parsed.ok) {
      return failure(parsed.reason, `'${uri}' is not an addressable quay:// URI (${parsed.reason})`);
    }
    const { address } = parsed;
    const canonical = formatQuayAddress(address);

    // The project segment is a fleet REGISTRY ID. An unresolvable segment (a CloudCLI UUID is
    // the usual shape) is named as such before any read is attempted.
    const project = await dependencies.resolveFleetProject(address.project);
    if (project === null) {
      return failure(
        'unknown-project',
        `'${address.project}' is not a project registered in quay-fleet`,
      );
    }

    const fleet = dependencies.fleetWallReader;

    if (fleet === null) {
      return address.type === 'task'
        ? resolveFromSnapshot(address, project, canonical, 'reader-unavailable')
        : failure(
            'fleet-unavailable',
            `the fleet read port is unavailable; only task references have a snapshot fallback ('${canonical}')`,
          );
    }

    const reference = await fleet.resolve(canonical);
    if (reference === null) {
      return address.type === 'task'
        ? resolveFromSnapshot(address, project, canonical, 'reader-unavailable')
        : failure(
            'fleet-unavailable',
            `the fleet read port is unavailable; only task references have a snapshot fallback ('${canonical}')`,
          );
    }

    // A non-task kind has no snapshot content to add: the fleet's L1 is the whole reading.
    if (address.type !== 'task') return fleetAnswer(address, canonical, reference);

    // A task's stored content (title/status) lives in the snapshot while the fleet's write
    // path has stored no L2 row. The fleet's L1 values stay; the reason names why the
    // content came from the snapshot.
    const reading = await fleet.summary(canonical, summaryRootFor(address, project));
    if (reading !== null && reading.state === 'ok') return fleetAnswer(address, canonical, reference);

    return resolveFromSnapshot(
      address,
      project,
      canonical,
      reading === null
        ? 'reader-unavailable'
        : reading.state === 'project-not-registered'
          ? 'project-not-registered'
          : 'no-summary',
      reference,
    );
  };

  const summary = async (uri: string): Promise<QuayUriSummaryResult> => {
    const parsed = parseQuayAddress(uri);
    if (!parsed.ok) {
      return failure(parsed.reason, `'${uri}' is not an addressable quay:// URI (${parsed.reason})`);
    }
    const { address } = parsed;
    const canonical = formatQuayAddress(address);
    const project = await dependencies.resolveFleetProject(address.project);
    if (project === null) {
      return failure('unknown-project', `'${address.project}' is not a project registered in quay-fleet`);
    }

    /** The snapshot holds no L2 ledger: an absent reading is all it can honestly answer. */
    const fallbackAbsent = (reason: QuayUriFallbackReason): QuayUriSummaryResult =>
      address.type === 'task'
        ? { ok: true, uri: canonical, source: 'snapshot-fallback', state: 'absent', reason }
        : failure(
            'fleet-unavailable',
            `the fleet read port is unavailable; only task references have a snapshot fallback ('${canonical}')`,
          );

    const fleet = dependencies.fleetWallReader;
    if (fleet === null) return fallbackAbsent('reader-unavailable');

    const reading = await fleet.summary(canonical, summaryRootFor(address, project));
    if (reading === null) return fallbackAbsent('reader-unavailable');
    // The fleet answered and refused the project, not the read: a workspace fact, reported
    // as itself rather than as a broken reader.
    if (reading.state === 'project-not-registered') return fallbackAbsent('project-not-registered');

    if (reading.state === 'absent') {
      // A stored-miss is NOT a reader failure: the fleet answered, it just has no row yet.
      return address.type === 'task'
        ? { ok: true, uri: canonical, source: 'snapshot-fallback', state: 'absent', reason: 'no-summary' }
        : { ok: true, uri: canonical, source: 'fleet', state: 'absent' };
    }

    return {
      ok: true,
      uri: canonical,
      source: 'fleet',
      state: 'ok',
      summary: reading.summary,
      generatedAt: reading.generatedAt,
      sourceEventId: reading.sourceEventId,
    };
  };

  return { resolve, summary };
}

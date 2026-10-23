import { spawn } from 'node:child_process';

import type { QuayTaskCounts } from '@/shared/types.js';

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
 *    `wall summary` to it verbatim. When that read port is unavailable, a TASK reference
 *    falls back to the snapshot CloudCLI already reads for the Quay panel, which is honest
 *    stored data — never a summary generated on the spot.
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
 * Accepted forms (project segment mandatory):
 *   quay://<project>/task/<id>
 *   quay://<project>/task/<id>#ac-<n>
 *   quay://<project>/goal/<id>
 *   quay://<project>/ledger/<name>/<eventId>
 *   quay://<project>/board
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

/** Formats a parsed address back into the canonical reference the wall mints. */
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

/**
 * Formats the SAME object in quay-fleet's own address forms, which is what the fleet read
 * port parses.
 *
 * WHY THIS TRANSLATION EXISTS. The wall's addresses carry the project as their FIRST
 * segment (`quay://<project>/task/<id>`) because one wall shows several projects. The
 * fleet reads one workspace at a time — the caller names it with `--root`, not in the
 * address — so its refs are project-less (`quay://task/<id>`, `quay://goal/<id>`,
 * `quay://ledger/<name>/<eventId>`), and a board names its project as the object id
 * (`quay://board/<project>`). The project segment therefore selects the workspace root
 * for the read; inside that workspace the fleet's own form is the address.
 *
 * The returned `uri` in a resolve/summary result stays in the wall's form — the caller
 * only ever sees the address space it minted.
 */
function formatFleetAddress(address: QuayUriAddress): string {
  switch (address.type) {
    case 'task':
      return `quay://task/${address.id}${address.ac === null ? '' : `#ac-${address.ac}`}`;
    case 'goal':
      return `quay://goal/${address.id}`;
    case 'ledger':
      return `quay://ledger/${address.name}/${address.eventId}`;
    case 'board':
      return `quay://board/${address.project}`;
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
 * The fleet side of the wall (quay-fleet's `wall resolve` / `wall summary` read port).
 *
 * Both methods return `null` — never throw — when the port cannot be read: no binary is
 * configured, the child failed or timed out, or its document was unreadable. `null` is the
 * single "unavailable" reading that lets the resolver choose the snapshot fallback.
 */
export type QuayFleetWallReader = {
  resolve(uri: string): Promise<QuayFleetL1 | null>;
  summary(uri: string, projectRoot: string): Promise<QuayFleetL2 | null>;
};

/** The environment variable naming the fleet CLI a deployment wants the server to call. */
export const QUAY_FLEET_BIN_ENV = 'QUAY_FLEET_BIN';

/** One call to the fleet CLI, normalized so the reader never sees child-process internals. */
type FleetCommandResult = { ok: boolean; stdout: string };

/**
 * Runs the fleet CLI once with a hard wall-clock bound. It never rejects: a missing binary,
 * a timeout and a non-zero exit all read `ok: false`, which the caller maps to `null`
 * (the snapshot fallback) rather than surfacing a process error the panel cannot act on.
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
      settle({ ok: false, stdout: '' });
      return;
    }

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ ok: false, stdout: '' });
    }, timeoutMs);

    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // stderr is drained so a chatty child cannot block on a full pipe; its content is not
    // a reading this module reports — the exit code already says the call failed.
    child.stderr?.resume();
    child.on('error', () => settle({ ok: false, stdout: '' }));
    child.on('close', (code) => settle({ ok: code === 0, stdout }));
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
 * `binaryPath` defaults to {@link QUAY_FLEET_BIN_ENV}. A deployment that has not set it
 * gets `null` — the honest "no fleet read port here" reading that sends task references
 * down the snapshot fallback — rather than a guessed host path.
 */
export function createQuayFleetCliWallReader(options: {
  binaryPath?: string | null;
  timeoutMs: number;
}): QuayFleetWallReader | null {
  const configured = options.binaryPath ?? process.env[QUAY_FLEET_BIN_ENV] ?? '';
  if (configured === '') return null;
  const binaryPath = configured;

  return {
    async resolve(uri: string): Promise<QuayFleetL1 | null> {
      const result = await runFleetCommand(binaryPath, ['wall', 'resolve', uri, '--json'], options.timeoutMs);
      return result.ok ? readFleetL1(parseFleetJson(result.stdout)) : null;
    },
    async summary(uri: string, projectRoot: string): Promise<QuayFleetL2 | null> {
      const result = await runFleetCommand(
        binaryPath,
        ['wall', 'summary', uri, '--root', projectRoot, '--json'],
        options.timeoutMs,
      );
      return result.ok ? readFleetL2(parseFleetJson(result.stdout)) : null;
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

/** Failure reason codes: the four parse rejections plus the three read-path outcomes. */
export type QuayUriErrorCode =
  | QuayUriRejection
  | 'project-not-found'
  | 'snapshot-unavailable'
  | 'task-not-found'
  | 'fleet-unavailable';

/** Which side answered. The fallback names itself so a caller never mistakes it for fleet. */
export type QuayUriSource = 'fleet' | 'snapshot-fallback';

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
  /** Fleet's action enum verbatim; `[]` on the fallback (this side never invents actions). */
  actions: readonly string[];
  fragment?: { kind: 'ac'; index: number };
  source: QuayUriSource;
  /** The stored task fields, present only on the snapshot fallback. */
  task?: QuayUriSnapshotTask;
};

/** An L2 reading: a stored summary, `absent`, or a named failure. */
export type QuayUriSummarySuccess = {
  ok: true;
  uri: string;
  source: QuayUriSource;
  state: 'ok' | 'absent';
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

/** The injected seams the resolver reads through; all three are pure data edges. */
export type QuayUriResolveDependencies = {
  /** quay-fleet's L1/L2 read port, or `null` when no fleet CLI is configured. */
  fleetWallReader: QuayFleetWallReader | null;
  /** Resolves a reference's project segment to the workspace root the fleet reads. */
  resolveProjectRoot(projectId: string): string | null;
  /**
   * The project's existing snapshot reading (Cache then load-on-demand is the service's
   * choice). `null` means there is no snapshot at all — the fallback then says so.
   */
  readSnapshot(projectId: string): Promise<QuayUriSnapshotTasks | null>;
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
 * Creates the resolver. The fleet port is tried first; only a task reference that it
 * cannot answer falls back to the snapshot, and the fallback never generates an L2.
 */
export function createQuayUriResolver(dependencies: QuayUriResolveDependencies): QuayUriResolver {
  /**
   * The snapshot answer for one task reference. It reuses the snapshot's own fields and
   * declares `actions: []` — CloudCLI is not the action enum's source, so inventing a set
   * here would make the two sides disagree.
   */
  const resolveFromSnapshot = async (
    address: Extract<QuayUriAddress, { type: 'task' }>,
    uri: string,
  ): Promise<QuayUriResolveResult> => {
    if (dependencies.resolveProjectRoot(address.project) === null) {
      return failure('project-not-found', `no CloudCLI project '${address.project}' to fall back to`);
    }
    const snapshot = await dependencies.readSnapshot(address.project);
    if (snapshot === null) {
      return failure(
        'snapshot-unavailable',
        `the fleet read port is unavailable and project '${address.project}' has no snapshot reading`,
      );
    }
    const task = findSnapshotTask(snapshot, address.id);
    if (task === null) {
      return failure('task-not-found', `task '${address.id}' is not in project '${address.project}' snapshot`);
    }
    const fragment = fragmentOf(address);
    return {
      ok: true,
      uri,
      type: 'task',
      label: task.id,
      actions: [],
      source: 'snapshot-fallback',
      ...(fragment === undefined ? {} : { fragment }),
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

    const fleet = dependencies.fleetWallReader;
    if (fleet !== null) {
      const reference = await fleet.resolve(formatFleetAddress(address));
      if (reference !== null) {
        // type/actions/fragment are quay-fleet's values, forwarded unchanged: this side is
        // a consumer of the enum, never a second source for it.
        return {
          ok: true,
          uri: canonical,
          type: reference.type,
          label: reference.label,
          actions: reference.actions,
          ...(reference.fragment === undefined ? { fragment: fragmentOf(address) } : { fragment: reference.fragment }),
          source: 'fleet',
        };
      }
    }

    if (address.type === 'task') return resolveFromSnapshot(address, canonical);

    return failure(
      'fleet-unavailable',
      `the fleet read port is unavailable; only task references have a snapshot fallback ('${canonical}')`,
    );
  };

  const summary = async (uri: string): Promise<QuayUriSummaryResult> => {
    const parsed = parseQuayAddress(uri);
    if (!parsed.ok) {
      return failure(parsed.reason, `'${uri}' is not an addressable quay:// URI (${parsed.reason})`);
    }
    const { address } = parsed;
    const canonical = formatQuayAddress(address);
    const projectRoot = dependencies.resolveProjectRoot(address.project);
    if (projectRoot === null) {
      return failure('project-not-found', `no CloudCLI project '${address.project}'`);
    }

    const fleet = dependencies.fleetWallReader;
    if (fleet !== null) {
      const reading = await fleet.summary(formatFleetAddress(address), projectRoot);
      if (reading !== null) {
        return reading.state === 'ok'
          ? {
              ok: true,
              uri: canonical,
              source: 'fleet',
              state: 'ok',
              summary: reading.summary,
              generatedAt: reading.generatedAt,
              sourceEventId: reading.sourceEventId,
            }
          : { ok: true, uri: canonical, source: 'fleet', state: 'absent' };
      }
    }

    if (address.type === 'task') {
      // The snapshot holds no L2 ledger, and the read path never manufactures one: the
      // honest answer for a task reference when the fleet is unavailable is `absent`.
      return { ok: true, uri: canonical, source: 'snapshot-fallback', state: 'absent' };
    }

    return failure(
      'fleet-unavailable',
      `the fleet read port is unavailable; only task references have a snapshot fallback ('${canonical}')`,
    );
  };

  return { resolve, summary };
}

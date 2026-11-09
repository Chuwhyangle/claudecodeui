
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  QuayLoopDrain,
  QuayLoopKernel,
  QuayLoopOrphan,
  QuayLoopPointer,
  QuayLoopStatus,
  QuayLoopVersionRelation,
} from '@/shared/types.js';

import type { QuayFileReader } from './quay-command-port.js';
import { asRecord } from './quay-snapshot-summaries.js';

/**
 * The Loop status card's reading, projected from the SAME `driver status --kind worker` document
 * the snapshot's driver summary parses (no second subprocess), the three tiny drain-control
 * files, and — only for a live kernel path inside the plugin cache — its `.orphaned_at` marker.
 * A path taken from the CLI document is treated as untrusted and refused before any read when
 * it escapes the cache.
 *
 * Consumers: `service/quay-snapshot-read.service.ts`.
 */

/**
 * The three per-kind drain control files quay's `driver drain` / `driver resume` write under
 * `<project>/.quay/`. Each carries a boolean `halted` flag; the file's absence means that kind
 * has never been drained (read as `false`), while an unreadable flag is `null`.
 */
const QUAY_LOOP_DRAIN_CONTROL_FILES = {
  worker: 'worker-control.json',
  promotion: 'promotion-control.json',
  quality: 'quality-control.json',
} as const satisfies Record<keyof QuayLoopDrain, string>;

/**
 * How long Claude Code keeps an orphan-marked plugin version directory before its background
 * cleanup deletes it: 14 days. Source: the Claude Code plugin docs on installing/managing
 * plugins — after an update or uninstall the superseded version directory gets a
 * `.orphaned_at` marker (epoch milliseconds) and is removed by the background cleanup two
 * weeks later. This is the constant the `.quay/plugin`-pinned loop must watch: an anchor
 * running from such a directory loses its scripts when the window closes.
 */
const QUAY_PLUGIN_ORPHAN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The four states `driver status --json` prints for `loaded_version` (and `pointer.state`).
 * Anything else is an unknown reading and must be reported `not-evaluated`, never guessed.
 */
const QUAY_LOOP_VERSION_RELATIONS: readonly QuayLoopVersionRelation[] = [
  'current',
  'behind',
  'ahead',
  'not-evaluated',
];

/** The marker file Claude Code writes into a superseded plugin version directory. */
const QUAY_PLUGIN_ORPHAN_MARKER = '.orphaned_at';

/** True when `candidate` is `root` itself or sits strictly beneath it (lexical, no symlink resolution). */
function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** The path's real form, or the path unchanged when it does not resolve (missing/broken link). */
function resolveRealPathOrSelf(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

/**
 * The plugin-cache root Claude Code installs versioned plugin directories under:
 * `<plugins root>/cache`, where the plugins root defaults to `~/.claude/plugins` and is
 * overridden by `CLAUDE_CODE_PLUGIN_CACHE_DIR`.
 */
function resolvePluginCacheRoot(): string {
  const override = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim();
  const pluginsRoot = override ? override : path.join(os.homedir(), '.claude', 'plugins');
  return path.resolve(pluginsRoot, 'cache');
}

/**
 * Reads one drain control file. Absence is `false` (the kind has never been drained), a
 * readable boolean `halted` is itself, and anything else — unreadable text, invalid JSON,
 * a non-boolean flag — is `null`. The two "not halted" readings are deliberately distinct:
 * "no file" is a fact about the loop's history, while `null` is "could not tell".
 */
async function readDrainFlag(reader: QuayFileReader, filePath: string): Promise<boolean | null> {
  const size = await reader.size(filePath);
  if (size === null) {
    return false;
  }

  let text: string;
  try {
    text = await reader.readText(filePath);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  return record !== null && typeof record.halted === 'boolean' ? record.halted : null;
}

/**
 * Projects the `loaded_version` family from one `driver status` record. A value outside the
 * four known states, or an absent field, is `not-evaluated` with an explicit reason — never
 * `current` (the CLI documents `not-evaluated` as its own state precisely so an unread kernel
 * is not shown as up to date).
 */
function summarizeLoopKernel(record: Record<string, unknown>): QuayLoopKernel {
  const raw = record.loaded_version;
  const known = typeof raw === 'string' && QUAY_LOOP_VERSION_RELATIONS.includes(raw as QuayLoopVersionRelation);
  const relation: QuayLoopVersionRelation = known ? (raw as QuayLoopVersionRelation) : 'not-evaluated';

  const cliReason = typeof record.loaded_version_reason === 'string' && record.loaded_version_reason !== ''
    ? record.loaded_version_reason
    : null;
  const reason = relation !== 'not-evaluated'
    ? cliReason
    : cliReason ?? (typeof raw === 'string'
      ? `driver status reported loaded_version "${raw}", which is not one of ${QUAY_LOOP_VERSION_RELATIONS.join('/')}`
      : 'driver status carried no loaded_version reading');

  return {
    loaded: typeof record.loaded === 'string' ? record.loaded : null,
    installed: typeof record.installed === 'string' ? record.installed : null,
    relation,
    reason,
  };
}

/**
 * Projects the CLI's `pointer` segment. Absent/unreadable segment is `null` ("not reported");
 * an unrecognised `state` reads `not-evaluated` rather than being passed through or guessed.
 */
function summarizeLoopPointer(value: unknown): QuayLoopPointer | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const raw = record.state;
  const state: QuayLoopVersionRelation = typeof raw === 'string' && QUAY_LOOP_VERSION_RELATIONS.includes(raw as QuayLoopVersionRelation)
    ? (raw as QuayLoopVersionRelation)
    : 'not-evaluated';

  return {
    state,
    linkVersion: typeof record.link_version === 'string' ? record.link_version : null,
    coreVersion: typeof record.core_version === 'string' ? record.core_version : null,
  };
}

/**
 * Reads the orphan marker for the running kernel's version directory.
 *
 * `loaded_kernel` is a path taken from a CLI document, so it is treated as untrusted: a
 * relative path, any `..` segment, or a path that — lexically or after symlink resolution —
 * leaves the plugin cache is `not-evaluated`, and NO file is read. Only a path that sits at
 * `<cache>/<marketplace>/<plugin>/<version>/…` is a versioned plugin directory and can carry
 * a marker; anything else under the cache (or a scratch build outside it) is
 * `not-applicable`.
 *
 * The marker's content is the epoch-millisecond instant Claude Code wrote it. An empty or
 * non-numeric marker, or a read failure, is `not-evaluated`; an absent marker is `none`.
 */
async function readLoopOrphan(reader: QuayFileReader, loadedKernel: unknown): Promise<QuayLoopOrphan> {
  const notEvaluated = (): QuayLoopOrphan => ({ state: 'not-evaluated', markedAt: null, removeAfter: null });
  const notApplicable = (): QuayLoopOrphan => ({ state: 'not-applicable', markedAt: null, removeAfter: null });

  if (typeof loadedKernel !== 'string' || loadedKernel.trim() === '') {
    return notEvaluated();
  }
  // Reject escapes BEFORE normalisation, so `..` can never be folded away into a path that
  // appears to sit inside the cache.
  if (!path.isAbsolute(loadedKernel) || loadedKernel.split(/[\\/]+/).includes('..')) {
    return notEvaluated();
  }

  const cacheRoot = resolvePluginCacheRoot();
  const kernelPath = path.resolve(loadedKernel);
  if (!isPathInside(cacheRoot, kernelPath)) {
    return notApplicable();
  }

  const relativeSegments = path.relative(cacheRoot, kernelPath).split(path.sep).filter(Boolean);
  // `<marketplace>/<plugin>/<version>/<at least one path segment>` — anything shallower is
  // not a versioned plugin directory, so orphan marking cannot apply to it.
  if (relativeSegments.length < 4) {
    return notApplicable();
  }

  const versionDir = path.join(cacheRoot, relativeSegments[0], relativeSegments[1], relativeSegments[2]);
  // A version directory that resolves outside the cache is an escape even when the literal
  // path looks contained; refuse before touching any marker inside it.
  const realCacheRoot = resolveRealPathOrSelf(cacheRoot);
  if (!isPathInside(realCacheRoot, resolveRealPathOrSelf(versionDir))) {
    return notEvaluated();
  }

  const markerPath = path.join(versionDir, QUAY_PLUGIN_ORPHAN_MARKER);
  // The marker itself can be a symlink planted to point outside the cache, so resolve it and
  // re-check containment before reading (a missing marker resolves to itself and stays inside).
  if (!isPathInside(realCacheRoot, resolveRealPathOrSelf(markerPath))) {
    return notEvaluated();
  }

  const markerSize = await reader.size(markerPath);
  if (markerSize === null) {
    return { state: 'none', markedAt: null, removeAfter: null };
  }

  let markerText: string;
  try {
    markerText = await reader.readText(markerPath);
  } catch {
    return notEvaluated();
  }

  const trimmed = markerText.trim();
  if (!/^\d+$/.test(trimmed)) {
    return notEvaluated();
  }
  const markedAtMs = Number(trimmed);
  if (!Number.isSafeInteger(markedAtMs)) {
    return notEvaluated();
  }

  return {
    state: 'marked',
    markedAt: new Date(markedAtMs).toISOString(),
    removeAfter: new Date(markedAtMs + QUAY_PLUGIN_ORPHAN_RETENTION_MS).toISOString(),
  };
}

/**
 * Projects the loop's overall status from the SAME `driver status --kind worker --json`
 * document the snapshot's `driver` summary already parses (no extra subprocess), plus the
 * three tiny drain control files under `<project>/.quay/` and — only when the CLI named a
 * live kernel path in the plugin cache — its `.orphaned_at` marker.
 *
 * Returns `null` when the driver status read produced no record at all (failed or
 * unparseable), which the snapshot reports as "not reported" rather than inventing a
 * healthy-looking loop.
 */
export async function summarizeLoop(
  reader: QuayFileReader,
  nowMs: number,
  projectPath: string,
  driverStatus: unknown,
): Promise<QuayLoopStatus | null> {
  const record = asRecord(driverStatus);
  if (!record) {
    return null;
  }

  const quayDir = path.join(projectPath, '.quay');
  const [worker, promotion, quality] = await Promise.all([
    readDrainFlag(reader, path.join(quayDir, QUAY_LOOP_DRAIN_CONTROL_FILES.worker)),
    readDrainFlag(reader, path.join(quayDir, QUAY_LOOP_DRAIN_CONTROL_FILES.promotion)),
    readDrainFlag(reader, path.join(quayDir, QUAY_LOOP_DRAIN_CONTROL_FILES.quality)),
  ]);

  return {
    anchorPid: typeof record.anchor_pid === 'number' && Number.isFinite(record.anchor_pid) ? record.anchor_pid : null,
    kernel: summarizeLoopKernel(record),
    pointer: summarizeLoopPointer(record.pointer),
    drain: { worker, promotion, quality },
    orphan: await readLoopOrphan(reader, record.loaded_kernel),
    observedAt: new Date(nowMs).toISOString(),
  };
}

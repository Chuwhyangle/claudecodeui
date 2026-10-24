/**
 * The architecture-delta producer — one structural revision per project, at most hourly.
 *
 * A landing (develop moving) is the moment a project's structure can change, but the structural
 * reading itself is much more expensive than the project tile's board read: it loads every
 * ArchGuard scope index. So the producer is THROTTLED per project — a second trigger inside
 * `ARCHITECTURE_DELTA_REFRESH_MS` (one hour) answers the previous revision WITHOUT calling the
 * architecture service. The throttle is keyed on the previous revision's `attemptedAt`, so a
 * failed attempt also counts: a broken analysis is not retried in a tight loop.
 *
 * A FAILED SNAPSHOT IS A READING. A project without `.archguard`, an unreadable scope index or a
 * thrown reader all produce an `unevaluated` revision whose reason is the failure — the tile
 * must never look green because the reading could not be taken. The previous snapshot is kept in
 * the digest, so the next successful run still diffs against the last snapshot the reader saw.
 *
 * WHAT IT DOES NOT DECIDE. `diffArchitectureStructures` states facts (new cycles, new reverse or
 * cross-layer edges, growth); whether those facts are a regression is a semantic judgment this
 * producer refuses to make.
 *
 * Consumers: the observation composition (a landing-triggered refresh, once wired) and
 * `server/modules/observation/tests/architecture-delta.test.ts`.
 */
import type { ArchitectureStructureResult } from '@/modules/architecture/index.js';

import {
  ARCHITECTURE_SIZE_CALIBER,
  diffArchitectureStructures,
  readStructureSnapshot,
  type ArchitectureStructuralDiff,
} from './architecture-delta.js';
import { formatArchitectureUri } from './observation-uri.js';
import type { ObservedObject, ObservationStore } from './observation-store.js';

/** The producer name every architecture revision is stamped with. */
export const ARCHITECTURE_DELTA_PRODUCER = 'architecture-delta';

/** One hour: a project's structure is read at most this often, however many landings occur. */
export const ARCHITECTURE_DELTA_REFRESH_MS = 60 * 60 * 1000;

/**
 * The project the producer observes.
 *
 * `projectId` addresses the CloudCLI project the architecture service resolves to a root;
 * `fleetProjectId` is what the `cloudcli://architecture/<id>` URI (and therefore the wall) uses.
 * A project without a fleet id has no addressable tile and is skipped — the same rule the
 * project-truth producer applies to its unregistered projects.
 */
export type ArchitectureDeltaTarget = {
  readonly projectId: string;
  readonly fleetProjectId: string | null;
  /** The tile's title; defaults to the fleet project id. */
  readonly title?: string;
  /**
   * The session whose transcript the architecture tab can be opened from. The structural
   * snapshot itself is project-wide, but the tab's page is `/session/<id>/architecture`, so a
   * tile without one states that the tab cannot be opened instead of opening the wrong session.
   */
  readonly sessionId?: string | null;
};

/** What the producer needs from the world. Production binds `readStructure` to the service. */
export type ArchitectureDeltaProducerDeps = {
  /** The observation store every revision is written through. */
  store: ObservationStore;
  /**
   * The project-wide structural snapshot. REQUIRED because the architecture module already owns
   * the manifest/scope reads and its parse cache; this producer must not re-implement them.
   */
  readStructure: (projectId: string) => Promise<ArchitectureStructureResult>;
  /** The clock stamped onto the write and the throttle. Defaults to `Date.now`. */
  now?: () => number;
  /** The per-project throttle window. Defaults to {@link ARCHITECTURE_DELTA_REFRESH_MS}. */
  refreshMs?: number;
};

/** The producer's two verbs. */
export type ArchitectureDeltaProducer = {
  /**
   * Refreshes ONE project. Answers the previous revision when throttled, `null` when the project
   * has no fleet id or the store itself failed.
   */
  refreshProject(target: ArchitectureDeltaTarget): Promise<ObservedObject | null>;
  /** Refreshes every project sequentially, so a fan-out never becomes an analysis storm. */
  refreshAll(targets: readonly ArchitectureDeltaTarget[]): Promise<ObservedObject[]>;
};

/** The digest's persisted shape — what the wall and the preview read back. */
type ArchitectureDeltaDigest = {
  /** When this reading was attempted (also the throttle key). */
  attemptedAt: number;
  /** When ArchGuard produced the analysis behind it. */
  analysisGeneratedAt: string | null;
  snapshotId: string;
  snapshot: ReturnType<typeof readStructureSnapshot>;
  diff: ArchitectureStructuralDiff | null;
  /** The same sentences as `deltaItems`, kept where the tile preview looks for them. */
  diffs: string[];
  sizeCaliber: typeof ARCHITECTURE_SIZE_CALIBER;
  /** The session the tab opens from; only present when the caller supplied one. */
  sessionId?: string;
  /** Set only on the `unevaluated` reading. */
  error?: string;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The previous attempt instant a throttle may key on, or null when there is none. */
function readAttemptedAt(digest: Record<string, unknown> | undefined): number | null {
  if (digest === undefined) return null;
  const value = digest.attemptedAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds the producer over its injected world. */
export function createArchitectureDeltaProducer(
  deps: ArchitectureDeltaProducerDeps,
): ArchitectureDeltaProducer {
  const now = deps.now ?? (() => Date.now());
  const refreshMs = deps.refreshMs ?? ARCHITECTURE_DELTA_REFRESH_MS;

  /**
   * The store is the only thing whose failure has nowhere to be recorded: the next refresh
   * retries (the throttle key never landed), so the reading is simply not lost as an exception.
   */
  const writeSafely = (
    input: Parameters<ObservationStore['writeRevision']>[0],
  ): ObservedObject | null => {
    try {
      return deps.store.writeRevision(input);
    } catch {
      return null;
    }
  };

  const refreshProject = async (target: ArchitectureDeltaTarget): Promise<ObservedObject | null> => {
    const fleetProjectId = target.fleetProjectId?.trim() ?? '';
    // No fleet id ⇒ no `cloudcli://architecture/<id>` address ⇒ nowhere the wall could show it.
    if (fleetProjectId === '') return null;

    const uri = formatArchitectureUri(fleetProjectId);
    const title = (target.title ?? '').trim() || fleetProjectId;
    const sessionId = (target.sessionId ?? '').trim();
    const previousObject = deps.store.getObject(uri);
    const attemptedAt = readAttemptedAt(previousObject?.digest);
    const at = now();

    // Throttled: the previous revision IS this trigger's answer, and the architecture service is
    // not called at all. This is what "同一项目一小时内至多一次" means mechanically.
    if (previousObject !== null && attemptedAt !== null && at - attemptedAt < refreshMs) {
      return previousObject;
    }

    const previousSnapshot = readStructureSnapshot(previousObject?.digest.snapshot);

    let result: ArchitectureStructureResult;
    try {
      result = await deps.readStructure(target.projectId);
    } catch (error) {
      const reason = `结构快照生成失败：${errorMessage(error)}`;
      return writeSafely({
        uri,
        kind: 'architecture',
        title,
        status: { state: 'unevaluated', reason },
        digest: {
          attemptedAt: at,
          analysisGeneratedAt: null,
          snapshotId: previousSnapshot?.id ?? '',
          snapshot: previousSnapshot,
          diff: null,
          diffs: [reason],
          sizeCaliber: ARCHITECTURE_SIZE_CALIBER,
          ...(sessionId === '' ? {} : { sessionId }),
          error: reason,
        } satisfies ArchitectureDeltaDigest,
        deltaItems: [reason],
        provenance: {
          producer: ARCHITECTURE_DELTA_PRODUCER,
          tier: 'deterministic',
          evaluatedAt: at,
        },
      });
    }

    const snapshot = result.snapshot;
    const diff = diffArchitectureStructures(previousSnapshot, snapshot);
    return writeSafely({
      uri,
      kind: 'architecture',
      title,
      // A structural change is a FACT, not a verdict: the state stays `ok` and every judgment is
      // left to the delta sentences and their reader.
      status: { state: 'ok' },
      digest: {
        attemptedAt: at,
        analysisGeneratedAt: result.provenance.generatedAt,
        snapshotId: snapshot.id,
        snapshot,
        diff,
        diffs: [...diff.deltaItems],
        ...(sessionId === '' ? {} : { sessionId }),
        // `sizeCaliber` (and the whole diff document) rides in with `...diff` below.
        ...diff,
      } satisfies ArchitectureDeltaDigest,
      deltaItems: [...diff.deltaItems],
      provenance: {
        producer: ARCHITECTURE_DELTA_PRODUCER,
        tier: 'deterministic',
        evaluatedAt: at,
      },
    });
  };

  return {
    refreshProject,
    async refreshAll(targets) {
      const written: ObservedObject[] = [];
      for (const target of targets) {
        const object = await refreshProject(target);
        if (object !== null) written.push(object);
      }
      return written;
    },
  };
}

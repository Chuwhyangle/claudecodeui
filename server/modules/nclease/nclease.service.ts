/**
 * Reads the NC lease ledger through the `ncres` CLI.
 *
 * The ledger is the single source of truth; this module never invents a
 * healthy reading. When the CLI is missing or the ledger is unreadable the
 * answer is `degraded: true` with the reason, so the panel shows a banner
 * instead of an empty "everything is free" table.
 *
 * Consumers: `server/modules/nclease/nclease.routes.ts` (both commands) and the
 * module's route criterion, which injects fakes instead of shelling out.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { NcLease, NcLeaseProbe, NcLeaseStatus } from '@/shared/types.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 5000;

/**
 * The `ncres` executable: `NCRES_BIN` when the deployment sets one, otherwise the
 * name on `PATH`.
 *
 * Read per call rather than captured at module load so a deployment (or a test)
 * that sets `NCRES_BIN` after this module was imported still gets its binary. No
 * personal home-directory path is baked in: the server runs wherever it is
 * deployed, and the ledger CLI is a machine-local prerequisite.
 */
function resolveNcresBin(): string {
  return process.env.NCRES_BIN || 'ncres';
}

/**
 * How long a lease may go without a heartbeat before the panel offers a release
 * button. Below this the holder is presumably still working, and a click would
 * silently take the instance away from it.
 *
 * Mirrored by the sidebar panel, which hides the button on the same reading
 * rather than sending a request the server would refuse.
 */
export const RELEASE_GRACE_SECONDS = 30 * 60;

export type ReleaseVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether the panel may release this lease.
 *
 * The browser has no stable `ncres` owner identity, so a release from here is
 * always a forced one. To keep that from becoming a one-click takeover it is
 * limited to leases that look abandoned: the heartbeat is older than the grace
 * window or past the TTL, or the container is no longer running.
 */
export function isReleasable(
  lease: NcLease | null | undefined,
  probe: NcLeaseProbe | null | undefined,
): ReleaseVerdict {
  if (!lease) return { ok: false, reason: '该槽当前没有租约' };
  if (probe && probe.state !== 'running') return { ok: true };
  if (lease.stale) return { ok: true };
  if (lease.heartbeat_age_s >= RELEASE_GRACE_SECONDS) return { ok: true };
  return {
    ok: false,
    reason: `租约心跳正常（${lease.heartbeat_age_s}s），请让持有者在 CLI 执行 ncres release`,
  };
}

function degraded(reason: string): NcLeaseStatus {
  return {
    ts: new Date().toISOString(),
    degraded: true,
    instances: [],
    free: [],
    errors: [reason],
  };
}

/** One full reading of the three slots with docker probed. */
export async function readNcLeaseStatus(): Promise<NcLeaseStatus> {
  try {
    const { stdout } = await execFileAsync(resolveNcresBin(), ['status', '--json'], {
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as NcLeaseStatus;
    if (!Array.isArray(parsed.instances)) return degraded('ncres status returned no instances');
    return parsed;
  } catch (error) {
    return degraded(error instanceof Error ? error.message : String(error));
  }
}

export type ReleaseLeaseInput = {
  slot: string;
  outcome?: 'ok' | 'failed' | 'abandoned';
  note?: string;
};

export type ReleaseLeaseResult = {
  ok: boolean;
  leaseId?: string;
  slot?: string;
  error?: string;
};

/**
 * Releases a slot from the panel.
 *
 * The panel acts as a human, so it passes `--force`: the CLI only compares an
 * owner string, and a browser session has no stable one. The release is still
 * recorded in the ledger and the event log with the note the operator typed.
 */
export async function releaseNcLease(input: ReleaseLeaseInput): Promise<ReleaseLeaseResult> {
  const args = ['release', input.slot, '--force', '--outcome', input.outcome || 'ok'];
  if (input.note) args.push('--note', input.note);
  try {
    const { stdout } = await execFileAsync(resolveNcresBin(), args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { lease_id?: string; slot?: string };
    return { ok: true, leaseId: parsed.lease_id, slot: parsed.slot };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

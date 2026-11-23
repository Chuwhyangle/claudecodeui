/**
 * The NC-lease wire types, a type-only leaf directly under `src/shared`.
 *
 * WHY NOT `src/shared/types.ts`: that file is an oversize-ratchet baseline entry
 * that may only shrink, and the nclease surface is a new wire shape rather than
 * an addition to an existing one — the same reason `src/shared/replySuggestionsType.ts`
 * sits here. Nothing imports these through `@/shared/types`, so no re-export is
 * needed; every consumer names this leaf directly.
 *
 * Consumers: `src/shared/api/clientTail.ts` (the two endpoints), the sidebar's
 * NC-lease indicator and its controller, and `src/shared/tests/wireContractTypeSync.test.ts`
 * (the two-end pin against `server/shared/types/nclease.ts`).
 */

//----------------- NC LEASE LEDGER (sidebar occupancy row) ------------

/**
 * Docker's reading of one NC container, as `ncres status --json` reports it.
 *
 * `state` is `running`, `exited`, `missing` or `unknown`; the sidebar row must
 * show the last two as "stopped/unknown" rather than treating them as free.
 * Mirrors the server's copy in `server/shared/types/nclease.ts` (pinned by
 * `wireContractTypeSync.test.ts`).
 */
export type NcLeaseProbe = {
  container: string | null;
  port: number | null;
  state: string;
  health: string | null;
  uptime_s: number | null;
  image_id: string | null;
  error: string | null;
};

/** One active lease on a slot; `stale` means the heartbeat is older than its TTL. */
export type NcLease = {
  lease_id: string;
  who: string;
  purpose: string;
  phase: string | null;
  state: string;
  since: string | null;
  expires_at: string | null;
  ttl_s: number;
  heartbeat_age_s: number;
  stale: boolean;
  branch: string | null;
  topic: string | null;
  base_sha: string | null;
  out_dir: string | null;
  contract_path: string | null;
  image_id: string | null;
  note: string | null;
  probe_state: string | null;
};

/** One row of `ncres status --json`: slot identity, live probe, lease and code version. */
export type NcLeaseInstance = {
  id: 'nc1' | 'nc2' | 'nc3';
  container: string;
  port: number;
  tier: 'dev' | 'delivery';
  out_dir: string;
  db: string;
  probe: NcLeaseProbe;
  lease: NcLease | null;
  /** `<out_dir>/BUILD-INFO.json`, absent until a build stamps the slot. */
  build: NcBuild | null;
  build_state: NcBuildState;
};

/** The version stamp a compile/CI run leaves in the slot's output directory. */
export type NcBuild = {
  sha: string;
  short?: string;
  branch?: string;
  built_at?: string | null;
  source?: 'local' | 'ci' | 'manual';
  note?: string | null;
};

/**
 * How the slot's stamped build compares with the newest `pre` commit:
 * `aligned` = same commit, `behind` = ancestor by N commits,
 * `diverged` = not in pre's history, `unmarked` = no stamp.
 */
export type NcBuildState = {
  state: 'aligned' | 'behind' | 'diverged' | 'unmarked' | 'no-pre-head';
  sha?: string;
  head?: string;
  behind?: number;
  built_at?: string | null;
  head_fetched_at?: string | null;
};

/** The whole `GET /api/nclease/status` body; a degraded reading never claims the slots are free. */
export type NcLeaseStatus = {
  ts: string | null;
  degraded: boolean;
  instances: NcLeaseInstance[];
  free: string[];
  errors: string[];
};

/** What `POST /api/nclease/release` accepts; the server validates the slot and outcome. */
export type NcReleaseRequest = {
  slot: 'nc1' | 'nc2' | 'nc3';
  outcome?: 'ok' | 'failed' | 'abandoned';
  note?: string;
};

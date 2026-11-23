//----------------- NC LEASE LEDGER (the sidebar's NC-1/2/3 occupancy row) ------------

/**
 * Docker's reading of one NC container, as `ncres status --json` reports it.
 *
 * `state` is `running`, `exited`, `missing` or `unknown`; the panel must show the
 * last two rather than treating them as free.
 *
 * Consumers: `server/modules/nclease/nclease.service.ts` (the reading it returns
 * verbatim) and the `wireContractTypeSync` criterion, which mirrors it against the
 * browser's copy in `src/shared/types.ts`.
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

/**
 * One active lease on a slot. `stale` means the heartbeat is older than the TTL,
 * which is a warning rather than an automatic reclaim — the CLI keeps the lease
 * until a human or the holder releases it.
 *
 * Consumer: `server/modules/nclease/nclease.service.ts` (`isReleasable` reads
 * `stale` and `heartbeat_age_s` to decide whether the panel may force a release).
 */
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

/**
 * One row of `ncres status --json`: slot identity, live probe, lease and code version.
 *
 * Consumer: `server/modules/nclease/nclease.routes.ts`, which looks a slot up by
 * `id` before allowing a release, and the wire-type sync criterion.
 */
export type NcLeaseInstance = {
  id: string;
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
 * How the slot's stamped build compares with the newest `pre` commit.
 *
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

/**
 * The whole `GET /api/nclease/status` body. A degraded reading carries the reason
 * and an empty instance list; it never claims the slots are free.
 *
 * Consumer: `server/modules/nclease/nclease.routes.ts` (answered verbatim) and the
 * browser's copy in `src/shared/types.ts`.
 */
export type NcLeaseStatus = {
  ts: string | null;
  degraded: boolean;
  instances: NcLeaseInstance[];
  free: string[];
  errors: string[];
};

/**
 * What `POST /api/nclease/release` accepts; the route validates the slot and outcome.
 *
 * Consumer: `server/modules/nclease/nclease.routes.ts` (`parseRelease`) and the
 * browser's API client.
 */
export type NcReleaseRequest = {
  slot: 'nc1' | 'nc2' | 'nc3';
  outcome?: 'ok' | 'failed' | 'abandoned';
  note?: string;
};

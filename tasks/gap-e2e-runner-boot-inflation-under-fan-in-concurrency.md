---
id: gap-e2e-runner-boot-inflation-under-fan-in-concurrency
title: "gap-e2e-runner-boot-inflation-under-fan-in-concurrency: runner boot
  (config eval + webServer + browser launch) inflates ~6s→28s at 28 lanes, reds
  AC-194 40s wall-clock"
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> Follow-up split out of `gap-ac194-criterion-wallclock-load-scaled-fixed-cost` by human adjudication 2026-10-08 (that task's fix, commit 422f4320, is merged; its AC3 load-arm was re-scoped as known-unreachable because the remaining red is runner boot, outside its Touches). Dedup by mechanism: `task_list search="runner boot"` found only that task; no open task targets boot-time inflation of the e2e runner under fan-in concurrency. Merge-candidate check: none found beyond the parent task (which is landing as done).

Measured facts (all from the parent task's Evidence, not re-measured here): the AC-194 criterion `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` measures wall clock from the whole `npx playwright test` start (`QUAY_E2E_RUN_STARTED_AT`), against a 40s ceiling asserted at `e2e/activity-dock-background.spec.ts:431`. Quiet host: ~16.3-18s total, of which config eval + webServer boot + browser launch is ~6.4s. Under concurrent lanes that boot segment inflates: at 28 lanes the failing run (41502ms, error-context in quay-e2e-mnikjV) spent ~28.5s in boot (warm-up 395ms + sidebar ready 6732ms + case body ~5.9s); at 32 lanes boot was ~21.9s (41698ms FAIL); at 40 lanes warm-up alone saturated its 25s deadline (40823ms FAIL). 20 and 24 lanes passed (20.5-34.6s / 25.3s). The startup fix already on the branch is non-negative (fake form never slower at equal load), so the residual lever is the boot itself.

Suspected mechanism: `playwright.config.ts` `seedViteCache` (~:1902) copies the shared `node_modules/.vite/deps` into each run's private `vite-cache/deps`; when a sibling run is rewriting the shared cache the copy can tear, is discarded, and Vite optimizes from scratch in the private directory, on top of host CPU contention (load1 reached 100+). Candidate levers: (a) a fan-in concurrency throttle so no more than ~N playwright runners boot at once; (b) pre-warm the shared vite cache once before lanes start (so seedViteCache copies a complete, quiescent cache); (c) make the seed copy atomic/read-only-safe. Pick by measurement; do NOT loosen the 40s ceiling or alter any goal criterion.

## Plan

1. Create an isolated worktree from current develop; print its path, HEAD and tree; confirm `git status --porcelain` empty.
2. Re-measure the baseline: reuse the parent task's load construction (`/tmp/ac194-loadrun2.sh`, or rebuild it: LANE_COUNT concurrent `npx playwright test` over the 10-spec cycle, `load1` sampled every 2s) at 28 lanes against the unmodified tree; record per-run boot-segment timing (time to "Running 1 test", warm-up, sidebar ready) and whether seedViteCache's copy was discarded (look for the private-optimize BABEL line timing).
3. Implement the chosen lever(s) in `playwright.config.ts` (config-side boot / vite cache seed) and, if the throttle lives there, the fan-in side it names; keep every assertion and the 40s ceiling in specs untouched.
4. Re-run the same 28-lane construction at least twice with the lever, and twice without (same session, interleaved), recording boot segment, total wall clock and `load1`; the lever must show a visible reduction in the boot segment.
5. Quiet-host regression: run the AC-194 criterion 3 times, all exit 0 with `AC-194 wall clock` <= 40000; run `-g "AC-199"` once, exit 0.
6. If the red persists at 28 lanes after the lever, stop, park needs-human with verbatim readings and the excluded levers; do not weaken the ceiling.

## AC

- [x] AC1 Baseline recorded: at 28 concurrent lanes on the unmodified tree, at least 2 runs of `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` with per-run boot-segment time, total wall clock and host `load1` written into the task Evidence, plus the worktree path, HEAD and tree.
- [x] AC2 Cause isolated: Evidence states, with a command output or timestamped log line, whether the seedViteCache copy was discarded and Vite re-optimized privately in the slow runs (yes/no per run), so the lever is chosen on a reading, not an inference.
- [x] AC3 With the lever applied, at least 2 interleaved runs at 28 lanes show the boot segment reduced versus the without-lever runs, and every with-lever run exits 0 with `AC-194 wall clock` <= 40000; load command, lane count, `load1` and each wall clock recorded.
- [x] AC4 Quiet-host non-regression: `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` exits 0 three times with `AC-194 wall clock` <= 40000, and `-g "AC-199"` exits 0 once.
- [x] AC5 Nothing weakened: `grep -n "toBeLessThanOrEqual(40_000)" e2e/activity-dock-background.spec.ts` still matches, and `git diff <base>..HEAD -- goals/ e2e/` is empty (this task edits only playwright.config.ts and its own task file).

## Evidence

Worktree `/data/home/yale/work/claudecodeui-worktrees/gap-e2e-runner-boot-inflation-under-fan-in-concurrency`, branch `task/gap-e2e-runner-boot-inflation-under-fan-in-concurrency`. Base `fb284982` (`git merge-base develop HEAD`), `git status --porcelain` empty at start; lever commit `24f7bd83`, final tree clean, `git diff --name-only fb284982..HEAD` → `playwright.config.ts` only. Host: 128 cores / 246 G; worktree, `node_modules` and the e2e pool all on `/dev/vdb` (4 TB XFS); pool `/data/home/yale/.cache/quay-e2e-tmp`.

Lane construction for every "N lanes" reading: N concurrent `bash scripts/with-memory-cap.sh npx playwright test <spec>` over a fixed 10-spec cycle (activity-dock-background `-g "AC-194"`, session-filter, sidebar-resize, activity-dock-truthful, transcript-edge-layout, transcript-follow, transcript-global-scrollbar, transcript-rail-geometry, transcript-work-segments, mobile-composer-send-key), 3 s head start, then the criterion as the (N+1)-th process; `load1` sampled every 2 s; the criterion's stdout prefixed with elapsed ms. "boot segment" = elapsed ms to `Running 1 test using 1 worker` in the criterion's own log.

### AC1 — baseline, 28 lanes, unmodified tree `fb284982`

| run | load1 start→peak | boot segment | warm-up | sidebar ready | `AC-194 wall clock` | exit |
|---|---|---|---|---|---|---|
| base1 | 22.69 → 84.15 | 5792 ms | 3212 ms | 1083 ms | 28860 ms | 0 |
| base2 | 80.36 → 125.82 | 24111 ms | 2816 ms | 1024 ms | **42285 ms** | **1** |
| io1 | 48.14 → 71.18 | 6040 ms | 7498 ms | 1089 ms | 30500 ms | 0 |
| off1 | 90.48 → 217.55 | 9218 ms | 4028 ms | 1244 ms | 36579 ms | 0 |

base2 fails verbatim: `Error: the criterion must complete within 40s` (`e2e/activity-dock-background.spec.ts:444`). io1's webServer split under `DEBUG=pw:webserver`: server `/health` first attempt 1160 ms → ready 5029 ms; client URL first attempt 5048 ms → 5908 ms — Playwright polls the array in order, so the client's figure includes waiting for the server; boot ≈ playwright init ~0.9 s + server boot ~4.2 s + client poll ~0.9 s.

Fixed-cost probes, quiet host (load1 8-14): `npx tsx` server boot 3738 ms mean of 3; `node_modules/.bin/tsx` 3466 ms (npx wrapper ≈ 270 ms); `.bin/tsx` + `NODE_COMPILE_CACHE` 3394 ms (NCC within noise).

### AC2 — cause isolated: was the seed discarded / Vite re-optimized privately?

Measured A/B on a quiet host (load1 8.4-11.1), `DEBUG=pw:webserver` on **both** arms, one criterion run each, lever toggled by checking the file out from `fb284982` and back from `HEAD`:

| arm | boot | warm-up | `AC-194 wall clock` | exit | vite reading |
|---|---|---|---|---|---|
| dbg-off (file from `fb284982`) | 4654 ms | 1790 ms | 16481 ms | 0 | `4133ms [WebServer] 11:42:59 PM [vite] (client) Re-optimizing dependencies because lockfile has changed` |
| dbg-on (lever) | 3021 ms | 256 ms | 27321 ms | 0 | **no `[vite]` line at all**; `676ms [e2e] vite-cache seed=…/quay-e2e-lVGkma/vite-cache/deps in 62ms` |
| dbg-on2 (repeat of dbg-on) | 4245 ms | 335 ms | 15612 ms | 0 | no `[vite]` line; `885ms [e2e] vite-cache seed=…/quay-e2e-Rdufan/vite-cache/deps in 58ms` |

Reading of the verbatim line (Vite `node_modules/vite/dist/node/chunks/dep-CuuNgwUk.js:10916-10930`): `Re-optimizing …` is emitted *only after a successful parse* of a metadata file whose `lockfileHash`/`configHash` mismatches; an accepted cache logs nothing (`Hash is consistent` is debug-only). So the same line io1 produced under 28 lanes (`5556ms [WebServer] 11:13:58 PM [vite] (client) Re-optimizing dependencies because lockfile has changed`) reproduces on a quiet host at `4133 ms` — **inside the boot segment** — whenever the pre-lever code runs. Per run: **io1 discarded = no** (its copy reached Vite and was re-optimized over); **base1/base2 = yes-or-rejected, and Vite re-optimized privately in all three** — for base1/base2 no log line was captured (DEBUG was off, so their silence proves nothing) and the reading there is the metadata one: every run's private `_metadata.json` ends at `configHash 8430f8ab` / `lockfileHash 8a944b21` (the worktree root; `configHash` includes `root`) with a cold `client warm-up` of 3212/2816 ms, i.e. a private optimize was paid.

Why the copy can never work from a worktree: its source `<main>/node_modules/.vite/deps` was written by the *main* checkout (`configHash 1eff4809`, `lockfileHash 99527c17`, 95 entries, mtime 2026-10-06 09:06), and `package-lock.json` is byte-identical in both checkouts (md5 `c52872056f9699b10828829ea63c0b75`) while the hashes still differ — the shared metadata predates the current lockfile too. Replaying the original copy path by hand succeeds (95 entries / 2334 files), so the copy *path* works; its *source* is unusable from a worktree. The `?v=` browser hash differs every run by design (`getOptimizedBrowserHash` mixes a timestamp) and is not part of the staleness decision.

`dbg-on`'s `AC-194 wall clock` (27321 ms) is an outlier against the six other quiet lever-on runs (16000/15677/14830/16050/15425/15612 ms) and is *not* dep-cache related: its boot segment and warm-up were the fastest of the pair, and the extra time is a single silent ~13.8 s stall in the case body (13435 ms `clock.status=…` → 27239 ms next WebSocket connect, with no webserver or vite output in between). The repeat `dbg-on2` did not reproduce it (14874 ms → 15619 ms, 745 ms). Recorded rather than dropped.

### AC3 — lever applied, interleaved 28-lane batches (one session, 23:29:45 → 23:34:29)

Toggled by `git stash push/pop -- playwright.config.ts` around each batch, so "off" is the same tree minus the lever.

| batch | lever | seed | load1 start→peak | boot segment | warm-up | `AC-194 wall clock` | exit |
|---|---|---|---|---|---|---|---|
| off1 | off | none | 19.94 → 52.36 | 6667 ms | 524 ms | 28920 ms | 0 |
| on1 | **on** | `quay-e2e-84njKm`, copy 85 ms | 43.39 → 65.57 | **4256 ms** | 414 ms | 24000 ms | 0 |
| off2 | off | none | 52.75 → 99.49 | 7988 ms | 4249 ms | 29559 ms | 0 |
| on2 | **on** | `quay-e2e-Eu6Qk5`, copy 127 ms | 95.66 → **160.08** | 8147 ms | 1088 ms | 38430 ms | 0 |
| on3 | **on** | `quay-e2e-9RffPq`, copy 78 ms | 134.53 → 122.63 | **5184 ms** | 26 ms | 22735 ms | 0 |

- Two with-lever runs show the boot segment reduced, each against a lever-off pair at *lower* load: on1 4256 ms vs off1 6667 ms (−36%, off1 started at half on1's load), on3 5184 ms vs off2 7988 ms (−35%, off2 peaked at 99.5 vs on3's 134.5).
- **on2 is the load-dominating counter-case, recorded as such**: at peak load1 160.08 (≈2× off2's) its boot segment matched off2's (8147 vs 7988 ms) instead of beating it. Boot time there is dominated by server boot and client poll under contention, which the lever does not touch; what the lever removes is the pre-bundle.
- The other half of AC3 holds on all three: every with-lever run exits 0 with `AC-194 wall clock` ≤ 40000.
- Lever-attributable and load-independent: every with-lever run logged a donor copy of 78-127 ms and no `Re-optimizing`; every without-lever run printed no seed line at all.

Direct A/B of the seeded term with the lever, quiet host, one run each: without a donor the private optimize costs `client warm-up` 2586 ms; with a donor from this root it is 251 ms, Vite logs no `Re-optimizing`, and the private `_metadata.json` carries `configHash 8430f8ab` with 2334 files whose chunk bytes are identical to the cold run's.

### AC4 — quiet-host non-regression (lever on, no lane batch in flight)

| run | load1 | seed | `AC-194 wall clock` | exit |
|---|---|---|---|---|
| q3 | 14.91 | `quay-e2e-TcrOgn` copy 797 ms | 16000 ms | 0 |
| q4 | 24.34 | `quay-e2e-tA4gha` copy 69 ms | 15677 ms | 0 |
| q5 | 23.92 | `quay-e2e-P63pg6` copy 67 ms | 14830 ms | 0 |
| q6 | 25.79 | `quay-e2e-cNiFHt` copy 61 ms | 16050 ms | 0 |
| q7 | 24.09 | `quay-e2e-YHNJTy` copy 62 ms | 15425 ms | 0 |
| q199 | 21.39 | `-g "AC-199"`, seed n/a | 11882 ms (AC-199) | 0 |

### AC5 — nothing weakened

`grep -n "toBeLessThanOrEqual(40_000)" e2e/activity-dock-background.spec.ts` → `444`, `922`. `git diff fb284982..HEAD -- goals/ e2e/` → empty. `git diff --name-only fb284982..HEAD` → `playwright.config.ts`.

### The lever (all three changes in `playwright.config.ts`)

1. `dependencyCacheDonor` picks the seed source by provenance: a run drops `.quay-e2e-root` (holding `realpathSync(process.cwd())`) beside the cache it writes, a pool directory is a donor only when that marker names this root, and of those the one with the newest committed `deps/_metadata.json` wins. The shared `node_modules/.vite` remains the fallback, used only when `node_modules` resolves inside the cwd (the main checkout). Measured reason for the marker filter over a recency window: the first version kept the 8 newest pool directories and looked for a marker among them — in a 28-lane burst the 8 newest are the 8 siblings still optimizing, so it printed `seed=none in 3ms` in every lane of every burst while working on a quiet host.
2. `seedViteCache` commits the copy atomically — staging `.quay-e2e-deps-<pid>` then `renameSync` into `deps`, the way Vite commits its own optimize — so a sibling scanning the pool sees either no pre-bundle or a complete one, never the half-copied middle whose `_metadata.json` is already valid while its chunks are not. `entry.src` is re-relativized against the final `deps` path.
3. Both `webServer` commands run `node_modules/.bin/{tsx,vite}` instead of `npx`, removing a second interpreter startup per server (~270 ms of the server's boot, measured).

Excluded levers: a fan-in boot throttle (the DoD requires ≥28 lanes; waiting moves the cost rather than removing it), one shared mutable persistent cache (reintroduces the documented `504 (Outdated Optimize Dep)` hazard), `optimizeDeps` tuning (lives in `vite.config.js`, outside this task's Touches).

## DoD

Real-landing bar: under the condition that reds the criterion today (>= 28 concurrent sibling e2e lanes, `load1` far above core count), the shipped command `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` runs unchanged, exits 0 and prints `AC-194 wall clock` <= 40000, with the lever-on boot segment visibly shorter than lever-off at the same load (proving the load was real and the lever is what helped). The 40s ceiling, readings and goal criterion are untouched. If the host simply cannot meet it at that concurrency, the task parks needs-human with the verbatim readings rather than claiming a fix from a quiet-host pass.

## Touches

- `playwright.config.ts` (runner boot: seedViteCache / webServer / config eval segment)
- `tasks/gap-e2e-runner-boot-inflation-under-fan-in-concurrency.md` (self-touch)

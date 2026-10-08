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

- [ ] AC1 Baseline recorded: at 28 concurrent lanes on the unmodified tree, at least 2 runs of `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` with per-run boot-segment time, total wall clock and host `load1` written into the task Evidence, plus the worktree path, HEAD and tree.
- [ ] AC2 Cause isolated: Evidence states, with a command output or timestamped log line, whether the seedViteCache copy was discarded and Vite re-optimized privately in the slow runs (yes/no per run), so the lever is chosen on a reading, not an inference.
- [ ] AC3 With the lever applied, at least 2 interleaved runs at 28 lanes show the boot segment reduced versus the without-lever runs, and every with-lever run exits 0 with `AC-194 wall clock` <= 40000; load command, lane count, `load1` and each wall clock recorded.
- [ ] AC4 Quiet-host non-regression: `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` exits 0 three times with `AC-194 wall clock` <= 40000, and `-g "AC-199"` exits 0 once.
- [ ] AC5 Nothing weakened: `grep -n "toBeLessThanOrEqual(40_000)" e2e/activity-dock-background.spec.ts` still matches, and `git diff <base>..HEAD -- goals/ e2e/` is empty (this task edits only playwright.config.ts and its own task file).

## DoD

Real-landing bar: under the condition that reds the criterion today (>= 28 concurrent sibling e2e lanes, `load1` far above core count), the shipped command `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` runs unchanged, exits 0 and prints `AC-194 wall clock` <= 40000, with the lever-on boot segment visibly shorter than lever-off at the same load (proving the load was real and the lever is what helped). The 40s ceiling, readings and goal criterion are untouched. If the host simply cannot meet it at that concurrency, the task parks needs-human with the verbatim readings rather than claiming a fix from a quiet-host pass.

## Touches

- `playwright.config.ts` (runner boot: seedViteCache / webServer / config eval segment)
- `tasks/gap-e2e-runner-boot-inflation-under-fan-in-concurrency.md` (self-touch)

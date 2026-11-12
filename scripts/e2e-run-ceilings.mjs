/**
 * The arithmetic behind `playwright.config.ts`'s run watchdog, and the control arm that makes its one
 * timing defect reproducible without waiting for a host load spike.
 *
 * WHY THIS IS A MODULE AND NOT FOUR INLINE EXPRESSIONS. The watchdog has two ceilings measured from two
 * different origins, and the origin of each is the whole of its meaning:
 *
 *   · the BOOT ceiling bounds the unbounded pre-spawn availability probe over the `webServer` urls;
 *   · the RUN ceiling bounds the whole `npx playwright test` invocation.
 *
 * Until 2026-10-29 both were measured from `runStartedAt` — the first line of the config module. That is
 * right for the run ceiling and wrong for the boot ceiling: config evaluation itself is a long
 * *synchronous* block (Vite dep-cache seed, a real client-root copy, a hash-plus-esbuild server bundle),
 * and a JS timer cannot fire while it runs. The boot deadline therefore expired *inside* config
 * evaluation and fired with a 0ms delay the moment the event loop was free again — before Playwright had
 * spawned a single webServer. `describeStall()` then read two closed ports and recorded the run as
 * `stage: "webServer-start"`, which is the class the boot ceiling exists to catch, for a run that had not
 * begun booting. Gate event `9d08ccd0-c886-4e58-b750-ea2f2eeb7ede` (2026-10-29T07:24:21Z) is that exact
 * signature: `boot ceiling crossed at 56826ms`, `port 20689 (server) is not listening, port 3471 (client)
 * is not listening`, after the same tree had passed six times in a row at lower host load.
 *
 * The fix is the origin, not the number: `bootDeadlineFrom(configEvalCompletedAt, …)` starts the boot
 * window where config evaluation ends. Raising `BOOT_CEILING_MS` past 40s instead would cross the 60s
 * the goal gate kills at, and a larger load spike would still break it — the pointer was wrong, not the
 * size. Keeping the run ceiling on `runStartedAt` (`runDeadlineFrom`) is deliberate: it is a bound on
 * the whole invocation, config evaluation included, and the 60s kill bounds exactly that span.
 *
 * `QUAY_E2E_CONFIG_EVAL_STALL_MS` is the control arm: a synchronous `Atomics.wait` injected after the
 * seeds and before the client-root copy / server bundle, so "config evaluation is slower than the 40s
 * boot ceiling" can be produced on demand instead of inferred from host load. Default 0, clamped to
 * 120000, and only ever waited on by the data-directory owner — a Playwright worker re-evaluates the
 * config with `QUAY_E2E_DATA_DIR_OWNER=false` and must not pay the stall a second time. It is a test
 * control, not a product behaviour; it is documented beside `QUAY_E2E_CLIENT_ROOT=off`, the file's other
 * control arm.
 */

/** Environment variable naming the config-evaluation stall, in milliseconds. */
export const CONFIG_EVAL_STALL_ENV = 'QUAY_E2E_CONFIG_EVAL_STALL_MS';

/** Upper bound of the control arm. Above the 40s boot ceiling by 3x, and under the gate's 60s kill only as a bound to clamp to — not a value a criterion runs at. */
export const CONFIG_EVAL_STALL_MAX_MS = 120_000;

/**
 * The single-file ceiling `playwright.config.ts` derives when a spec declares no budget of its own.
 *
 * Kept here as the pivot of `bootCeilingFor`: the boot window is the shipped 40s for every selection whose
 * run ceiling is at or below this value, and only grows for selections that declared a larger budget. It is
 * the same number the config keeps as `SINGLE_SPEC_CEILING_MS`; passing it in would spread one invariant
 * across two files, so the function names it once.
 */
export const SINGLE_SPEC_CEILING_MS = 55_000;

/** The boot window for the default selection — the shipped 40s, byte-for-byte. */
export const DEFAULT_BOOT_CEILING_MS = 40_000;

/** The boot window never grows past this, however large the declared run budget is. */
export const MAX_BOOT_CEILING_MS = 120_000;

/**
 * How far the boot window must stay inside the run ceiling.
 *
 * Load-bearing rather than cosmetic: the watchdog writes its crossing line and `watchdog-state.json` as it
 * ends the run, and a boot window that reached the run ceiling would let the gate's SIGKILL land first — the
 * exact "crossing that is not written down" the run ceiling exists to prevent. 5s also matches the original
 * `WEB_SERVER_TIMEOUT_MS` (35s) → `BOOT_CEILING_MS` (40s) gap.
 */
export const BOOT_CEILING_RUN_MARGIN_MS = 5_000;

/**
 * The boot ceiling for a run whose selected specs declare `runCeilingMs` in total.
 *
 * WHY IT SCALES. The boot ceiling is a bound on the unbounded pre-spawn availability probe over the
 * `webServer` urls, and it is measured from the end of config evaluation (see `bootDeadlineFrom`). It was
 * `40_000` while every criterion ran under the 55s single-file default, and that was enough: boot-after-
 * config-eval measured 6-18.5s under 28 sibling lanes. The `resident-shell-tab.spec.ts` rounds of
 * 2026-11-06 at load1 78-195 changed the arithmetic — config evaluation itself read 2.2s, 35.4s, 48.2s and
 * 107.5s — so a fixed 40s window and the 55s run ceiling were being crossed at nearly the same moment, and
 * lifting only the run budget would merely pick whichever wall the loaded host reached first. Scaling the
 * window by the declared budget is the same lever the sibling specs already use for their run budget.
 *
 * RULE. `runCeilingMs <= SINGLE_SPEC_CEILING_MS` ⇒ `40_000` exactly (every existing default selection,
 * including the one-file gate invocation, keeps its bytes). Above that, add the declared budget over the
 * floor, capped at 120s: `min(120_000, 40_000 + (runCeilingMs - 55_000))`. The result is asserted to stay
 * `BOOT_CEILING_RUN_MARGIN_MS` inside the run ceiling, so a future cap change cannot silently make the boot
 * window the last thing standing between the run and the gate's kill.
 *
 * @param {number} runCeilingMs
 * @returns {number}
 */
export function bootCeilingFor(runCeilingMs) {
  const runCeiling = Number(runCeilingMs);
  if (!Number.isFinite(runCeiling) || runCeiling <= SINGLE_SPEC_CEILING_MS) {
    return DEFAULT_BOOT_CEILING_MS;
  }
  const scaled = DEFAULT_BOOT_CEILING_MS + (runCeiling - SINGLE_SPEC_CEILING_MS);
  const ceiling = Math.min(MAX_BOOT_CEILING_MS, scaled);
  if (!(ceiling < runCeiling - BOOT_CEILING_RUN_MARGIN_MS)) {
    throw new Error(
      `boot ceiling ${ceiling}ms must stay ${BOOT_CEILING_RUN_MARGIN_MS}ms inside the ${runCeiling}ms run `
        + 'ceiling, or the run is killed before its crossing is written',
    );
  }
  return ceiling;
}

/**
 * The `webServer[].timeout` each entry gets for a run whose selected specs declare `runCeilingMs` in total.
 *
 * WHY IT FOLLOWS THE BOOT CEILING. Playwright waits this long after spawning a webServer for its url to
 * answer, and names the wait in its own failure line (`Error: Timed out waiting <n>ms from
 * config.webServer.`). It is the run's *earliest* wall: it is reached before any spec body executes, so
 * when it is fixed at 35s it stays the first thing a loaded host crosses even after `bootCeilingFor`
 * grew the watchdog's boot window with the declared budget. Gate events at tree
 * `9595c8d5f839ff94821c8bb21f23859d5c45d5e5` (2026-11-12T10:13:54.356Z goal-sweep, 10:17:52.010Z
 * goal-cli) both died on exactly that line while their own watchdogs recorded `fired: false` and a
 * config evaluation of 23.4s / 149.6s — the 535s selection still waited 35s.
 *
 * RULE. `bootCeilingFor(runCeilingMs) - BOOT_CEILING_RUN_MARGIN_MS`: the shipped 55s selection keeps
 * `35_000` byte-for-byte (40s boot ceiling − 5s), and every selection that declares more than the
 * single-spec default gets `115_000` (the 120s boot cap − 5s). Keeping the same 5s margin means this
 * bound is still strictly below the boot ceiling for every selection, so a boot that truly cannot answer
 * is still reported by Playwright's own line rather than by the watchdog, which would end the run without
 * naming the wait.
 *
 * @param {number} runCeilingMs
 * @returns {number}
 */
export function webServerTimeoutFor(runCeilingMs) {
  return bootCeilingFor(runCeilingMs) - BOOT_CEILING_RUN_MARGIN_MS;
}

/**
 * Reads the control-arm stall from an environment bag, clamped to `[0, CONFIG_EVAL_STALL_MAX_MS]`.
 *
 * An unset, empty or non-numeric value reads 0 — the shipped behaviour — rather than throwing: a
 * malformed knob must not turn every e2e run red by failing inside config evaluation.
 */
export function readConfigEvalStallMs(env = process.env) {
  const raw = env?.[CONFIG_EVAL_STALL_ENV];
  if (raw === undefined || raw === null) return 0;
  const text = String(raw).trim();
  if (text === '') return 0;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(CONFIG_EVAL_STALL_MAX_MS, Math.max(0, Math.trunc(parsed)));
}

/**
 * The boot ceiling's deadline, measured from the END of config evaluation.
 *
 * `configEvalCompletedAt` is the instant the module finished its synchronous seeding / client-root /
 * bundle work — the first instant at which Playwright can spawn a webServer, and therefore the only
 * honest origin for a bound on that spawn.
 *
 * @param {number} configEvalCompletedAt
 * @param {number} bootCeilingMs
 * @returns {number}
 */
export function bootDeadlineFrom(configEvalCompletedAt, bootCeilingMs) {
  return configEvalCompletedAt + bootCeilingMs;
}

/**
 * The run ceiling's deadline, measured from `runStartedAt` — the whole invocation, config evaluation included.
 *
 * @param {number} runStartedAt
 * @param {number} runCeilingMs
 * @returns {number}
 */
export function runDeadlineFrom(runStartedAt, runCeilingMs) {
  return runStartedAt + runCeilingMs;
}

/**
 * Milliseconds to wait from `now` until `deadline`, never negative — the same floor `setTimeout` needs.
 *
 * @param {number} deadline
 * @param {number} [now]
 * @returns {number}
 */
export function timerDelay(deadline, now = Date.now()) {
  return Math.max(0, deadline - now);
}

/**
 * Blocks the calling thread for `ms`, synchronously.
 *
 * Synchronous on purpose: the defect being controlled for is *config evaluation blocking the event
 * loop*, and an `await`-based sleep would hand the loop back — letting an armed timer fire mid-stall and
 * "reproduce" the failure for a different reason than the one under test. `Atomics.wait` on a buffer
 * nobody writes parks the thread for the whole duration.
 *
 * Returns the clamped duration actually waited, so a caller can print the reading rather than the request.
 *
 * @param {number} ms
 * @param {(line: string) => void} [log]
 * @returns {number}
 */
export function stallConfigEvaluation(ms, log = () => {}) {
  const bounded = Math.min(CONFIG_EVAL_STALL_MAX_MS, Math.max(0, Math.trunc(Number(ms) || 0)));
  if (bounded <= 0) return 0;
  log(`[e2e] config-eval-stall: holding config evaluation for ${bounded}ms (${CONFIG_EVAL_STALL_ENV}=${bounded})`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, bounded);
  return bounded;
}

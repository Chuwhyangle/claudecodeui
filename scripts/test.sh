#!/usr/bin/env bash
# quay fan-in test entrypoint: typecheck + lint + server node:test + client vitest,
# with one `__PERFILE__` line per test file so quay's /tests page gets file-level detail.
# Every stage runs even if an earlier one failed; the exit code is non-zero if any failed.
# Env: QUAY_TEST_DRY=1 consumes args, validates positional files, then exits 0 without running.
#      QUAY_TEST_CONCURRENCY_CEILING=<n> server-phase concurrency ceiling (default: adaptive,
#                                 min(16, effective_cpu × K); see below).
#      QUAY_TEST_CONCURRENCY_CEILING_K=<k> test seam: override K in the adaptive default
#                                 (so the checker's fail-closed can be falsified).
#      QUAY_TEST_FILE_TIMEOUT=<secs> per-process wall-clock bound (default 600).
#      QUAY_TEST_RERUN_RED_FILES=0 disable the isolated re-run rule for BOTH red judges (the server
#                                 phase pool and the e2e lane): a unit that redded while its siblings
#                                 were live is otherwise re-judged ONCE, alone, before it is recorded
#                                 (default 1; see "red-file isolated re-run" below).
#      QUAY_SUITE_MAX_RUNTIME_MS=<ms> whole-invocation bound (see the liveness watchdogs below).
#      QUAY_SUITE_SILENCE_MS=<ms> no-progress bound (see the liveness watchdogs below).
#      QUAY_MEMORY_MAX=<size> memory cap for the client vitest process (default 24G; `off` disables).
#      QUAY_SUITE_WATCHDOG_TRACE=1 print the observed progress readings at the end, so the two
#                                  thresholds above can be RE-DERIVED from a measurement rather
#                                  than re-guessed.
#      QUAY_SUITE_KEEP_LOGS=1 keep the per-file child output even on a GREEN run (default: only a
#                             red/aborted run keeps it — see the suite-logs block below).
#      QUAY_SUITE_KEEP_LOGS_DIR=<dir> where the kept logs go (default .quay/suite-logs/<run-id>).
#      QUAY_SUITE_LOG_MAX_BYTES=<n>  per-file cap for a kept log (default 262144 = 256 KiB).
#      QUAY_SUITE_LOG_TOTAL_BYTES=<n> whole-run cap for everything kept (default 67108864 = 64 MiB).
#      QUAY_SUITE_DURATION_BASELINE=<path> duration baseline for the full run's server dispatch
#                                  (default scripts/suite-duration-baseline.tsv). Missing, empty,
#                                  unreadable, or unparseable => plain alphabetical order (fail-open).
#      QUAY_TEST_STOP_AFTER=order     print the effective server dispatch order (one path per line)
#                                  to stdout and exit 0 — collection + ordering only, no stage runs.
#      QUAY_TEST_STOP_AFTER=stages    run only the two static stages, then report normally and skip
#                                  the server and client phases (the structural C1 check's seam).
#      QUAY_TEST_STOP_AFTER=e2e       the complementary seam: run ONLY the e2e lane below, then
#                                  report normally (skips the static stages and both heavy phases).
#      QUAY_TEST_E2E_CMD=<cmd>        test seam: replace the e2e lane's command (default: the
#                                  Scenario Runner browser spec through node_modules/.bin/playwright).
#                                  It exists so the lane's pass/red plumbing can be exercised with a
#                                  stub — a browser-installed requirement for a pin would couple the
#                                  server lane to Chromium for no gain.
#   Flags: --keep-logs <dir> = name the directory AND keep even when green (the explicit switch);
#          --run-id <id>     = use <id> as the run directory's name instead of the generated one.
#
# Every FAILING file also gets a second, machine-readable record right after its `__PERFILE__`
# line:  `__PERFILE_KIND__ file=<label> kind=infra|assert`
# `infra` = the failure carries no evidence a worker could fix (the process was cut off, or the
# runner reported nothing test-attributable); `assert` = a real failing assertion/test. Before
# this existed, `Error: STACK_TRACE_ERROR` (a load artifact) and `AssertionError: 1 !== 2` (a real
# defect) reached downstream in the same shape — `not ok - <file>: <first line>` — so a fan-in red
# could not be attributed and no worker could be dispatched. The kind is an ADDITIONAL line, not
# an extra key=value on `__PERFILE__`/`not ok`: quay's per-file parser matches `__PERFILE__` with an
# anchored regex, so a trailing field would make it silently drop every row it reads today.
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 2

CONCURRENCY=4
# ── 服务端阶段的并发【上限夹取】(gap-server-phase-concurrency-clamp；
#    上限按 effective CPU 自适应：gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu) ─────
# 本脚本原先对 `--test-concurrency` **照单全收**（只挡空值/非数字/0），于是调用方给多大就
# 并发多大。fan-in 的 runner 会按 nproc 推一个值 splice 进来（本机 128 核 ⇒ 请求 128），
# 而本仓服务端逐文件进程很多：2026-09-20 16:23Z 那轮 fan-in 的 log 里，把
# `__PERFILE__` 行的 `[end_ms - duration_ms, end_ms]` 当区间做最大重叠扫描得
# **server_max_concurrent=101**
# （全部同时在跑），逐文件耗时**中位 46,758ms**；对照本机安静态 N=100 的中位 1,399ms ——
# **中位涨 33×**，几乎每个文件都被垫到 ~47s 的地板。判红因此落在「每次不同的文件」上，
# 而「每次不同」正是机制指纹 —— 不是那些测试各自的缺陷。
#
# ⛔ 上限不是固定字面量，而是 effective CPU 的函数。每个 `tsx --test` 进程的 CPU/内存占用
# 是固定的，有效核越少，同样 N 路并发的排队/抢占/OOM 风险越高 —— 把 128 核档实测的膝点 16
# 直接搬到 2/4/8 有效核的 cgroup 就是**过订阅**。默认上限 = min(自然上限 16, effective_cpu × K)：
#   · 16 = 128 核档实测的吞吐膝点（读数与复算命令见 scripts/server-phase-concurrency-check.sh
#     的 SLOPE_TABLE 与完成记录的坡度表）。N=16 以上加并发只加压力、不换吞吐。
#   · K 由**分档坡度表实测**推出，不得凭感觉设：server-phase-concurrency-check.sh 逐档验证
#     公式的推荐值都落在该档实测 0 失败区间内。当前 K=1（每有效核一线程，128 核档被 16 夹住）。
#   · bash 的 `nproc` **不是** cgroup bandwidth-quota 感知的（实测 CPUQuota=250% 下仍报 128），
#     所以读 scripts/effective-capacity.sh 的 effective_cpu，而不是 nproc。
#   · 探测不可用 / 读数缺失 / 不可解析 ⇒ fail-open 回 16（本机 128 核档既有默认），不改既有行为。
#
# ⛔ 夹取只在【超过上限】时发生：调用方调**低**（例如 4）必须原样生效 —— 既有契约，
# server/shared/tests/quay-test-script.test.ts 与 gap-suite-hang-watchdog 的 AC 都在断言它。
# QUAY_TEST_CONCURRENCY_CEILING 显式设置时语义不变：仍**优先于**自适应默认值。
# QUAY_TEST_CONCURRENCY_CEILING_K 是**测试接缝**（覆盖 K），使守卫的 fail-closed 可证伪。
CEILING_CAP=16
CEILING_K="${QUAY_TEST_CONCURRENCY_CEILING_K:-1}"
case "$CEILING_K" in ''|*[!0-9]*|0) CEILING_K=1 ;; esac

adaptive_ceiling() {
  local out cpu scaled
  out="$(bash "$ROOT_DIR/scripts/effective-capacity.sh" 2>/dev/null)" \
    || { printf '%s' "$CEILING_CAP"; return; }
  cpu="$(printf '%s\n' "$out" | sed -n 's/^effective_cpu=\([0-9][0-9]*\)$/\1/p' | head -1)"
  case "$cpu" in ''|*[!0-9]*|0) printf '%s' "$CEILING_CAP"; return ;; esac
  scaled=$((cpu * CEILING_K))
  [ "$scaled" -gt "$CEILING_CAP" ] && scaled="$CEILING_CAP"
  [ "$scaled" -lt 1 ] && scaled=1
  printf '%s' "$scaled"
}

CONCURRENCY_CEILING="${QUAY_TEST_CONCURRENCY_CEILING:-$(adaptive_ceiling)}"
case "$CONCURRENCY_CEILING" in ''|*[!0-9]*|0) CONCURRENCY_CEILING="$CEILING_CAP" ;; esac
FILES=()
FOR_TASK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --for-task) FOR_TASK="${2:-}"; shift 2 ;;
    --static-checks-doc) echo "no doc checks in this repo"; exit 0 ;;
    --allow-thin) shift ;;
    --run-id) RUN_ID_ARG="${2:-}"; shift 2 ;;
    --keep-logs)
      # `--keep-logs` alone is still the explicit switch; the value (if any) only names the dir.
      ALWAYS_KEEP_LOGS=1
      case "${2:-}" in ''|-*) shift ;; *) KEEP_LOGS_DIR="$2"; shift 2 ;; esac
      ;;
    --buckets|--root|--state-dir|--runner|--log-file) shift 2 ;;
    --test-concurrency=*)
      CONCURRENCY="${1#*=}"
      case "$CONCURRENCY" in ''|*[!0-9]*|0) CONCURRENCY=4 ;; esac
      shift ;;
    -*) shift ;;
    *) FILES+=("$1"); shift ;;
  esac
done

# 夹取（只在上限之上）。判词走 stderr：stdout 是 `__PERFILE__` 与 dry-run 行的既有契约面，
# 不掺别的东西 —— quay 的 per-file 解析器用**锚定**正则，多一行都可能正是它丢行的原因。
if [ "$CONCURRENCY" -gt "$CONCURRENCY_CEILING" ]; then
  printf 'test.sh: --test-concurrency=%s exceeds the server-phase ceiling %s -> clamped to %s (basis: scripts/server-phase-concurrency-check.sh; override with QUAY_TEST_CONCURRENCY_CEILING)\n' \
    "$CONCURRENCY" "$CONCURRENCY_CEILING" "$CONCURRENCY_CEILING" >&2
  CONCURRENCY="$CONCURRENCY_CEILING"
fi

# ── prelude guard: the SCOPE of every worker's self-test (gap-worker-selfcheck-scoped) ───────
# Runs before any stage or file collection, so "nobody runs it" is impossible: a task's self-test
# AC must not make the FULL suite the worker's gate — that is fan-in's merge gate. The guard reads
# this tree's own tasks/, and it distinguishes the two cases instead of demanding --for-task
# everywhere: a task WITH *.test.* in Touches must use `--for-task <its own id>`, while a task
# WITHOUT one must run its own delivered checker (scripts/*.sh) — for that task --for-task would
# resolve to 0 files and exit 0 on the thin path, i.e. a green that cannot go red. `done` /
# `superseded` history is out of scope. Exit 1 (not 2): a red here is a verdict, not a usage error.
#
# The guard's stdout (its scan/PASS/FAIL lines) is forwarded to stderr: this script's stdout is a
# contract surface — `__PERFILE__` / `__PERFILE_KIND__` rows and the dry-run line, plus (under
# QUAY_TEST_STOP_AFTER=order) the dispatch order, which AC4 diffs byte-for-byte against `find`.
if ! bash "$ROOT_DIR/scripts/suite-scope-check.sh" 1>&2; then
  echo "test.sh: aborting before any stage — the active tasks' self-test scope is not compliant (verdict above)" >&2
  exit 1
fi

# Per-process wall-clock bound. Two reasons it exists: (1) one hung test file must not hang the
# whole suite (the caller's watchdog then kills everything and NOTHING is attributed); (2) it makes
# "this file's process was cut off" a STRUCTURAL fact — GNU timeout(1) exits 124 — rather than
# something a downstream reader has to guess from a log line. The attribution checker lowers it to
# a few seconds to reproduce that shape on purpose; healthy runs never come near it.
FILE_TIMEOUT_SECS="${QUAY_TEST_FILE_TIMEOUT:-600}"
case "$FILE_TIMEOUT_SECS" in ''|*[!0-9]*|0) FILE_TIMEOUT_SECS=600 ;; esac
# Only GNU timeout has --signal/--kill-after; without them the wrapper must not be used at all
# (a busybox timeout would reject the flags and fail every file), so the bound is simply absent.
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1 && timeout --version 2>&1 | grep -qi gnu; then
  TIMEOUT_BIN="$(command -v timeout)"
fi

# ── e2e lane: the Scenario Runner browser arm as a merge-gate lane ──────────────────────────
# (gap-regression-gate-fan-in-lane-for-e2e-arm — see the lane's own block further down for WHY
# it is here, why it can afford to be, and what its false form reads like.)
E2E_SPEC="e2e/session-lifecycle-scenario.spec.ts"
E2E_CMD="${QUAY_TEST_E2E_CMD:-node_modules/.bin/playwright test $E2E_SPEC}"

# --for-task <id>: scoped run = the existing test files listed in tasks/<id>.md Touches (thin is allowed)
if [ -n "$FOR_TASK" ]; then
  TASK_FILE="tasks/$FOR_TASK.md"
  [ -f "$TASK_FILE" ] || { echo "task file not found: $TASK_FILE" >&2; exit 2; }
  while IFS= read -r f; do
    [ -f "$f" ] && FILES+=("$f")
  done < <(awk '/^## Touches/{t=1;next} /^## /{t=0} t && /^- /{sub(/^- +/,"");gsub(/`/,"");print $1}' "$TASK_FILE" | grep -E '\.test\.[jt]sx?$')
  if [ ${#FILES[@]} -eq 0 ]; then
    echo "no scoped test files for $FOR_TASK (thin)"; exit 0
  fi
fi

for f in "${FILES[@]+"${FILES[@]}"}"; do
  if [ ! -f "$f" ]; then
    echo "test file not found: $f" >&2
    exit 2
  fi
done

if [ "${QUAY_TEST_DRY:-}" = "1" ]; then
  echo "dry run: args consumed (concurrency=$CONCURRENCY, files=${#FILES[@]})"
  exit 0
fi

# ── optional-deps preflight: 已声明却在 node_modules 里解析不到的 optionalDependency ─────────
# (gap-optional-dep-absent-from-main-checkout-reds-the-whole-suite — 见检查脚本自己的长 WHY)
#
# 判据的执行面是 worktree，依赖面却是【所有 worktree 通过符号链接共享的主检出 node_modules】，
# 两者不同源：只在某个 worktree 里装过的 optional 依赖，落地后会把「缺件」的红留给**每一个**
# 同族任务（断言读成 unavailable），而 suite 原先只报「某文件断言失败」——看不出是环境缺包。
# 2026-10-14 实测因此烧掉 5 个 fan-in 轮、三条同族任务连续 exited-not-landed。这一行前置检查
# 把这种缺件**点名**出来（包名 + 修复命令），让下一轮一眼可判。
#
# 输出走 stderr：stdout 是 `__PERFILE__` / dry-run 行的既有契约面，quay 的 per-file 解析器用
# **锚定**正则，不掺别的东西。且**不** abort、**不**改计数：红点本身仍由测试断言给出（环境判词
# 是**独立的一行**，不进 per-file red 计数 —— AC3）。`ENV-FAIL` 判词随后与断言失败形成对照。
#
# QUAY_OPTIONAL_DEPS_ROOT=<dir> 是**测试接缝**：把检查的被测位置挪到一个构造的根（例如"除
# onnxruntime-node 外全部符号链接到共享 node_modules"的农场），使假形态可在**不碰共享
# node_modules** 的前提下被端到端复现 —— 共享 node_modules 是全池共用的，挪开它会伤到别人的
# 任务（这正是本条要防的那类事故）。缺省不设时，被测位置就是本仓库根，行为与接线前逐字相同。
OPTDEPS_MISSING=0
OPTDEPS_ARGS=()
[ -n "${QUAY_OPTIONAL_DEPS_ROOT:-}" ] && OPTDEPS_ARGS=(--root "$QUAY_OPTIONAL_DEPS_ROOT")
if ! bash "$ROOT_DIR/scripts/optional-deps-preflight.sh" ${OPTDEPS_ARGS[@]+"${OPTDEPS_ARGS[@]}"} 1>&2; then
  OPTDEPS_MISSING=1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TOTAL=0; PASS=0; FAIL=0; UNCLASSIFIED=0
FAILED_LINES=()

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

# ── __BEGIN_WATCHDOG__ liveness watchdogs ────────────────────────────────────
#
# WHY: nothing above bounds this invocation. `timeout(1)` bounds each *server file*
# and the one vitest run, but a hang that survives those (a stuck stage, a child that
# ignores TERM, a bash-level deadlock, `timeout` absent or non-GNU) leaves the call
# sitting there forever — and this is the one failure class no layer downstream can
# see, because it is not red, it is SILENT. quay's own record of that shape is two
# hangs of 33.7 and 199.5 minutes, both ended by a human running `kill -TERM -- -<pgid>`.
#
# These two guards answer ONE question — is it still moving? — and nothing else. They
# do not decide whether to retry, and they do not change any verdict: they only end
# something that is already hung, which is why they can be unconditionally on.
#
#   max-runtime   the whole invocation has an upper bound
#   silence       no progress for this long => hung
#
# THRESHOLDS ARE MEASURED, NOT GUESSED (quay SPEC-suite-speed AC3: no threshold before
# the data exists). Readings taken on this machine 2026-09-20 with this script's own
# `QUAY_SUITE_WATCHDOG_TRACE=1` (which reprints them, so they can be re-derived instead of
# re-guessed — that is the whole reason the switch exists):
#
#   full suite, alone            wall  53.9s .. 59.0s   max progress gap 6.0s
#   2 full suites concurrently   wall  67.4s (worst)     max progress gap 8.0s
#
# THE ARITHMETIC LIVES IN scripts/suite-hang-watchdog-check.sh, so these two numbers can be
# re-derived rather than re-guessed, and so a stale default cannot sit here quietly:
#
#   bash scripts/suite-hang-watchdog-check.sh --measure     (re-runs the three suites, ~2 min)
#
# Both recipes are "multiply the worst reading, then round UP to a whole minute", and that
# checker fails if what ships below the recipe's floor ever falls under it.
#
# Rounding UP only ever makes a guard more permissive, which is the direction that is safe
# to be sloppy in, because the two failure directions are NOT symmetric: too high leaves a
# hang for a human to notice (what happens today), too low kills a healthy suite that was
# merely slowed down by load and turns a load artifact into a lost run.
#
#   max-runtime  660s = 9 x the worst concurrent wall clock on record (9 x 67.4s = 606s ->
#                660s), and 11.2x the quiet one. The suite is allowed a whole extra per-file
#                bound (QUAY_TEST_FILE_TIMEOUT, 600s) of slack past the worst concurrent
#                reading; past that it is doing ~10 runs' worth of work and is not coming
#                back. This is the backstop, not the usual trigger.
#   silence      240s = 30 x the worst concurrent progress gap (30 x 8.0s = 240s), and 40x
#                the quiet one. Concurrency degraded that gap by only 1.33x here, so the
#                margin absorbs it ~22x over. Note this sits BELOW the 600s per-file bound,
#                so it ends a single stuck file in 240s rather than letting timeout(1) take
#                600s — deliberately, since a file that has produced nothing at all for
#                240s is a hang from the outside. The slowest real file in the quiet run
#                took 12.7s, so nothing healthy is within 19x of this line; raise
#                QUAY_SUITE_SILENCE_MS if a legitimately slow file ever needs longer.
#
# On firing, the guard ends this process tree and this script exits non-zero with a
# `suite-watchdog: ABORT guard=... reason=timeout|hung threshold_ms=... elapsed_ms=...
# silent_ms=...` line in the report. It terminates; it never re-judges.
SUITE_MAX_RUNTIME_MS="${QUAY_SUITE_MAX_RUNTIME_MS:-660000}"
SUITE_SILENCE_MS="${QUAY_SUITE_SILENCE_MS:-240000}"
case "$SUITE_MAX_RUNTIME_MS" in ''|*[!0-9]*|0) SUITE_MAX_RUNTIME_MS=660000 ;; esac
case "$SUITE_SILENCE_MS" in ''|*[!0-9]*|0) SUITE_SILENCE_MS=240000 ;; esac
# __END_WATCHDOG__

# Poll interval. Small relative to either threshold, large enough that the byte census
# below is free; it does not have to divide them evenly (the comparison is >=).
WATCHDOG_POLL_SECS="${QUAY_SUITE_WATCHDOG_POLL_SECS:-2}"
case "$WATCHDOG_POLL_SECS" in ''|*[!0-9]*|0) WATCHDOG_POLL_SECS=2 ;; esac

SUITE_PID=$$
WATCHDOG_DIR="$TMP/watchdog"
mkdir -p "$WATCHDOG_DIR" 2>/dev/null || true
WATCHDOG_PROGRESS="$WATCHDOG_DIR/progress"   # last milestone, written by progress()
WATCHDOG_VERDICT="$WATCHDOG_DIR/verdict"     # why a guard fired, read by the TERM trap
WATCHDOG_TRACE_FILE="$WATCHDOG_DIR/trace"    # observed readings, rewritten every poll
WATCHDOG_STOP="$WATCHDOG_DIR/stop"           # touched by the normal shutdown path
WATCHDOG_START=$(now_ms)
WATCHDOG_ABORTED=0
WATCHDOG_PID=""
WATCHDOG_HAVE_PGREP=0
command -v pgrep >/dev/null 2>&1 && WATCHDOG_HAVE_PGREP=1

# progress(): the suite's own heartbeat. Called at every boundary where the suite has
# demonstrably moved on — a stage finished, a server file finished, a phase started.
# Written temp+rename so a reader never sees a half-written value.
progress() {
  local t="$WATCHDOG_PROGRESS.$BASHPID"
  now_ms > "$t" 2>/dev/null && mv -f "$t" "$WATCHDOG_PROGRESS" 2>/dev/null
  return 0
}
progress

# kill_tree <pid> <sig>: signal every DESCENDANT of <pid>, deepest first. <pid> itself is
# never signalled, and neither is the caller ($BASHPID) — the watchdog must outlive the
# kill it is performing, or it takes its own verdict down with it.
kill_tree() {
  local pid="$1" sig="${2:-TERM}" c
  [ "$WATCHDOG_HAVE_PGREP" = "1" ] || return 0
  for c in $(pgrep -P "$pid" 2>/dev/null || true); do
    [ "$c" = "$BASHPID" ] && continue
    kill_tree "$c" "$sig"
    kill -s "$sig" "$c" 2>/dev/null || true
  done
  return 0
}

# watchdog_bytes: total bytes the suite's children have produced so far. A test that is
# slow but ALIVE usually keeps printing (node:test emits TAP as subtests finish), so
# output growth is progress just as much as a milestone is — and reading it is what lets
# the silence bound be generous without becoming useless. Only the top level of $TMP is
# counted: the watchdog's own state lives one level down, in $TMP/watchdog.
watchdog_bytes() {
  local n
  n="$(find "$TMP" -maxdepth 1 -type f -printf '%s\n' 2>/dev/null | awk '{s += $1} END { print s + 0 }')"
  printf '%s' "${n:-0}"
}

# suite_alive — false once the suite is gone OR has become a zombie. `kill -0` alone is NOT
# enough and this is not a detail: the suite's parent may be a runner that is itself blocked
# and reaping nothing, so an exited suite sits in the process table as a zombie that still
# answers `kill -0`. Polling on that alone would make every abort pause for the full
# escalation budget to kill something that was already dead. An unreadable /proc (non-Linux)
# falls back to `kill -0`, which is then merely pessimistic, never wrong.
suite_alive() {
  local line st
  kill -0 "$SUITE_PID" 2>/dev/null || return 1
  [ -r "/proc/$SUITE_PID/stat" ] || return 0
  line="$(cat "/proc/$SUITE_PID/stat" 2>/dev/null)" || return 0
  st="${line##*) }"; st="${st%% *}"
  [ "$st" = "Z" ] && return 1
  return 0
}

# watchdog_wait_gone <ticks> — up to <ticks> * 0.25s for the suite to be gone.
watchdog_wait_gone() {
  local i=0
  while [ "$i" -lt "$1" ]; do
    suite_alive || return 0
    i=$((i + 1)); sleep 0.25
  done
  return 0
}

# watchdog_fire <guard> <reason> <limit_ms> <elapsed_ms> <silent_ms>
# Write the verdict where the report and the TERM trap can both see it, end the tree,
# and leave. Deliberately does NOT re-classify anything: whether the run is red is the
# caller's conclusion, and this only reports that it will never finish on its own.
#
# The ORDER is the whole point. SIGKILL cannot be trapped, so killing first and asking
# later is how a hung suite ends up with no report at all — the run stops, and nobody can
# read why. So the suite is asked first (TERM), which lets its own trap finish the report
# and end its own tree; the escalating KILL below is only for a suite that cannot answer,
# e.g. one blocked behind a foreground child that will not die.
watchdog_fire() {
  local guard="$1" reason="$2" limit="$3" elapsed="$4" silent="$5"
  printf 'suite-watchdog: ABORT guard=%s reason=%s threshold_ms=%s elapsed_ms=%s silent_ms=%s\n' \
    "$guard" "$reason" "$limit" "$elapsed" "$silent" > "$WATCHDOG_VERDICT"
  cat "$WATCHDOG_VERDICT"
  kill -s TERM "$SUITE_PID" 2>/dev/null || true
  watchdog_wait_gone 20
  kill_tree "$SUITE_PID" KILL       # unblocks a trap that is queued behind a live child
  watchdog_wait_gone 20
  kill -s KILL "$SUITE_PID" 2>/dev/null || true
  exit 3
}

watchdog_loop() {
  local now m size last_progress prev_bytes elapsed silent max_silent=0 events=0
  last_progress="$WATCHDOG_START"; prev_bytes=0
  while [ ! -e "$WATCHDOG_STOP" ]; do
    now=$(now_ms)
    m="$(cat "$WATCHDOG_PROGRESS" 2>/dev/null || true)"
    case "$m" in ''|*[!0-9]*) m=0 ;; esac
    if [ "$m" -gt "$last_progress" ]; then last_progress="$m"; events=$((events + 1)); fi
    size="$(watchdog_bytes)"
    if [ "$size" -gt "$prev_bytes" ]; then
      prev_bytes="$size"; last_progress="$now"; events=$((events + 1))
    fi
    [ "$last_progress" -gt "$now" ] && last_progress="$now"
    elapsed=$(( now - WATCHDOG_START ))
    silent=$(( now - last_progress ))
    [ "$silent" -gt "$max_silent" ] && max_silent=$silent
    printf 'max_silence_ms=%s progress_events=%s elapsed_ms=%s\n' \
      "$max_silent" "$events" "$elapsed" > "$WATCHDOG_TRACE_FILE.$$" 2>/dev/null \
      && mv -f "$WATCHDOG_TRACE_FILE.$$" "$WATCHDOG_TRACE_FILE" 2>/dev/null
    if [ "$elapsed" -ge "$SUITE_MAX_RUNTIME_MS" ]; then
      watchdog_fire max-runtime timeout "$SUITE_MAX_RUNTIME_MS" "$elapsed" "$silent"
    fi
    if [ "$silent" -ge "$SUITE_SILENCE_MS" ]; then
      watchdog_fire silence hung "$SUITE_SILENCE_MS" "$elapsed" "$silent"
    fi
    sleep "$WATCHDOG_POLL_SECS"
  done
  return 0
}

# The watchdog is DISOWNED on purpose. It is a job like any other while it runs, and
# `jobs -rp | wc -l` is what throttles the server phase to $CONCURRENCY and what the bare
# `wait` waits on — left attached, the watchdog would silently cost one concurrency slot
# and make the suite wait for a process that only exits when the suite does.
( watchdog_loop ) &
# `${!:-}` rather than `$!`: under `set -u` a bare `$!` is a fatal error whenever no
# background job has been started, which turns "the guard is not armed" into "the suite
# will not start" — the opposite of what a disabled guard should do.
WATCHDOG_PID="${!:-}"
[ -n "$WATCHDOG_PID" ] && { disown "$WATCHDOG_PID" 2>/dev/null || true; }

watchdog_stop() {
  : > "$WATCHDOG_STOP" 2>/dev/null || true
  [ -n "${WATCHDOG_PID:-}" ] && kill -s TERM "$WATCHDOG_PID" 2>/dev/null
  return 0
}

# A guard that fired has already asked this shell to stop; all that is left is to end the
# tree, make the run non-zero, and say so where the failure list would have been. The
# report carries the raw verdict line verbatim, so guard / threshold / silence are all
# readable from it. Also reachable mid-report (see the server record loop): a guard can
# take the .res files out from under it, and "file X failed" is the wrong story for that.
suite_abort() {
  [ "${WATCHDOG_ABORTED:-0}" = "1" ] && return 0
  WATCHDOG_ABORTED=1
  kill_tree "$$" TERM
  local verdict
  verdict="$(cat "$WATCHDOG_VERDICT" 2>/dev/null || true)"
  if [ -n "$verdict" ]; then
    printf 'not ok - %s\n' "$verdict"
  else
    printf 'not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above\n'
  fi
  # An aborted run is the one whose evidence is scarcest: the units that never reported are
  # exactly the ones whose output exists nowhere else. Copy $TMP before the EXIT trap removes it
  # (the copy is taken AFTER kill_tree, so no child is still writing into what is being read).
  suite_keep_logs "aborted: the run did not finish on its own"
  # The four counters stay consistent (tests = pass + fail + cancelled) even though the run
  # was cut short: every unit that never reported is a cancellation, except that one of them
  # is the hang itself, which the verdict line above already counts as the failure. Before
  # PLANNED is set (an abort during typecheck/lint) the fallback still balances, since TOTAL
  # is then the number already recorded.
  local planned="${PLANNED:-$((TOTAL + 1))}" cancelled
  cancelled=$((planned - TOTAL - 1))
  [ "$cancelled" -lt 0 ] && cancelled=0
  printf '# tests %s\n# pass %s\n# fail %s\n# cancelled %s\n' \
    "$planned" "$PASS" "$((TOTAL - PASS + 1))" "$cancelled"
  exit 3
}

# ── suite-logs: keep the per-file child output when the run is red ───────────────────────────
#
# WHY. Every child's full stdout/stderr is written into $TMP, and the exit path below used to
# `rm -rf "$TMP"` it unconditionally — so a red run left behind nothing but the 300-character
# `first_error` excerpt per file. The 2026-09-25 09:17 fan-in suite is the shape this removes:
# 12 of its 14 failures were, verbatim,
#   `not ok - <file>: no result file was written for this file — its process died without reporting`
# and with $TMP gone, whether those processes were OOM-killed, signalled, or hung is not
# recoverable from anything left on disk. This block copies $TMP into a per-run directory BEFORE
# that rm, so a red run leaves behind the evidence that explains it.
#
# It only PRESERVES output; it never judges. classify_failure_kind() and first_error() are
# untouched, no failure line is added or reworded, and the exit status is still decided by
# `[ "$FAIL" -eq 0 ] && [ "$UNCLASSIFIED" -eq 0 ]` at the end of this script — nothing here can
# turn a green run red or a red run green.
#
#   red            the run's own verdict was non-zero   => keep (default)
#   aborted        a guard or an external signal ended it => keep (this is the run whose
#                  evidence is scarcest: the units that never reported are exactly the ones
#                  whose output exists only in $TMP)
#   any other non-zero exit (a `set -u` death, a signal that never reached the report) => keep
#                  — see the suite_cleanup fallback
#   green          => nothing is copied and $TMP is removed as before, so any number of green
#                  runs leaves no growth behind
#   --keep-logs <dir> | QUAY_SUITE_KEEP_LOGS=1 => keep even when green (the explicit switch)
#
# BOUNDED, because "keep the evidence" must not become "fill the disk": one kept file is cut at
# PER_FILE_LOG_CAP and the whole directory at TOTAL_LOG_CAP, and a file that was cut gets a
# `<name>.truncated` sidecar saying how many bytes were dropped. The one-line `# suite-logs:`
# record printed next to the failures repeats both facts, so a reader of the fan-in log can tell
# a complete capture from a partial one without opening anything.
#
# The plan arrays are re-declared at the point they are filled; they are named here too because
# suite_keep_logs() reads them and runs from an EXIT trap, and a read of an unset array under
# `set -u` would abort the very trap that exists to preserve the evidence.
SERVER_FILES=(); CLIENT_FILES=()
SUITE_LOGS_KEPT=0
SUITE_LOGS_DIR=""
KEEP_MANIFEST=""
ALWAYS_KEEP_LOGS="${ALWAYS_KEEP_LOGS:-0}"
KEEP_LOGS_DIR="${KEEP_LOGS_DIR:-${QUAY_SUITE_KEEP_LOGS_DIR:-}}"
case "${QUAY_SUITE_KEEP_LOGS:-}" in ''|0|no|false) ;; *) ALWAYS_KEEP_LOGS=1 ;; esac
PER_FILE_LOG_CAP="${QUAY_SUITE_LOG_MAX_BYTES:-262144}"     # 256 KiB
TOTAL_LOG_CAP="${QUAY_SUITE_LOG_TOTAL_BYTES:-67108864}"    # 64 MiB
case "$PER_FILE_LOG_CAP" in ''|*[!0-9]*|0) PER_FILE_LOG_CAP=262144 ;; esac
case "$TOTAL_LOG_CAP" in ''|*[!0-9]*|0) TOTAL_LOG_CAP=67108864 ;; esac
# What the manifest may occupy. The copy loop reserves it out of TOTAL_LOG_CAP and the manifest
# is cut to it, so `kept content + ledger <= TOTAL_LOG_CAP` holds by construction.
LEDGER_RESERVE=65536

# The run's identity. Default is the human-readable twin of the `<epoch_ms>-<pid>` suffix fan-in
# puts in `.quay/fan-in-suite-*.log`, so a `.quay/suite-logs/<run-id>/` directory can be matched
# back to the run that produced it; --run-id / QUAY_SUITE_RUN_ID let a caller that already has an
# id keep the two aligned. Slugged, because it becomes a path segment.
log_slug() { printf '%s' "$1" | sed -e 's#[/\\]#__#g' -e 's/[^A-Za-z0-9._-]/_/g'; }
SUITE_RUN_ID="$(log_slug "${RUN_ID_ARG:-${QUAY_SUITE_RUN_ID:-}}")"
[ -n "$SUITE_RUN_ID" ] || SUITE_RUN_ID="$(date +%Y%m%dT%H%M%S)-$$"

# wc -c rather than stat(1): the count has to survive on whatever coreutils this host has, and a
# failed read must read as 0 rather than as an empty string that breaks every `-gt` test below.
file_bytes() {
  local n
  n="$(wc -c <"$1" 2>/dev/null | tr -d '[:space:]')"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  printf '%s' "$n"
}

# log_dest_name <basename-in-TMP> — the name a child's output gets in the keep dir. The index in
# `srv-3.out` means nothing to a reader six hours later, so the label is carried through:
# `server/database/x.test.ts` -> `server__database__x.test.ts.out`.
log_dest_name() {
  local b="$1" i
  case "$b" in
    srv-*.out|srv-*.res)
      i="${b#srv-}"; i="${i%.*}"
      printf '%s.%s' "$(log_slug "${SERVER_FILES[$i]:-server-$i}")" "${b##*.}"
      ;;
    stage-*.out) i="${b#stage-}"; printf '%s.stage.log' "$(log_slug "${i%.out}")" ;;
    vitest.out)  printf 'client-vitest.log' ;;
    vitest.json) printf 'client-vitest.json' ;;
    *)           printf '%s.log' "$(log_slug "$b")" ;;
  esac
}

# keep_pair <src> <dest-name> — copy ONE child artifact under both caps, appending its ledger row
# to $KEEP_MANIFEST and accumulating the run totals in the KEPT_* globals. Never fails the run:
# an artifact that cannot be written is recorded as omitted instead, because a silently missing
# log is indistinguishable from a log that was never produced — the exact confusion this block
# exists to remove.
keep_pair() {
  local src="$1" name="$2" size take room cut_note=""
  [ -f "$src" ] || return 0
  size="$(file_bytes "$src")"
  take="$size"
  if [ "$take" -gt "$PER_FILE_LOG_CAP" ]; then
    take="$PER_FILE_LOG_CAP"
    cut_note="per-file cap ${PER_FILE_LOG_CAP} B"
  fi
  room=$((TOTAL_LOG_CAP - KEPT_BYTES - LEDGER_RESERVE))
  [ "$room" -lt 0 ] && room=0
  if [ "$take" -gt "$room" ]; then
    take="$room"
    cut_note="${cut_note:+$cut_note; }whole-run cap ${TOTAL_LOG_CAP} B"
  fi
  if [ "$take" -le 0 ]; then
    KEPT_OMITTED=$((KEPT_OMITTED + 1))
    printf '%s\t0\t%s\tOMITTED: no room left under the whole-run cap %s B\n' \
      "$name" "$size" "$TOTAL_LOG_CAP" >>"$KEEP_MANIFEST"
    return 0
  fi
  if ! head -c "$take" "$src" >"$SUITE_LOGS_DIR/$name" 2>/dev/null; then
    KEPT_OMITTED=$((KEPT_OMITTED + 1))
    printf '%s\t0\t%s\tOMITTED: could not write %s\n' "$name" "$size" "$SUITE_LOGS_DIR/$name" >>"$KEEP_MANIFEST"
    return 0
  fi
  KEPT_FILES=$((KEPT_FILES + 1)); KEPT_BYTES=$((KEPT_BYTES + take))
  if [ "$take" -lt "$size" ]; then
    KEPT_CUT=$((KEPT_CUT + 1))
    printf '[suite-logs] TRUNCATED: kept the first %s of %s bytes — %s bytes were dropped (%s)\n' \
      "$take" "$size" "$((size - take))" "$cut_note" >"$SUITE_LOGS_DIR/$name.truncated"
    KEPT_BYTES=$((KEPT_BYTES + $(file_bytes "$SUITE_LOGS_DIR/$name.truncated")))
    printf '%s\t%s\t%s\tTRUNCATED: %s B dropped (%s); the note is in %s.truncated\n' \
      "$name" "$take" "$size" "$((size - take))" "$cut_note" "$name" >>"$KEEP_MANIFEST"
  else
    printf '%s\t%s\t%s\t-\n' "$name" "$take" "$size" >>"$KEEP_MANIFEST"
  fi
  return 0
}

# suite_keep_logs <reason> — copy $TMP into this run's keep dir (idempotent) and print the
# one-line record naming it. Returns 0 on every path; when the logs could not be written the
# record says so, because a lost capture must never be reported in the shape of a kept one.
suite_keep_logs() {
  local reason="$1"
  [ "${SUITE_LOGS_KEPT:-0}" = "1" ] && return 0
  [ -d "$TMP" ] || return 0
  SUITE_LOGS_KEPT=1
  if [ -n "${KEEP_LOGS_DIR:-}" ]; then
    SUITE_LOGS_DIR="$KEEP_LOGS_DIR"
  else
    SUITE_LOGS_DIR="$ROOT_DIR/.quay/suite-logs/$SUITE_RUN_ID"
  fi
  if ! mkdir -p "$SUITE_LOGS_DIR" 2>/dev/null; then
    printf '# suite-logs: UNAVAILABLE (cannot create %s) — this run'"'"'s per-file output was destroyed with %s; keep reason: %s\n' \
      "$SUITE_LOGS_DIR" "$TMP" "$reason"
    return 0
  fi
  KEEP_MANIFEST="$SUITE_LOGS_DIR/MANIFEST.txt"
  KEPT_FILES=0; KEPT_BYTES=0; KEPT_CUT=0; KEPT_OMITTED=0; KEPT_TRIED=0
  {
    printf '# suite-logs MANIFEST — per-file child output kept from a run that did not pass\n'
    printf '# keep reason: %s\n' "$reason"
    printf '# source: %s\n' "$TMP"
    printf '# caps: per-file %s B, whole run %s B (this ledger may occupy %s B of it)\n' \
      "$PER_FILE_LOG_CAP" "$TOTAL_LOG_CAP" "$LEDGER_RESERVE"
    printf '# file\tkept_bytes\tproduced_bytes\tnote\n'
  } >"$KEEP_MANIFEST" 2>/dev/null
  local f
  for f in "$TMP"/*; do
    [ -f "$f" ] || continue
    KEPT_TRIED=$((KEPT_TRIED + 1))
    keep_pair "$f" "$(log_dest_name "$(basename "$f")")"
  done
  # The watchdog's own readings exist only for the runs that ended early — i.e. precisely the
  # runs this block is for, and they are what separates "it hung" from "we do not know why".
  for f in "$TMP/watchdog/trace" "$TMP/watchdog/verdict"; do
    [ -f "$f" ] || continue
    KEPT_TRIED=$((KEPT_TRIED + 1))
    keep_pair "$f" "watchdog-$(basename "$f").txt"
  done
  local mbytes
  mbytes="$(file_bytes "$KEEP_MANIFEST")"
  if [ "$mbytes" -gt "$LEDGER_RESERVE" ]; then
    head -c "$LEDGER_RESERVE" "$KEEP_MANIFEST" >"$KEEP_MANIFEST.cut" 2>/dev/null \
      && mv -f "$KEEP_MANIFEST.cut" "$KEEP_MANIFEST"
    mbytes="$(file_bytes "$KEEP_MANIFEST")"
  fi
  KEPT_BYTES=$((KEPT_BYTES + mbytes))
  printf '# suite-logs: %s | kept %s of %s child artifact(s), %s bytes on disk (truncation sidecars and the ledger included) of the %s-byte whole-run cap; truncated %s, omitted %s | reason: %s\n' \
    "$SUITE_LOGS_DIR" "$KEPT_FILES" "$KEPT_TRIED" "$KEPT_BYTES" "$TOTAL_LOG_CAP" "$KEPT_CUT" "$KEPT_OMITTED" "$reason"
  return 0
}

# Every exit path ends the tree, not just the abort path: a fatal error in this script
# (set -u, a bad read) would otherwise orphan whatever tests are still running, which is
# the same "nobody ends it" shape the watchdogs exist to remove.
suite_cleanup() {
  local rc="$?"
  watchdog_stop
  kill_tree "$$" TERM
  # An exit that never went through the report (a `set -u` death, a signal this shell could not
  # trap, a kill that arrived after the report) still has $TMP intact. Removing it would
  # reproduce exactly the loss this block exists to remove, and a non-zero exit status is the
  # only verdict available at this point — which is enough to justify the copy.
  if [ "$rc" -ne 0 ] && [ "${SUITE_LOGS_KEPT:-0}" != "1" ]; then
    suite_keep_logs "unexpected non-zero exit (rc=$rc)"
  fi
  rm -rf "$TMP"
}
trap 'suite_abort' TERM INT
trap 'suite_cleanup' EXIT

# record <label> <duration_ms> <passed> <end_ms> [first_error] [kind]
#
# A failing file must carry a classification: without one a downstream reader cannot tell a
# worker-fixable defect from an infrastructure artifact, and quay's policy (ci-red-attribute)
# makes an infra label an irreversible exemption. So an unknown/absent kind is emitted as
# kind=unclassified AND makes the run exit non-zero — the field is never silently optional.
record() {
  local label="$1" dur="$2" ok="$3" end="$4" err="${5:-}" kind="${6:-}"
  [ "$dur" -lt 1 ] && dur=1
  echo "__PERFILE__ duration_ms=$dur $label passed=$ok end_ms=$end"
  TOTAL=$((TOTAL + 1))
  if [ "$ok" = "true" ]; then PASS=$((PASS + 1)); else
    FAIL=$((FAIL + 1)); FAILED_LINES+=("not ok - $label: ${err:-failed}")
    case "$kind" in
      infra|assert) ;;
      *) kind="unclassified"; UNCLASSIFIED=$((UNCLASSIFIED + 1)) ;;
    esac
    echo "__PERFILE_KIND__ file=$label kind=$kind"   # __KIND_RECORD__
  fi
}

first_error() {
  local line
  line="$(grep -m1 -E 'Error|error|not ok|✗|FAIL|failed' "$1" 2>/dev/null | head -c 300)"
  echo "${line:-see log}"
}

# __BEGIN_CLASSIFY__
# classify_failure_kind <lane> <rc> <log> [<failed_assertions>] -> prints infra | assert
#
# STRUCTURAL FACTS ONLY — no log keyword matching (nothing greps for "ETIMEDOUT",
# "STACK_TRACE_ERROR", "Error:" or any other message text). What it reads:
#   * the process exit-code envelope: 129..192 = died from signal 128+N, 124 = GNU timeout(1)
#     fired — in both cases the process was cut off, so its report cannot be trusted;
#   * the runner's OWN failed-assertion tally: node's test reporter summary counter (`# fail N`
#     under TAP, `ℹ fail N` under the spec reporter) and vitest's JSON assertionResults[].status.
#
# The asymmetry is deliberate, and it is the same one quay's ci-red-attribute records: a real
# assertion failure is NEVER relabelled infra (each infra label exempts a red, and that direction
# is not reversible), so `assert` wins the moment the runner tallied a failing assertion. `infra`
# is reachable only when the runner tallied NOTHING attributable to a test.
#
# lane=stage (typecheck/lint) has no framework tally to read, so only the envelope applies: a
# stage that exited normally with a nonzero status found a real defect in the tree.
classify_failure_kind() {
  local lane="$1" rc="$2" log="$3" failed="${4:-}"
  case "$lane" in
    server)
      if sed -E 's/\x1b\[[0-9;]*m//g' "$log" 2>/dev/null | grep -qE '^(#|ℹ) ?fail [1-9][0-9]*'; then
        echo assert; return 0
      fi
      ;;
    client)
      # Normalise the tally BEFORE the arithmetic test. The subject must be the raw value: a
      # `:-0` default here would make an empty tally subject the string "0", which matches neither
      # branch, so the assignment would silently not happen and `[ "" -gt 0 ]` would both error on
      # stderr and skip the assertion tally it exists to read.
      case "$failed" in ''|*[!0-9]*) failed=0 ;; esac
      if [ "$failed" -gt 0 ]; then echo assert; return 0; fi
      # Killed by the memory cap scripts/with-memory-cap.sh imposes: the test blew its budget, which
      # is attributable to the code under test, so it is NOT the "cut off" infra shape below.
      if grep -q 'client vitest OOM-killed at the memory cap' "$log" 2>/dev/null; then echo assert; return 0; fi
      ;;
    stage) : ;;                      # no framework tally to read: the envelope below decides
    *) echo assert; return 0 ;;      # unknown lane: never grant an exemption
  esac
  # Nothing test-attributable was reported. A cut-off process explains that structurally...
  if { [ "$rc" -ge 129 ] && [ "$rc" -le 192 ]; } || [ "$rc" -eq 124 ]; then
    echo infra; return 0
  fi
  # ...otherwise the lane decides. vitest reported the file failed with ZERO assertion results
  # (its worker died before asserting anything: the STACK_TRACE_ERROR shape) => infra. For the
  # server lane the same absence means node/tsx could not even run the file — a broken test file,
  # which is a real defect to fix => assert. A typecheck/lint stage reached this point having
  # exited normally, so it found a real defect too.
  case "$lane" in
    client) echo infra ;;
    *) echo assert ;;
  esac
}
# __END_CLASSIFY__

# run_stage <label> <cmd...>: run a whole-command stage as one pseudo file
run_stage() {
  local label="$1"; shift
  local out="$TMP/stage-$label.out" s e rc
  s=$(now_ms); "$@" >"$out" 2>&1; rc=$?; e=$(now_ms)
  if [ $rc -eq 0 ]; then record "$label" $((e - s)) true "$e"
  else record "$label" $((e - s)) false "$e" "$(first_error "$out")" "$(classify_failure_kind stage "$rc" "$out")"; fi
  progress
}

# run_stage_bg <label> <cmd...>: like run_stage, but starts the command in the BACKGROUND and
# writes the same evidence run_stage does — $TMP/stage-<label>.out (child output) plus a
# $TMP/stage-<label>.res carrier holding `<rc> <duration_ms> <end_ms>`, the exact shape the server
# lane writes to srv-N.res. The PARENT records it later (see run_static_stages_parallel), because
# record() mutates the parent's counters and FAILED_LINES: a subshell's updates to those would be
# discarded, so the stage would vanish from the report while still costing wall clock.
run_stage_bg() {
  local label="$1"; shift
  local out="$TMP/stage-$label.out" res="$TMP/stage-$label.res" s e rc
  (
    s=$(now_ms); "$@" >"$out" 2>&1; rc=$?; e=$(now_ms)
    echo "$rc $((e - s)) $e" >"$res"
    progress
  ) &
}

# run_static_stages_parallel (C1): typecheck and lint do not depend on each other — `tsc --noEmit`
# writes no files and oxlint only reads — and both are ordered before the server phase, so a serial
# pair pays their sum (measured 14.9s + 9.0s in round 636) for nothing. They now OVERLAP, and the
# parent records them anyway in a FIXED order, typecheck then lint, so a lint that finishes first
# can never reorder the `__PERFILE__` rows. Both stages always run and either being red still makes
# the run red (record() sets FAIL; the tail's `# fail N` and exit test are unchanged).
run_static_stages_parallel() {
  run_stage_bg typecheck npm run typecheck
  run_stage_bg lint npm run lint
  wait
  local label out res rc dur end
  for label in typecheck lint; do
    out="$TMP/stage-$label.out"; res="$TMP/stage-$label.res"
    if [ -s "$res" ]; then
      read -r rc dur end <"$res"
      if [ "$rc" = "0" ]; then record "$label" "$dur" true "$end"
      else record "$label" "$dur" false "$end" "$(first_error "$out")" "$(classify_failure_kind stage "$rc" "$out")"; fi
    else
      # A stage that produced no carrier died without reporting. That is this script's own
      # bookkeeping failing, not a test defect, but there is no framework tally to read for a
      # stage lane either way — record it as a failure with the assert kind so it is never
      # silently dropped (an unclassified/absent row would be worse than a loud red).
      record "$label" 1 false "$(now_ms)" "no result file was written for this stage — its process died without reporting" assert
    fi
  done
  progress
}

# ── longest-first server dispatch (gap-suite-server-dispatch-longest-first-and-parallel-static-stages) ──
#
# WHY. The server phase runs one process per file under a concurrency ceiling, so its wall clock is
# the SPAN of the launch schedule, not the sum of durations: an alphabetically collected list starts
# the slowest file LATE, and the phase then ends on that file's own tail. Round 636 (2026-10-05T23:24Z,
# green, 232 server files) had perFile span 180.7s while its theoretical floor was
# max(128.9s longest file, 1347.4s/16 = 84.2s) = 128.9s; voice-error-classification.false-forms.test.ts
# (128.9s) only started 52s in N=16 (its mean concurrency was 7.4). Ordering by a committed per-file
# duration baseline starts the long files first and pulls the span toward that floor.
#
# FAIL-OPEN IS THE CONTRACT, not a nicety. The baseline is an optimisation; the suite must not depend
# on it. Missing, empty, unreadable, or carrying even ONE unparseable line => the collected list is
# left byte-for-byte today's alphabetical order and the exit code is unchanged. A bad baseline can
# therefore never lose or duplicate a file, nor turn a green suite red.
#
# The baseline is a DATA file (scripts/suite-duration-baseline.tsv), deliberately not a script: a new
# scripts/*.mjs would be swept by scripts/tsconfig.json (allowJs+checkJs+strict) and red the whole
# suite via `npm run typecheck`.
#
# Only the full-collection path calls this. Positional / --for-task files are the caller's choice and
# keep the caller's order — never reordered.
dispatch_server_files() {
  local baseline="${QUAY_SUITE_DURATION_BASELINE:-$ROOT_DIR/scripts/suite-duration-baseline.tsv}"
  local tab=$'\t' reason="" line dur path okpath i j f cd cp
  DISPATCH_ORDER="alphabetical"; DISPATCH_SOURCE=""; DISPATCH_KNOWN=0; DISPATCH_UNKNOWN=0

  if [ ! -e "$baseline" ]; then reason="baseline not found: $baseline"
  elif [ ! -f "$baseline" ]; then reason="baseline is not a regular file: $baseline"
  elif [ ! -r "$baseline" ]; then reason="baseline is not readable: $baseline"
  elif [ ! -s "$baseline" ]; then reason="baseline is empty: $baseline"
  fi

  local -a bdur=() bpath=()
  if [ -z "$reason" ]; then
    # Pass 1: EVERY content line must parse, else the whole thing fails open. Splitting on the
    # first TAB proves "one TAB, digits before it, a server test path after it" without a regex.
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*) continue ;; esac
      dur="${line%%"$tab"*}"; path="${line#*"$tab"}"
      okpath=0
      case "$path" in server/*.test.ts|server/*.test.js) okpath=1 ;; esac
      if [ "$path" = "$line" ] || [ "${path#*"$tab"}" != "$path" ] \
         || [ -z "$dur" ] || [ "${dur//[0-9]/}" != "" ] || [ "$okpath" != "1" ]; then
        reason="baseline line is unparseable: $line"; break
      fi
      bdur+=("$dur"); bpath+=("$path")
    done < "$baseline"
  fi

  if [ -n "$reason" ]; then
    printf 'test.sh: server dispatch order=alphabetical reason=%s\n' "$reason" >&2
    return 0
  fi

  # known = baseline entries still present in the collected list ("still exists"), longest first.
  # A baseline path that is not in the list (deleted, or excluded from the find) is ignored.
  local -a kd=() kp=() rest=()
  for ((i = 0; i < ${#bpath[@]}; i++)); do
    for f in "${SERVER_FILES[@]+"${SERVER_FILES[@]}"}"; do
      if [ "$f" = "${bpath[$i]}" ]; then kd+=("${bdur[$i]}"); kp+=("$f"); break; fi
    done
  done
  # Insertion sort, duration descending. Stable on ties, so equal-duration files keep the baseline's
  # own (duration desc, path asc) order — deterministic without a second comparison key here.
  for ((i = 1; i < ${#kp[@]}; i++)); do
    cd="${kd[$i]}"; cp="${kp[$i]}"; j=$((i - 1))
    while [ "$j" -ge 0 ] && [ "${kd[$j]}" -lt "$cd" ]; do
      kd[$((j + 1))]="${kd[$j]}"; kp[$((j + 1))]="${kp[$j]}"; j=$((j - 1))
    done
    kd[$((j + 1))]="$cd"; kp[$((j + 1))]="$cp"
  done
  # unknown = collected files the baseline does not mention, in their existing (alphabetical) order.
  for f in "${SERVER_FILES[@]+"${SERVER_FILES[@]}"}"; do
    local inbase=0
    for path in "${bpath[@]+"${bpath[@]}"}"; do
      if [ "$path" = "$f" ]; then inbase=1; break; fi
    done
    [ "$inbase" = "1" ] || rest+=("$f")
  done

  SERVER_FILES=()
  if [ ${#kp[@]} -gt 0 ]; then SERVER_FILES+=("${kp[@]}"); fi
  if [ ${#rest[@]} -gt 0 ]; then SERVER_FILES+=("${rest[@]}"); fi
  DISPATCH_ORDER="longest-first"; DISPATCH_SOURCE="$baseline"
  DISPATCH_KNOWN=${#kp[@]}; DISPATCH_UNKNOWN=${#rest[@]}
  printf 'test.sh: server dispatch order=longest-first source=%s known=%s unknown=%s\n' \
    "$DISPATCH_SOURCE" "$DISPATCH_KNOWN" "$DISPATCH_UNKNOWN" >&2
}

SERVER_FILES=(); CLIENT_FILES=(); DISPATCH_FILES=()
if [ ${#FILES[@]} -gt 0 ]; then
  for f in "${FILES[@]}"; do
    f="${f#./}"
    DISPATCH_FILES+=("$f")
    case "$f" in server/*) SERVER_FILES+=("$f") ;; *) CLIENT_FILES+=("$f") ;; esac
  done
else
  while IFS= read -r f; do SERVER_FILES+=("$f"); done < <(find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort)
  # Full-collection path only: reorder server files longest-first from the duration baseline
  # (fail-open => the list above is left untouched). Positional / --for-task files keep the
  # caller's order, so this is deliberately not called for them.
  dispatch_server_files
  DISPATCH_FILES=("${SERVER_FILES[@]}")
  CLIENT_FILES=("__all__")
fi

# Test seam (QUAY_TEST_STOP_AFTER=order): print the effective dispatch order, one path per line,
# and nothing else on stdout — so the file SET can be diffed byte-for-byte against `find … | sort`
# (AC4) and the first lines checked for longest-first (AC2). Reached on both paths.
if [ "${QUAY_TEST_STOP_AFTER:-}" = "order" ]; then
  for f in "${DISPATCH_FILES[@]+"${DISPATCH_FILES[@]}"}"; do printf '%s\n' "$f"; done
  exit 0
fi

# Test seam (QUAY_TEST_STOP_AFTER=stages|e2e): how much of the invocation runs. `stages` keeps the
# two static stages and skips the heavy phases — the structural parallel check's seam (AC5/AC6),
# which never changes a verdict, only how much runs. `e2e` is its complement: it runs ONLY the e2e
# lane, so the lane's pass/red plumbing can be exercised without paying for the whole suite.
RUN_STATIC=1; RUN_HEAVY=1; RUN_E2E=1
case "${QUAY_TEST_STOP_AFTER:-}" in
  stages) RUN_HEAVY=0 ;;
  e2e)    RUN_STATIC=0; RUN_HEAVY=0 ;;
esac

# Static stages run only when the WHOLE tree is the target (the scoped path is the task's own
# subset and skips them, as before). They are independent, so they run concurrently — C1.
if [ ${#FILES[@]} -eq 0 ] && [ "$RUN_STATIC" = "1" ]; then
  run_static_stages_parallel
fi

# How many units this invocation means to report, pinned while the plan is still known. The
# abort path needs it: a guard that ends the run has to be able to say how much never ran,
# and past this point the counters only describe what DID run. Typecheck and lint each count
# as one unit in the collecting path (they are recorded as stages); in the scoped path they
# do not run at all, so they are not planned.
PLANNED=$((${#SERVER_FILES[@]} + ${#CLIENT_FILES[@]}))
[ ${#FILES[@]} -eq 0 ] && PLANNED=$((PLANNED + 2))
# The e2e lane is one more unit on the full-collection path. Gated on the same flag that launches
# it, so a seam that skips the lane does not leave a phantom unit in an aborted run's count.
[ ${#FILES[@]} -eq 0 ] && [ "$RUN_E2E" = "1" ] && PLANNED=$((PLANNED + 1))

# ── red-file isolated re-run (gap-fan-in-suite-load-flake-one-per-run) ───────────────────────
#
# WHY. Both judges run under concurrency: the server phase runs $CONCURRENCY files at once, and the
# e2e lane boots Chromium WHILE vitest holds the client phase. The ceiling only BOUNDS that; it does
# not make either of them red-proof. Measured 2026-10-13 on this host AT the ceiling itself (N=16):
# across the pre-fix reading set the SAME command redded 5 DISTINCT units — 4 server files (one of
# them THIS SCRIPT's own self-test) and the e2e lane's spec — with NO unit redding twice, and every
# one of them came out green when re-judged alone (`# fail 0`; the lane: `3 passed (8.9s)`). A
# different file each round, and the shape is not an assertion: one server file died on a
# NODE-INTERNAL assertion (`Assertion failed: (env_->execution_async_id()) == (0)`), and the lane's
# red is `Failed to fetch dynamically imported module:
# …/src/modules/chat/hooks/useSessionStore.ts` with 2 of its 3 cases passing in 3.3s — the arm's own
# Vite module graph, not its subject. The same fingerprint is already recorded in this repo twice:
# the predecessor task's own slope table (scripts/server-phase-concurrency-check.sh,
# `gap-server-phase-concurrency-clamp`) carries `claude-peer-name-follows-ai-title … 负载 flake，
# 复测清掉` and `claude-peer-name-title-guard … 撞 real-claude 竞态`; and `.quay/config.yml`'s
# driver-level `loop.rerun_command` already codifies the rule one level up — a red suite's files that
# re-run green is `rerun-green`, "a load flake — land as green". A verdict that moves with host load
# measures the host, not the code; the fix therefore belongs in the suite's concurrency policy
# (分 lane), not in the file.
#
# WHAT. A unit whose parallel attempt exited non-zero is re-judged ONCE, ALONE, by the SAME
# invocation — a server file AFTER `wait`, i.e. at a point where no sibling file, no static stage and
# no e2e lane is running; the e2e lane in its own collection block, once the lane and the client
# phase have both ended. Only the isolated verdict is recorded, so the `__PERFILE__` /
# `__PERFILE_KIND__` rows still appear exactly once per unit and quay's anchored per-file parser sees
# the shape it sees today. The parallel attempt's log is kept next to the isolated one. One knob
# governs both judges.
#
# WHEN IT DOES NOT APPLY. A run a liveness guard has already doomed is not re-judged: both call sites
# test `$WATCHDOG_VERDICT` first, so such a run pays no second attempt and still reports the guard's
# own verdict.
#
# WHY IT CANNOT BUY A FALSE GREEN. A red that is NOT contention-caused survives the isolated
# attempt: a real failing assertion, a file that never returns, and a dying worker each fail alone
# too, and they are classified from the isolated envelope by the same `classify_failure_kind`. The
# e2e lane is covered by the same argument and by this repo's own pin for it
# (server/shared/tests/quay-test-script.test.ts: its `QUAY_TEST_E2E_CMD='exit 1'` stub is re-judged
# here and still recorded as a red unit). Both judges are exercised by the re-runnable checks that
# ship with this script — scripts/suite-infra-attribution-check.sh (real-assertion / hang-forever /
# worker-death) and scripts/suite-hang-watchdog-check.sh (its five scenarios) — which are re-run
# against this change and keep their verdicts. The re-run never lowers $CONCURRENCY for the pool,
# never touches an assertion, and never runs a unit more than twice.
# `QUAY_TEST_RERUN_RED_FILES=0` restores the single-attempt behaviour.
RERUN_RED=1
case "${QUAY_TEST_RERUN_RED_FILES:-1}" in 0) RERUN_RED=0 ;; esac

# server: one node:test process per file, up to $CONCURRENCY at a time
if [ "$RUN_HEAVY" = "1" ] && [ ${#SERVER_FILES[@]} -gt 0 ]; then
  i=0
  for f in "${SERVER_FILES[@]}"; do
    (
      s=$(now_ms)
      # ── undici `bad port` lottery (gap-undici-blocked-ports-held-in-server-test-lane) ──
      # The 54 `app.listen(0, '127.0.0.1')` sites below fetch back to their own ephemeral port;
      # undici refuses 18 ports outright (`Error: bad port` before a socket opens), and the kernel
      # can hand `listen(0)` one of them — a different file reds each run, disjoint from any task
      # delta. The preload wired into the two calls below makes each per-file process hold those 18
      # ports for its whole lifetime, so the kernel cannot hand one out. Measured: a 127.0.0.1
      # holder blocks 127.0.0.1, 0.0.0.0 and :: allocation of that port; see
      # scripts/undici-blocked-ports-preload.mjs, which swallows every bind failure so this can
      # never keep the lane from starting. The fan-in lane runs one file per `node --import tsx`,
      # i.e. one holder set per process — exactly what the preload is for.
      #
      # ── invocation shape (gap-suite-server-phase-bypass-npx-and-tsx-cli-wrapper) ──
      # `npx tsx --tsconfig … --test` was a deep process chain (npx → tsx CLI → node --test runner
      # → the spawned test process) at ~525-575 MB per file. `node --import tsx … --test` keeps the
      # same `node --test` runner — so `ℹ fail N` / `# fail N` and the watchdog's output shape are
      # unchanged — but drops the npx and tsx-CLI wrappers: 2 processes, ~307-347 MB (measured).
      # The `@/*` → `server/*` alias the tsx CLI's `--tsconfig` flag used to supply now rides
      # `TSX_TSCONFIG_PATH`: bare `node --import tsx` fails `ERR_UNKNOWN_FILE_EXTENSION` on `@/…`
      # without it. `env` execs into node in place, so it adds no process.
      if [ -n "$TIMEOUT_BIN" ]; then
        "$TIMEOUT_BIN" --signal=TERM --kill-after=10 "$FILE_TIMEOUT_SECS" \
          env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test "$f" >"$TMP/srv-$i.out" 2>&1
      else
        env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test "$f" >"$TMP/srv-$i.out" 2>&1
      fi
      rc=$?; e=$(now_ms)
      echo "$rc $((e - s)) $e" >"$TMP/srv-$i.res"
      # One file finished => the suite moved on. This is the server phase's only
      # per-file liveness signal that does not depend on the child printing anything.
      progress
    ) &
    i=$((i + 1))
    while [ "$(jobs -rp | wc -l)" -ge "$CONCURRENCY" ]; do wait -n; done
  done
  wait
  i=0
  for f in "${SERVER_FILES[@]}"; do
    if [ -s "$TMP/srv-$i.res" ]; then
      read -r rc dur end <"$TMP/srv-$i.res"
      if [ "$rc" = "0" ]; then record "$f" "$dur" true "$end"
      else
        # Redded in the pool — re-judge it alone before recording it (see the block above). The
        # recorded duration stays the POOL attempt's: that is what this file costs the phase, and
        # it is what the duration baseline behind longest-first dispatch is built from. The
        # isolated attempt's own rc/duration are printed for the reading and its log kept beside
        # the pool's, so "it only fails under contention" stays visible instead of being erased.
        rlog="$TMP/rerun-$(log_slug "$f").out"; rrc="$rc"
        if [ "$RERUN_RED" = "1" ] && [ ! -e "$WATCHDOG_VERDICT" ]; then
          printf 'test.sh: %s redded in the parallel pool (rc=%s at concurrency=%s) — re-running it alone before recording: %s\n' \
            "$f" "$rc" "$CONCURRENCY" "$rlog" >&2
          progress
          if [ -n "$TIMEOUT_BIN" ]; then
            "$TIMEOUT_BIN" --signal=TERM --kill-after=10 "$FILE_TIMEOUT_SECS" \
              env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test "$f" >"$rlog" 2>&1
          else
            env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test "$f" >"$rlog" 2>&1
          fi
          rrc=$?
          progress
          printf 'test.sh: isolated re-run of %s exited rc=%s (pool rc=%s) — recording the isolated verdict\n' \
            "$f" "$rrc" "$rc" >&2
        fi
        if [ "$rrc" = "0" ]; then record "$f" "$dur" true "$end"
        else record "$f" "$dur" false "$end" "$(first_error "$rlog")" "$(classify_failure_kind server "$rrc" "$rlog")"; fi
      fi
    elif [ -e "$WATCHDOG_VERDICT" ]; then
      # A guard ended the tree, so this file has no result and none is coming. Report the
      # guard, not the file: a missing result file is not a defect any worker can fix.
      suite_abort
    else
      record "$f" 1 false "$(now_ms)" "no result file was written for this file — its process died without reporting" assert
    fi
    i=$((i + 1))
  done
fi

# ── e2e lane: the Scenario Runner browser arm (gap-regression-gate-fan-in-lane-for-e2e-arm) ──
#
# WHY A LANE AND NOT A CHECKLIST. The Scenario Runner's browser arm (`$E2E_SPEC`, delivered by
# gap-scenario-runner-playwright-executor-same-timeline) is the only surface that folds the shared
# timeline inside a real Chromium against the app's own Vite module graph. Until this block it ran
# in NO gate: playwright appears in no phase above, so the arm's colour could not move a merge —
# a check that only runs when someone remembers is a declaration, not a gate.
#
# WHY IT CAN AFFORD TO BE HERE — measured 2026-10-13 on this host, not assumed. The whole
# invocation (config evaluation, BOTH webServers, Chromium, 3 cases) costs 8.9-10.4s wall and
# ~293 MiB peak RSS; under 24 busy cores it was 9.45s / 294 MiB. The arm's own playwright config
# self-bounds it (BOOT_CEILING 40s, per-spec 55s), i.e. strictly inside this script's watchdog.
#
# WHY IT IS LAUNCHED *HERE*. It is started just before the client phase and collected after it, so
# it OVERLAPS vitest rather than extending the gate's wall clock. Not earlier, on purpose: the
# server phase's scheduler sizes itself with `jobs -rp`, so a lane started before it would silently
# take one of the 16 file slots (16 -> 15 concurrent files) and lengthen that phase instead.
#
# SCOPE. Full-collection path only — the scoped path is a task's own subset and keeps its own
# order — and skipped by the `order`/`stages` seams, so no existing seam, pin or ordering changes
# shape. `first_error`/`classify_failure_kind stage` are reused unchanged: a playwright run that
# exits non-zero found a real defect (assert), one cut off by a signal is infra.
#
# FALSE FORM (what the task's AC2 reads). A failing arm reaches record() as an ordinary red —
# `__PERFILE__ … passed=false`, `__PERFILE_KIND__ … kind=assert` and a `not ok -` line — so this
# run exits non-zero and quay's fan-in refuses the merge. Delete this block and that reading is
# gone: the arm is unblocked again, which is exactly the gap this lane closes.
E2E_LANE=0
if [ "$RUN_E2E" = "1" ] && [ ${#FILES[@]} -eq 0 ]; then
  E2E_LANE=1
  progress
  (
    s=$(now_ms); bash -c "$E2E_CMD" >"$TMP/e2e.out" 2>&1; rc=$?; e=$(now_ms)
    echo "$rc $((e - s)) $e" >"$TMP/e2e.res"
    progress
  ) &
  E2E_PID=$!
fi

# client: single vitest run, JSON report parsed per file
if [ "$RUN_HEAVY" = "1" ] && [ ${#CLIENT_FILES[@]} -gt 0 ]; then
  # This phase is ONE process whose whole span is a single silence: `--reporter=json`
  # writes the per-file report at the end, so neither stdout nor the report grows while
  # it runs. The heartbeat goes in here, at the phase's own start, so the silence the
  # watchdog measures during the client phase is the client phase and not the tail of
  # whatever ran before it.
  progress
  # The vitest process runs in its own memory-capped cgroup scope: a runaway test (2026-09-25:
  # 218G peak) otherwise makes the kernel OOM-kill the whole tmux-pane scope, :3001 included.
  # A capped kill surfaces as exit 137 with no report, which classify_failure_kind reads as infra.
  MEMCAP="$ROOT_DIR/scripts/with-memory-cap.sh"
  export QUAY_MEMORY_UNIT="quay-vitest-$$-$(now_ms)"
  ARGS=()
  [ "${CLIENT_FILES[0]}" != "__all__" ] && ARGS=("${CLIENT_FILES[@]}")
  VRC=0
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" --signal=TERM --kill-after=10 "$FILE_TIMEOUT_SECS" \
      "$MEMCAP" npx vitest run --reporter=json --outputFile="$TMP/vitest.json" "${ARGS[@]+"${ARGS[@]}"}" >"$TMP/vitest.out" 2>&1 || VRC=$?
  else
    "$MEMCAP" npx vitest run --reporter=json --outputFile="$TMP/vitest.json" "${ARGS[@]+"${ARGS[@]}"}" >"$TMP/vitest.out" 2>&1 || VRC=$?
  fi
  # The kernel kills a WORKER, not vitest itself, so the exit code is unreliable (observed: 1, with
  # ERR_IPC_CHANNEL_CLOSED and no report) and would read as the "cut off"/zero-assertion infra shape.
  # Exceeding the cap is the test's own defect, not the host's: the journal is the only witness, so
  # leave a marker classify_failure_kind reads.
  if [ "$VRC" -ne 0 ] && journalctl --user --no-pager -q -u "$QUAY_MEMORY_UNIT.scope" 2>/dev/null | grep -q 'OOM killer'; then
    echo "client vitest OOM-killed at the memory cap (QUAY_MEMORY_MAX=${QUAY_MEMORY_MAX:-24G})" >>"$TMP/vitest.out"
  fi
  # A guard that fired while vitest was running reaches here only if this shell's TERM trap
  # has not been honoured yet; reporting the client phase from a dead run would be a lie.
  [ -e "$WATCHDOG_VERDICT" ] && suite_abort
  if [ -s "$TMP/vitest.json" ]; then
    # Column 5 is the runner's own failed-assertion tally for that file: it is what separates a
    # real assertion failure (assert) from a file the worker died on before asserting (infra).
    while IFS=$'\t' read -r label dur ok end nfailed err; do
      if [ "$ok" = "true" ]; then record "$label" "$dur" true "$end"
      else record "$label" "$dur" false "$end" "$err" "$(classify_failure_kind client "$VRC" "$TMP/vitest.out" "$nfailed")"; fi
    done < <(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const root = process.argv[2] + "/";
      for (const t of r.testResults) {
        const bad = t.status !== "passed";
        const msg = bad
          ? (((t.assertionResults || []).find((a) => a.status === "failed") || {}).failureMessages || [t.message || "failed"])[0] || "failed"
          : "";
        const nfailed = (t.assertionResults || []).filter((a) => a.status === "failed").length;
        const dur = Math.max(1, Math.round(t.endTime - t.startTime));
        console.log([t.name.replace(root, ""), dur, !bad, Math.round(t.endTime), nfailed, String(msg).split("\n")[0].slice(0, 300)].join("\t"));
      }' "$TMP/vitest.json" "$ROOT_DIR")
  else
    # No report at all: the run itself died (worker killed, reporter channel closed, hard
    # timeout). Nothing test-attributable was recorded, so lane=client classifies it infra.
    record client-vitest 1 false "$(now_ms)" "$(first_error "$TMP/vitest.out")" "$(classify_failure_kind client "$VRC" "$TMP/vitest.out")"
  fi
  progress
fi

# e2e lane: collect the background run started above and record it exactly like a stage — the
# carrier file is the same `<rc> <duration_ms> <end_ms>` shape the server lane writes, so a lane
# that died without reporting is loud rather than absent (see the lane's own block for the WHY).
if [ "$E2E_LANE" = "1" ]; then
  wait "$E2E_PID" 2>/dev/null
  if [ -s "$TMP/e2e.res" ]; then
    read -r rc dur end <"$TMP/e2e.res"
    if [ "$rc" = "0" ]; then record "$E2E_SPEC" "$dur" true "$end"
    else
      # Redded while the client phase was live — re-judge it alone before recording it, exactly like
      # a server file (see "red-file isolated re-run" above; one knob governs both judges). The lane's
      # own duration and end stay the POOL attempt's: that is what this arm costs the run. The arm's
      # own playwright config self-bounds the second attempt (BOOT_CEILING 40s, per-spec 55s), and a
      # run a guard has already doomed is not re-judged at all.
      rout="$TMP/e2e.rerun.out"; rrc="$rc"
      if [ "$RERUN_RED" = "1" ] && [ ! -e "$WATCHDOG_VERDICT" ]; then
        printf 'test.sh: %s redded in the parallel pool (rc=%s) — re-running it alone before recording: %s\n' \
          "$E2E_SPEC" "$rc" "$rout" >&2
        progress
        bash -c "$E2E_CMD" >"$rout" 2>&1
        rrc=$?
        progress
        printf 'test.sh: isolated re-run of %s exited rc=%s (pool rc=%s) — recording the isolated verdict\n' \
          "$E2E_SPEC" "$rrc" "$rc" >&2
      fi
      if [ "$rrc" = "0" ]; then record "$E2E_SPEC" "$dur" true "$end"
      else record "$E2E_SPEC" "$dur" false "$end" "$(first_error "$rout")" "$(classify_failure_kind stage "$rrc" "$rout")"; fi
    fi
  elif [ -e "$WATCHDOG_VERDICT" ]; then
    suite_abort
  else
    record "$E2E_SPEC" 1 false "$(now_ms)" "no result file was written for this lane — its process died without reporting" assert
  fi
  progress
fi

# The suite finished on its own, so no guard could have fired. Stop the watchdog before
# the report is printed so it can never append a verdict to a run that already ended.
watchdog_stop

echo
for l in "${FAILED_LINES[@]+"${FAILED_LINES[@]}"}"; do echo "$l"; done
# Environment signal, co-located with the failures so a reader scanning the red sees WHY a whole
# family of files can red at once: a DECLARED optionalDependency is missing from the shared
# node_modules (the prelude printed the named `ENV-MISSING`/`ENV-FAIL` verdict above). It goes to
# stderr and is deliberately NOT a `__PERFILE__` row — it is an environment reading, not a per-file
# test verdict, so it never enters the per-file red count (AC3).
if [ "$OPTDEPS_MISSING" = "1" ]; then
  printf 'optional-deps-preflight: ENV-VERDICT kind=environment-missing-optional-deps — the per-file reds above may be caused by a declared optionalDependency missing from the shared node_modules, not by this task'"'"'s delta (see the prelude ENV-MISSING/ENV-FAIL lines)\n' >&2
fi
# The kept evidence is named right next to the failures it explains, so the directory is readable
# straight out of the run's own stdout (and therefore out of `.quay/fan-in-suite-*.log`) instead
# of having to be known in advance. A green run keeps nothing and so prints nothing here.
if [ "$FAIL" -gt 0 ] || [ "$UNCLASSIFIED" -gt 0 ]; then
  suite_keep_logs "red: ${FAIL} failed, ${UNCLASSIFIED} unclassified"
elif [ "$ALWAYS_KEEP_LOGS" = "1" ]; then
  suite_keep_logs "explicit --keep-logs (this run is green)"
fi
# Opt-in: the raw readings the two thresholds are derived from, so a later change to them
# can be a re-measurement instead of a guess. Read from the trace the watchdog rewrote on
# every poll — it is a snapshot, not a final tally, so it is only printed for a run that
# ran to completion.
if [ "${QUAY_SUITE_WATCHDOG_TRACE:-}" = "1" ] && [ -s "$WATCHDOG_TRACE_FILE" ]; then
  printf 'suite-watchdog: trace %s max_runtime_threshold_ms=%s silence_threshold_ms=%s\n' \
    "$(cat "$WATCHDOG_TRACE_FILE")" "$SUITE_MAX_RUNTIME_MS" "$SUITE_SILENCE_MS"
fi
echo "# tests $TOTAL"
echo "# pass $PASS"
echo "# fail $FAIL"
echo "# cancelled 0"
# UNCLASSIFIED > 0 means a failure reached the report without a usable kind. That is a bug in
# this script's own attribution, so it is a red run, not a silently-attributable one.
[ "$FAIL" -eq 0 ] && [ "$UNCLASSIFIED" -eq 0 ]

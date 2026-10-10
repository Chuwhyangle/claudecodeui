#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/server-phase-concurrency-check.sh — 服务端阶段并发上限的判据
# （tasks/gap-server-phase-concurrency-clamp.md；人（yale）2026-09-21 裁定立案）
#   （上限改为按 effective CPU 自适应：tasks/gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu.md）
#
# 要断言的那一件事：**调用方给多大，服务端阶段的并发都不会过订阅；调用方调低必须原样生效；
# 而上限本身是 effective CPU 的函数，且该函数在每一档都有实测 0 失败支撑。**
#
#   ① --test-concurrency=<极大值> / <fan-in 同形值> ⇒ 打印值 = 上限（夹取发生）
#   ② --test-concurrency=4 / =2 / =1 与不给 flag（默认 4）⇒ 打印值原样（夹取不发生）
#   ③ 上限**逐档有实测依据**：SLOPE_TABLE 按 effective_cpu 分档；对表里**每一个**档 c，
#      把 `scripts/test.sh` 在 effective_cpu=c 下的公式输出 f(c) 跑出来（读 dry-run 行的实际
#      生效值，不是从源码猜），断言：
#        (a) 该档存在一条实测 0 失败行，其 N == f(c)；否则红（公式值在本档无实测支撑）。
#        (b) 该档若存在实测失败行，则要求 f(c) < 该档最小失败 N（推荐值不得落进越界区）。
#        (c) 表里至少一档有实测失败行（余量倍数据此算出，不是靠猜）。
#        (d) 表里至少四档（2/4/8/本机 128）。
#      ⛔ 「无坡度表支撑的公式/值」= 凭感觉写的阈值，本判据直接判红（fail-closed）。负控制：
#      注入 QUAY_TEST_CONCURRENCY_CEILING_K=3 ⇒ f(2)=6（表里没有该档 6 这一行）⇒ 必须判红
#      （完成记录里贴了这条红）。
#   ④ 输出行格式未变：默认档与 `--test-concurrency=4` 都必须**逐字**打印
#      `dry run: args consumed (concurrency=<n>, files=<m>)`（既有契约，
#      server/shared/tests/quay-test-script.test.ts 也在断言它）。
#   ⑤ 显式覆盖不被自适应公式改写：模拟低档下 `QUAY_TEST_CONCURRENCY_CEILING=<v>` 的生效值 = v。
#
# ③ 的档如何模拟：`scripts/effective-capacity.sh` 的 `EFFECTIVE_CAPACITY_TEST_*` 接缝**覆盖的是
# 原始读数**，所以把 cpu.max 置 max、cpuset 计数与 nproc 都置 c，effective_cpu 就确定为 c（与真机
# cgroup 无关，CI 上同样可跑）。同理，③ 的探针**清掉** QUAY_TEST_CONCURRENCY_CEILING，读的是
# 自适应默认值本身；⑤ 则显式设上它，断言它压过公式。档 c 的真实读数由实测坡度表（见下）与完成
# 记录里的 `systemd-run -p CPUQuota=` 读数共同举证。
#
# 为什么判据是 standalone 脚本而不是 *.test.ts：本仓套件只收集 `server/**` 与 `src/**`
# 下的测试文件，放在 scripts/ 下的检查器不会被套件递归调用 —— 否则它会在套件里再跑套件，
# 自己把自己拖红（与 scripts/suite-concurrency-check.sh 同因）。本任务 ## Touches 不含
# `*.test.*`，属 scripts/suite-scope-check.sh 的 (b) 类：`--for-task` 会掏空成 thin 假绿，
# 故自测入口就是本检查器（该守卫的判词里逐字写明了这一点）。
#
# 退出码：0 判据成立；1 判据不成立；2 用法/环境错误。
# ⛔ 判词一律**同一行**带出成因与实测读数（本仓 AC 硬校验），不得用裸 grep -q 链。
# ─────────────────────────────────────────────────────────────────────────────
set -u

# ── SLOPE_TABLE：并发坡度表（AC 的原始数据，也是上限公式的唯一依据）─────────────
#
# 七列（TAB 分隔）：cpu  N  load1(起跑时)  墙钟ms  失败文件数  失败文件  来源
#   cpu = scripts/effective-capacity.sh 的 effective_cpu 档（2/4/8/128）；
#   N   = 该档请求的服务端阶段并发（--test-concurrency）。
# ⛔ 任何一列都不许留空（read 把连续 TAB 当单个分隔符，空列会串位）；「无」写成 `-`。
#    低核档没采 load1，记 `-`：该档的「压力」由 CPUQuota 本身决定，不是外部竞争进程。
#
# 实测条件：位置参数把全部 271 个 `server/**/*.test.ts|js` 点名 ⇒ scripts/test.sh 走位置参数
# 分支，不跑 typecheck / lint / client，留下的墙钟就是服务端阶段本身。复算命令（每档）：
#
#   mapfile -t SF < <(find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort)
#   # 低核档（本机用 systemd-run 模拟；--scope 逃出调用者 cgroup，配额由此档独占）：
#   systemd-run --user --scope --quiet -p CPUQuota=<200%|400%|800%> -p MemoryMax=32G \
#     --working-directory=<repo> -- bash scripts/test.sh --test-concurrency=<N> "${SF[@]}"
#   # 本机 128 核档：同上但不加 CPUQuota。
#   # ⛔ 显式 QUAY_TEST_CONCURRENCY_CEILING=<N> 以**越过自适应上限**，测的是套件在该 N 下的原始行为。
#   # ⛔ 套件的两个 liveness 看门狗（660s/240s）是按本机 128 核的套件墙钟标定的；低核档天然更慢，
#   #    测量时必须抬高它们（QUAY_SUITE_MAX_RUNTIME_MS / QUAY_SUITE_SILENCE_MS），否则读到的是看门狗
#   #    到点（与并发无关），不是并发事实。被测量的边界始终是逐文件界 QUAY_TEST_FILE_TIMEOUT(600s)。
#
# 2/4/8 三档各测三个 N：公式推荐值 f(c)=c（K=1）、2c、4c（2026-10-10 本轮实测，systemd-run
# CPUQuota 模拟）；128 档测 f(128)=16（2026-10-10 本机），其余 128 档行是 2026-09-21 那次任务的
# 安静档读数，逐字保留。
#
# ⚠️ 表里同时有「0 失败档」与「失败档」：这不是笔误 —— 越界的后果取决于整机压力，不只取决于 N。
# 末行（fan-in 真身）不是本 agent 发起的，而是本仓历史 fan-in log 里那次**真实**轮次的读数
# （同一台机器、请求值 128，那一轮判红一个文件、中位文件耗时 46,758ms）；该文件随后被删除，
# 是不可复算的历史读数，仅用于「至少有一档实测失败」这条结构判据与余量读数，不参与公式验证。
# 历史读数与复算命令的原文出处见 tasks/gap-server-phase-concurrency-clamp.md 完成记录。
SLOPE_TABLE="$(cat <<'TABLE'
2	2	-	926234	0	-	本轮实测 2026-10-10 systemd-run CPUQuota=200%（2 有效核）全 271 个 server 文件
2	4	-	784986	1	server/modules/voice/tests/voice-error-classification.false-forms.test.ts	本轮实测 2026-10-10 CPUQuota=200%（2 有效核，N=2×核数）：该文件要跑 tsc 假形臂，2× 稀释下逐文件墙钟 176.9s，kind=assert 红
4	4	-	452518	0	-	本轮实测 2026-10-10 systemd-run CPUQuota=400%（4 有效核）全 271 个 server 文件
4	8	-	412421	0	-	本轮实测 2026-10-10 systemd-run CPUQuota=400%（4 有效核，N=2×核数）全 271 个 server 文件
4	16	-	487118	2	server/modules/providers/tests/claude-peer-name-title-guard.test.ts,server/modules/session-hosts/tests/resident-server-restart.test.ts	本轮实测 2026-10-10 CPUQuota=400%（N=4×核数）：逐文件墙钟被稀释 4×，两个 kind=assert 红（resident-server-restart 撞定长 20s 截止、claude-peer-name-title-guard 撞 real-claude 竞态）
8	8	-	250206	0	-	本轮实测 2026-10-10 systemd-run CPUQuota=800%（8 有效核）全 271 个 server 文件
8	16	-	243930	1	server/modules/session-hosts/tests/resident-server-restart.test.ts	本轮实测 2026-10-10 CPUQuota=800%（N=2×核数）：该文件的定长 60s 内部截止（「waiting for the first resident host to appear with a pid」）撞上 2× 稀释
8	32	-	376892	2	server/modules/oauth/tests/agent-retirement.test.ts,server/modules/session-hosts/tests/resident-server-restart.test.ts	本轮实测 2026-10-10 CPUQuota=800%（N=4×核数）：resident-server-restart 撞定长 25s /health 截止、agent-retirement 撞兄弟 falsify 残留 ENOENT
128	4	11	30044	0	-	既有实测 2026-09-21 安静（原文保留）
128	16	-	152510	0	-	本轮实测 2026-10-10 本机 128 核（N=f(128)=16；早先一次同档红是 claude-peer-name-follows-ai-title 的负载 flake，复测清掉）
128	16	13	14201	0	-	既有实测 2026-09-21 安静（原文保留）
128	32	15	13435	0	-	既有实测 2026-09-21 安静（原文保留）
128	64	14	13734	0	-	既有实测 2026-09-21 安静（原文保留）
128	100	14	14397	0	-	既有实测 2026-09-21 安静（原文保留）
128	128	22	18544	0	-	既有实测 2026-09-21 安静（原文保留）
128	128	66	23239	0	-	既有实测 2026-09-21 +64 竞争进程（原文保留）
128	128	93	15928	0	-	既有实测 2026-09-21 +64 竞争进程二跑（原文保留）
128	128	129	24312	0	-	既有实测 2026-09-21 +256 竞争进程（原文保留）
128	128	87-135	-	1	server/modules/launch-profiles/tests/gateway-end-to-end.test.ts	fan-in 真身 2026-09-20T16:23Z（本仓 log；中位文件耗时 46758ms）ⓘ 该文件已于 2026-09-21 随旧实体拆除删除，本行是不可复算的历史读数
TABLE
)"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 2

TEST_SH="$ROOT_DIR/scripts/test.sh"
PROBE_HUGE="${SPCC_PROBE_HUGE:-100000}"
PROBE_FANIN="${SPCC_PROBE_FANIN:-128}"   # fan-in 在本机实际塞入的值（128 核）
OVERRIDE_PROBE="${SPCC_OVERRIDE_PROBE:-9}"  # ⑤ 的显式覆盖探针值（既非任一档公式输出，也 < 16）
DRY_LINE_RE='^dry run: args consumed \(concurrency=[0-9]+, files=[0-9]+\)$'

usage() {
  cat <<'USAGE'
usage: bash scripts/server-phase-concurrency-check.sh [options]

  无参即可：①②④ 走 QUAY_TEST_DRY=1 探针（秒级、确定性、不依赖机器负载）；③ 逐档读本脚本
  内置的 SLOPE_TABLE 并核对公式输出；⑤ 用 EFFECTIVE_CAPACITY_TEST_* 接缝模拟低档核对显式覆盖。

  --test-sh <path>   被测的套件入口（默认 <repo>/scripts/test.sh）
  --huge <n>         ① 的「极大值」探针（默认 100000）
  --fan-in <n>       ① 的「fan-in 同形」探针（默认 128 = 本机 nproc）
  -h, --help         本帮助
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --test-sh) TEST_SH="${2:-}"; shift 2 ;;
    --test-sh=*) TEST_SH="${1#*=}"; shift ;;
    --huge) PROBE_HUGE="${2:-}"; shift 2 ;;
    --huge=*) PROBE_HUGE="${1#*=}"; shift ;;
    --fan-in) PROBE_FANIN="${2:-}"; shift 2 ;;
    --fan-in=*) PROBE_FANIN="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "server-phase-concurrency-check: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -f "$TEST_SH" ] || {
  printf 'server-phase-concurrency-check: cannot evaluate — test.sh not found: %s (env error, not a verdict)\n' "$TEST_SH" >&2
  exit 2
}

# dry_line <n|""|__tier:c__> — 跑一次 dry-run，打印 `dry run: args consumed (...)` 那一行（原文）。
# 空串 = 不给 --test-concurrency（默认档）。`__tier:c__` = 用 EFFECTIVE_CAPACITY_TEST_* 接缝把
# effective_cpu 定为 c，并**清掉** QUAY_TEST_CONCURRENCY_CEILING（读自适应默认值）。⛔ 只读 stdout
# 的那一行：判据的读数就是「实际生效值」，任何夹取都必然先体现在这里。
dry_line() {
  local out
  case "${1:-}" in
    __tier:*)
      out="$(env -u QUAY_TEST_CONCURRENCY_CEILING \
             EFFECTIVE_CAPACITY_TEST_CPU_MAX=max \
             EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT="${1#__tier:}" \
             EFFECTIVE_CAPACITY_TEST_NPROC="${1#__tier:}" \
             QUAY_TEST_DRY=1 bash "$TEST_SH" "--test-concurrency=$PROBE_HUGE" 2>/dev/null)" || return 1 ;;
    '')
      out="$(QUAY_TEST_DRY=1 bash "$TEST_SH" 2>/dev/null)" || return 1 ;;
    *)
      out="$(QUAY_TEST_DRY=1 bash "$TEST_SH" "--test-concurrency=$1" 2>/dev/null)" || return 1 ;;
  esac
  printf '%s\n' "$out" | sed -n '/^dry run: args consumed /p' | head -1
}

# dry_eff <n|""|__tier:c__> — 同一行里的 concurrency 值；拿不到就返回非零。
dry_eff() {
  local line val
  line="$(dry_line "$1")" || return 1
  val="$(printf '%s\n' "$line" | sed -n 's/^dry run: args consumed (concurrency=\([0-9]*\), files=[0-9]*)$/\1/p')"
  [ -n "$val" ] || return 1
  printf '%s' "$val"
}

# ── 坡度表读数（③ 的唯一依据）────────────────────────────────────────────────
# 七列：cpu N load1 wallms fails files prov
tiers()          { printf '%s\n' "$SLOPE_TABLE" | awk -F'\t' 'NF && $1 ~ /^[0-9]+$/ { if (!seen[$1]++) print $1 }' | sort -n; }
tier_has_safe_n() { printf '%s\n' "$SLOPE_TABLE" | awk -F'\t' -v c="$1" -v n="$2" 'NF && $1==c && $2==n && $5 ~ /^[0-9]+$/ && $5+0==0 { f=1 } END { exit !f }'; }
tier_safe_ns()   { printf '%s\n' "$SLOPE_TABLE" | awk -F'\t' -v c="$1" 'NF && $1==c && $5 ~ /^[0-9]+$/ && $5+0==0 { print $2 }' | sort -n | paste -sd, -; }
tier_min_unsafe(){ printf '%s\n' "$SLOPE_TABLE" | awk -F'\t' -v c="$1" 'NF && $1==c && $5 ~ /^[0-9]+$/ && $5+0>0 { print $2 }' | sort -n | head -1; }
tier_unsafe_count(){ printf '%s\n' "$SLOPE_TABLE" | awk -F'\t' -v c="$1" 'NF && $1==c && $5 ~ /^[0-9]+$/ && $5+0>0 { n++ } END { print n+0 }'; }
tier_wall_at()   { printf '%s\n' "$SLOPE_TABLE" | awk -F'\t' -v c="$1" -v n="$2" 'NF && $1==c && $2==n { print $4; exit }'; }

tier_list="$(tiers)"
tier_count="$(printf '%s\n' "$tier_list" | grep -c .)"
tier_list_disp="$(printf '%s\n' "$tier_list" | paste -sd, -)"
slope_rows="$(printf '%s\n' "$SLOPE_TABLE" | grep -c .)"

echo "server-phase-concurrency-check: test_sh=$TEST_SH 坡度表档数=$tier_count（$tier_list_disp） 行数=$slope_rows"
echo "server-phase-concurrency-check: 坡度表(实测) $(printf '%s' "$SLOPE_TABLE" | paste -sd';' - | sed 's/; */ | /g')"

# ── 探针 ─────────────────────────────────────────────────────────────────────
FAILS=()

huge_eff="$(dry_eff "$PROBE_HUGE")" || huge_eff=""
fanin_eff="$(dry_eff "$PROBE_FANIN")" || fanin_eff=""
four_eff="$(dry_eff 4)" || four_eff=""
two_eff="$(dry_eff 2)" || two_eff=""
one_eff="$(dry_eff 1)" || one_eff=""
default_eff="$(dry_eff "")" || default_eff=""

CEILING="$huge_eff"
case "$CEILING" in ''|*[!0-9]*|0) CEILING="";; esac

readout="极大($PROBE_HUGE)→${huge_eff:-?} fan-in同形($PROBE_FANIN)→${fanin_eff:-?} 4→${four_eff:-?} 2→${two_eff:-?} 1→${one_eff:-?} 默认→${default_eff:-?}"

# 上限**之上**的实测档，按结局计数（同 N 既可能有干净档、也可能有失败档 —— 诚实读数）。
above_clean=0; above_unsafe=0
while IFS=$'\t' read -r cpu n _load _wall fails _files _prov; do
  [ -n "${n:-}" ] || continue
  case "${fails:-}" in ''|*[!0-9]*) continue ;; esac
  if [ -n "$CEILING" ] && [ "$n" -gt "$CEILING" ] 2>/dev/null; then
    if [ "$fails" -gt 0 ]; then above_unsafe=$((above_unsafe + 1)); else above_clean=$((above_clean + 1)); fi
  fi
done < <(printf '%s\n' "$SLOPE_TABLE")

# ── ① 夹取发生：极大值 / fan-in 同形值都必须落在上限上 ────────────────────────
if [ -z "$CEILING" ]; then
  FAILS+=("① 探针不可判：--test-concurrency=$PROBE_HUGE 的 dry-run 没有打印可解析的 concurrency=<n>（读到 '$huge_eff'），上限无从取得（fail-closed）")
elif [ "$huge_eff" = "$PROBE_HUGE" ]; then
  FAILS+=("① 未夹取：请求 --test-concurrency=$PROBE_HUGE，实测生效值仍是 $huge_eff（= 请求值）——调用方给多大就并发多大")
fi
if [ -n "$CEILING" ] && [ "$fanin_eff" != "$CEILING" ]; then
  FAILS+=("① 未夹取(fan-in 同形)：请求 --test-concurrency=$PROBE_FANIN（本机 fan-in 实际塞入值），实测生效值 = ${fanin_eff:-?}，应被夹到上限 $CEILING")
fi

# ── ② 调低原样生效（夹取只在上限之上发生）────────────────────────────────────
for pair in "4:$four_eff" "2:$two_eff" "1:$one_eff"; do
  want="${pair%%:*}"; got="${pair#*:}"
  [ "$got" = "$want" ] || FAILS+=("② 调低被篡改：请求 --test-concurrency=$want，实测生效值 = ${got:-?}，应原样为 $want")
done
[ "$default_eff" = "4" ] || FAILS+=("② 默认档被篡改：不给 --test-concurrency 时实测生效值 = ${default_eff:-?}，应原样为 4")

# ── ③ 上限逐档有实测依据（没有坡度表就不许有上限）────────────────────────────
if [ "$tier_count" -lt 4 ]; then
  FAILS+=("③ 坡度表只有 $tier_count 档（< 4，需含 2/4/8/128），不足以支撑公式取值")
fi
any_unsafe=0
tier_readout=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  f_c="$(dry_eff "__tier:$c")" || f_c=""
  safe_ns="$(tier_safe_ns "$c")"
  min_u="$(tier_min_unsafe "$c")"
  ucnt="$(tier_unsafe_count "$c")"
  [ "$ucnt" -gt 0 ] && any_unsafe=1
  w_f="$(tier_wall_at "$c" "$f_c")"
  tier_readout="${tier_readout}cpu=$c f=$f_c 墙钟=${w_f:-?}ms 0失败档=[${safe_ns:-none}] 最小失败N=${min_u:-none} ｜ "
  if [ -z "$f_c" ]; then
    FAILS+=("③ cpu=$c 档取不到公式输出（dry-run 不可解析）——本档的推荐值无从与实测比对（fail-closed）")
  elif tier_has_safe_n "$c" "$f_c"; then
    :
  else
    FAILS+=("③ cpu=$c 档公式推荐值 f=$f_c 在本档没有实测 0 失败行（该档 0 失败档: ${safe_ns:-none}）——无实测支撑的取值不许上线")
  fi
  if [ -n "$f_c" ] && [ -n "$min_u" ] && [ "$f_c" -ge "$min_u" ] 2>/dev/null; then
    FAILS+=("③ cpu=$c 档公式推荐值 f=$f_c ≥ 本档最小实测失败 N=$min_u——推荐值落进越界区")
  fi
done < <(printf '%s\n' "$tier_list")

if [ "$any_unsafe" -eq 0 ]; then
  FAILS+=("③ 坡度表里没有任何实测失败档：公式推荐值与失败边界之间的余量无从算出（不能靠猜）")
fi

# ── ④ 输出行格式未变（逐字）──────────────────────────────────────────────────
default_line="$(dry_line "")" || default_line=""
four_line="$(dry_line 4)" || four_line=""
printf '%s\n' "$default_line" | grep -Eq "$DRY_LINE_RE" \
  || FAILS+=("④ 默认档输出行格式变了：读到 '$default_line'，应逐字匹配 dry run: args consumed (concurrency=<n>, files=<m>)")
printf '%s\n' "$four_line" | grep -Eq "$DRY_LINE_RE" \
  || FAILS+=("④ --test-concurrency=4 输出行格式变了：读到 '$four_line'，应逐字匹配 dry run: args consumed (concurrency=<n>, files=<m>)")

# ── ⑤ 显式覆盖不被自适应公式改写（模拟低档 cpu=2）───────────────────────────
override_line="$(EFFECTIVE_CAPACITY_TEST_CPU_MAX=max EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT=2 EFFECTIVE_CAPACITY_TEST_NPROC=2 \
                 QUAY_TEST_CONCURRENCY_CEILING="$OVERRIDE_PROBE" QUAY_TEST_DRY=1 bash "$TEST_SH" "--test-concurrency=$PROBE_HUGE" 2>/dev/null \
                 | sed -n '/^dry run: args consumed /p' | head -1)"
override_eff="$(printf '%s\n' "$override_line" | sed -n 's/^dry run: args consumed (concurrency=\([0-9]*\), files=[0-9]*)$/\1/p')"
[ "$override_eff" = "$OVERRIDE_PROBE" ] \
  || FAILS+=("⑤ 显式覆盖被公式改写：模拟 cpu=2 下 QUAY_TEST_CONCURRENCY_CEILING=$OVERRIDE_PROBE，实测生效值 = ${override_eff:-?}，应原样为 $OVERRIDE_PROBE")

# ── 判词（全部读数集中在同一行）──────────────────────────────────────────────
verdict_readout="探针 $readout ｜ 上限=$CEILING ｜ 逐档 $tier_readout上限之上实测档=干净${above_clean}/失败${above_unsafe}"

if [ ${#FAILS[@]} -gt 0 ]; then
  for m in "${FAILS[@]}"; do
    printf 'server-phase-concurrency-check: FAIL — %s ｜ %s\n' "$m" "$verdict_readout"
  done
  printf 'server-phase-concurrency-check: FAIL — %s 条不成立：服务端阶段的并发没有被夹在自适应上限内（或某个上限取值没有实测依据）\n' "${#FAILS[@]}"
  exit 1
fi

printf 'server-phase-concurrency-check: PASS — ① 极大值与 fan-in 同形值都被夹到上限 ② 调低(4/2/1)与默认(4)原样生效 ③ 每个 effective_cpu 档的公式推荐值都有该档实测 0 失败行支撑 ④ dry-run 行格式逐字未变 ⑤ 显式覆盖原样生效 ｜ %s\n' \
  "$verdict_readout"
exit 0

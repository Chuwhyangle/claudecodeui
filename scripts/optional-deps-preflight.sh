#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/optional-deps-preflight.sh — 「已声明的 optionalDependency 却在 node_modules
# 里解析不到」的环境前置检查（gap-optional-dep-absent-from-main-checkout-reds-the-whole-suite）
#
# WHY THIS EXISTS. 判据（测试）的执行面是 **worktree**，而依赖面是**所有 worktree 通过符号链接
# 共享的那一份主检出 `node_modules`** —— 两者不同源。于是一条只在【某个 worktree 里】装过
# optional 依赖的任务，可以带着自己 worktree 的绿读数落地，而把「缺件」的红留给**每一个**同族
# 任务：它们的断言读成 unavailable，suite 只报「某个文件断言失败」，**看不出是环境缺包**。
# 2026-10-14 实测：`voice-realtime-uplink-vad.test.ts` 因 `onnxruntime-node` 未装进主检出
# node_modules 而确定性红，三条同族任务连续 exited-not-landed，driver 判成 LOOP DEADLOCK，
# 其中一条 park `needs-human` —— 而三条任务的 AC 其实早已全部勾完，活干完了。
# 在主检出 `npm install --no-save onnxruntime-node@1.30.0` 之后，同一文件 10 pass / 0 fail。
#
# ⛔ 本条**不**改弱任何断言、不加 skip：红点由安装解决，本条要加的是让下一次能**一眼看出
# 是缺件**的信号。缺件的根因在 node_modules，而 suite 原先不点名它。
#
# WHAT IT CHECKS. 读 `<root>/package.json` 的 `optionalDependencies`（已声明的集合），逐个解析
# `<root>/node_modules/<name>/package.json` 是否可读。凡「已声明但解析不到」的包，逐包输出一行
# `ENV-MISSING`（点名包名 + 期望路径 + 修复命令），并输出**一行独立的环境判词** `ENV-FAIL`
# （`kind=environment-missing-optional-deps`）。这行**不是** `__PERFILE__`，不进入 suite 的
# per-file red 计数 —— 它是环境信号，不是代码判词。
#
# ⛔ 它不是抽签、也不是归因问题：「重跑仍红」（rerun-red），而 suite 原先不点名它。补上这行
# 之后，fan-in 的第一轮就能把「环境缺件」判成一条点名包名的独立信号。
#
# --root <dir> 只挪动 package.json / node_modules 的**被测位置**（供构造假形态复现），
# **不**挪动本脚本自己的接线判据 —— 接线永远核对本脚本所在仓库的 scripts/test.sh。
#
# 退出码：0 = 全部已声明的 optionalDependency 都能解析；1 = 有缺件（环境判词）；
#         2 = 用法/环境错误（package.json / node 读不到，或接线判据读不到 test.sh）。
# ⛔ 判词一律**同一行**带出成因（本仓 AC 硬校验：失败退出必须同行输出原因），不用裸 `grep -q` 链。
# ─────────────────────────────────────────────────────────────────────────────
set -u

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$REPO_DIR"   # where package.json + node_modules are looked up (--root overrides)

usage() {
  cat <<'USAGE'
usage: bash scripts/optional-deps-preflight.sh [options]

  --root <dir>     被测位置：读 <dir>/package.json 与 <dir>/node_modules（默认本脚本所在仓库根）。
                   仅供构造「缺件」假形态做复现；接线判据不受它影响。
  -h, --help       本帮助

输出：绿 = 一行 `optional-deps-preflight: PASS …`（exit 0）；
      红 = 每个缺件一行 `… ENV-MISSING pkg=<name> …` + 一行 `… ENV-FAIL kind=environment-missing-optional-deps …`（exit 1）。
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT_DIR="${2:-}"; shift 2 ;;
    --root=*) ROOT_DIR="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "optional-deps-preflight: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

PKG_JSON="$ROOT_DIR/package.json"
if [ ! -f "$PKG_JSON" ]; then
  printf 'optional-deps-preflight: cannot evaluate — package.json not found: %s (env error, not a verdict)\n' "$PKG_JSON" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  printf 'optional-deps-preflight: cannot evaluate — node not on PATH (env error, not a verdict)\n' >&2
  exit 2
fi

# ── wiring self-check：本检查必须被 suite 入口的前置调用，否则它是死代码 ────────────────
# 前置 = 第一条 stage（run_stage …）或第一次文件收集（SERVER_FILES=/CLIENT_FILES=）之前。
# 只认非注释行里的调用（注释里提到文件名不算接线）。核对的是**本脚本所在仓库**的 test.sh。
TEST_SH="$REPO_DIR/scripts/test.sh"
WIRING_VERDICT=""
if [ ! -f "$TEST_SH" ]; then
  printf 'optional-deps-preflight: cannot evaluate the wiring — test.sh not found: %s (env error, not a verdict)\n' "$TEST_SH" >&2
  exit 2
fi
guard_line="$(awk '/^[[:space:]]*#/ { next } /optional-deps-preflight\.sh/ { print NR; exit }' "$TEST_SH")"
stage_line="$(awk '/^[[:space:]]*(run_stage|SERVER_FILES=|CLIENT_FILES=)/ { print NR; exit }' "$TEST_SH")"
if [ -z "$guard_line" ]; then
  WIRING_VERDICT="VIOLATION(wiring) — $TEST_SH never calls scripts/optional-deps-preflight.sh on a non-comment line: the environment check is dead code, and \"nobody runs it\" is exactly the silent-gap it exists to prevent"
elif [ -n "$stage_line" ] && [ "$guard_line" -ge "$stage_line" ]; then
  WIRING_VERDICT="VIOLATION(wiring) — $TEST_SH calls scripts/optional-deps-preflight.sh at line $guard_line, but the first stage/file collection is at line $stage_line: it must run in the PRELUDE, before any test work starts"
fi

# ── declared optionalDependencies: one `<name>\t<range>` per line ───────────────────────
if ! DECL="$(node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const o = p.optionalDependencies || {};
  Object.keys(o).sort().forEach((k) => console.log(k + "\t" + o[k]));
' "$PKG_JSON")"; then
  printf 'optional-deps-preflight: cannot parse %s (env error, not a verdict)\n' "$PKG_JSON" >&2
  exit 2
fi

NM="$ROOT_DIR/node_modules"
DECLARED=0
PRESENT=0
MISSING=()
while IFS=$'\t' read -r name range; do
  [ -n "${name:-}" ] || continue
  DECLARED=$((DECLARED + 1))
  if [ -f "$NM/$name/package.json" ]; then
    PRESENT=$((PRESENT + 1))
  else
    MISSING+=("$name")
    printf 'optional-deps-preflight: ENV-MISSING pkg=%s declared=%s expected-at=%s/%s — a declared optionalDependency is not resolvable here (an install ran in some OTHER worktree, not in the shared node_modules this tree links to)\n' \
      "$name" "$range" "$NM" "$name"
    printf 'optional-deps-preflight: FIX pkg=%s command="npm install --no-save %s"\n' "$name" "$name"
  fi
done <<< "${DECL:-}"

if [ -n "$WIRING_VERDICT" ]; then
  printf 'optional-deps-preflight: %s\n' "$WIRING_VERDICT"
fi

if [ ${#MISSING[@]} -eq 0 ] && [ -z "$WIRING_VERDICT" ]; then
  printf 'optional-deps-preflight: PASS declared=%s present=%s root=%s node_modules=%s\n' \
    "$DECLARED" "$PRESENT" "$ROOT_DIR" "$NM"
  exit 0
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  pkgs="$(IFS=,; printf '%s' "${MISSING[*]}")"
  fix_cmds=""
  for m in "${MISSING[@]}"; do fix_cmds="${fix_cmds:+$fix_cmds }$m"; done
  printf 'optional-deps-preflight: ENV-FAIL kind=environment-missing-optional-deps count=%s pkgs=%s fix="npm install --no-save %s" — this is an ENVIRONMENT signal, not a per-file test verdict: the suite runs on a worktree whose dependencies are shared, so a package installed only in some other worktree reads as missing here and reds every sibling that depends on it\n' \
    "${#MISSING[@]}" "$pkgs" "$fix_cmds"
fi
exit 1

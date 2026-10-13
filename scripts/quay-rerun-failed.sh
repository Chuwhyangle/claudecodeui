#!/usr/bin/env bash
# quay fan-in failed-file rerun dispatcher.
#
# This script is the target of this project's `.quay/config.yml` `loop.rerun_command`
# declaration. When a fan-in suite reds, the worker-driver rereuns ONLY the files the suite
# named, in the same round and the same fan-in lock; a fully green rerun is read as
# `rerun-green` (a load flake — land as green), a still-red rerun as `rerun-red` (a real red).
# The driver invokes this with the template
#
#     bash {worktree}/scripts/quay-rerun-failed.sh --worktree {worktree} {files}
#
# i.e. `{files}` is spliced element-by-element, one named failed file per argv entry.
#
# WHY A DISPATCHER AND NOT `bash scripts/test.sh {files}`.
#   scripts/test.sh launches its e2e lane ONLY on the full-collection path — the lane lives
#   inside `if [ "$RUN_E2E" = "1" ] && [ ${#FILES[@]} -eq 0 ]` — so a positional
#   `e2e/*.spec.ts` never reaches the playwright lane. It falls into the client vitest bucket,
#   and vitest's include is `src/**` only, so the spec is never executed: vitest finds 0 tests
#   (its own exit 1 is swallowed by test.sh, which exits on its failure tally, not on VRC) and
#   the rerun reads green. That is a vacuous green — neither a browser-arm load flake nor a
#   REAL e2e red could ever be seen through it. This script's whole reason to exist is to send
#   each named file to the runner that actually owns it:
#
#       e2e/*.spec.ts   -> node_modules/.bin/playwright test <spec>        (the e2e lane's runner)
#       everything else -> bash scripts/test.sh --root <worktree> <file>   (server/client lanes)
#
# ⛔ THIS SCRIPT ONLY DISPATCHES. It never retries, never swallows a failure, never turns a red
#    green: every runner's exit status is forwarded and ANY non-zero makes the whole script
#    exit non-zero (the driver reads a non-zero rerun as `rerun-red`). A deterministic failure
#    must not be laundered as a flake — that is the safety boundary of declaring the key at all.
#
# Usage: bash scripts/quay-rerun-failed.sh --worktree <dir> <file> [<file> ...]
# Exit:  0 iff every dispatched runner exited 0; 2 on a usage error.
set -u

WORKTREE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WORKTREE="${2:-}"; shift 2 ;;
    --worktree=*) WORKTREE="${1#*=}"; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    --) shift; break ;;
    -*) echo "quay-rerun-failed: unknown flag: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
FILES=("$@")

if [ -z "$WORKTREE" ]; then
  echo "quay-rerun-failed: --worktree <dir> is required" >&2
  exit 2
fi
if [ ! -d "$WORKTREE" ]; then
  echo "quay-rerun-failed: --worktree is not a directory: $WORKTREE" >&2
  exit 2
fi
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "quay-rerun-failed: no failed files given (usage: --worktree <dir> <file>...)" >&2
  exit 2
fi

# The named files are relative to the tested tree; every runner below is launched from the
# worktree root (test.sh re-derives its own ROOT_DIR from its script path, playwright uses cwd).
cd "$WORKTREE" || { echo "quay-rerun-failed: cannot cd into $WORKTREE" >&2; exit 2; }

rc_all=0
for f in "${FILES[@]}"; do
  case "$f" in
    e2e/*.spec.ts)
      echo "quay-rerun-failed: $f -> playwright (e2e lane runner)" >&2
      node_modules/.bin/playwright test "$f"
      ;;
    *)
      echo "quay-rerun-failed: $f -> scripts/test.sh (server/client lanes)" >&2
      bash scripts/test.sh --root "$WORKTREE" "$f"
      ;;
  esac
  rc=$?
  echo "quay-rerun-failed: $f exit=$rc" >&2
  if [ "$rc" -ne 0 ]; then rc_all=1; fi
done

exit "$rc_all"

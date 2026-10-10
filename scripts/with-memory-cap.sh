#!/usr/bin/env bash
# with-memory-cap.sh <cmd> [args...] — run <cmd> in its own cgroup scope with a hard memory cap.
#
# Why: a runaway test (2026-09-25: chatComposerResponsive.test.tsx, peak 218G of 252G) shares the
# tmux pane's cgroup with everything else started from that pane — the :3001 server, other
# sessions. The kernel OOM killer then takes the WHOLE scope, so an unbounded test looks like
# "the server died". With its own scope the OOM kill is confined to the test.
#
# The command is exec'd, so its stdio, PID and exit status are unchanged. Note the OOM killer picks
# a victim inside the scope, so a multi-process runner (vitest) may exit 1, not 137: ask the journal.
#
# Env:
#   QUAY_MEMORY_MAX=<size>  cap for the scope, systemd size syntax. Explicit values (including `0`
#                           or `off`) are used VERBATIM, with no derivation below — this is the
#                           escape hatch scripts/vitest-heap-limit-check.sh and callers that need an
#                           exact number rely on.
#                           `0` or `off` disables the wrapper and runs <cmd> directly.
#   QUAY_MEMORY_UNIT=<name> name the scope `<name>.scope` instead of a generated one, so the caller
#                           can ask the journal afterwards whether this cap's OOM kill happened
#                           (`journalctl --user -u <name>.scope | grep 'OOM killer'`).
#   QUAY_MEMORY_SLICE=<slice> place the scope under this systemd user slice (e.g. quay-fleet.slice).
#                           `systemd-run --scope` does NOT nest under the caller's cgroup, so without
#                           this the scope escapes any limit set on the caller's own scope. Set by
#                           scripts/start-drivers-scoped.sh so the whole fleet shares one ceiling.
#                           Any cgroup ANCESTOR above this scope (e.g. a container's own memory.max)
#                           still bounds it regardless — cgroup v2 limits compose down the tree, so
#                           this escape hatch cannot exceed what the environment actually has.
#
# Default QUAY_MEMORY_MAX (gap-with-memory-cap-default-adapts-to-effective-memory, 2026-10-09 low-
# compute-stability ruling): when QUAY_MEMORY_MAX is unset (or set to ""), the default is no longer
# the bare literal 24G — it is derived from scripts/effective-capacity.sh's `effective_mem_mb`
# (cgroup v2 memory.max when present, else host total memory), at DEFAULT_CAP_FRACTION of that value,
# clamped to [DEFAULT_CAP_FLOOR_MB, 24576] (24576 MB = 24G, the EXISTING ceiling — a host/cgroup with
# no tighter limit than that still gets exactly 24G, unchanged from before this task). The fraction
# leaves headroom OUTSIDE the cap for the calling shell/session and any sibling processes sharing the
# same enclosing cgroup — on a host/cgroup with no limit at all (effective_mem_mb = total RAM), 75%
# of a 246G host floors back to the unchanged 24G ceiling anyway (24576 < 246000*0.75), so large
# hosts see IDENTICAL behavior to before this task. The probe is read fresh on every invocation
# (cheap: a handful of /sys/fs/cgroup reads, no subprocess spawn beyond the probe itself) rather than
# cached, so a cgroup resize between calls is picked up without restarting anything.
DEFAULT_CAP_FRACTION_NUM=75   # numerator of the safety fraction (75/100 = 75%), see Evidence for why
DEFAULT_CAP_FRACTION_DEN=100
DEFAULT_CAP_FLOOR_MB=512      # never derive a cap tighter than this — a cap this size is still usable
DEFAULT_CAP_CEILING_MB=24576  # = 24G, the pre-existing literal; derivation never exceeds it
set -u

[ "$#" -gt 0 ] || { echo "usage: with-memory-cap.sh <cmd> [args...]" >&2; exit 2; }

if [ -n "${QUAY_MEMORY_MAX:-}" ]; then
  CAP="$QUAY_MEMORY_MAX"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROBE="$SCRIPT_DIR/effective-capacity.sh"
  DERIVED_MB=""
  if [ -r "$PROBE" ]; then
    EFF_LINE="$(bash "$PROBE" 2>/dev/null | grep -m1 '^effective_mem_mb=')"
    EFF_MB="${EFF_LINE#effective_mem_mb=}"
    if [ -n "$EFF_MB" ] && [ "$EFF_MB" -gt 0 ] 2>/dev/null; then
      DERIVED_MB=$(( EFF_MB * DEFAULT_CAP_FRACTION_NUM / DEFAULT_CAP_FRACTION_DEN ))
      [ "$DERIVED_MB" -lt "$DEFAULT_CAP_FLOOR_MB" ] && DERIVED_MB="$DEFAULT_CAP_FLOOR_MB"
      [ "$DERIVED_MB" -gt "$DEFAULT_CAP_CEILING_MB" ] && DERIVED_MB="$DEFAULT_CAP_CEILING_MB"
    fi
  fi
  if [ -n "$DERIVED_MB" ]; then
    CAP="${DERIVED_MB}M"
  else
    CAP="24G"
  fi
fi

case "$CAP" in
  0|off) exec "$@" ;;
esac

SLICE_ARGS=()
[ -n "${QUAY_MEMORY_SLICE:-}" ] && SLICE_ARGS=(--slice="$QUAY_MEMORY_SLICE")

if command -v systemd-run >/dev/null 2>&1 \
  && systemd-run --user --scope --quiet "${SLICE_ARGS[@]+"${SLICE_ARGS[@]}"}" -p MemoryMax="$CAP" -p MemorySwapMax=0 true >/dev/null 2>&1; then
  UNIT_ARGS=()
  [ -n "${QUAY_MEMORY_UNIT:-}" ] && UNIT_ARGS=(--unit="$QUAY_MEMORY_UNIT")
  exec systemd-run --user --scope --quiet "${UNIT_ARGS[@]+"${UNIT_ARGS[@]}"}" "${SLICE_ARGS[@]+"${SLICE_ARGS[@]}"}" -p MemoryMax="$CAP" -p MemorySwapMax=0 -- "$@"
fi

echo "with-memory-cap: no systemd user manager, running uncapped: $1" >&2
exec "$@"

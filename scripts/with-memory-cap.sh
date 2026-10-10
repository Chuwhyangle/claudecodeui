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
#   QUAY_MEMORY_MAX=<size>  cap for the scope, systemd size syntax (default 24G).
#                           `0` or `off` disables the wrapper and runs <cmd> directly.
#   QUAY_MEMORY_UNIT=<name> name the scope `<name>.scope` instead of a generated one, so the caller
#                           can ask the journal afterwards whether this cap's OOM kill happened
#                           (`journalctl --user -u <name>.scope | grep 'OOM killer'`).
#   QUAY_MEMORY_SLICE=<slice> place the scope under this systemd user slice (e.g. claudecodeui.slice,
#                           the name scripts/start-drivers-scoped.sh derives from the project root).
#                           `systemd-run --scope` does NOT nest under the caller's cgroup, so without
#                           this the scope escapes any limit set on the caller's own scope. Set by
#                           scripts/start-drivers-scoped.sh so every scope under one project shares
#                           that project's ceiling.
#
# Degrades to running <cmd> uncapped (with one stderr line saying so) when there is no usable
# systemd user manager, e.g. macOS, containers, CI runners. The probe is a real `true` in a real
# capped scope, because `systemd-run` failing and <cmd> failing are indistinguishable by exit code.
set -u

[ "$#" -gt 0 ] || { echo "usage: with-memory-cap.sh <cmd> [args...]" >&2; exit 2; }

CAP="${QUAY_MEMORY_MAX:-24G}"

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

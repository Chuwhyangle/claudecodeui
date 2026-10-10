#!/usr/bin/env bash
# start-drivers-scoped.sh [start-drivers.js args...] — start the quay drivers (promotion + worker)
# and the web server inside this project's memory-capped slice.
#
# Why: the 2026-09-25 host OOM happened in a scope that a session had started ad hoc with no
# `MemoryMax`, so the drivers and every worker they spawn (claude sessions running vitest, tsx, tsc)
# could take all 252G of a host shared with other users. This puts them under one ceiling.
#
# The slice is named after THIS project's root directory: default `<basename ROOT_DIR>.slice`
# (`claudecodeui.slice` for this repo). It used to be a literal shared name taken from another,
# paused project. A slice name is global to the systemd user manager, so a literal shared here means
# two checkouts share one ceiling AND one `memory.peak` — and that peak was measured at 54.99G once
# without any way to say which project caused it. Deriving the name from the root gives each project
# its own slice and its own reading.
#
# A name is also not cosmetic: systemd reads `a-b.slice` as a CHILD of `a.slice`. A default that
# still began with the other project's prefix (`<other>-<project>.slice`) would silently nest inside
# that project's slice instead of standing alone. `<basename ROOT_DIR>.slice` cannot do that.
#
# An explicit `QUAY_MEMORY_SLICE` still wins verbatim, so pointing several projects at one ceiling
# stays possible — it just has to be asked for.
#
# The slice does NOT have to exist beforehand. When its unit file is missing this script writes
# `~/.config/systemd/user/<slice>` from the template below and runs `systemctl --user
# daemon-reload`; systemd then loads the fragment and applies its MemoryHigh/MemoryMax to the slice
# (also when the slice had already appeared as a runtime-only unit). A fresh machine therefore
# needs no hand-made unit file, and "scoped" no longer depends on remembering to make one. The
# numbers are the provisional 48G/64G, overridable with `QUAY_SLICE_MEMORY_HIGH` /
# `QUAY_SLICE_MEMORY_MAX`; re-read the slice's own `memory.peak` after a few days of real use and
# re-set them.
#
# `QUAY_MEMORY_SLICE` is exported so scripts/with-memory-cap.sh puts each per-test scope under the
# SAME slice: `systemd-run --scope` does not nest under the caller's cgroup, so without it those
# scopes would sit outside the ceiling. `OOMPolicy=continue` keeps one OOM-killed worker from
# stopping the whole scope (systemd's default for a scope would be to stop it).
#
# `QUAY_TEST_SYSTEMD_RUN_LIMITS` is the second half of the same idea, for the full-suite runner. That
# runner wraps the whole suite in its OWN `systemd-run --scope`, whose cap comes from the plugin's
# `DEFAULT_SYSTEMD_RUN_LIMITS` = 6G unless overridden. That scope is created by the runner, so it
# lands in `app.slice` and NOT in the slice above — this ceiling does not back it, and its own 6G is
# the only thing bounding it. 6G is below what the suite needs: the server phase runs 163 per-file
# `node --test` processes, 16 at a time, several of which spawn a real `claude` CLI (~300-430MB each
# measured) — so the scope is OOM-killed ~33s in and the suite reports "terminated by an external
# signal before the suite finished". The driver cannot attribute that to any file, so EVERY fan-in
# parks its task at needs-human and no task can ever land. 24G is the value
# scripts/with-memory-cap.sh already budgets for this same suite (QUAY_MEMORY_MAX), so the two
# wrappers around one suite now agree instead of disagreeing by 4x.
#
# Env:
#   QUAY_MEMORY_SLICE              slice to run under (default <basename of this repo>.slice)
#   QUAY_SLICE_MEMORY_HIGH         MemoryHigh for a slice this script has to create (default 48G)
#   QUAY_SLICE_MEMORY_MAX          MemoryMax for a slice this script has to create (default 64G)
#   QUAY_SLICE_UNIT_DIR            directory holding slice unit files
#                                  (default $HOME/.config/systemd/user; a test seam)
#   QUAY_ENSURE_SLICE_ONLY=1       create the slice if missing, print its MemoryMax, exit without
#                                  starting the drivers (operator/test seam)
#   START_DRIVERS_SCOPED_DRY_RUN=1 resolve and print the slice name and the unit text that would be
#                                  written; call no systemd and exit (test seam)
#   QUAY_TEST_SYSTEMD_RUN_LIMITS   cap the full-suite runner puts on its own scope
#                                  (default MemoryMax=24G; the plugin's own default is 6G)
#   QUAY_PLUGIN_DIR                quay plugin dir holding scripts/dist/start-drivers.js
#                                  (default: newest release under ~/.claude/plugins/cache/quay/quay/)
set -eu

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLICE="${QUAY_MEMORY_SLICE:-$(basename "$ROOT_DIR").slice}"
SLICE_HIGH="${QUAY_SLICE_MEMORY_HIGH:-48G}"
SLICE_MAX="${QUAY_SLICE_MEMORY_MAX:-64G}"
SLICE_UNIT_DIR="${QUAY_SLICE_UNIT_DIR:-$HOME/.config/systemd/user}"
SLICE_UNIT_FILE="$SLICE_UNIT_DIR/$SLICE"
SUITE_LIMITS="${QUAY_TEST_SYSTEMD_RUN_LIMITS:-MemoryMax=24G}"

# The unit text is one function so the dry run and the real write can never drift apart.
slice_unit_text() {
  cat <<EOF
[Unit]
Description=Memory ceiling for $SLICE (quay drivers and their workers)

[Slice]
# Throttle first (reclaim pressure), kill only past MemoryMax. Values are provisional: calibrate
# from this slice's own memory.peak after a day of real use. See
# docs/operations/process-isolation-and-memory-caps.md in the claudecodeui repo.
MemoryHigh=$SLICE_HIGH
MemoryMax=$SLICE_MAX
MemorySwapMax=0
EOF
}

if [ "${START_DRIVERS_SCOPED_DRY_RUN:-}" = 1 ]; then
  echo "dry-run: slice=$SLICE"
  echo "dry-run: unit-file=$SLICE_UNIT_FILE"
  if [ -e "$SLICE_UNIT_FILE" ]; then
    echo "dry-run: action=exists"
  else
    echo "dry-run: action=would-create"
    echo "dry-run: --- unit ---"
    slice_unit_text
    echo "dry-run: --- end unit ---"
  fi
  exit 0
fi

# Create the slice's unit the first time it is needed. `systemctl --user daemon-reload` is what
# makes systemd load the fragment and apply its MemoryHigh/MemoryMax to the slice; without it a
# fresh machine would have to build the file by hand. A failed reload is reported, not fatal: the
# MemoryMax check below still refuses to start the drivers uncapped, and `QUAY_ENSURE_SLICE_ONLY`
# prints the reading so the operator can see the slice did not take.
if [ ! -e "$SLICE_UNIT_FILE" ]; then
  mkdir -p "$SLICE_UNIT_DIR"
  slice_unit_text > "$SLICE_UNIT_FILE"
  if systemctl --user daemon-reload 2>/dev/null; then
    echo "start-drivers-scoped: created $SLICE_UNIT_FILE (MemoryHigh=$SLICE_HIGH MemoryMax=$SLICE_MAX)"
  else
    echo "start-drivers-scoped: wrote $SLICE_UNIT_FILE but 'systemctl --user daemon-reload' failed — the slice is not active yet" >&2
  fi
fi

if [ "${QUAY_ENSURE_SLICE_ONLY:-}" = 1 ]; then
  echo "start-drivers-scoped: $SLICE MemoryMax=$(systemctl --user show "$SLICE" -p MemoryMax --value 2>/dev/null || echo unset) (ensure-slice-only, drivers not started)"
  exit 0
fi

if [ -z "${QUAY_PLUGIN_DIR:-}" ]; then
  base="$HOME/.claude/plugins/cache/quay/quay"
  newest="$(ls "$base" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
  [ -n "$newest" ] || { echo "start-drivers-scoped: no released quay plugin under $base" >&2; exit 1; }
  QUAY_PLUGIN_DIR="$base/$newest"
fi
[ -f "$QUAY_PLUGIN_DIR/scripts/dist/start-drivers.js" ] \
  || { echo "start-drivers-scoped: missing $QUAY_PLUGIN_DIR/scripts/dist/start-drivers.js" >&2; exit 1; }

# QUAY_PLUGIN_DIR above picks the ORCHESTRATOR only. `start-drivers.js` does not use its own plugin
# root for the two things that actually stay resident — it shells out to the BARE `quay` on PATH for
# both `driver start --kind <k>` and `serve` (it prints `start-drivers: quay CLI = quay`). So with an
# older release's bin dir earlier on PATH, this script starts the newest orchestrator and the
# OLDEST kernel + web server, while its own output looks like a normal start.
#
# Measured 2026-10-05 (claudecodeui, PATH held .../quay/quay/0.11.0/bin before .../0.14.0/bin even
# though 0.14.0 is the installed release): the restart came up 0.11.0 end-to-end — `quay driver
# status` reported `loaded-version-behind: loaded=0.11.0 installed=0.14.0` and the anchor's own
# `source_watch_dir` named .../0.11.0/scripts/dist — with 0.14.0's start-drivers.js as the parent.
# A restart that silently loads the version you were replacing is worse than one that fails.
#
# Pin PATH to this plugin dir so the CLI that starts everything is the same release as the
# orchestrator. Fail closed rather than fall back: a silent fallback to whatever `quay` PATH happens
# to hold is the exact defect above.
[ -x "$QUAY_PLUGIN_DIR/bin/quay" ] \
  || { echo "start-drivers-scoped: missing $QUAY_PLUGIN_DIR/bin/quay — refusing to fall back to whatever 'quay' PATH holds" >&2; exit 1; }
export PATH="$QUAY_PLUGIN_DIR/bin:$PATH"

# The slice must exist AND carry a MemoryMax, or "scoped" would be a lie.
max="$(systemctl --user show "$SLICE" -p MemoryMax --value 2>/dev/null || true)"
case "$max" in
  ''|infinity) echo "start-drivers-scoped: $SLICE has no MemoryMax (got '${max:-unset}') — refusing to start uncapped" >&2; exit 1 ;;
esac

# `docker`-style guard: do not start a second set of drivers for this root.
if pgrep -u "$(id -u)" -f "driver-anchor.js __anchor --root $ROOT_DIR" >/dev/null 2>&1; then
  echo "start-drivers-scoped: drivers already running for $ROOT_DIR" >&2
  exit 1
fi

UNIT="quay-drivers-$(basename "$ROOT_DIR")-$(date +%s)"
echo "start-drivers-scoped: $UNIT.scope in $SLICE (MemoryMax=$max, full-suite scope $SUITE_LIMITS)"
exec systemd-run --user --scope --quiet --unit="$UNIT" --slice="$SLICE" -p OOMPolicy=continue -- \
  env QUAY_MEMORY_SLICE="$SLICE" \
      QUAY_TEST_SYSTEMD_RUN_LIMITS="$SUITE_LIMITS" \
  node "$QUAY_PLUGIN_DIR/scripts/dist/start-drivers.js" --root "$ROOT_DIR" "$@"

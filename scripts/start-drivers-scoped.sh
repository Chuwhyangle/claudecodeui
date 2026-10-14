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
# ── The wiring that makes the slice an actual ceiling (gap-project-slice-actually-binds-… 2026-10-14)
#
# `QUAY_MEMORY_SLICE` alone was never enough. systemd-run does NOT nest a transient scope under the
# caller's cgroup: a `systemd-run --user --scope` with no `--slice` lands in `app.slice`, the user
# manager's default. The outer scope this script creates below therefore DID land in the slice, but
# every scope the AND INSIDE it created — the anchor, the serve host, and the full-suite runner's own
# scope — landed in `app.slice` instead, where no project ceiling backstops them. Measured
# 2026-10-14: the running anchor's cgroup was
# `…/user@1004.service/app.slice/quay-anchor-claudecodeui-<ms>.scope` and a real suite's
# `.quay/suite-cgroup-evidence.txt` recorded `ControlGroup=…/app.slice/run-uXXXX.scope`, while
# `systemctl --user show claudecodeui.slice -p MemoryPeak` read 1.09 MB — nothing had ever run under
# the slice. "Scoped" was a name, not a boundary.
#
# The launcher cannot be told the slice: the quay runtime that creates those scopes hard-codes
# `systemd-run --user --scope --collect --unit=… -p MemoryAccounting=yes -p OOMPolicy=continue` with
# no `--slice` and reads no slice env var. So this script WIRES the slice in at the one choke point
# every one of those calls goes through: PATH. It installs a `systemd-run` shim (below) into
# `QUAY_SLICE_SHIM_DIR`, puts that directory first on the child's PATH, and exports
# `QUAY_REAL_SYSTEMD_RUN` so the shim can reach the real binary. The shim adds `--slice=<slice>` to
# any `systemd-run --user …` call that did not name a slice itself — `with-memory-cap.sh` already
# names one, so it is a no-op there — and the anchor/serve/suite scopes all land under the project
# slice. A restart of the drivers is what makes it live: the currently-running anchor was started
# before this wiring and cannot be moved, so "MemoryPeak is no longer ~1 MB" only becomes true after
# the next real start.
#
# ⛔ NOT done here, deliberately: no existing MemoryMax/MemoryHigh/MemorySwapMax NUMBER is touched
# (the 48G/64G/0 stay). This file only wires and verifies; it does not re-budget.
#
# Env:
#   QUAY_MEMORY_SLICE              slice to run under (default <basename of this repo>.slice)
#   QUAY_SLICE_MEMORY_HIGH         MemoryHigh for a slice this script has to create (default 48G)
#   QUAY_SLICE_MEMORY_MAX          MemoryMax for a slice this script has to create (default 64G)
#   QUAY_SLICE_UNIT_DIR            directory holding slice unit files
#                                  (default $HOME/.config/systemd/user; a test seam)
#   QUAY_SLICE_SHIM_DIR            where the systemd-run shim is installed
#                                  (default ${XDG_CACHE_HOME:-$HOME/.cache}/quay-slice-shim/<slice>;
#                                  a test seam — the shim must persist for the anchor's whole life)
#   QUAY_SLICE_SYSTEMCTL           command used to read the slice back (default `systemctl --user`;
#                                  a test seam so the fail-closed path can be driven without systemd)
#   QUAY_ENSURE_SLICE_ONLY=1       create the slice if missing, print its MemoryMax, exit without
#                                  starting the drivers (operator/test seam)
#   QUAY_SLICE_SHIM_ONLY=1         install the systemd-run shim, print its directory, exit without
#                                  starting the drivers (operator/test seam)
#   QUAY_SLICE_VALIDATE_ONLY=1     create the slice, run the dash guard and the MemoryMax
#                                  fail-closed check, exit 0 when the slice is usable (operator/test
#                                  seam; the real start path runs the same checks and then continues)
#   START_DRIVERS_SCOPED_DRY_RUN=1 resolve and print the slice name, the unit text that would be
#                                  written, and the shim that would be installed; call no systemd and
#                                  write nothing (test seam)
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
SLICE_SHIM_DIR="${QUAY_SLICE_SHIM_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/quay-slice-shim/$SLICE}"

# The command used to read a slice back. A test seam so the fail-closed path can be exercised on a
# host (or CI) where the `systemctl --user` that matters is not the one under test.
SLICE_SYSTEMCTL_RAW="${QUAY_SLICE_SYSTEMCTL:-systemctl --user}"
read -r -a SYSTEMCTL <<<"$SLICE_SYSTEMCTL_RAW"

# A slice name that contains a dash is a position in the tree, not just a name: systemd reads
# `a-b.slice` as a CHILD of `a.slice`, whose ceiling is `infinity`. Such a name would silently gain
# an unlimited parent and the ceiling this script promises would not cover the tree. Refuse rather
# than nest — the operator can pass a dash-free `QUAY_MEMORY_SLICE` explicitly.
case "${SLICE%.slice}" in
  *-*) echo "start-drivers-scoped: slice '$SLICE' contains '-' — systemd reads 'a-b.slice' as a child of 'a.slice', so this would silently nest under an unlimited parent slice and no project ceiling would bind; set QUAY_MEMORY_SLICE to a dash-free name" >&2; exit 1 ;;
esac

# The real systemd-run, found on PATH WITHOUT the shim directory (which may itself be on PATH when
# this script is invoked from inside an already-shimmed tree). Empty when systemd-run is absent.
resolve_real_systemd_run() {
  local dir IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] || dir="."
    case "$dir" in "$SLICE_SHIM_DIR") continue ;; esac
    if [ -x "$dir/systemd-run" ]; then printf '%s\n' "$dir/systemd-run"; return 0; fi
  done
  return 1
}
REAL_SYSTEMD_RUN="$(resolve_real_systemd_run || true)"

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

# The shim is one function too: the dry run, the shim-only seam and the real install all emit it
# from here, so they can never drift apart.
slice_shim_text() {
  cat <<EOF
#!/usr/bin/env bash
# systemd-run shim — installed by scripts/start-drivers-scoped.sh (claudecodeui).
#
# Why: systemd-run --scope does NOT nest a transient unit under the caller's cgroup; a
# \`systemd-run --user --scope\` with no \`--slice\` lands in \`app.slice\`, the user manager's
# default. The quay runtime creates the anchor, the serve host and the full-suite scope that way
# (no \`--slice\`, no slice env var), so without this shim those scopes escape the project slice and
# nothing bounds them by project. This shim routes every user-manager transient unit into
# \`$SLICE\` by adding \`--slice=$SLICE\` to any invocation that did not name a slice itself.
#
# It is a no-op when the caller already chose a slice (scripts/with-memory-cap.sh passes
# --slice=\$QUAY_MEMORY_SLICE), and it only touches \`--user\` invocations so a system-manager
# systemd-run is left alone.
set -eu
real="\${QUAY_REAL_SYSTEMD_RUN:-systemd-run}"
slice="\${QUAY_MEMORY_SLICE:-}"
want_slice=1
has_user=0
for a in "\$@"; do
  case "\$a" in
    --user) has_user=1 ;;
    --slice|--slice=*|--slice-inherit|Slice=*) want_slice=0 ;;
  esac
done
if [ "\$want_slice" = 1 ] && [ -n "\$slice" ] && [ "\$has_user" = 1 ]; then
  exec "\$real" --slice="\$slice" "\$@"
fi
exec "\$real" "\$@"
EOF
}

# Install the shim into a stable directory (it must outlive this script: the drivers \`exec\` below
# and run for days). Returns non-zero — and installs nothing — when the real systemd-run is unknown,
# because a shim that cannot find the real binary would recurse into itself.
install_slice_shim() {
  [ -n "$REAL_SYSTEMD_RUN" ] || return 1
  mkdir -p "$SLICE_SHIM_DIR"
  slice_shim_text > "$SLICE_SHIM_DIR/systemd-run"
  chmod +x "$SLICE_SHIM_DIR/systemd-run"
}

if [ "${START_DRIVERS_SCOPED_DRY_RUN:-}" = 1 ]; then
  echo "dry-run: slice=$SLICE"
  echo "dry-run: unit-file=$SLICE_UNIT_FILE"
  echo "dry-run: shim-dir=$SLICE_SHIM_DIR"
  echo "dry-run: real-systemd-run=${REAL_SYSTEMD_RUN:-unset}"
  if [ -e "$SLICE_UNIT_FILE" ]; then
    echo "dry-run: action=exists"
  else
    echo "dry-run: action=would-create"
    echo "dry-run: --- unit ---"
    slice_unit_text
    echo "dry-run: --- end unit ---"
  fi
  echo "dry-run: --- shim ---"
  slice_shim_text
  echo "dry-run: --- end shim ---"
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
  if "${SYSTEMCTL[@]}" daemon-reload 2>/dev/null; then
    echo "start-drivers-scoped: created $SLICE_UNIT_FILE (MemoryHigh=$SLICE_HIGH MemoryMax=$SLICE_MAX)"
  else
    echo "start-drivers-scoped: wrote $SLICE_UNIT_FILE but '${SYSTEMCTL[*]} daemon-reload' failed — the slice is not active yet" >&2
  fi
fi

# The slice must exist AND carry a MemoryMax, or "scoped" would be a lie. Both the real start path
# and `QUAY_SLICE_VALIDATE_ONLY` read it through here, so they can never disagree.
require_slice_memory_max() {
  local max
  max="$("${SYSTEMCTL[@]}" show "$SLICE" -p MemoryMax --value 2>/dev/null || true)"
  case "$max" in
    ''|infinity) echo "start-drivers-scoped: $SLICE has no MemoryMax (got '${max:-unset}') — refusing to start uncapped" >&2; return 1 ;;
  esac
  printf '%s\n' "$max"
}

if [ "${QUAY_SLICE_SHIM_ONLY:-}" = 1 ]; then
  if install_slice_shim; then
    echo "start-drivers-scoped: installed systemd-run shim at $SLICE_SHIM_DIR/systemd-run (slice=$SLICE, real=$REAL_SYSTEMD_RUN)"
    exit 0
  fi
  echo "start-drivers-scoped: cannot install the slice shim — no systemd-run on PATH" >&2
  exit 1
fi

if [ "${QUAY_ENSURE_SLICE_ONLY:-}" = 1 ]; then
  echo "start-drivers-scoped: $SLICE MemoryMax=$("${SYSTEMCTL[@]}" show "$SLICE" -p MemoryMax --value 2>/dev/null || echo unset) (ensure-slice-only, drivers not started)"
  exit 0
fi

if [ "${QUAY_SLICE_VALIDATE_ONLY:-}" = 1 ]; then
  max="$(require_slice_memory_max)" || exit 1
  echo "start-drivers-scoped: $SLICE usable (MemoryMax=$max, shim-dir=$SLICE_SHIM_DIR)"
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

# The slice must carry a MemoryMax, or "scoped" would be a lie. Same check as the validate-only
# seam above.
max="$(require_slice_memory_max)" || exit 1

# `docker`-style guard: do not start a second set of drivers for this root.
if pgrep -u "$(id -u)" -f "driver-anchor.js __anchor --root $ROOT_DIR" >/dev/null 2>&1; then
  echo "start-drivers-scoped: drivers already running for $ROOT_DIR" >&2
  exit 1
fi

# Install the slice shim and hand it to the whole driver tree through PATH, so the anchor / serve /
# full-suite scopes the quay runtime creates (with no `--slice` of their own) land under $SLICE. A
# host without systemd-run cannot be scoped at all; the outer systemd-run below would have failed
# anyway, so report it rather than start silently unwired.
install_slice_shim \
  || { echo "start-drivers-scoped: cannot install the slice wiring shim — no systemd-run on PATH" >&2; exit 1; }

UNIT="quay-drivers-$(basename "$ROOT_DIR")-$(date +%s)"
echo "start-drivers-scoped: $UNIT.scope in $SLICE (MemoryMax=$max, full-suite scope $SUITE_LIMITS, shim=$SLICE_SHIM_DIR)"
exec systemd-run --user --scope --quiet --unit="$UNIT" --slice="$SLICE" -p OOMPolicy=continue -- \
  env QUAY_MEMORY_SLICE="$SLICE" \
      QUAY_TEST_SYSTEMD_RUN_LIMITS="$SUITE_LIMITS" \
      QUAY_REAL_SYSTEMD_RUN="$REAL_SYSTEMD_RUN" \
      PATH="$SLICE_SHIM_DIR:$PATH" \
  node "$QUAY_PLUGIN_DIR/scripts/dist/start-drivers.js" --root "$ROOT_DIR" "$@"

#!/usr/bin/env bash
# scripts/effective-capacity.sh — cgroup-v2-aware "effective capacity" probe (read-only).
#
# Why this exists (gap-effective-capacity-probe-cgroup-cpu-mem-quota, 2026-10-09 ruling: low-compute
# stability over cross-project shared locks): this repo's hardcoded test-tuning literals
# (scripts/test.sh --test-concurrency=16, vitest.config.ts CLIENT_MAX_WORKERS=8,
# scripts/with-memory-cap.sh QUAY_MEMORY_MAX=24G) were all measured on THIS 128-core/246GB host and
# never re-derived for a cgroup limited to 2/4/8 effective cores or a few GB of memory. `nproc` does
# NOT reflect a cgroup v2 CPU bandwidth quota (`cpu.max`) — measured on this host: CPUQuota=250% ->
# `nproc` still reports 128. This script reads the SAME files the kernel writes for its own cgroup v2
# limits and reports the EFFECTIVE value with its PROVENANCE, so callers can derive from a real number
# instead of a host-wide one.
#
# This is a bash-native port of quay's plugin/scripts/effective-capacity-probe.ts (frozen output
# contract, 2026-10-09 cross-project field alignment between ClaudeCodeUI and quay — see
# tasks/gap-effective-capacity-probe-cgroup-cpu-mem-quota.md). It is a PORT, not a dependency: this
# script never reads anything under a quay plugin install path, so it works whether or not quay is
# installed, and under any quay version or absolute install location.
#
# One deliberate divergence from the quay port, disclosed rather than hidden: quay's `nproc` field is
# sourced from Node's `os.availableParallelism()`, which (measured on this host, Node v24.21.0) IS
# itself cgroup-bandwidth-quota-aware — so their "fallback" reading is already correct even when the
# cgroup files can't be read. Bash's `nproc` command is NOT quota-aware (measured on this host:
# CPUQuota=50%/250%/400% -> `nproc` stays 128 every time) — there is no bash-native equivalent of
# availableParallelism(). This script's `nproc` field is therefore a strictly weaker fallback than
# quay's; the PRIMARY path (reading cpu.max directly) is identical and equally reliable in both.
#
# ── Hierarchical limits: the OWN cgroup is not the whole story (2026-10-14) ─────────────────────────
# (gap-effective-capacity-scope-own-budget-and-actual-concurrency-display)
#
# In cgroup v2 a controller's files exist ONLY in a cgroup that has that controller enabled
# (`cgroup.controllers`). The caller's OWN cgroup frequently has none — measured on this host, a
# systemd --user scope under a slice whose `cgroup.subtree_control` omits `cpu` has NO `cpu.max`
# file at all, while the SLICE above it carries the real bandwidth quota. Reading only the own
# directory therefore answered `nproc-fallback` on a quota-constrained host: the mechanism that
# scripts/test.sh's adaptive ceiling promised (see its `adaptive_ceiling()`) was inert, and the
# value of `effective_cpu` was always the host's 128, so the ceiling was decided by the literal
# CEILING_CAP=16 by coincidence rather than by the quota. Measured 2026-10-14, live, no seam:
#
#   $ systemctl --user set-property eccprobe.slice CPUQuota=200%
#   $ systemd-run --user --scope --slice=eccprobe.slice -- bash scripts/effective-capacity.sh
#   effective_cpu=128   cpu_source=nproc-fallback     # WRONG: the quota is 2 cores
#
# This script now walks the caller's cgroup ANCESTOR CHAIN (root .. own) and takes the MINIMUM of
# every readable quota along it. That is the correct composition for cgroup v2 CPU bandwidth, where
# a child's effective quota is the min of its own and all its ancestors' — so a quota that lives
# only on an ancestor is now reported instead of being silently missed. `cpuset.cpus.effective` is
# deliberately NOT walked: the kernel already intersects the whole chain into that file, and at an
# unrelated ancestor it merely mirrors the host's own CPU set (measured: `user.slice` reports
# `0-127` = the whole 128-core host), so reading it from above would report a "constraint" that is
# not one. It stays an OWN-cgroup reading, as before.
#
# `cpu_source` keeps the frozen value set (cgroup-cpu-max|cpuset|nproc-fallback); a quota found on
# an ancestor reports `cgroup-cpu-max` exactly like one on the own cgroup, because it IS the same
# kind of reading. When NO level of the chain imposes a quota, the source is `nproc-fallback` — the
# explicit "there is no quota" semantic, never a silent fallback that looks like a measurement.
#
# Two memory numbers are now reported SEPARATELY, because they answer two different questions:
#   effective_mem_mb   the MINIMUM numeric memory.max over the whole chain — the conservative budget
#                      an outer cgroup will actually enforce on this process (unchanged meaning for
#                      every consumer that just wants "how much am I really allowed").
#   scope_mem_max_mb   the caller's OWN cgroup's memory.max — "what THIS scope may use". This is the
#                      number a suite asks for: a 16 GiB suite scope nested inside an 8 GiB session
#                      cap must read 16384 here, not the outer 8192, or the consumer would starve
#                      the suite to a budget that is not its own. When the own cgroup has no limit
#                      of its own (`memory.max` == "max"), the NEAREST ancestor that does impose one
#                      supplies the value, and `scope_mem_source` says which of the two it was —
#                      the two keys never overwrite each other.
#
# ── Fail-open by contract ─────────────────────────────────────────────────────────────────────────
# cgroup v2 unavailable (no unified hierarchy, no "0::" line in /proc/self/cgroup, cpu.max/memory.max
# absent or unparsable) => fall back to nproc / host total memory, and REPORT that it fell back via
# the *_source fields and cgroup_v2=false. This script never exits non-zero because of what it reads;
# report mode always exits 0.
#
# ── The third state ───────────────────────────────────────────────────────────────────────────────
# "cgroup present but imposes no limit of this kind" (cpu.max == "max", memory.max == "max") is a
# DIFFERENT fact from "cgroup unavailable" (no unified hierarchy at all) — both end up using the same
# fallback VALUE, but cgroup_v2 distinguishes which one actually happened:
#   cgroup_v2=false                    -> no cgroup was read at all; every value is a host fallback.
#   cgroup_v2=true  + source=cgroup-*   -> the cgroup file supplied this value.
#   cgroup_v2=true  + source=*-fallback -> the cgroup WAS readable but imposed no limit of that kind.
#
# ── Output contract (the first six field names frozen by the 2026-10-09 cross-project alignment;
#    the two `scope_mem_*` fields are a 2026-10-14 repo-local ADDITION appended after them, so a
#    consumer that reads by field name — or by position among the first six — is unaffected) ────────
# report mode: one `key=value` per line, in this order:
#   effective_cpu=<int>          min(bandwidth-quota cores, cpuset cores, nproc) — the final value
#   cpu_source=cgroup-cpu-max|cpuset|nproc-fallback
#   effective_mem_mb=<int>       min numeric memory.max over the ancestor chain, else host total
#   mem_source=cgroup-memory-max|free-fallback
#   nproc=<int>                  the control reading (host/affinity), NOT the final value
#   cgroup_v2=true|false
#   scope_mem_max_mb=<int>       the caller's OWN cgroup's memory.max (nearest ancestor when the own
#                                cgroup imposes none), else host total
#   scope_mem_source=cgroup-memory-max|ancestor-cgroup-memory-max|free-fallback
# `--json` prints exactly the same eight fields as one JSON object with unchanged key names.
#
# Tie-break when two CPU candidates give the same minimum: cgroup-cpu-max > cpuset > nproc-fallback
# (a cgroup constraint that happens to equal the host reading is still the cgroup constraint).
#
# ── Test seams (they override the RAW READINGS, not a second code path) ────────────────────────────
#   EFFECTIVE_CAPACITY_TEST_CPU_MAX             override the OWN cpu.max raw text ("200000 100000")
#   EFFECTIVE_CAPACITY_TEST_ANCESTOR_CPU_MAX    override the ANCESTOR-chain cpu.max reading — the
#                                               value a single synthetic ancestor level contributes,
#                                               i.e. how the nested "quota lives above me" case is
#                                               exercised without touching the host's systemd
#   EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT        override the cpuset core COUNT (integer)
#   EFFECTIVE_CAPACITY_TEST_MEMORY_MAX          override the OWN memory.max raw text (bytes / "max")
#   EFFECTIVE_CAPACITY_TEST_ANCESTOR_MEMORY_MAX override the ancestor-chain memory.max reading (same
#                                               synthetic-ancestor semantics as the CPU one above)
#   EFFECTIVE_CAPACITY_TEST_NPROC               override the nproc reading (integer)
#   EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB        override the memory FALLBACK reading (MB)
# Setting any of the cgroup seams (CPU_MAX, ANCESTOR_CPU_MAX, CPUSET_COUNT, MEMORY_MAX,
# ANCESTOR_MEMORY_MAX) asserts a cgroup IS present (that is what the seam simulates), so cgroup_v2
# reads true even on a host without a unified hierarchy. A seam set to the empty string still counts
# as "set" (distinguishes "set but empty" from "not set at all").
#
# Seams are HERMETIC per controller: setting ANY seam of a controller makes every level of that
# controller come from seams, so no seamed case silently depends on the host's cgroup. CPU group =
# CPU_MAX / ANCESTOR_CPU_MAX / CPUSET_COUNT / NPROC; memory group = MEMORY_MAX / ANCESTOR_MEMORY_MAX /
# MEM_AVAIL_MB. The real ancestor walk and the real own-directory reads alike are skipped for a seamed
# controller; a level the seams leave unnamed simply contributes no candidate. The all-real path — no
# seams, i.e. production and the live systemd-run tests — is unaffected. The `nproc=` output FIELD is
# still always filled with a number (falling back to the real reading), since the frozen contract
# always emits it.
#
# Usage:
#   scripts/effective-capacity.sh            # report mode
#   scripts/effective-capacity.sh --json     # JSON mode
#   scripts/effective-capacity.sh --help     # usage, exit 0
#
# Exit status: 0 = report emitted (report mode never fails — fail-open by contract);
#              2 = usage error (an unrecognized argument).
#
# Tests: scripts/effective-capacity.test.mjs
set -u

CGROUP_ROOT="/sys/fs/cgroup"
PROC_SELF_CGROUP="/proc/self/cgroup"
MB=$((1024 * 1024))

USAGE='effective-capacity.sh — cgroup-v2-aware effective capacity probe (read-only)
usage: scripts/effective-capacity.sh [--json] [--help]
  (no flag)  report mode: one key=value line per field (effective_cpu, cpu_source, effective_mem_mb,
             mem_source, nproc, cgroup_v2, scope_mem_max_mb, scope_mem_source)
  --json     the same eight fields as one JSON object
  --help,-h  print this usage and exit 0'

json_mode=0
for arg in "$@"; do
  case "$arg" in
    --json) json_mode=1 ;;
    --help|-h) printf '%s\n' "$USAGE"; exit 0 ;;
    *) printf 'effective-capacity.sh: unknown argument: %s\n%s\n' "$arg" "$USAGE" >&2; exit 2 ;;
  esac
done

# ── seam presence (distinguishes "unset" from "set to empty string") ───────────────────────────────
cpu_max_seam_set=0;    [ -v EFFECTIVE_CAPACITY_TEST_CPU_MAX ]      && cpu_max_seam_set=1
anc_cpu_seam_set=0;    [ -v EFFECTIVE_CAPACITY_TEST_ANCESTOR_CPU_MAX ] && anc_cpu_seam_set=1
cpuset_seam_set=0;     [ -v EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT ] && cpuset_seam_set=1
memory_max_seam_set=0; [ -v EFFECTIVE_CAPACITY_TEST_MEMORY_MAX ]   && memory_max_seam_set=1
anc_mem_seam_set=0;    [ -v EFFECTIVE_CAPACITY_TEST_ANCESTOR_MEMORY_MAX ] && anc_mem_seam_set=1
nproc_seam_set=0;      [ -v EFFECTIVE_CAPACITY_TEST_NPROC ]        && nproc_seam_set=1
mem_avail_seam_set=0;  [ -v EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB ] && mem_avail_seam_set=1

seam_implies_cgroup=0
if [ "$cpu_max_seam_set" = 1 ] || [ "$anc_cpu_seam_set" = 1 ] || [ "$cpuset_seam_set" = 1 ] \
   || [ "$memory_max_seam_set" = 1 ] || [ "$anc_mem_seam_set" = 1 ]; then
  seam_implies_cgroup=1
fi

# A controller's ANCESTOR-CHAIN WALK runs only when no seam of that controller is set at all. Reason:
# a seam exists to make a reading reproducible, and the ancestor walk reads the REAL host chain — so a
# test that pins one level by seam and leaves the walk live would have a host-dependent result (a test
# asserting "own memory.max = max, so derive from host total" would silently read, on a host whose own
# enclosing cgroup carries a limit, that limit instead). Gating every cgroup read of a seamed
# controller keeps each seamed case hermetic while leaving the all-real path (no seams — production,
# and the live systemd-run tests) exactly as it is.
#
# Group membership is by CONTROLLER, so a seam suppresses every level of it, including the one it does
# not name: a test that seams only "the ancestor chain has no quota" must not silently start depending
# on the host's own cpu.max either. CPU group = CPU_MAX, ANCESTOR_CPU_MAX, CPUSET_COUNT, NPROC.
# Memory group = MEMORY_MAX, ANCESTOR_MEMORY_MAX, MEM_AVAIL_MB.
cpu_seam_group=0
if [ "$cpu_max_seam_set" = 1 ] || [ "$anc_cpu_seam_set" = 1 ] || [ "$cpuset_seam_set" = 1 ] \
   || [ "$nproc_seam_set" = 1 ]; then
  cpu_seam_group=1
fi
mem_seam_group=0
if [ "$memory_max_seam_set" = 1 ] || [ "$anc_mem_seam_set" = 1 ] || [ "$mem_avail_seam_set" = 1 ]; then
  mem_seam_group=1
fi

# ── cgroup v2 detection + this process's own cgroup directory ───────────────────────────────────────
mounted=0
[ -f "$CGROUP_ROOT/cgroup.controllers" ] && mounted=1

rel_path=""
have_rel_path=0
if [ -r "$PROC_SELF_CGROUP" ]; then
  while IFS= read -r line; do
    case "$line" in
      0::*)
        rel_path="${line#0::}"
        [ -z "$rel_path" ] && rel_path="/"
        have_rel_path=1
        break
        ;;
    esac
  done < "$PROC_SELF_CGROUP"
fi

cg_dir=""
if [ "$mounted" = 1 ] && [ "$have_rel_path" = 1 ]; then
  cg_dir="$CGROUP_ROOT$rel_path"
fi

cgroup_v2=false
if { [ "$mounted" = 1 ] && [ "$have_rel_path" = 1 ]; } || [ "$seam_implies_cgroup" = 1 ]; then
  cgroup_v2=true
fi

# ── the ancestor chain: every cgroup from the root DOWN to (and including) the own one ──────────────
# Built from the kernel's own /proc/self/cgroup path, never from a guessed layout. A segment that is
# "." or ".." would let the walk escape the hierarchy, so such a path is refused outright (the walk
# then contributes nothing) instead of being followed.
chain_dirs=()
chain_ok=1
if [ "$have_rel_path" = 1 ] && [ "$mounted" = 1 ]; then
  chain_acc=""
  IFS='/' read -ra chain_segs <<< "$rel_path"
  for seg in "${chain_segs[@]}"; do
    [ -z "$seg" ] && continue
    if [ "$seg" = "." ] || [ "$seg" = ".." ]; then chain_ok=0; break; fi
    chain_acc="$chain_acc/$seg"
    chain_dirs+=("$CGROUP_ROOT$chain_acc")
  done
fi
if [ "$chain_ok" != 1 ]; then chain_dirs=(); fi
# Ancestors nearest-first: everything above the own cgroup, most specific first. Used for the
# "own cgroup imposes no limit of this kind" fallbacks, where NEAREST is the meaningful choice.
ancestor_dirs_nearest_first=()
if [ ${#chain_dirs[@]} -gt 0 ]; then
  i=$((${#chain_dirs[@]} - 1))
  while [ "$i" -ge 0 ]; do
    ancestor_dirs_nearest_first+=("${chain_dirs[$i]}")
    i=$((i - 1))
  done
  # drop the first element (the own cgroup is closest to itself, but it is not an ANCESTOR)
  unset 'ancestor_dirs_nearest_first[0]'
  ancestor_dirs_nearest_first=("${ancestor_dirs_nearest_first[@]+"${ancestor_dirs_nearest_first[@]}"}")
fi

# ── raw readings (every level of a SEAMED controller comes from seams — see the hermeticity note
#    above; a level the seams leave unnamed simply contributes no candidate) ─────────────────────────
# OWN cpu.max
own_cpu_max_raw=""
if [ "$cpu_max_seam_set" = 1 ]; then
  own_cpu_max_raw="$EFFECTIVE_CAPACITY_TEST_CPU_MAX"
elif [ "$cpu_seam_group" = 0 ] && [ -n "$cg_dir" ] && [ -r "$cg_dir/cpu.max" ]; then
  own_cpu_max_raw="$(cat "$cg_dir/cpu.max" 2>/dev/null || true)"
fi

# ANCESTOR cpu.max readings: the seam contributes ONE synthetic ancestor level, so the nested case
# ("the quota is on the slice above me") is exercisable without creating a real slice.
ancestor_cpu_max_raws=()
if [ "$anc_cpu_seam_set" = 1 ]; then
  ancestor_cpu_max_raws=("$EFFECTIVE_CAPACITY_TEST_ANCESTOR_CPU_MAX")
elif [ "$cgroup_v2" = true ] && [ "$cpu_seam_group" = 0 ]; then
  for ad in "${ancestor_dirs_nearest_first[@]+"${ancestor_dirs_nearest_first[@]}"}"; do
    if [ -r "$ad/cpu.max" ]; then
      ancestor_cpu_max_raws+=("$(cat "$ad/cpu.max" 2>/dev/null || true)")
    fi
  done
fi

if [ "$cpuset_seam_set" = 1 ]; then
  cpuset_raw_count="$EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT"
  cpuset_from_seam=1
elif [ "$cpu_seam_group" = 0 ] && [ "$cgroup_v2" = true ] && [ -n "$cg_dir" ] && [ -r "$cg_dir/cpuset.cpus.effective" ]; then
  cpuset_raw_count=""
  cpuset_from_seam=0
  cpuset_text="$(cat "$cg_dir/cpuset.cpus.effective" 2>/dev/null || true)"
else
  cpuset_raw_count=""
  cpuset_from_seam=0
  cpuset_text=""
fi

# OWN memory.max
own_memory_max_raw=""
if [ "$memory_max_seam_set" = 1 ]; then
  own_memory_max_raw="$EFFECTIVE_CAPACITY_TEST_MEMORY_MAX"
elif [ "$mem_seam_group" = 0 ] && [ -n "$cg_dir" ] && [ -r "$cg_dir/memory.max" ]; then
  own_memory_max_raw="$(cat "$cg_dir/memory.max" 2>/dev/null || true)"
fi

# ANCESTOR memory.max readings (same synthetic-ancestor semantics as the CPU one).
ancestor_memory_max_raws=()
if [ "$anc_mem_seam_set" = 1 ]; then
  ancestor_memory_max_raws=("$EFFECTIVE_CAPACITY_TEST_ANCESTOR_MEMORY_MAX")
elif [ "$cgroup_v2" = true ] && [ "$mem_seam_group" = 0 ]; then
  for ad in "${ancestor_dirs_nearest_first[@]+"${ancestor_dirs_nearest_first[@]}"}"; do
    if [ -r "$ad/memory.max" ]; then
      ancestor_memory_max_raws+=("$(cat "$ad/memory.max" 2>/dev/null || true)")
    fi
  done
fi

# nproc has two jobs with different contracts, so it is computed twice:
#   nproc_reading — the FALLBACK CANDIDATE for the CPU winner. Under a seamed CPU controller it is the
#                   seam value or nothing at all (the seam group is hermetic), so a seamed case never
#                   silently depends on the host's core count.
#   nproc_field   — the `nproc=` OUTPUT field, which the frozen contract always fills with a number.
nproc_reading=""
if [ "$nproc_seam_set" = 1 ]; then
  nproc_reading="$EFFECTIVE_CAPACITY_TEST_NPROC"
elif [ "$cpu_seam_group" = 0 ]; then
  nproc_reading="$(nproc 2>/dev/null || echo 1)"
fi
case "$nproc_reading" in ''|*[!0-9]*|0) nproc_reading="" ;; esac

nproc_field="$nproc_reading"
case "$nproc_field" in ''|*[!0-9]*|0) nproc_field="$(nproc 2>/dev/null || echo 1)" ;; esac
case "$nproc_field" in ''|*[!0-9]*|0) nproc_field=1 ;; esac

if [ "$mem_avail_seam_set" = 1 ] && [ "$EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB" -gt 0 ] 2>/dev/null; then
  mem_fallback_mb="$EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB"
else
  mem_total_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if [ -n "$mem_total_kb" ] && [ "$mem_total_kb" -gt 0 ] 2>/dev/null; then
    mem_fallback_mb=$((mem_total_kb / 1024))
  else
    mem_fallback_mb=1
  fi
  [ "$mem_fallback_mb" -gt 0 ] 2>/dev/null || mem_fallback_mb=1
fi

# ── parse cpu.max ("<quota> <period>" or "max <period>"); unlimited/unparsable -> no candidate ──────
# Prints the core count, or nothing at all when this reading imposes no bandwidth quota.
parse_cpu_max_cores() {
  local raw="$1" q p c
  [ -z "$raw" ] && return 0
  q="$(printf '%s' "$raw" | awk '{print $1}')"
  p="$(printf '%s' "$raw" | awk '{print $2}')"
  [ -z "$q" ] && return 0
  [ "$q" = "max" ] && return 0
  [ "$q" -gt 0 ] 2>/dev/null || return 0
  [ -z "$p" ] && p=100000
  [ "$p" -gt 0 ] 2>/dev/null || return 0
  c=$((q / p))
  [ "$c" -lt 1 ] && c=1
  printf '%s' "$c"
}

# The effective bandwidth quota is the MINIMUM over the own cgroup and every ancestor (cgroup v2
# composes CPU bandwidth hierarchically), so a quota that lives only on a slice above is found.
cpu_bandwidth_cores=""
if [ "$cgroup_v2" = true ]; then
  for raw in "$own_cpu_max_raw" "${ancestor_cpu_max_raws[@]+"${ancestor_cpu_max_raws[@]}"}"; do
    cores="$(parse_cpu_max_cores "$raw")"
    [ -z "$cores" ] && continue
    if [ -z "$cpu_bandwidth_cores" ] || [ "$cores" -lt "$cpu_bandwidth_cores" ]; then
      cpu_bandwidth_cores="$cores"
    fi
  done
fi

# ── parse cpuset.cpus.effective ("0-3,8,10-11" -> 7); seam supplies a count directly ────────────────
# OWN cgroup only — see the header: the kernel already intersects the chain into this file, and at an
# unrelated ancestor it merely mirrors the host CPU set rather than constraining anything.
cpuset_cores=""
if [ "$cgroup_v2" = true ]; then
  if [ "$cpuset_from_seam" = 1 ]; then
    if [ -n "$cpuset_raw_count" ] && [ "$cpuset_raw_count" -gt 0 ] 2>/dev/null; then
      cpuset_cores="$cpuset_raw_count"
    fi
  elif [ -n "${cpuset_text:-}" ]; then
    total=0
    valid=1
    IFS=',' read -ra parts <<< "$cpuset_text"
    for part in "${parts[@]}"; do
      part="$(printf '%s' "$part" | tr -d '[:space:]')"
      [ -z "$part" ] && continue
      if [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]]; then
        lo="${BASH_REMATCH[1]}"; hi="${BASH_REMATCH[2]}"
        if [ "$hi" -lt "$lo" ]; then valid=0; break; fi
        total=$((total + hi - lo + 1))
      elif [[ "$part" =~ ^[0-9]+$ ]]; then
        total=$((total + 1))
      else
        valid=0; break
      fi
    done
    if [ "$valid" = 1 ] && [ "$total" -gt 0 ]; then cpuset_cores="$total"; fi
  fi
fi

# ── CPU winner: build the candidate list in tie-break PRIORITY order (cgroup-cpu-max first, then
#    cpuset, then nproc-fallback last), seed the winner with the FIRST candidate, then only replace it
#    on a STRICT `<` — so a value tie keeps whichever candidate came earlier in priority order
#    (cgroup-cpu-max beats an equal-valued cpuset; cpuset beats an equal-valued nproc) ───────────────
# A seamed controller can leave the list empty (e.g. CPU_MAX seam "max" alone), so the fail-open
# guarantee is applied here: the report ALWAYS carries a CPU value, falling back to the real nproc.
cpu_values=()
cpu_sources=()
if [ -n "$cpu_bandwidth_cores" ]; then
  cpu_values+=("$cpu_bandwidth_cores"); cpu_sources+=("cgroup-cpu-max")
fi
if [ -n "$cpuset_cores" ]; then
  cpu_values+=("$cpuset_cores"); cpu_sources+=("cpuset")
fi
if [ -n "$nproc_reading" ]; then
  cpu_values+=("$nproc_reading"); cpu_sources+=("nproc-fallback")
fi
if [ ${#cpu_values[@]} -eq 0 ]; then
  cpu_values=("$nproc_field"); cpu_sources=("nproc-fallback")
fi

effective_cpu="${cpu_values[0]}"
cpu_source="${cpu_sources[0]}"
for i in "${!cpu_values[@]}"; do
  if [ "${cpu_values[$i]}" -lt "$effective_cpu" ]; then
    effective_cpu="${cpu_values[$i]}"
    cpu_source="${cpu_sources[$i]}"
  fi
done

# ── memory, two numbers ───────────────────────────────────────────────────────────────────────────
# Helper: a memory.max raw text -> bytes, or nothing when it is absent/unlimited/unparsable.
parse_mem_max_bytes() {
  local raw="$1" n
  [ -z "$raw" ] && return 0
  [ "$raw" = "max" ] && return 0
  n="$raw"
  [ "$n" -gt 0 ] 2>/dev/null || return 0
  printf '%s' "$n"
}

# (1) effective_mem_mb: the MINIMUM over the whole chain (own included) — the budget an outer cgroup
#     will actually enforce on this process. Unchanged meaning for the consumers that derive from it
#     (scripts/with-memory-cap.sh's default cap): with no ancestor limit it is the own value as before.
effective_mem_mb="$mem_fallback_mb"
mem_source="free-fallback"
chain_mem_bytes=""
if [ "$cgroup_v2" = true ]; then
  for raw in "$own_memory_max_raw" "${ancestor_memory_max_raws[@]+"${ancestor_memory_max_raws[@]}"}"; do
    b="$(parse_mem_max_bytes "$raw")"
    [ -z "$b" ] && continue
    if [ -z "$chain_mem_bytes" ] || [ "$b" -lt "$chain_mem_bytes" ]; then
      chain_mem_bytes="$b"
    fi
  done
fi
if [ -n "$chain_mem_bytes" ]; then
  effective_mem_mb=$((chain_mem_bytes / MB))
  [ "$effective_mem_mb" -lt 1 ] && effective_mem_mb=1
  mem_source="cgroup-memory-max"
fi

# (2) scope_mem_max_mb: what the callers OWN cgroup may use — own first, nearest ancestor only when
#     the own cgroup imposes no limit of its own. The source field names which of the two it was, so
#     the two readings can never be confused for one another.
scope_mem_max_mb=""
scope_mem_source="free-fallback"
own_mem_bytes="$(parse_mem_max_bytes "$own_memory_max_raw")"
if [ -n "$own_mem_bytes" ]; then
  scope_mem_max_mb=$((own_mem_bytes / MB))
  scope_mem_source="cgroup-memory-max"
else
  for raw in "${ancestor_memory_max_raws[@]+"${ancestor_memory_max_raws[@]}"}"; do
    b="$(parse_mem_max_bytes "$raw")"
    [ -z "$b" ] && continue
    scope_mem_max_mb=$((b / MB))
    scope_mem_source="ancestor-cgroup-memory-max"
    break
  done
fi
if [ -z "$scope_mem_max_mb" ]; then
  scope_mem_max_mb="$mem_fallback_mb"
  scope_mem_source="free-fallback"
fi
[ "$scope_mem_max_mb" -lt 1 ] && scope_mem_max_mb=1

# ── render ────────────────────────────────────────────────────────────────────────────────────────
if [ "$json_mode" = 1 ]; then
  printf '{"effective_cpu":%s,"cpu_source":"%s","effective_mem_mb":%s,"mem_source":"%s","nproc":%s,"cgroup_v2":%s,"scope_mem_max_mb":%s,"scope_mem_source":"%s"}\n' \
    "$effective_cpu" "$cpu_source" "$effective_mem_mb" "$mem_source" "$nproc_field" "$cgroup_v2" \
    "$scope_mem_max_mb" "$scope_mem_source"
else
  printf 'effective_cpu=%s\n'    "$effective_cpu"
  printf 'cpu_source=%s\n'       "$cpu_source"
  printf 'effective_mem_mb=%s\n' "$effective_mem_mb"
  printf 'mem_source=%s\n'       "$mem_source"
  printf 'nproc=%s\n'            "$nproc_field"
  printf 'cgroup_v2=%s\n'        "$cgroup_v2"
  printf 'scope_mem_max_mb=%s\n' "$scope_mem_max_mb"
  printf 'scope_mem_source=%s\n' "$scope_mem_source"
fi
exit 0

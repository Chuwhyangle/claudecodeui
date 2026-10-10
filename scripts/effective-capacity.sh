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
# ── Output contract (field names frozen by the 2026-10-09 cross-project alignment) ──────────────────
# report mode: one `key=value` per line, in this order:
#   effective_cpu=<int>          min(bandwidth-quota cores, cpuset cores, nproc) — the final value
#   cpu_source=cgroup-cpu-max|cpuset|nproc-fallback
#   effective_mem_mb=<int>
#   mem_source=cgroup-memory-max|free-fallback
#   nproc=<int>                  the control reading (host/affinity), NOT the final value
#   cgroup_v2=true|false
# `--json` prints exactly the same six fields as one JSON object with unchanged key names.
#
# Tie-break when two CPU candidates give the same minimum: cgroup-cpu-max > cpuset > nproc-fallback
# (a cgroup constraint that happens to equal the host reading is still the cgroup constraint).
#
# ── Test seams (same five names as quay's port; they override the RAW READINGS, not a second code
#    path) ─────────────────────────────────────────────────────────────────────────────────────────
#   EFFECTIVE_CAPACITY_TEST_CPU_MAX        override the cpu.max raw text ("200000 100000" / "max 100000")
#   EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT   override the cpuset core COUNT (integer)
#   EFFECTIVE_CAPACITY_TEST_MEMORY_MAX     override the memory.max raw text (bytes / "max")
#   EFFECTIVE_CAPACITY_TEST_NPROC          override the nproc reading (integer)
#   EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB   override the memory FALLBACK reading (MB)
# Setting any of the three cgroup seams (CPU_MAX, CPUSET_COUNT, MEMORY_MAX) asserts a cgroup IS
# present (that is what the seam simulates), so cgroup_v2 reads true even on a host without a unified
# hierarchy. A seam set to the empty string still counts as "set" (distinguishes "set but empty" from
# "not set at all").
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
             mem_source, nproc, cgroup_v2)
  --json     the same six fields as one JSON object
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
cpuset_seam_set=0;     [ -v EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT ] && cpuset_seam_set=1
memory_max_seam_set=0; [ -v EFFECTIVE_CAPACITY_TEST_MEMORY_MAX ]   && memory_max_seam_set=1
nproc_seam_set=0;      [ -v EFFECTIVE_CAPACITY_TEST_NPROC ]        && nproc_seam_set=1
mem_avail_seam_set=0;  [ -v EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB ] && mem_avail_seam_set=1

seam_implies_cgroup=0
if [ "$cpu_max_seam_set" = 1 ] || [ "$cpuset_seam_set" = 1 ] || [ "$memory_max_seam_set" = 1 ]; then
  seam_implies_cgroup=1
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

# ── raw readings ──────────────────────────────────────────────────────────────────────────────────
if [ "$cpu_max_seam_set" = 1 ]; then
  cpu_max_raw="$EFFECTIVE_CAPACITY_TEST_CPU_MAX"
elif [ -n "$cg_dir" ] && [ -r "$cg_dir/cpu.max" ]; then
  cpu_max_raw="$(cat "$cg_dir/cpu.max" 2>/dev/null || true)"
else
  cpu_max_raw=""
fi

if [ "$cpuset_seam_set" = 1 ]; then
  cpuset_raw_count="$EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT"
  cpuset_from_seam=1
elif [ "$cgroup_v2" = true ] && [ -n "$cg_dir" ] && [ -r "$cg_dir/cpuset.cpus.effective" ]; then
  cpuset_raw_count=""
  cpuset_from_seam=0
  cpuset_text="$(cat "$cg_dir/cpuset.cpus.effective" 2>/dev/null || true)"
else
  cpuset_raw_count=""
  cpuset_from_seam=0
  cpuset_text=""
fi

if [ "$memory_max_seam_set" = 1 ]; then
  memory_max_raw="$EFFECTIVE_CAPACITY_TEST_MEMORY_MAX"
elif [ -n "$cg_dir" ] && [ -r "$cg_dir/memory.max" ]; then
  memory_max_raw="$(cat "$cg_dir/memory.max" 2>/dev/null || true)"
else
  memory_max_raw=""
fi

if [ "$nproc_seam_set" = 1 ] && [ "$EFFECTIVE_CAPACITY_TEST_NPROC" -gt 0 ] 2>/dev/null; then
  nproc_reading="$EFFECTIVE_CAPACITY_TEST_NPROC"
else
  nproc_reading="$(nproc 2>/dev/null || echo 1)"
  [ "$nproc_reading" -gt 0 ] 2>/dev/null || nproc_reading=1
fi

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
cpu_bandwidth_cores=""
if [ "$cgroup_v2" = true ]; then
  quota_tok="$(printf '%s' "$cpu_max_raw" | awk '{print $1}')"
  period_tok="$(printf '%s' "$cpu_max_raw" | awk '{print $2}')"
  [ -z "$period_tok" ] && period_tok=100000
  if [ -n "$quota_tok" ] && [ "$quota_tok" != "max" ] \
     && [ "$quota_tok" -gt 0 ] 2>/dev/null && [ "$period_tok" -gt 0 ] 2>/dev/null; then
    cpu_bandwidth_cores=$((quota_tok / period_tok))
    [ "$cpu_bandwidth_cores" -lt 1 ] && cpu_bandwidth_cores=1
  fi
fi

# ── parse cpuset.cpus.effective ("0-3,8,10-11" -> 7); seam supplies a count directly ────────────────
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
#    cpuset, then nproc-fallback always last), seed the winner with the FIRST candidate, then only
#    replace it on a STRICT `<` — so a value tie keeps whichever candidate came earlier in priority
#    order (cgroup-cpu-max beats an equal-valued cpuset; cpuset beats an equal-valued nproc) ─────────
cpu_values=()
cpu_sources=()
if [ -n "$cpu_bandwidth_cores" ]; then
  cpu_values+=("$cpu_bandwidth_cores"); cpu_sources+=("cgroup-cpu-max")
fi
if [ -n "$cpuset_cores" ]; then
  cpu_values+=("$cpuset_cores"); cpu_sources+=("cpuset")
fi
cpu_values+=("$nproc_reading"); cpu_sources+=("nproc-fallback")

effective_cpu="${cpu_values[0]}"
cpu_source="${cpu_sources[0]}"
for i in "${!cpu_values[@]}"; do
  if [ "${cpu_values[$i]}" -lt "$effective_cpu" ]; then
    effective_cpu="${cpu_values[$i]}"
    cpu_source="${cpu_sources[$i]}"
  fi
done

# ── memory: cgroup limit (bytes -> MB, floored) if present and not "max", else host total ───────────
effective_mem_mb="$mem_fallback_mb"
mem_source="free-fallback"
if [ "$cgroup_v2" = true ] && [ -n "$memory_max_raw" ] && [ "$memory_max_raw" != "max" ] \
   && [ "$memory_max_raw" -gt 0 ] 2>/dev/null; then
  effective_mem_mb=$((memory_max_raw / MB))
  [ "$effective_mem_mb" -lt 1 ] && effective_mem_mb=1
  mem_source="cgroup-memory-max"
fi

# ── render ────────────────────────────────────────────────────────────────────────────────────────
if [ "$json_mode" = 1 ]; then
  printf '{"effective_cpu":%s,"cpu_source":"%s","effective_mem_mb":%s,"mem_source":"%s","nproc":%s,"cgroup_v2":%s}\n' \
    "$effective_cpu" "$cpu_source" "$effective_mem_mb" "$mem_source" "$nproc_reading" "$cgroup_v2"
else
  printf 'effective_cpu=%s\n'    "$effective_cpu"
  printf 'cpu_source=%s\n'       "$cpu_source"
  printf 'effective_mem_mb=%s\n' "$effective_mem_mb"
  printf 'mem_source=%s\n'       "$mem_source"
  printf 'nproc=%s\n'            "$nproc_reading"
  printf 'cgroup_v2=%s\n'        "$cgroup_v2"
fi
exit 0

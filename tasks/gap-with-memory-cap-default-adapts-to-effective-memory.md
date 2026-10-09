---
id: gap-with-memory-cap-default-adapts-to-effective-memory
title: scripts/with-memory-cap.sh 的默认内存上限从固定 24G 改为按 effective memory
  自适应（不超过物理/cgroup 可用量）
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-effective-capacity-probe-cgroup-cpu-mem-quota
---
## Proposal

**依赖**：`gap-effective-capacity-probe-cgroup-cpu-mem-quota`。

**现状**：`scripts/with-memory-cap.sh:30` `CAP="${QUAY_MEMORY_MAX:-24G}"`——固定 24G，不读实际可用内存。`gap-npm-test-server-scripts-bounded-concurrency-and-memory-scope`（done）明确记录了"不改 with-memory-cap.sh"是该任务自己的范围边界，本任务是专门接手这件事的后续任务，不是重复。在物理/cgroup 内存小于 24G 的环境里，这个"上限"本身可能超过可用量——意味着没有真正的保护：一个失控测试仍可能把宿主/cgroup 其它进程挤爆，而 systemd-run 的 `MemoryMax=24G` 在小内存机器上可能从"硬顶"变成"形同不设"。

**本任务要做的**：默认 `CAP` 从 `scripts/effective-capacity.sh` 的 `effective_mem_mb` 推导（例如取可用量的某个安全比例，而不是可用量的 100%，需留出调用方自身与其它并存进程的余量；具体比例由实测决定，不得凭感觉），`QUAY_MEMORY_MAX`/`QUAY_MEMORY_UNIT`/`QUAY_MEMORY_SLICE`/`off` 等既有显式覆盖与禁用语义**一字不改**（这是该脚本头注释明确的、被 `scripts/vitest-heap-limit-check.sh` 依赖的契约面）。

**不做**：不修改 `with-memory-cap.sh` 的 systemd-run 降级逻辑（无 systemd 用户管理器时的行为）；不修改调用方（`package.json`/`scripts/test.sh`）的任何调用形态——只改脚本内部的默认值来源。

## AC

- [ ] AC1 默认值来源替换：不设 `QUAY_MEMORY_MAX` 时，`CAP` 由 effective memory 推导；显式设置 `QUAY_MEMORY_MAX`（含 `off`/`0`）时行为与改动前逐字一致（现有 `scripts/vitest-heap-limit-check.sh` 对此脚本"一字不许动"的要求——本任务只改默认值计算这一处，其它逐字不动，需先读一次该守卫的具体断言面确认未被触碰）。
- [ ] AC2 不超过可用量：在 2G/4G/8G 几档模拟内存受限环境（`systemd-run -p MemoryMax=`）下，默认 `CAP` 不超过该档可用量的安全比例，且留出的余量经实测验证不会导致调用方自身被反噬。
- [ ] AC3 负控制：`QUAY_MEMORY_MAX=1G bash scripts/with-memory-cap.sh node -e "..."`（既有负控制模式，参考 `gap-npm-test-server-scripts-bounded-concurrency-and-memory-scope` 的 DoD 负控）在新默认值逻辑下依然必须被 OOM 杀死且归因正确——证明显式覆盖路径未被新默认值逻辑污染。
- [ ] AC4 既有守卫不退化：`bash scripts/vitest-heap-limit-check.sh` 退出码与改动前相同；`npm run typecheck`/`npm run lint` 退出 0。

## DoD

真实落地标准：2G/4G/8G 三档的真实 OOM 边界验证（故意触发、确认被杀、确认归因正确）贴进完成记录；`QUAY_MEMORY_MAX` 显式覆盖路径的行为与改动前逐字相同的证据（diff 对照）。未验证项如实声明同前序任务。

## Touches

- scripts/with-memory-cap.sh
- tasks/gap-with-memory-cap-default-adapts-to-effective-memory.md (new)
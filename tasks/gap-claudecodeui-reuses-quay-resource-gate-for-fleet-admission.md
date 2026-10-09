---
id: gap-claudecodeui-reuses-quay-resource-gate-for-fleet-admission
title: 跨项目测试资源准入：ClaudeCodeUI 确认直接复用 quay 的 resource-gate.sh（Driver 层全局上限），自身
  Policy/Gate 不变
status: done
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

跨项目测试资源准入的分层现状（声明，非新设计）：ClaudeCodeUI 没有自己独立的 driver——跑在本仓库上的调度进程就是 quay 自己的 `worker-driver.js`/promotion-driver 本体（`--root /data/home/yale/work/claudecodeui`），不是另一套实现。该进程在起重活（全量 `scripts/test.sh`）前已经调用 `<pluginRoot>/scripts/resource-gate.sh`（fail-closed：脚本缺失或 spawn 失败都返回 `{go:false}`），判据是 `/proc/pressure/cpu` 的 `some avg10`（主判据，<60 视为 ok）与 `/proc/loadavg` 1-min（过载窗口补充判据，`< nproc×2`）。`gap-driver-resource-gate-path-anchored-at-root-third-party`（quay 侧 done 任务）把该脚本的路径解析从「锚死在调用方 root」改成「从 kernel 自身安装位置解析（含 `QUAY_PLUGIN_ROOT` 覆盖）」，正是为了让没有 `plugin/` 目录的第三方项目（ClaudeCodeUI 就是其中之一）也能复用同一份脚本——这件事已经在生效，不是待办。

**实测证据（2026-10-09T10:1x，本机）**：
```
cpu_stall(some avg10)=0.00  [limit 60]   ok
loadavg=10.84             [limit nproc×2≈256] ok
nproc=128  node_procs=251  swap=16383MB  [nproc-invariant ok]
=> GO: 资源充足，可以跑
```

**架构结论（本任务要声明的）**：Driver 层（`resource-gate.sh`，部署在 quay 安装位置，全局唯一，PSI+loadavg 判据，GO/WAIT fail-closed）与 Policy/Gate 层（`scripts/test.sh` 的 pass/fail 判词、`__PERFILE__`/`__PERFILE_KIND__` 归因、各任务的 AC 契约）完全分离——resource-gate 只决定「现在能不能跑」，从不触碰「跑完算不算过」的语义；全局安全上限（`quay-fleet.slice` 的 `MemoryMax=64G`、`resource-gate.sh` 的阈值）保持不变，不因本次确认而调整。

**协同记录**：与 quay 侧一个对等会话（socket `uds:/run/user/1004/cc-socks/1167246.sock`）2026-10-09 互相确认：quay 侧不需要为 ClaudeCodeUI 新开 directive 或代码改动；ClaudeCodeUI 侧记这条声明性 task 即可，不重复记录。

## AC

- [x] AC1 `worker-driver.js` 对本仓库的调用链里确实存在 `resource-gate.sh` 路径拼接与 fail-closed 分支（`strings` 反编译确认，见 Proposal）。
- [x] AC2 `resource-gate.sh` 对本仓库现场实测返回 GO，判据字段齐全（见 Proposal 实测证据）。
- [x] AC3 与 quay 侧对等会话互相确认架构对齐，书面记录（本任务）。

## DoD

本任务是声明性的——不修改任何代码、不新增任何机制。「做完」= 上述三条 AC 的证据都已采集并写入本任务；quay 侧 `gap-driver-resource-gate-path-anchored-at-root-third-party` 保持为权威实现来源，本任务只做指针式声明，不重复维护判据细节（阈值变化请看 quay 侧那条任务，不要在本任务里同步编辑）。

## Touches

- tasks/gap-claudecodeui-reuses-quay-resource-gate-for-fleet-admission.md (new)
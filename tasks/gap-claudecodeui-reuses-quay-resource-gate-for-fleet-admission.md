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

## 2026-10-09T13:xx 更正（如实披露——本任务的"架构结论"覆盖面被高估了）

**原文的问题**：AC1-3 只证明了「`resource-gate.sh` 这个共享入口存在、且在机械 fan-in 派发前被调用一次」，没有证明「全局 quota 已闭环」——这是两件不同的事，本任务原先把前者当成了后者的证据，范围被高估。

**新证据（来自 `gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged` 落地过程中的真实台账观察）**：

1. **`scripts/test.sh` 自身不调用 `resource-gate.sh`**（`grep -n "resource-gate\|process-budget" scripts/test.sh` 零命中）。resource-gate 只在 `worker-driver.js` 的机械 fan-in 派发路径上被调用一次——**本地/手动直接跑 `npm test` 或 `bash scripts/test.sh`，以及 worker 自己在 worktree 里跑的 `--for-task` scoped 自测，完全不经过这道门**。本次会话内我自己跑的 `QUAY_TEST_STOP_AFTER=stages` 结构自测、以及被派发 worker 跑的 `bash scripts/test.sh --for-task …`，都没有经过 resource-gate——不是因为它们是 scoped，而是因为这条调用路径压根没有把 gate 接进来。
2. **`process-budget.sh`（C 面：供 `scripts/test.sh` 自身读取的并发预算）在 ClaudeCodeUI 没有被采用**——该脚本头部注释声明的「`scripts/test.sh default_concurrency_formula` 读本脚本」是对任意采纳项目的通用说明，ClaudeCodeUI 的 `scripts/test.sh` 没有读它（同一条 grep 为证），其 `--test-concurrency=16` 是硬编码常量。
3. **真实台账证据：同一时间窗口（2026-10-09T02:40–03:30Z）内，ClaudeCodeUI 项目自己就有 2–4 个 worker session 在不同 worktree 里并发在飞**（`.quay/worker-round.jsonl` 读数：`in_flight_tasks` 同时含 `gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged`、`gap-mcp-pending-interaction-visibility-and-idempotent-answer`、`gap-voice-realtime-live-session-send-wiring`、`gap-voice-realtime-connection-resilience`）。`.git/fan-in.lock` 只序列化「fan-in 合并步骤」本身，**不序列化各 worker 在自己 worktree 里跑的 scoped 自测**——而正是这些 scoped 自测会拉起真实 `claude` resident 进程（`resident-server-restart.test.ts` 之类）。这与同一窗口内 `.quay/verification-round.jsonl` 观察到的高红率（9 轮 fan-in 里 8 轮红，失败文件集中在 `resident-server-restart.test.ts`——已知的、owner 已承认「触发源不在本仓可控范围」的 lane-负载敏感判据，见 `gap-resident-server-restart-criterion-wait-headroom-under-lane-load`）在时间上吻合，是一个合理但尚未被本任务或任何现存任务正面验证的归因假说。

**结论**：「共享入口存在」（原 AC1-2）成立不变，不撤销；但「全局 quota 已闭环」这个推论**不成立**，本任务的原 Proposal 措辞对此有误导。覆盖面的真实边界：

| 并发来源 | 是否被 `resource-gate.sh` 覆盖 |
|---|---|
| 机械 fan-in 派发（worker-driver.js 发起全量 suite 前） | ✅ 覆盖 |
| 本地/手动直接跑 `npm test` / `bash scripts/test.sh` | ❌ 不覆盖 |
| worker 自己在 worktree 里跑的 `--for-task` scoped 自测 | ❌ 不覆盖 |
| 同项目内多个 worker session 并发在飞（本次观察到 2–4 个） | ❌ 不覆盖（`fan-in.lock` 也不覆盖，它只锁合并步骤） |
| 跨项目（quay/cantus/…）同时起的重活 | 部分覆盖：各项目若都接了 `resource-gate.sh` 的 A 面，各自派发前都会读同一份宿主级 PSI/loadavg 快照，但这是**时点快照**，不是**持有的租约/配额扣减**——N 个项目可以都在同一秒读到 GO 然后同时开始跑，期间互相之间没有协调。 |

已把这条更细的归因假说与覆盖面表格另立任务 `gap-claudecodeui-scoped-self-test-and-concurrent-worker-sessions-bypass-resource-gate`，不在本任务里继续扩写（本任务保持声明性质，只做指针）。
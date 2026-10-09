---
id: gap-claudecodeui-scoped-self-test-and-concurrent-worker-sessions-bypass-resource-gate
title: 跨项目资源准入未闭环：worker 自身的 scoped 自测与同项目内并发 worker session 不经过
  resource-gate.sh，疑似是 resident-server-restart 高红率的资源争抢来源
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

**背景**：`gap-claudecodeui-reuses-quay-resource-gate-for-fleet-admission`（声明性,done）原先的结论"共享入口存在=全局quota已闭环"覆盖面被高估——已在该任务里更正,本任务接手把更正里点名的归因假说和覆盖面缺口单独立案,避免声明性任务继续膨胀。

**覆盖面现状（已核实,非假设）**：

| 并发来源 | 是否经过 `resource-gate.sh` |
|---|---|
| 机械 fan-in 派发（`worker-driver.js` 发起全量 suite 前） | ✅ 覆盖 |
| 本地/手动直接跑 `npm test` / `bash scripts/test.sh` | ❌ 不覆盖（`grep -n "resource-gate\|process-budget" scripts/test.sh` 零命中） |
| worker 自己在 worktree 里跑的 `--for-task` scoped 自测（AC 自验的标准步骤） | ❌ 不覆盖 |
| 同项目内多个 worker session 并发在飞 | ❌ 不覆盖（`.git/fan-in.lock` 只序列化 fan-in 合并步骤本身，不序列化各 worker 在自己 worktree 里跑的任何测试） |
| 跨项目（quay/cantus/…）同时起的重活 | 部分覆盖：各项目若都接了 A 面，各自派发前读同一份宿主级 PSI/loadavg **时点快照**，不是**持有的租约/配额扣减**——N 个项目/worker 可以在同一秒都读到 GO 然后同时开始跑，运行期间互相不协调 |

**归因假说（有时间关联证据，尚未做因果验证）**：2026-10-09T02:40–04:29Z 窗口内，`.quay/worker-round.jsonl` 显示 ClaudeCodeUI 项目自己同时有 2–4 个 worker session 在不同 worktree 并发在飞（`gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged`、`gap-mcp-pending-interaction-visibility-and-idempotent-answer`、`gap-voice-realtime-live-session-send-wiring`、`gap-voice-realtime-connection-resilience`）。同一窗口 `.quay/verification-round.jsonl` 的 9 轮机械 fan-in 里 8 轮红，失败文件高度集中在 `server/modules/session-hosts/tests/resident-server-restart.test.ts`（6/9 轮）——该判据是已知的、owner 已承认「触发源（lane 并发下真实 claude 重拉延迟）不在本仓可控范围」的负载敏感判据（`gap-resident-server-restart-criterion-wait-headroom-under-lane-load`，done，margin 修法，非根治）。本任务要验证：这 2–4 个并发 worker session 自己在各自 worktree 里跑的 scoped 自测（会拉起真实 `claude` resident 进程）是否正是把 lane 负载推过已有余量（`ROUND_TIMEOUT_MS` 60s = 38.9s×1.5）的那个来源——如果是，说明问题不在判据本身的余量够不够，而在准入层完全没有计入这类并发源。

**本任务的范围边界（重要）**：
- 不重新修 `resident-server-restart.test.ts` 本身（它的余量修法已 done，且明确声明"若红仍复发，按宿主负载归因，不得栽到该任务头上"）。
- 不弱化 `resource-gate.sh` 现有的 fail-closed 语义，不降低任何现有的全局上限（`quay-fleet.slice` MemoryMax=64G 等）。
- 覆盖面扩展若需要 quay 侧（`worker-driver.ts`/`resource-gate.sh`/`process-budget.sh`）的机制改动，本任务只负责验证归因 + 提出设计方向，不代表 quay 侧已认领；需要另行与 quay 侧协同（参考本仓与 quay 侧 2026-10-09 已有的一次对等会话协同记录）。

## AC

- [ ] AC1 因果验证（不是时间关联）：构造一个可控复现——同时起 N 个（N∈{1,2,4}）会真实拉起 `claude` resident 进程的 scoped 测试（如 `resident-server-restart.test.ts` 本身或同类 `claude-resident-*.test.ts`），分别单独跑与并发跑，记录 `resident-server-restart.test.ts` 的 `waitForResidentPid` 实测延迟随并发 worker 数的变化曲线，判定是否存在"并发 worker 数越多，重拉延迟越逼近/越过已有余量"的因果关系（而非仅仅时间上吻合）。
- [ ] AC2 若 AC1 证实因果关系：提出并评估至少一种覆盖方案，二选一或组合——(a) worker 自己的 scoped 自测调用 `resource-gate.sh`（需要机制上区分"轻量单文件判据"与"全量 suite"，避免把检查成本本身变成新的开销）；(b) 同项目内对"会拉起真实 resident 进程的测试文件"引入一个项目内的轻量互斥（例如基于 flock 的命名资源槛，而非笼统的 suite 级锁），使同一时刻只有一个真实 `claude` resident 进程在跑。每个方案都要回答：是否保持 fail-closed（机制故障时默认 WAIT 而非默默放行）；是否保持现有全局上限不变；对现有 worker 吞吐的预期影响量级。
- [ ] AC3 若 AC1 不能证实因果关系（如实记录,不得假装证实）：如实记录"时间关联存在、因果未坐实"，并将归因重新指向 `gap-resident-server-restart-criterion-wait-headroom-under-lane-load` 已登记的宿主负载类别，不新增覆盖机制,关闭本任务（标记为 `superseded` 或等价的"调查完毕无需动代码"状态，附调查过程与读数）。
- [ ] AC4 范围门：若 AC2 的方案被采纳并实现，`npm run typecheck`/`npm run lint` 退出 0；改动不降低任何现有全局并发/内存上限的数值；`resource-gate.sh`/`process-budget.sh` 若被改动，改动方需与 quay 侧协同（记录协同证据，不得单边改一个被多项目共享的脚本）。

## DoD

真实落地标准：AC1 的因果曲线是本次会话或后续 worker 真实测得的数据（标明测量时的宿主负载作为对照变量），不是推断；若走 AC2 路线，新机制上线后要能在 `.quay/verification-round.jsonl` 的后续真实 fan-in 轮次里观察到 `resident-server-restart.test.ts` 红率下降（给出修复前后窗口的真实红/绿轮次比例对比，不是单轮）；若走 AC3，关闭理由要点名已有的归因任务，不留悬空的"疑似问题"状态。未验证项如实声明：本任务创建时尚未执行 AC1 的可控复现实验。

## Touches

- tasks/gap-claudecodeui-scoped-self-test-and-concurrent-worker-sessions-bypass-resource-gate.md (new)
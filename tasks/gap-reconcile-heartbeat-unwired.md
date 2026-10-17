---
id: gap-reconcile-heartbeat-unwired
title: reconcileTick 的 heartbeat 检查点没接线：只有 result 帧调用它，phantom-run 永不检测
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
<!-- dedup-ref --> 机制去重（立案时实测 2026-10-17）：`grep -rln 'reconcileTick' tasks/*.md` → 0 命中。gap-ac390-resident-reconcile-observability（done）是**最邻近的任务**，但它交付的是「对账循环本身 + 判据」：其判据 (c) 写「含 heartbeat 多拍」，实际是**测试自己调 `harness.driver.reconcileTick()`**（claude-resident-reconcile.test.ts:602-604），没有判据断言生产里那个拍真的调用它。本任务是「把 AC-390 声称过、但没接的那半截接上」——AC-390 的 Touches 明列了 `activity-heartbeat.service.ts` 作为「heartbeat 触发点」，落地代码却没接。是补 AC-390 的漏，不是重复。separate。

## Finding

### 缺陷面

`reconcileTick`（claude-host-driver.provider.ts:3428）的文档写「在 RESULT 之后**与 heartbeat（既有 5 s 一拍）**上检查」，并明说「driver 不自己 arm interval，由那个每 session 一拍的上层来问」。但全仓库唯一调用点是 `observe()` 里的 `result` 分支（:6202）。所谓「既有 5 s 一拍」是 `startActivityHeartbeat`（activity-heartbeat.service.ts:215 的 `setInterval`）——**per-socket、客户端驱动、`timer.unref()`、只在有浏览器订阅时才跑**；另一个 30 s 的是 websocket-server 协议 ping。两者都不是 session 级的服务端拍。

结果：phantom-run 只在 `RESULT` 到达那一刻被检查，而那一刻 `quiescentMs≈0`，永远不满足 `> T_q`。实测全日志 `phantom-run` 0 条，却有一条 21+ 分钟没关的幽灵 run（4073c200）。所以 §10.1 的第二个检查点（heartbeat）**前提基础设施根本不存在**，幽灵 run 没有任何一层能看见。

### 修法

给 reconcile 接一根**服务端 per-host 拍**，独立于客户端订阅：要么在 driver 内按 host 生命周期 arm 一根 unref 拍（host 建时起、host 关时清，账本与 host 同生命周期最自然——此时要**改掉**文档里「driver 不自己 arm interval」那句已失效的前提），要么新建一个 resident reconcile beat 服务。每拍调 `reconcileTick(sessionId)`，让 phantom-run 在 `log` 模式下被记、在 `enforce` 模式下被关。判定必须能证「无客户端订阅时也跑」，否则又成一个 per-socket 假形态。

## AC
- [ ] AC1 装配读数：读生产装配（像 AC-397 那样执行它，不是文本 grep）——把 heartbeat 那根拍的 tick 回调取出来，绑定隔离的 host/reconcileTick，证明每拍真的调 reconcileTick，且**无任何客户端订阅时也调**。
- [ ] AC2 行为读数：注入「注册表有 running run 而账本静止超 T_q、无客户端」的分歧 ⇒ `log` 模式每拍记一行 `[reconcile] … anomaly=phantom-run`；`enforce` 模式把幽灵 run 关闭（aborted/reason=reconciled）。
- [ ] AC3 反例：已开 turn 的真实长 turn 在两种模式、多拍之后都不被关（不引入 lease 定时过期的过结算）。
- [ ] AC4 取假形态：删掉拍上对 reconcileTick 的调用（或让拍只在有订阅时才 arm）⇒ AC1/AC2 红；还原恢复绿。
- [ ] AC5 生命周期：host 关闭 ⇒ 拍被清除、无泄漏（unref，不拦进程退出）；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `。

## DoD
真实落地判据：交付树上经装配读数证明「拍真的调 reconcileTick、无订阅也跑」，并注入分歧在 log/enforce 两模式各验证一次；删装配 ⇒ 红。`git diff` 只含拍的那根接线（driver 或新服务）、文档里那句失效前提的修订、判据文件、本任务 task 文件。

## Touches
- `server/modules/websocket/services/activity-heartbeat.service.ts` （若修法复用其 tick 则改；若 driver 自 arm 则不碰）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （reconcileTick 的拍接线 + 文档修订）
- `server/modules/providers/tests/claude-resident-reconcile.test.ts` （就地加「无订阅拍仍调」臂；若 grep 契约不允许加缝则另起同级文件）
- `tasks/gap-reconcile-heartbeat-unwired.md` （自触）

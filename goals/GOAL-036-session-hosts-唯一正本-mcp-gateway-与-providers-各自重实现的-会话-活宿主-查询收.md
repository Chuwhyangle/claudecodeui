---
id: GOAL-036
title: session-hosts 唯一正本：mcp-gateway 与 providers 各自重实现的「会话→活宿主」查询收敛到
  sessionHostManager.liveHostForSession
status: active
kind: goal
origin: "人 yale 2026-10-10 指令：批准
  docs/experiments/2026-10-10-archguard-ownership-architecture-review.md 候选
  #1（ownership-first + ArchGuard before/after + negative control，跨项目复用 Quay
  GOAL-030~034 方法论），即「把 mcp-gateway 与 providers 两处字节级相同的 live-host-for-session
  查询逻辑收敛到正确 canonical owner」。候选 #2（mcp-gateway 的 lease-close 安全策略搬迁）本 goal
  明确不做，只做风险调查并写 follow-up（见 body 非目标）。"
activatedAt: 2026-10-10T09:33:52.670Z
---

## 背景

2026-10-10 的只读架构审查（docs/experiments/2026-10-10-archguard-ownership-architecture-review.md）用 ArchGuard 的真实 MCP 接口对本仓库 server/ 与 src/ 做了 before-facts 快照，发现 `server/modules/mcp-gateway/mcp-session-host-control.ts:297` 的 `readLiveHost` 与 `server/modules/providers/services/sessions.service.ts:1249` 的私有函数 `liveHostForSession` 各自独立重实现了同一条谓词：`manager.snapshot().find(h => h.state !== 'closed' && h.bindings.has(sessionId))`。

实现这个 goal 之前又多读了一层：`server/modules/session-hosts/session-host-manager.service.ts:1585` 的 `createSessionHostManager()` 工厂**已经**把这条查询暴露成公开方法 `liveHostForSession(appSessionId)`（经 session-hosts barrel 导出的 `sessionHostManager` 单例自带），且这个方法已经是全仓库既有的注入缝形状（`deps.hosts.liveHostForSession` / `deps.sessionHostManager.liveHostForSession`，被 `mcp-gateway.read-tools.ts`、`mcp-session-background.ts`、调试 agent 测试、voice-realtime 测试等广泛复用）。真正没有复用这个既有正本的，是三处私有重实现：
1. `server/modules/session-hosts/resident-host.service.ts:320` 的模块私有 `liveHostForSession(sessionHostManager, appSessionId)`（本模块内部，三个调用点）；
2. `server/modules/mcp-gateway/mcp-session-host-control.ts:297` 的 `readLiveHost(manager, sessionId)`（投影到 `{mode, leases}` 后导出）；
3. `server/modules/providers/services/sessions.service.ts:1249` 的模块私有 `liveHostForSession(appSessionId)`。

**语义等价证明**（写在这里，不是断言）：三处重实现都先 `state !== 'closed'` 过滤再找 `bindings.has(id)`；canonical 方法 `liveHostForSession` 直接遍历 `hosts.values()`（不经 `snapshot()`，不经 `withinRetention` 过滤）再 `copyHost`。`withinRetention` 的第一分支是「非 closed 的宿主总是可读」，所以对「非 closed」谓词已经排除的宿主集合，`withinRetention` 从不改变结果——两条路径对「活宿主」这一子集逐字等价，canonical 方法额外少了一次整表 `snapshot()`/`copyHost` 全量复制（只在命中时 `copyHost` 一次）。证据：`server/modules/session-hosts/session-host-manager.service.ts:1564-1569`（`snapshot`）与 `:922-947`（`copyHost`）与 `:1585-1591`（`liveHostForSession`）。

## 范围

- 删除三处私有重实现，改为直接调用已存在、已barrel导出的 `sessionHostManager.liveHostForSession` / `deps.sessionHostManager.liveHostForSession`。
- `mcp-session-host-control.ts` 的 `readLiveHost` 保留现有导出签名 `(manager, sessionId) => {mode, leases} | null`（mcp-gateway barrel 的既有消费者不变），内部改为委派给 `manager.liveHostForSession(sessionId)` 后投影。
- 不新增任何 barrel 导出（`sessionHostManager` 本就是 session-hosts barrel 的既有导出，三个消费模块都已经导入它或其等价注入缝）。

## 非目标

- 不动候选 #2（`mcp-gateway` 的 lease-blocking close 安全策略搬迁到 `session-hosts`）——只做风险调查、写 follow-up 记录，不在本 goal 实现（该策略是否也要让 HTTP 路由具备是产品决策，不是机械决策）。
- 不动 `session-hosts.routes.ts` `GET /` 里内联的 `running` Set 构造（见 AC 的 negative control）——它扫描的是全部会话而不是单个 sessionId，形状不同，故意不收敛。
- 不动候选 #3（前端 42 包级环）、不动 `connectedClients` 的 lint-suppressed 深导入——两者都在 2026-10-10 审查报告里被明确列为更大/更高风险的候选，本 goal 范围外。
- 不改 `SessionHostManager`/`liveHostForSession` 方法本体的行为，不改 `snapshot()`/`copyHost`/`withinRetention`。
- 不改任何对外可观察行为（HTTP 响应、MCP 工具返回值、审计日志）——这是纯粹的「同一读端口」收敛，zero behavior change。

## 退出条件

1. 三处私有重实现被删除，三个调用点改为调用 canonical `liveHostForSession` 方法；`git diff` 只触碰 `resident-host.service.ts`、`mcp-session-host-control.ts`、`sessions.service.ts` 三个文件（加一个新增的单测文件）。覆盖：AC-324。
2. 既有判据不改一字仍绿：`mcp-session-host-control.test.ts`（含其 spy 计数断言）、`resident-host-service.test.ts` 等任何已有判据文件逐字通过。覆盖：AC-324。
3. 新增一个 session-hosts 单测，覆盖 open/closed/bound/unbound 四种宿主下 `liveHostForSession` 的既有行为基线。覆盖：AC-324。
4. negative control：`session-hosts.routes.ts` 的 `running` Set 构造逐字不变。覆盖：AC-324。
5. ArchGuard after：`modules/session-hosts` 的 fanIn/fanOut/环 与 before-facts（fanIn 9 / fanOut 31 / 无环）逐字相同。覆盖：AC-324。
6. typecheck、lint 通过；develop 合并后窄范围判据再次逐字通过（postmerge）。覆盖：AC-324。

## 已知限制

- `providers/services/sessions.service.ts` 里 `switchSessionLifecycleMode` 的活宿主分支目前没有专门的单元测试直接调用（只被集成/端到端路径覆盖），本 goal 不补这个既有缺口。
- 本仓库此刻有自治的 quay worker-driver 在跑（`driver-anchor.js --root .../claudecodeui`），本 goal 的任务由本会话（yale 的交互 session）直接实现并合并，不经自治 selector 派发，以避免并发重复实现同一改动；任务 status 在实现+合并验证完成前保持非 `ready`。

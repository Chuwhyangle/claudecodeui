---
id: AC-324
title: 三处会话→活宿主重实现收敛到
  sessionHostManager.liveHostForSession，既有判据与新判据逐字绿，ArchGuard 包级边不变
status: active
kind: criterion
goal: GOAL-036
criterion: for f in
  server/modules/session-hosts/tests/live-host-for-session.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/session-hosts/tests/live-host-for-session.test.ts
  server/modules/mcp-gateway/tests/mcp-session-host-control.test.ts
  server/modules/session-hosts/tests/resident-host-service.test.ts
expect: 读数：(a) `server/modules/session-hosts/resident-host.service.ts` 的模块私有
  `liveHostForSession(sessionHostManager,
  appSessionId)`、`server/modules/mcp-gateway/mcp-session-host-control.ts` 的
  `readLiveHost` 内部重实现、`server/modules/providers/services/sessions.service.ts`
  的模块私有 `liveHostForSession(appSessionId)` 三处都不再各自重写 `state !== 'closed' &&
  bindings.has(id)` 谓词，而是调用已存在的 `sessionHostManager.liveHostForSession` /
  `deps.sessionHostManager.liveHostForSession`（`session-host-manager.service.ts:1585`
  的既有方法，经 session-hosts barrel 的 `sessionHostManager` 单例导出，不新增导出）。(b)
  `readLiveHost` 导出签名与返回形状 `{mode, leases} | null` 不变（mcp-gateway barrel
  的既有消费者不变）。(c) 新判据 `live-host-for-session.test.ts` 固定 open/closed/bound/unbound
  四种宿主下的既有行为基线（证明收敛前后行为逐字相同，不是新增行为）。(d) 既有判据
  `mcp-session-host-control.test.ts`（含其 spy
  计数断言）、`resident-host-service.test.ts`、`providers` 下任何引用这两处旧私有函数的判据全部不改一字仍绿。(e)
  negative control：`session-hosts.routes.ts` `GET /` 内联的 `running` Set 构造逐字零
  diff（它扫描全部会话，形状不同，故意不收敛）。(f) ArchGuard
  after：`archguard_get_package_metrics`（scope=server）对 `modules/session-hosts` 的
  fanIn/fanOut 与 `archguard_detect_cycles(outputScope=package)` 的环集合与 2026-10-10
  审查报告记录的 before-facts（fanIn 9 / fanOut 31 / 无环）逐字相同。(g) typecheck 与 lint
  通过。（红先行）当前必红：判据文件 `live-host-for-session.test.ts` 不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: "docs/experiments/2026-10-10-archguard-ownership-architecture-review.md
  候选 #1 + 人 yale 2026-10-10 批准实施指令。criterion
  的既有判据文件名与路径经直接读源码核实（mcp-session-host-control.ts:297-305、sessions.service.ts:1\
  249-1255、resident-host.service.ts:320-327、session-host-manager.service.ts:156\
  4-1591）。"
activatedAt: 2026-10-10T09:33:53.249Z
statusLog:
  - at: 2026-10-10T09:33:53.249Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-10T09:33:53.249Z
---

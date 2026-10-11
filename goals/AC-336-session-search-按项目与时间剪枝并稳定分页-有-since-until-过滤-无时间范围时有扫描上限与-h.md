---
id: AC-336
title: session_search 按项目与时间剪枝并稳定分页：有 since、until 过滤，无时间范围时有扫描上限与 hasMore，不静默漏掉更老的历史
status: active
kind: criterion
goal: GOAL-040
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-session-search-pruning.test.ts; do [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-session-search-pruning.test.ts
expect: 读数——(a) 新增可选参数 since、until，在全文扫描之前按会话的 updated_at
  预过滤，被排除的会话文件不进入扫描（注入的扫描器记录到的文件集合可断言）；(b)
  无时间范围时按最近活动从新到旧扫描，单次调用的扫描量有上限（会话文件数与耗时两道上限，数值写进工具描述），触顶时返回 hasMore 为
  true、nextCursor 与 scannedThrough（已扫描到的最老 lastActivity），沿 nextCursor
  继续翻页最终覆盖全部历史且不重复不遗漏；(c) cursor 改为按 lastActivity 与 sessionId 的键集，旧的 skip 计数
  cursor 仍被接受；(d) 每条命中带 turnIndex，与 session_read outline 的序号一致；(e)
  默认不建立任何新的全文或向量索引（不新增表、不写转录副本）。取假形态——无时间范围时只扫第一页且不报 hasMore ⇒ (b) 必须红。
origin: 外部 Agent 2026-10-11 第三轮：低风险、契约已定稿，按既有裁定范围推进；扫描上限默认值 200 文件/3000ms 为本轮推荐默认（E4）
activatedAt: 2026-10-11T13:48:40.294Z
statusLog:
  - at: 2026-10-11T13:48:40.294Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-11T13:48:40.294Z
---

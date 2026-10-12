---
id: AC-347
title: changes 的 session 增量按 (updatedAt, sessionId) 升序键集分页、项目过滤下推到查询，任何截断都不跳过未读行
status: active
kind: criterion
goal: GOAL-042
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts
  server/modules/mcp-gateway/tests/mcp-changes.test.ts; do [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json
  --test server/modules/mcp-gateway/tests/mcp-changes-session-paging.test.ts
  server/modules/mcp-gateway/tests/mcp-changes.test.ts
expect: 读数（新判据文件 mcp-changes-session-paging.test.ts，真实 sessions 表夹具）——(a) 窗口内 60
  个会话、limit 50：沿返回的 cursor 连续翻页，恰好覆盖全部 60 个会话，每个出现一次（按 sessionId 去重后计数等于
  60，且无一缺失），页内按 updatedAt 升序；(b) 窗口内会话数恰好等于 limit 且之后还有会话时，第一页 complete 为
  false，下一页继续给出剩余会话——不允许因「行数等于 limit」而把水位推到 now；(c) 只限定一个项目的调用：另一个项目在同一窗口内有 200
  个更新的会话时，被限定的项目仍拿到自己的全部会话（项目过滤在 SQL 里，而不是 LIMIT 之后再在 JS 里过滤）；(d) 多个会话的
  updatedAt 完全相同时，跨页边界按 sessionId 继续，不跳过、不重复；(e) 上一版本（v1）发出的 cursor
  仍被接受并继续工作；(f) 既有 mcp-changes.test.ts 全部通过。取假形态（先实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）——(i) 恢复 ORDER BY DESC ⇒ (a) 必须红；(ii) 把项目过滤移回 LIMIT 之后 ⇒ (c)
  必须红；(iii) 键集只按 updatedAt 不带 sessionId ⇒ (d) 必须红。红先行：当前判据文件不存在，存在性闸以退出码 1
  输出缺失文件名；实现前先写好的判据在当前代码上 (a)(b)(c) 必须红并逐字记录。
origin: docs/proposals/cloudcli-mcp-control-observability-2026-10.md §11（第五轮）；外部
  Agent 2026-10-12 裁定 E1–E4，同意推进
activatedAt: 2026-10-12T06:52:13.159Z
statusLog:
  - at: 2026-10-12T06:52:13.159Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-12T06:52:13.158Z
---

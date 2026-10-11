---
id: AC-337
title: 写工具接受可选 correlationId 作为关联标签：记入 run 元数据与审计，可按它过滤会话与统计，不引入新的调度实体
status: achieved
kind: criterion
goal: GOAL-040
criterion: for f in server/modules/mcp-gateway/tests/mcp-correlation-id.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-correlation-id.test.ts
expect: 读数——(a) session_send、session_create、approval_answer 与 ui 写工具接受可选
  correlationId（1 到 128 个字符，限定字符集），不传时行为与现在一致；(b) 该值写进本次 run 的元数据与审计行的
  correlation_id；(c) sessions_list 与 mcp_usage_stats 接受 correlationId
  过滤，只返回带该标签的会话或调用；(d) 不新增任何会自行推进状态的实体或表，没有定时器或后台循环读取它；(e) 超长或非法字符报
  INVALID_ARGUMENT 并点名 correlationId。取假形态——不写审计 ⇒ (b)(c) 必须红。
origin: 外部 Agent 2026-10-11 第三轮：低风险、契约已定稿；硬依赖 AC-334 的列与工具，task 已 depends_on 串行
activatedAt: 2026-10-11T13:49:41.943Z
statusLog:
  - at: 2026-10-11T13:49:41.943Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-11T18:56:58.715Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-11T13:49:41.942Z
---

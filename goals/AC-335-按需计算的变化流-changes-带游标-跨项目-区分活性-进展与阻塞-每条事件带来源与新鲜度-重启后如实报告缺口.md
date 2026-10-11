---
id: AC-335
title: 按需计算的变化流 changes：带游标、跨项目、区分活性、进展与阻塞，每条事件带来源与新鲜度，重启后如实报告缺口
status: achieved
kind: criterion
goal: GOAL-040
criterion: for f in server/modules/mcp-gateway/tests/mcp-changes.test.ts; do [
  -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-changes.test.ts
expect: 读数——(a) 只读工具 changes 输入 cursor、since、projects、kinds、limit（1 到 200，默认
  50），输出 cursor、generatedAt、bootId、complete 与 events，每条事件带
  kind、project、at、signal（liveness、progress、blocked 之一）、ref、不含消息正文的 summary 与
  source（type、observedAt、ageMs）；(b) 夹具依次造会话新消息、run 开始与结束、一条待审批、Quay
  缓存中任务状态变化，用上一次返回的 cursor 再取，恰好看到这些变化且每条 signal 正确，会话新消息为 liveness，任务状态迁移为
  progress，待审批为 blocked；(c) 投递语义为至少一次，重复取同一 cursor 结果可重复但不遗漏；(d) cursor 里的
  bootId 与当前不同时返回 gaps，说明此前内存中的 run 与审批变化不可见，而不是假装完整；(e) 不触发全量会话同步、不在冷缓存时启动 Quay
  CLI（注入服务的调用计数为 0），Quay 冷缓存时在 gaps 里说明；(f) 篡改的 cursor 报
  INVALID_ARGUMENT。取假形态——把会话新消息标为 progress ⇒ (b) 必须红；bootId 变化时不报 gaps ⇒ (d)
  必须红。
origin: docs/proposals/cloudcli-mcp-control-observability-2026-10.md §4 第 1
  阶段；外部 Agent 2026-10-11 暂定裁定 D4、D5、D6。草稿：待契约确认后再激活，不派发
activatedAt: 2026-10-11T13:53:34.348Z
statusLog:
  - at: 2026-10-11T13:53:34.348Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-11T17:14:30.580Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-11T13:53:34.348Z
---

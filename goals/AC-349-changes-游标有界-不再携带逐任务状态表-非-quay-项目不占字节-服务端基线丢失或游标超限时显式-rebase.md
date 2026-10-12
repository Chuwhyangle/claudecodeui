---
id: AC-349
title: changes 游标有界：不再携带逐任务状态表，非 Quay 项目不占字节，服务端基线丢失或游标超限时显式 rebase gap，绝不宣称 complete
status: active
kind: criterion
goal: GOAL-042
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts
  server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts
  server/modules/mcp-gateway/tests/mcp-changes.test.ts; do [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json
  --test server/modules/mcp-gateway/tests/mcp-changes-cursor-bounds.test.ts
  server/modules/mcp-gateway/tests/mcp-changes-quay-index.test.ts
  server/modules/mcp-gateway/tests/mcp-changes.test.ts
expect: 读数（新判据文件 mcp-changes-cursor-bounds.test.ts）——(a) 58 个项目、其中 8 个 Quay
  项目、合计 2729 个任务的夹具下，编码后的 cursor 不超过 8192 字节；(b) cursor 不再内嵌逐任务状态表，每个 Quay
  项目只记录紧凑的版本或摘要，并引用服务端有界 LRU 中的基线；非 Quay 项目不出现在 cursor 里；(c) 服务端 LRU 淘汰了某项目基线，或
  bootId 改变时：该项目报告 state 为 rebase 的 gap，complete 为
  false，不编造事件，下一次调用重新建立基线；淘汰与重启期间发生的迁移以 gap 的形式明确声明「可能遗漏」，绝不静默；(d)
  切换项目作用域不会让之后切回时产生「全部是新任务」的误报（要么保留基线，要么报告 rebase）；(e) 上一版本（v1，含逐任务表）的 cursor
  仍被接受：解码后迁移为新格式，并报告 rebase 或按其表 diff，而不是拒绝；(f) LRU
  的容量与单项基线大小有明确上限（数值写进代码常量与工具描述）。取假形态——(i) 淘汰时不报 gap ⇒ (c) 必须红；(ii) 去掉 8KB
  上限或仍内嵌任务表 ⇒ (a)(b) 必须红。红先行同 AC-347。
origin: docs/proposals/cloudcli-mcp-control-observability-2026-10.md §11（第五轮）；外部
  Agent 2026-10-12 裁定 E1–E4，同意推进
activatedAt: 2026-10-12T06:52:14.243Z
statusLog:
  - at: 2026-10-12T06:52:14.243Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-12T06:52:14.242Z
---

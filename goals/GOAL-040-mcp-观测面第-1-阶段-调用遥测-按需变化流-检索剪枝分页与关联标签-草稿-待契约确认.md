---
id: GOAL-040
title: MCP 观测面第 1 阶段：调用遥测、按需变化流、检索剪枝分页与关联标签（草稿，待契约确认）
status: achieved
kind: goal
origin: 外部 Agent 2026-10-11 第三轮：优先完成 AC-334 契约并推进到可由 Driver 执行的状态
activatedAt: 2026-10-11T13:46:01.115Z
statusLog:
  - at: 2026-10-11T13:46:01.115Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-11T18:57:37.672Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

第 0 阶段（GOAL-039）修的是目标解析。审计基线（UTC 10-07 00:00 至 10-11 10:00，2777 次调用）显示外部客户端主要靠轮询：session_read 占 55.6%，quay_snapshot 占 6.5%（p95 3.8 秒）；头部调用方两次成功写操作之间的读调用 p50 为 4、p90 为 22。session_search 只被调用一次，耗时 24.6 秒，因为每次都全量扫描转录文件。审计表没有错误码、返回体积和关联标签，所以无法精确度量「完成一次推进意图需要多少次调用」。完整证据与决策见 docs/proposals/cloudcli-mcp-control-observability-2026-10.md。本 goal 承载第 1 阶段，**保持草稿**，等待外部 Agent 与人确认接口契约后再激活。

## 范围

- 调用遥测：审计行补错误码、返回字节数、关联标签，并提供只读统计工具（AC-334）。
- 按需计算的变化流 changes，不建事件总线（AC-335）。
- session_search 按项目与时间剪枝、稳定分页、无时间范围时报告 hasMore（AC-336）。
- 写工具的可选关联标签 correlationId（AC-337）。

## 非目标

- 不做语义检索，不建全文或向量索引，不存转录副本。
- 不做持久化事件日志；只有在证明按需拼接会丢事件后才另行立项。
- 不做独立的 Operation 实体，不做任何调度，完成与否仍以 Quay gate 为准。
- 不实现 Quay task_trace：它属于 Quay 的导出接口，CloudCLI 只透传，另在 Quay 立项。
- 不碰 sessions_list 的分页（GOAL-027 AC-300）和 run_get、runId 语义（GOAL-027 AC-298、AC-299）。

## 退出条件

1. 遥测可聚合且不含正文（AC-334）。覆盖状态：直接覆盖。
2. 变化流（AC-335）：游标、三类信号、来源与新鲜度、重启缺口。覆盖状态：直接覆盖。
3. 检索剪枝与分页（AC-336）。覆盖状态：直接覆盖。
4. 关联标签（AC-337）。覆盖状态：直接覆盖。
5. 效果读数：同一头部调用方连续 3 天以上的窗口里，两次写之间的读调用 p50 不高于 2、p90 不高于 8，session_read 占比低于 30%，用 AC-334 的统计工具读出。覆盖状态：无单独 AC，需要外部客户端改用 changes 后才能读到，属观察项。

## 已知限制

- 每个新工具都会移动 tools/list 的计数钉与登记表测试（mcp-english-only、mcp-error-envelope、mcp-tool-annotations、mcp-read-tools），每个新测试文件都会移动 quay-test-script 的测试文件总数钉，须在各自任务内同步。
- 系统是单用户的，没有按项目的权限控制；跨项目的变化流与检索等同于全量读权限。

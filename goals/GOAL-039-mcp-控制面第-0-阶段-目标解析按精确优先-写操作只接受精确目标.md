---
id: GOAL-039
title: MCP 控制面第 0 阶段：目标解析按精确优先、写操作只接受精确目标
status: achieved
kind: goal
origin: docs/proposals/cloudcli-mcp-control-observability-2026-10.md；外部 Agent
  2026-10-11 本轮裁定 D1、D2，授权推进低风险修复
activatedAt: 2026-10-11T10:08:01.740Z
statusLog:
  - at: 2026-10-11T10:35:42.657Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

外部 MCP 客户端（ChatGPT Agent）10-07 至 10-11 高频经 CloudCLI MCP 查询会话、推进任务。mcp_audit_log 记录 2777 次调用，其中 sessions_list 失败 32 次（22%）。可复现的根因是项目解析没有「精确标题」层：project 取 quay 时，只要还有 quay-web、foo-quay 等标题包含 quay，就必然报 TARGET_AMBIGUOUS，只能改用 UUID。完整讨论、证据与决策表见 docs/proposals/cloudcli-mcp-control-observability-2026-10.md。本 goal 只承载该讨论的第 0 阶段：已裁定、低风险的契约修正。

## 范围

- 目标解析优先级：精确 id，然后规范化完整路径（只对项目），然后唯一精确标题（先区分大小写，再不区分大小写），最后才是子串。
- 写工具只接受精确目标。只靠子串命中时拒绝并给出候选，沿用 TARGET_AMBIGUOUS，不新增错误码。
- 歧义候选附带 path 与 matchType，方便调用方一次重试成功。

## 非目标

- 不做变化流、检索性能、correlationId、调用统计工具。这些属于第 1 阶段，另立 goal，草稿态，等待契约确认。
- 不改错误信封结构，不重命名错误码（不新增 AMBIGUOUS_PROJECT）。
- 不加按项目的权限控制。

## 退出条件

1. 解析优先级与写工具严格性（AC-333）：精确 id、完整路径、精确标题依次优先于子串；写工具拒绝只靠子串的目标，服务调用计数为 0。覆盖状态：直接覆盖。
2. 真实服务读数：在临时实例上，sessions_list 与 quay_snapshot 用 project=quay 都成功（以前报 TARGET_AMBIGUOUS），session_create 用子串被拒。覆盖状态：由 AC-333 对应任务的 DoD 覆盖，无单独 AC。
3. 既有 MCP 判据保持通过（移植、不放宽），typecheck 通过。覆盖状态：无单独 AC。

## 已知限制

- 放宽了已验收的 AC-246 行为：以前精确同名但另有子串命中时报错，现在会解析。收紧也同时发生：写工具不再接受唯一子串。依赖「唯一子串即可写」的客户端会收到 TARGET_AMBIGUOUS（reason 为 exact_target_required），需要改用 id 或精确标题。
- 新增服务端测试文件会移动 quay-test-script.test.ts 钉住的测试文件总数，以及 suite-duration-baseline 的覆盖率下限，须同步。

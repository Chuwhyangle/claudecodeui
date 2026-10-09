---
id: AC-314
title: Multimodal Engineering Workspace 架构规格：三层信息架构的数据归属 + Quay/ClaudeCodeUI
  接口覆盖度盘点（设计产出，不实现）
status: draft
kind: criterion
goal: GOAL-032
criterion: "test -f docs/proposals/multimodal-engineering-workspace-SPEC.md || {
  echo \"missing spec: docs/proposals/multimodal-engineering-workspace-SPEC.md\"
  >&2; exit 1; }; grep -q \"不新建\"
  docs/proposals/multimodal-engineering-workspace-SPEC.md || { echo \"spec
  exists but has no explicit 'ClaudeCodeUI 不新建哪些状态' 边界声明\" >&2; exit 1; }"
expect: 产出一份规格文档，对 `docs/proposals/voice-native-control-plane.md` §12.6
  的三层信息架构（Portfolio Overview / Project-Goal-Task-Driver-Session /
  Evidence-Action）逐层列出：每一层打算显示的具体字段，各自的数据来源是 Quay 已有的哪个只读接口（CLI verb、MCP 工具、既有
  `QuaySnapshot` 投影）还是 ClaudeCodeUI 自己已有的哪个数据源；**明确列出 ClaudeCodeUI
  不打算新建的状态模型清单**，把
  `gap-quay-tab-loop-pulse-gantt-cross-project-interface-design` 已经做过一次的"路径 A（请
  Quay 导出可复用能力）vs 路径
  B（移植+等价性测试）"归属判断方法，应用到三层模型里其它还没做过这个判断的部分（不止甘特图一个部件）；对每一处"现有接口不够用"的缺口，标注该缺口应该由
  Quay 侧补（只读接口扩展）还是 ClaudeCodeUI 侧补（纯渲染/投影），不要求当场实现任何一处。**本 AC
  不要求、也不允许**本任务顺手开始写任何 UI 组件或新的后端状态管理代码——那是本 GOAL 后续、且尚未被批准的阶段。
origin: docs/proposals/voice-native-control-plane.md §12.6（2026-10-09
  补充的长期方向）；`gap-quay-tab-loop-pulse-gantt-cross-project-interface-design`（done，提供了方法论先例）；`gap-mcp-pending-interaction-visibility-and-idempotent-answer`（ready，提供了"注意力管理"层已有的数据地基）；人
  yale 2026-10-09 要求"若多项目工作空间确实需要独立推进，建一个后续 draft GOAL，不扩大 GOAL-031"。
---

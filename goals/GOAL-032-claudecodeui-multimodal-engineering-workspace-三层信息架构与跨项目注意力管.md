---
id: GOAL-032
title: ClaudeCodeUI Multimodal Engineering Workspace：三层信息架构与跨项目注意力管理（长期方向，draft）
status: draft
kind: goal
origin: docs/proposals/voice-native-control-plane.md §12.6（2026-10-09 补充）；人 yale
  2026-10-09 要求把多项目/多会话/多 agent 的工作台方向独立于 GOAL-031 追踪，建一个后续 draft GOAL 并明确关系，不扩大
  GOAL-031 的验收范围。
---
## 背景

GOAL-031 是 Live Voice 的最小单会话闭环（语音→理解→当前会话 `session_send`→反馈）。但 §12.6 把长期方向定得更大：Live Voice 的终态不是"给聊天框加语音"，是一个多项目、多会话、多 agent 的 **Multimodal Engineering Workspace**——语音只是这个工作台的一个输入/提醒通道，主要信息输出是结构化、可交互的视觉 UI（三层信息架构：Portfolio Overview / Project-Goal-Task-Driver-Session / Evidence-Action）。

本 GOAL 独立于 GOAL-031 追踪这个方向，**不把它塞进 GOAL-031 的验收范围**——GOAL-031 的"第二阶段非本 GOAL 范围"条款已经把跨项目/多会话排除出去，本 GOAL 就是那个"下一个 GOAL"，但目前还只到"规格与可行性调查"的阶段，没有被批准进入实现。

## 目标（当前阶段：只做规格与盘点，不实现）

产出一份架构规格（AC-314），把 §12.6 的三层信息架构落到具体字段级别，并明确每一层的数据归属——Quay 已有的只读接口能覆盖的部分直接复用（不新建状态模型），覆盖不到的部分标注缺口该由谁补。这条工作本身**不新建任何 UI 组件或后端状态管理代码**。

## 范围

- 对 §12.6.2 三层架构的每一层，列出具体字段与数据来源。
- 对 §12.6.6 的"不重复构建状态模型"原则，把 `gap-quay-tab-loop-pulse-gantt-cross-project-interface-design` 已经做过一次的路径 A/B 归属判断方法，推广到三层模型的其它部分。
- 对 §12.6.4 的注意力管理，确认 `gap-mcp-pending-interaction-visibility-and-idempotent-answer` 落地后的字段是否足够支撑"等待用户回答"这一类提醒，不够的话标注缺口。

## 非目标

- 不实现任何 UI 组件（Portfolio/Project 剖面/Evidence 面板一个都不做）。
- 不新建任何后端状态管理/数据模型——这正是本 GOAL 存在的理由之一：先把"要不要新建"这个问题的答案钉清楚，再谈要不要做。
- 不扩大 GOAL-031 的验收范围；GOAL-031 的单会话闭环与本 GOAL 的规格调查互不阻塞、互不依赖。
- 不新建审批/确认体系——延续 GOAL-031 已经裁定的立场（§12.6.8）：即使工作台扩展到多项目/多会话，危险操作确认仍然复用 Claude Code 自己已有的机制，不是本 GOAL 要解决的问题。
- 不预先假定一定会做下一阶段的实现——本 GOAL 当前只到"值不值得做、怎么做不重复建模"这一步，是否进入实现是规格产出之后的另一次决策。

## 退出条件

- AC-314 架构规格文档存在，覆盖三层模型的字段级数据归属与 Quay/ClaudeCodeUI 接口覆盖度盘点。

## 已知限制

- 本 GOAL 目前是 draft，未激活；是否激活、是否进入实现阶段，留给规格产出后的人工决策。
- 本 GOAL 的规格依赖 `gap-quay-tab-loop-pulse-gantt-cross-project-interface-design`（done）与 `gap-mcp-pending-interaction-visibility-and-idempotent-answer`（ready，建议等它落地后再定稿注意力管理那一节，否则只能先写"假设它落地后"的占位分析）。
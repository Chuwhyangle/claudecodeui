---
id: gap-voice-realtime-popup-observability-investigation
title: 语音发起的轮次遇到 AskUserQuestion/权限请求的可观测性调查（AC-313，只读不阻塞）
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-313
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rli "popup-observability\|voice.*askuserquestion" tasks/*.md goals/*.md` 零命中。本任务不依赖 GOAL-031 的其它任务，可以独立、立即开始——它只需要现有的 `server/modules/mcp-gateway/mcp-approvals.ts` 和一个能触发 `AskUserQuestion` 的真实或模拟 Claude 会话，不需要等 AC-309 或任何语音接线任务。

### 背景

语音发起的轮次（`ChatRunSource==='mcp'`）如果触发了 Claude Code 自己的 `AskUserQuestion`/权限确认，用户需要知道"它在等你"，而不是以为语音功能卡死了。本任务**只调查现状**，不实现任何应答能力——人 yale 明确要求这条不能变成本 GOAL 的硬阻塞。

### 方案

1. 构造一个场景：触发一轮会产生 `AskUserQuestion` 的 Claude 会话（真实触发，或复用 ADR-003 的调试 agent 做忠实模拟），来源标记为 `mcp`。
2. 在该请求挂起期间调用 `approvals_list`，记录它的原始返回（`requestId`/`toolName`/`inputSummary`/展开的 questions/options）。
3. 写记录 `docs/experiments/2026-10-09-voice-popup-observability.md`：贴出原始读数，回答"语音层如果去读这个工具，能不能知道'正在等人回答、问题是什么'"，给出一句明确建议——现状够用就写"够用，不建议现在做任何实现"；不够用就写清楚缺口是什么（但**不实现**那个缺口，只是指出来）。

### 边界（不做）

不实现任何语音应答 `AskUserQuestion` 的能力；不改 `mcp-approvals.ts`；不影响 GOAL-031 其它任务——即使这里的结论是"不够用"，GOAL-031 的退出条件依然是"这份调查记录存在且给出建议"，不是"缺口被补上"。

## AC

- [x] AC1 真实或忠实模拟的触发：有一次 `AskUserQuestion`/权限请求在"来源为 mcp 的轮次运行中"挂起的具体读数（不是推测出来的）。
- [x] AC2 `approvals_list` 的原始返回被记录：记录里贴出该工具在那个场景下实际返回的内容。
- [x] AC3 记录存在且给出明确建议：`docs/experiments/2026-10-09-voice-popup-observability.md` 存在，含"建议"二字开头的一句明确结论。
- [x] AC4 不扩大范围：完成记录写明本任务未改动 `mcp-approvals.ts` 或任何实现代码，`git diff --name-only` 只含本任务声明的记录文件与任务文件。

## DoD

真实落地判据：不是"写了一段分析"，是**真的让一个 mcp 来源的轮次触发过一次 AskUserQuestion，并读到了 `approvals_list` 在那个状态下的真实返回**。建议本身可以是"不用做"，这不影响本 AC 达标——判定的是"调查是否真的做了"，不是"结论是否支持实现"。

## Touches

- docs/experiments/2026-10-09-voice-popup-observability.md (new)
- tasks/gap-voice-realtime-popup-observability-investigation.md (self)
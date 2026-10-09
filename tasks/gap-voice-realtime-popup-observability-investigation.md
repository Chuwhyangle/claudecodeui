---
id: gap-voice-realtime-popup-observability-investigation
title: 语音发起的轮次遇到 AskUserQuestion/权限请求的可观测性调查（AC-313，只读不阻塞）
status: done
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-313
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rli "popup-observability\|voice.*askuserquestion" tasks/*.md goals/*.md` 零命中。本任务不依赖 GOAL-031 的其它任务，可以独立、立即开始——它只需要现有的 `server/modules/mcp-gateway/mcp-approvals.ts` 和一个能触发 `AskUserQuestion` 的真实或模拟 Claude 会话，不需要等 AC-309 或任何语音接线任务。

**2026-10-09 去重登记**：`gap-mcp-pending-interaction-visibility-and-idempotent-answer`（ready，通用 MCP 可见性硬化任务，源于一次真实事故）已经在自己的 dedup-ref 里声明和本任务"机制不同、互不依赖、互不阻塞"。两条任务的关系是单向改善，不是重复：那条任务一旦落地，会给 `session_get`/`sessions_list`/`approvals_list` 补上 `pendingInteraction`/`awaitingUser`/`interactive`/`autoTimeoutMs` 这几个结构化字段——本任务执行时若那条任务已经 done，应该直接读这些新字段作为"原始读数"的来源，不必再从 `turn.phase` 等更底层的信号自己推断一遍；若那条任务还没落地，本任务仍然可以用现有的 `approvals_list`（不展开 `pendingInteraction`）独立完成调查，只是读数会更原始一些，结论不受影响。

### 背景

语音发起的轮次（`ChatRunSource==='mcp'`）如果触发了 Claude Code 自己的 `AskUserQuestion`/权限确认，用户需要知道"它在等你"，而不是以为语音功能卡死了。本任务**只调查现状**，不实现任何应答能力——人 yale 明确要求这条不能变成本 GOAL 的硬阻塞。

### 方案

1. 构造一个场景：触发一轮会产生 `AskUserQuestion` 的 Claude 会话（真实触发，或复用 ADR-003 的调试 agent 做忠实模拟），来源标记为 `mcp`。
2. 在该请求挂起期间调用 `approvals_list`（若 `gap-mcp-pending-interaction-visibility-and-idempotent-answer` 已落地，一并调用 `session_get` 读 `pendingInteraction`），记录它们的原始返回（`requestId`/`toolName`/`inputSummary`/展开的 questions/options，以及新字段若存在）。
3. 写记录 `docs/experiments/2026-10-09-voice-popup-observability.md`：贴出原始读数，回答"语音层如果去读这些工具，能不能知道'正在等人回答、问题是什么'"，给出一句明确建议——现状够用就写"够用，不建议现在做任何实现"；不够用就写清楚缺口是什么（但**不实现**那个缺口，只是指出来）。

### 边界（不做）

不实现任何语音应答 `AskUserQuestion` 的能力；不改 `mcp-approvals.ts` 或 `gap-mcp-pending-interaction-visibility-and-idempotent-answer` 声明的任何文件；不影响 GOAL-031 其它任务——即使这里的结论是"不够用"，GOAL-031 的退出条件依然是"这份调查记录存在且给出建议"，不是"缺口被补上"。

## AC

- [ ] AC1 真实或忠实模拟的触发：有一次 `AskUserQuestion`/权限请求在"来源为 mcp 的轮次运行中"挂起的具体读数（不是推测出来的）。
- [ ] AC2 `approvals_list`（及若已落地的 `session_get.pendingInteraction`）的原始返回被记录：记录里贴出这些工具在那个场景下实际返回的内容。
- [ ] AC3 记录存在且给出明确建议：`docs/experiments/2026-10-09-voice-popup-observability.md` 存在，含"建议"二字开头的一句明确结论。
- [ ] AC4 不扩大范围：完成记录写明本任务未改动 `mcp-approvals.ts`/`gap-mcp-pending-interaction-visibility-and-idempotent-answer` 声明的任何文件或任何实现代码，`git diff --name-only` 只含本任务声明的记录文件与任务文件。

## DoD

真实落地判据：不是"写了一段分析"，是**真的让一个 mcp 来源的轮次触发过一次 AskUserQuestion，并读到了 `approvals_list`（以及若可用的 `pendingInteraction`）在那个状态下的真实返回**。建议本身可以是"不用做"，这不影响本 AC 达标——判定的是"调查是否真的做了"，不是"结论是否支持实现"。

## Touches

- docs/experiments/2026-10-09-voice-popup-observability.md (new)
- tasks/gap-voice-realtime-popup-observability-investigation.md (self)
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

## 完成结论（摘自 docs/experiments/2026-10-09-voice-popup-observability.md，交付物文件全程未受下面的操作事故影响）

建议**现状够用，不建议现在为 `AskUserQuestion` 的可观测性做任何实现**：`approvals_list` 的返回已经足以让语音层回答"哪个会话正在等人、问题是什么、有哪些选项、等了多久"。记录同时指出一条不属于本调查范围的缺口——语音桥的 executor 尚未真正接线到 Realtime 客户端（这是 `gap-voice-realtime-live-session-send-wiring` 的事），不影响这条"可观测性够用"的结论，也不影响 GOAL-031 的退出条件。

## 2026-10-09 事后去重登记（补记，不改变上面已完成的判定）

`gap-mcp-pending-interaction-visibility-and-idempotent-answer`（ready，通用 MCP 可见性硬化任务，源于一次真实事故）在它自己的 dedup-ref 里声明和本任务"机制不同、互不依赖、互不阻塞"。本任务的调查发生在它落地**之前**，只读到了 `approvals_list` 现有字段，没有它将会补上的 `pendingInteraction`/`awaitingUser` 等结构化字段——这不影响本任务已经得出的"现状够用"结论（那条结论本来就是针对 `approvals_list` 现有字段说的）。留给未来：若 `gap-mcp-pending-interaction-visibility-and-idempotent-answer` 落地后想法有变化，应该开一条新的调查任务去读新字段，而不是回头改写本任务已经关闭的判定。

## 操作事故记录（本次更正，便于审计）

2026-10-09 的一次 `task_write` 误用了本任务**完成前**的旧正文（含去重登记但 AC 全部未勾选）覆盖了本任务已完成的正文；紧接的修正尝试同时传了 `status:'done'` + `completeReason`，结果磁盘上的 `body` 字段没有跟着那次调用一起更新（只有状态保持 done）——这是本次操作本身暴露出的一个 ABI 行为：`status` 转换与 `body` 更新同一次调用时，`body` 可能不生效，需要分两次写。本次才是真正把 `body` 修正过来的那一次调用，不再附带 `status`/`completeReason`。真实交付物 `docs/experiments/2026-10-09-voice-popup-observability.md` 在磁盘上全程未被触碰，内容和结论从未受影响。
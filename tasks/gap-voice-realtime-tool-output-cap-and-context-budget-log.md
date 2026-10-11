---
id: gap-voice-realtime-tool-output-cap-and-context-budget-log
title: Live Voice Realtime 阶段A低风险优化：工具结果体积上限 + 上下文预算观测（纯函数、零协议改动、离线fake-upstream验证）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-12，承接 `/tmp/voice-cost-audit/{REPORT.md,RECONNECT_VS_ONDEMAND.md}` 三轮离线费用核验的"阶段A低风险优化"建议）

真实 journal 核实（8个连接，2026-10-11）：实际被调用的工具只有 `session_send`，其 `function_call_output`
本身很小（`{accepted,instruction}`，`voice-realtime-ws-proxy.service.ts:1067-1072` 引用过的形状）。但
`session_get`/`run_get`（`server/modules/voice-realtime/voice-realtime-live-executor.ts:253-254`）
复用的是 MCP gateway 的通用 `buildSessionDetail`/`buildRunGet`（`mcp-gateway.read-tools.ts`），**没有任何
voice 专属的体积上限**——这两个工具目前未在真实流量里出现过，所以这是**前瞻性加固**，不是修一个已观测到的
真实故障。

**为什么任何体积都值得现在就卡住，不等出现在真实流量后再修**：`voice-realtime-dashscope-transport.ts` 的
线协议只有 6 个客户端→上游成员（`voice-realtime-bridge.service.ts:46-70`），**没有** `conversation.item.delete`
/`truncate`；`function_call_output` 永远和 `response.create` 焊死发出（`toDashscopeFrames` 的
`function_call_output` 分支）。一旦某个工具结果写进去，它就是这条连接此后**每一次** response 都要重新处理、
重新计费的永久上下文——这正是三轮费用核验（`RECONNECT_VS_ONDEMAND.md` A部分）证实的"单连接成本随轮数二次
增长"的真实机制之一：任何一次性塞进去的大对象都会被这个二次增长放大。

### 查重（2026-10-12 实测）

- `tasks/` 里 `gap-live-voice-status-aggregate-and-inject`（**ready**）与
  `gap-live-voice-continuous-duplicate-session-send-without-new-audio`（**ready**）都在做"降低 Live Voice
  实时成本/噪音"相关的工作，但机制完全不同——前者是向上游**注入**执行面状态行（改 `session.update`），后者是
  连续模式下对**重复的** `session_send` 调用去重；两者 Touches 都claim了
  `voice-realtime-ws-proxy.service.ts`/`voice-realtime-bridge.service.ts`（各自不同程度）。本任务只改
  `voice-realtime-dashscope-transport.ts`（+该文件的既有测试+该模块的 `index.ts` 桶文件新增两个导出），
  **三个文件都不在上述两个 ready 任务的 Touches 里**，不 depends_on，可并行派发。
- grep `TOOL_OUTPUT_MAX_CHARS`/`CONTEXT_BUDGET_WARNING_TOKENS`/"工具结果.*体积"/"context.*budget" 在
  `tasks/` 下无命中。

### 边界 / 不做

- ⛔ 不改 VAD 传输（`src/shared/voiceEndpoint.ts`、`voiceFrameProcessor.ts`）、不做 reconnect——按人的范围声明，
  这两块留给其它会话/任务。
- ⛔ 不碰 `voice-realtime-ws-proxy.service.ts`、`voice-realtime-bridge.service.ts`——避免和上述两个 ready
  任务冲突。
- ⛔ 不改线协议语义：`function_call_output` 超限后仍然是**合法 JSON 字符串**（不是截断成半个 JSON），模型
  收到的是一个新形状（`{truncated,originalChars,maxChars,preview}`）而不是报错——不引入新的客户端↔上游消息
  种类，不改变 `toDashscopeFrames` 其它分支。
- ⛔ 不发任何真实 DashScope 拨号：本任务全部验证走该文件既有的 fake-upstream 测试harness
  （`voice-realtime-dashscope-harness.ts`），`apiKey` 路径不触碰。
- ⛔ `contextBudgetStatus` 只读、只导出，本任务**不**把它接进真实的 journal 写入路径
  （`voice-realtime-log.ts`）或 spend-guard——那需要碰 `log.ts`/`bridge.service.ts`，留给后续任务，防止
  和两个 ready 任务打架。

## Plan（已实施，见下方"实施记录"）

1. `voice-realtime-dashscope-transport.ts`：
   - `toWireOutput` 加体积上限 `TOOL_OUTPUT_MAX_CHARS`（2000 字符）。超限时**不**截断半个 JSON 字符串，
     而是整体换成 `{truncated:true, originalChars, maxChars, preview}` 的新合法 JSON——`preview` 字段保留
     前 2000 字符供排查。
   - 新增 `contextBudgetStatus(usage)`：纯函数，复用 `estimateRealtimeCostCny` 已验证过的
     `input_tokens_details.{audio_tokens,text_tokens}` 解析口径（与它永不互相矛盾），返回
     `{textTokens, audioTokens, overBudget, thresholdTokens}`；未知/畸形 `usage` 读 0 不抛错（与
     `estimateRealtimeCostCny` 同一条"fail-open"规则）。
2. `index.ts`（该模块桶文件）：新增导出 `TOOL_OUTPUT_MAX_CHARS`、`CONTEXT_BUDGET_WARNING_TOKENS`、
   `contextBudgetStatus`。
3. 测试加进**既有文件** `tests/voice-realtime-dashscope-transport.test.ts`（不新建文件，避免碰
   `server/shared/tests/quay-test-script.test.ts` 的文件数钉子）：
   - 在既有"AC1: the outbound translation..."测试里追加：超限 payload → 断言返回的是合法 JSON、
     `truncated/originalChars/maxChars/preview` 字段正确、长度确实变小；恰好等于上限的 payload → 不被改动
     （上限是闭区间，不是 off-by-one）。
   - 新增一个独立 `test()`：`contextBudgetStatus` 在临界值、`input_tokens_details.text_tokens` 缺失时
     回退到 `input-audio`、以及 `null`/`undefined`/非对象输入下的行为。

## 实施记录（2026-10-12，本会话直接实施，未派发 worker）

全部已在独立 worktree `claudecodeui-worktrees/gap-voice-realtime-tool-output-cap-and-context-budget-log`
（分支 `task/gap-voice-realtime-tool-output-cap-and-context-budget-log`，从 `develop` 分出并已
`merge --no-edit develop` 到最新）里完成并提交（commit `e2e126f4`，message 头
`feat(voice-realtime): cap tool_call_output size and add context-budget observation`）。真实命令与读数：

- `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts`
  → **14/14 passed**（含本任务新增的 2 条断言块），该文件自身的 AC1 断言"fetch 和 WebSocket 全程零调用"
  同样通过，确认全程离线。
- `npm run typecheck` → exit 0。
- `npm run lint` → exit 0（0 errors；既有的、与本次改动无关的 warning 不变）。
- `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` → **11/11
  passed**——确认未新建测试文件，文件数钉子不受影响。
- `git diff --stat`（相对 `develop` merge-base）：仅 3 个文件，116 行新增、2 行删除，均在
  `server/modules/voice-realtime/` 下。

## AC

- [x] AC1 工具结果体积上限且合法：超过 `TOOL_OUTPUT_MAX_CHARS` 的 `output` 经 `toDashscopeFrames` 后，
  `function_call_output.item.output` 是一段可被 `JSON.parse` 的字符串，含 `truncated:true`、
  `originalChars`(等于原始序列化长度)、`maxChars`、`preview`(前 `maxChars` 字符)；输出长度小于原始长度。
  判据：上方命令退出 0,新增断言块可见。
- [x] AC2 上限为闭区间：恰好等于 `TOOL_OUTPUT_MAX_CHARS` 长度的序列化结果不被改动（逐字节相等）。
- [x] AC3 `contextBudgetStatus` 复用同一套 usage 解析口径：对同一个 `usage` 对象,它读出的
  `textTokens`/`audioTokens` 与 `estimateRealtimeCostCny` 内部用来算钱的 text/audio 数值一致（断言两者
  基于相同输入不矛盾）；`text_tokens` 缺失时按 `input_tokens - audio_tokens` 回退,与
  `estimateRealtimeCostCny` 同规则。
- [x] AC4 边界与 fail-open：`textTokens === thresholdTokens` 时 `overBudget === true`（闭区间,不是
  off-by-one）；`usage` 为 `null`/`undefined`/非对象时返回全 0 且不抛错。
- [x] AC5 零新增测试文件：`server/shared/tests/quay-test-script.test.ts` 直接跑通过（文件数钉子不受影响）。
- [x] AC6 零协议改动、零云端调用：未新增/删除 `RealtimeClientMessage`/`RealtimeServerMessage` 的任何成员；
  该测试文件自身的"whole exercise is offline"断言通过；未修改 `voice-realtime-ws-proxy.service.ts`/
  `voice-realtime-bridge.service.ts`（`git diff --stat` 里不出现）。
- [x] AC7 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0。

## DoD

真实对象：`toDashscopeFrames`（生产导出函数，`voice-realtime-dashscope-transport.ts`）与
`contextBudgetStatus`（同文件新导出）在真实 fake-upstream 离线测试里被真实调用并断言；不是只读代码推断。
全程零网络、零 DashScope 拨号、零协议新增、零与两个同期 ready 任务（状态注入/重复 session_send 去重）文件级
冲突。实施记录里的四条命令读数即 DoD 证据，worker-driver 的机械 fan-in（merge develop → delta → typecheck
→ 全量 suite → ff）在此基础上收尾即可，本任务不要求重新实现。

## Touches

- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts
- tasks/gap-voice-realtime-tool-output-cap-and-context-budget-log.md (self)
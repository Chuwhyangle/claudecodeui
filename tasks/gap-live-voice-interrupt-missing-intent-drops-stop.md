---
id: gap-live-voice-interrupt-missing-intent-drops-stop
title: 语音 session_interrupt 缺 intent 被 TOOL_ARGUMENT_SCHEMA_VIOLATION
  整次拒收，真实「终止前面操作」指令连同 message 一起消失——缺 intent 不得吞掉停止与修正文本
status: ready
labels:
  - gap
  - P0
parent: null
children: []
extra:
  acceptance: test -f
    server/modules/voice-realtime/tests/voice-realtime-interrupt-missing-intent.test.ts
    && npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-interrupt-missing-intent.test.ts
---
## Proposal

**现象（2026-10-13 23:58 真实 live voice，journal `b5d01c21`，capture 同 id，构建 `cc92c094f`）**：

```
58:05.075 transcription.completed "终止前面操作。"
58:06.577 transcription.completed "处理我现在说的这句话。"
58:06.856 function_call session_interrupt {"message": "停止前面的操作，处理我现在说的这句话。"}
58:06.857 to-browser error TOOL_ARGUMENT_SCHEMA_VIOLATION (recoverable) … (intent: Invalid input: expected string, received undefined)
```

Realtime 模型**语义判断正确**、调用了 `session_interrupt`，只是没带 `intent`。`server/modules/voice-realtime/voice-realtime-tools.ts:345` 的 `inputSchema` 把 `intent` 定为 `z.string()`（必填），执行器（`voice-realtime-live-executor.ts`）也按 SPEC §6.2 拒收缺 `intent` 的停止。结果：①在跑的回合**没有被中止**；②`message`（修正文本）**也没有改走 `session_send`**，Claude Code 完全没收到这句话——人最想表达的「停止」从会话侧看不见。本次 9 段话语义中只送达 7 段，这是其一。

**原设计的理由仍成立的部分**：`intent` 是误停审计（SPEC §10.3 / C-3）的读数，不得伪造（`intent: ''` 是谎言）。**本任务不推翻审计，只推翻「缺审计字段 ⇒ 整次作废」**：缺 `intent` 时如实记 `intent: null` + `intentMissing: true`，停止照常执行；仍保留「不得伪造 intent」。

人 yale 2026-10-14 批准（本会话复盘 P0-1）。

## Plan

1. 语音面 `REALTIME_INTERRUPT_TOOL.inputSchema` 的 `intent` 改为 `z.string().optional()`；description 不得变长（`voice-realtime-status-tool.test.ts` AC6 预算余量极小——只改 schema 与 `VOICE_REALTIME_INSTRUCTIONS`，见 memory「新字段不得进 description」）。
2. 执行器：缺/空 `intent` 不再 throw；审计记录写 `intent: null`、`intentMissing: true`（journal `kind:interrupt` 同一条记录），中止照常走 AC-342 的「先入队后中断」链路（带 `message` 时先确认入队再 abort）。
3. **兜底不变量**：任何被拒的 `session_interrupt`（外来 session、D-2 禁止动词、执行异常等仍保留的拒绝理由）若带非空 `message`，该文本**必须**改走 `session_send` 投递并记 journal，不得静默消失。
4. 更新 `voice-realtime-interrupt-audit.test.ts` 中钉「缺 intent 被拒」的用例（:337–378）为新语义，并在本任务正文说明改动的 SPEC 条款。
5. 回归：新增 `voice-realtime-interrupt-missing-intent.test.ts`，用 b5d01c21 那一帧的**逐字参数** `{"message":"停止前面的操作，处理我现在说的这句话。"}` 驱动假上游。
6. 真实验证（不重启 :3001）：从 capture `b5d01c21….wav` 截取 offsetMs 覆盖 58:02.695–58:06.577（timeline 里对应 speech_started/stopped）的音频，在**备用端口实例**（`SERVER_PORT=39xx`、`VITE_IS_PLATFORM=true`、隔离 `VOICE_REALTIME_LOG_DIR`/`VOICE_REALTIME_CAPTURE_DIR`）或 dry-run 执行面上回放到真实上游，花费上限 ¥0.1；记录模型是否调用 interrupt、是否带 intent、执行面是否接受。

## AC

- [x] AC1 用 b5d01c21 的逐字参数（无 `intent`、有 `message`）调用语音面 `session_interrupt`：**不再**发 `TOOL_ARGUMENT_SCHEMA_VIOLATION`，执行面收到 abort 请求，`message` 先确认入队再 abort；取假形态：把 `intent` 改回必填 ⇒ 本用例红。
- [x] AC2 审计：上述调用在 journal 写**一条** `kind:interrupt`，`intent === null` 且 `intentMissing === true`；不得出现 `intent: ''` 或任何伪造文本；带 `intent` 的调用仍按原样记录。
- [x] AC3 兜底：构造一个仍会被拒的 interrupt（如 foreign session）且带非空 `message` ⇒ 该文本经 `session_send` 投递一次（`session_send delivered` 记录可见）；取假形态：删掉兜底 ⇒ 红。
- [x] AC4 `voice-realtime-status-tool.test.ts`、`voice-realtime-instructions-no-stop-words.test.ts`、`voice-realtime-interrupt-audit.test.ts`、`voice-realtime-interrupt.test.ts`、`voice-realtime-interrupt-revision-order.test.ts` 单文件逐个运行退出 0（不得多文件 fan-out，见 AGENTS.md「Running tests」）。
- [x] AC5 MCP 网关侧 `session_interrupt` schema 逐字节不变（语音面字段仍在 gateway 前被剥离）。
- [x] AC6 真实回放读数写入本任务 Notes：使用的音频区间（offsetMs）、capture sha256 前缀 `0f2bd51fbbb28c9f`、模型调用的工具与参数、执行面裁决、花费；未重启 :3001（pid 前后相同）、未改生产 env。读数不足时写「不足以判断」。

## DoD

真实形态的「无 intent 的停止」在合入后的代码上被执行面接受并中止回合（脚本回归 + 一次真实上游回放读数）；任何被拒的 interrupt 不再吞掉其 `message`；审计不伪造 intent。

## Touches

- server/modules/voice-realtime/voice-realtime-tools.ts
- server/modules/voice-realtime/voice-realtime-live-executor.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-log.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-audit.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts
- server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-missing-intent.test.ts (new)
- experiments/voice-realtime-interrupt-missing-intent/replay.mts (new)
- tasks/gap-live-voice-interrupt-missing-intent-drops-stop.md

## Notes

**查重（2026-10-14）**：`gap-live-voice-interrupt-audit-intent-trigger`（AC-339，done）引入了 intent 必填；`gap-live-voice-voice-terminated-interrupt`、`gap-live-voice-interrupt-after-revision-enqueued`（AC-342）、`gap-live-voice-interrupt-run-utterance-fence`（AC-343）、`gap-live-voice-interrupt-semantic-sampling`（AC-346）均 done，无未完成重复任务。本任务是对 AC-339「缺 intent ⇒ 拒」的修正。

**证据文件**：journal `~/.cloudcli/voice-realtime-log/b5d01c21-3f53-4228-a28e-d18b7cb967f7.jsonl`；capture `~/.cloudcli/voice-realtime-capture/b5d01c21-3f53-4228-a28e-d18b7cb967f7.{wav,timeline.jsonl}`（wav sha256 前缀 `0f2bd51fbbb28c9f`）。

**AC6 真实回放读数（2026-10-14，`experiments/voice-realtime-interrupt-missing-intent/replay.mts`，dry-run 执行面，第二实例端口 3911）**：

- 音频区间：capture `b5d01c21-3f53-4228-a28e-d18b7cb967f7.wav` 的 offsetMs 102800–106900（4.1 s；覆盖原现场的 103122 speech_started → 106824 committed）。
- capture sha256 前缀 `0f2bd51fbbb28c9f`（脚本运行时核对一致；10515244 字节）。
- 模型调用（读自诊断报告 `wire[]`）：`session_interrupt {"intent":"用户明确要求停止当前操作","message":"终止现在操作"}` 与 `session_send {"message":"处理我现在说的这句话"}`。
- 执行面裁决：**接受**。`TOOL_ARGUMENT_SCHEMA_VIOLATION` 帧 **0** 条；修正文本经 G1 先入队再 abort（`sent` 帧 `result.wouldSend.message`＝「终止现在操作」），dry-run 未向任何真实会话注入消息或中断。
- 花费：¥0.0067（出货 `estimateRealtimeCostCny` 估算公式；上限 ¥0.1）。
- 边界：:3001 pid 766174 → 766174（相同，未重启）；未改生产 env（第二实例用隔离 `HOME`/`DATABASE_PATH`/`VOICE_REALTIME_LOG_DIR`，`VOICE_REALTIME_CAPTURE=off`、`CLAUDE_SESSION_SCOPE_SWEEP=off`，未设 `VOICE_REALTIME_ENDPOINT`）。
- **读数边界（如实）**：这一次模型**带了** `intent`，所以单次真实回放本身**没有**直接展现「缺 intent 也被接受」那一臂——那一臂由脚本回归 AC1 覆盖（逐字 b5d01c21 参数 `{"message":…}` 驱动假上游；假形态 `intent` 改回必填即红）。真实回放佐证的是：真实模型的 `session_interrupt` 在合入后的出货校验＋执行面上被接受、0 条 schema 违规。
- 同次另记：interrupt 之后上游回报了 2 条 `recoverable UPSTREAM_ERROR`（`Unknown function call id: call_e2d9…`、`Cannot create response after rejected function_call_output`），**不是** schema 违规，报告 `ok:true`；与本任务改动无关（本任务只放宽 schema，未触及 interrupt 的执行/回传路径）。

**不做**：不改「busy 时补充话语进 CLI 队列」的 A+ 规则（那是 `gap-live-voice-busy-utterance-preemption-proposal` 的范围，须人裁定）。

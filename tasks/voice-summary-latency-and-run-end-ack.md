---
id: voice-summary-latency-and-run-end-ack
title: Live Voice 摘要提速（qwen-flash、去 40 字闸）与运行结束随机确认语
status: done
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

Live Voice 的「运行结束摘要」目前有两个可避免的延迟和一个体验缺口。实测（2026-10-20，同一用户 key、约 1400 字 context）：

- `qwen3.8-omni-flash` 摘要 LLM 单次 5.9 s；生产两轮分别是 7.4 s / 12.3 s，是运行结束后仅次于 Claude 运行时长的第二大延迟。
- `qwen-flash` 同请求 0.58–0.69 s（约 9 倍提速），但输出会到 42–44 字，撞上现有 ≤40 字硬闸而被拒绝。
- 运行结束到第一句声音之间仍是 8–13 s 的完全沉默（固定确认语缺失）。

本任务做三件事，并明确不动 context pack：

1. 摘要模型换成 `qwen-flash`，代码默认常量同步修改；请求形状不变（仍 `modalities:['text']`、非流式、60 s 超时）。
2. 放弃 ≤40 字硬闸：prompt 改为「精简、讲结果不讲过程、不设硬性字数」；`chars` 继续记日志。**保留**无 Markdown 闸与 verbatim tail ≤6 闸。可选加 `max_tokens: 200`，仅防失控输出。
3. 运行结束的 `running → idle` 转换处立即播一句随机固定确认语，再播 LLM 摘要；确认语独立于 context pack 与摘要结果。候选示例（可增删）：`处理完了。` / `完成了。` / `这次做完了。` / `好了，结果出来了。` / `搞定。`

context pack 不缩：实测 600 字 vs 1400 字只省 ~80 ms，且它同时服务 relay 模型的指代解析。

不新增测试文件：全部用例加在既有 `voice-realtime-run-end-summary.test.ts` / `voice-realtime-summary.test.ts`，避免顶高 `quay-test-script` 的收集数 pin。

## AC

- [x] AC1：`DEFAULT_VOICE_REALTIME_SUMMARY_MODEL` 为 `qwen-flash`；摘要 leaf 对注入的 fetch 发出的请求体是 `model: 'qwen-flash'`、`modalities: ['text']`、`stream: false`，context 位于 `<输出>` 内；既有 summary 测试的模型 pin 就地更新，其余请求形状断言不变。
- [x] AC2：长度不再是拒绝条件——一个 41 字以上、无 Markdown、verbatimTail ≤ 6 的摘要必须被 `run-end summary injected`；Markdown 违规与 verbatimTail > 6 仍分别被拒绝（两条腿各有独立用例，拒绝日志保持可归因）。
- [x] AC3：`VOICE_REALTIME_RUN_END_ACK` 未设置或空值时，运行结束不注入确认语（旧 wire 不变）；设置时按 `|` 分隔成候选列表，经可注入的 `random` 纯函数随机选一条，并以独立 id（`run-end-ack-N`）在 settle timer 之前注入；摘要到达后排在确认语之后。测试覆盖 random=0→首条、random→末条、结果 ∈ 候选集。
- [x] AC4：确认语独立于摘要：context pack 为空、summarize 返回 null、摘要被 Markdown/verbatim gate 拒绝时，确认语仍被注入并进入 TTS。
- [x] AC5：用户开口时确认语与摘要都按既有双工规则收到 `narrator_stop` 并被丢弃；不新增任何旁路或新的停播路径（既有 AC-406 用例保持绿）。

## DoD

- 上述用例在 `server/modules/voice-realtime/tests/voice-realtime-run-end-summary.test.ts` 与 `voice-realtime-summary.test.ts` 内落地并全绿；`npm run typecheck` 退出 0。
- 不新增 server 测试文件（`quay-test-script` 收集数 pin 不动）。
- 真机读数（`server.log`，真实 Live Voice 回合）：运行结束处出现 `run-end ack`；`narrator tts done run-end-ack-*` 约 0.25 s；`run-end summary injected` 距 idle 状态 <1.5 s；日志顺序确认语先于摘要；不再出现因字数触发的 `run-end summary refused`。
- `.env.example` 记录 `VOICE_REALTIME_SUMMARY_MODEL=qwen-flash` 与 `VOICE_REALTIME_RUN_END_ACK`（`|` 分隔候选、空=关闭）。

## Touches

- server/modules/voice-realtime/voice-realtime-summary.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-narrator.ts
- server/modules/voice-realtime/index.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-run-end-summary.test.ts
- server/modules/voice-realtime/tests/voice-realtime-summary.test.ts
- .env.example
- tasks/voice-summary-latency-and-run-end-ack.md
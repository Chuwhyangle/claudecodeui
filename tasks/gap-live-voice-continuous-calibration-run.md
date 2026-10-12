---
id: gap-live-voice-continuous-calibration-run
title: 连续模式真实校准 C-1..C-6 单次运行（semantic_vad
  行为、silence_duration、丢静音致盲、静音计费、模型等待、静音尾）+ 成本基线
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-362
---
## Proposal

### 背景

决策文档 `docs/proposals/live-voice-experience-first-decision-2026-10.md`（提交 `038730f0`）§6 列出 6 个只能靠真实上游回答的问题，§7 要求先拿成本基线、不预设目标、不假定静音必然计费。已有事实：F1（成本主因是每次 response 重读文本上下文）、F3/F4（音频 7 token/秒；静音不计费仅为**推断**）、P0-S4（`semantic_vad` 在控制面只是回显，无行为证据；官方文档却列为 qwen3.8 支持）。

### 校准项（全部在一次运行内完成）

| # | 问题 | 做法要点 |
|---|---|---|
| C-1 | qwen3.8 上 `semantic_vad` 是否有**行为**差异 | 同一段含「嗯…那个…」与句中停顿的音频，分别用 `server_vad` 与 `semantic_vad`，比较条目数与 response 数 |
| C-2 | `silence_duration_ms` 400 / 800 / 1000 的碎片数与说完→response 延迟 | 同一语料三档 |
| C-3 | 丢静音是否让上游 VAD 致盲 | 只发语音帧（预先剪掉静音），观察是否还有 `speech_stopped` |
| C-4 | 静音是否计费 | 60 s 纯静音 vs 60 s 含 5 s 语音，比较 usage 的 audio token 与账单 |
| C-5 | 允许「没说完可以不转发」的指令下，模型是否真的等待并在后续机会合并转发 | ≥10 样本，实验脚本自带指令（不改出货指令） |
| C-6 | 静音尾门控的最小静音尾 | 语音 + N ms 真实静音（N 递增），上游稳定断句的最小 N |

成本基线（同一运行的读数）：response 数、有效投递率、每 response text/audio 输入 token、¥/小时（说话与挂机两种场景按读数外推，标明外推）。

### 安全边界

- 备用端口第二实例（参照 `dod-real-live-voice-without-restart` 做法），`VOICE_REALTIME_MAX_CNY_PER_CONNECTION=0.05`，总花费上限 ¥1；执行面 dry-run（`server/index.ts` `dryRun` 分支），不向任何真实会话注入消息或中断；合成的 `sessionId` 不存在于任何库；`CLAUDE_SESSION_SCOPE_SWEEP=off`。
- 不重启 :3001（记录前后 pid），不发布，不触碰 Quay worker / driver。
- 只跑一次（不重复取数，见记忆：勿反复真实上游测量）。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


<!-- dedup-ref --> 机制去重：已 done 的 `gap-live-voice-interrupt-semantic-sampling`（AC-346）只测中断语义；`gap-voice-realtime-turn-detection-configurable-comparison`（done）比较的是切分臂而非 qwen3.8 上 semantic_vad 的行为与计费；open 任务 0 命中。

## Plan

1. 语料与音频（复用 `experiments/voice-realtime-interrupt-sampling/` 的 TTS 合成流程与 `experiments/voice-trim/fixtures/`）；按 C-3/C-4/C-6 预处理变体。
2. 实验脚本 `experiments/voice-realtime-continuous-calibration/run.mts`（备用端口、dry-run、花费上限、逐连接 journal）。
3. 单次运行；报告 `docs/operations/voice-realtime-continuous-calibration.md`，每项「读数：」与结论行；行首字段与 AC-362 判据一致。

## AC

- [ ] AC1：`f=docs/operations/voice-realtime-continuous-calibration.md` 存在，且含行首 `C-1 semantic_vad：`、`C-2 silence_duration：`、`C-3 丢静音致盲：`、`C-4 静音计费：`、`C-5 模型等待：`、`C-6 静音尾：`、`成本基线：`、`运行次数：`、`花费：`（AC-362 判据逐行检查）。
- [ ] AC2：每项附原始证据：连接 id、usage 行（text/audio token 分列）、事件时间线摘录；不得只给结论。
- [ ] AC3：报告写明运行次数 = 1、每连接上限与实际花费（CNY）、:3001 前后 pid 相同、dry-run 执行面。
- [ ] AC4：`npm run lint` 退出 0（若新增脚本）。

## DoD

真实 `qwen3.8-omni-flash-realtime` 跑过一次，C-1..C-6 与成本基线读数完整；不设通过门槛；读数被决策文档 §9 的裁定引用。

## Touches

- docs/operations/voice-realtime-continuous-calibration.md (new)
- experiments/voice-realtime-continuous-calibration/run.mts (new)
- experiments/voice-realtime-continuous-calibration/corpus.json (new)
- tasks/gap-live-voice-continuous-calibration-run.md

## Notes

立项：Opus 常驻会话，2026-10-12，人 yale 体验优先裁定（GOAL-044 / AC-362）。

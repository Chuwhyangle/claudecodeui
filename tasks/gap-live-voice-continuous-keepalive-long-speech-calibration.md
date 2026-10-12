---
id: gap-live-voice-continuous-keepalive-long-speech-calibration
title: Continuous 小额真实校准 R-1..R-3：持续上传长静音存活与零计费、长口述 server_vad vs semantic_vad、执行中决策分布
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-372
---
## Proposal

### 背景（本组任务共用）

人 yale 2026-10-13 裁定（决策文档 `docs/proposals/live-voice-experience-first-decision-2026-10.md` §11–§12，提交 `31d1b8b2`）：
- Live Voice 体验优先：**禁用浏览器 VAD 分段与中继静音门控（含 STS）**，改为 continuous 传输；
- **保留上游 `server_vad`**（或经校准的 `semantic_vad`）作为评估触发，绝不出现关了 VAD 又无触发；
- 模型随用户意图逐渐完整，**反复评估**在执行的 CLI 工作：继续、修改、取消或无需动作。

两条边界分开：
- 音频采集与传输：持续 20 ms PCM，含静音，不分段、不门控；
- 语义输出：由模型决定投递、中断或无需动作；CLI 在回合边界聚合。

已有读数：
- C-4：静音零计费；
- V-2：停传约 300 s 被上游 1007 关闭；
- C-1：`semantic_vad` 有效；
- C-5：模型不会自己等句子完整。

**缺失的 L4 持续评估信号**（§12.5）：
- 模型只看得到计数状态行和连接时一次性的上下文包，不知道当前 run 覆盖了哪些意图、还有哪些排队未开始、CLI 最近在做什么；
- 「无需动作」会被记为 `MODEL_TEXT_REPLY` 错误；
- 空条目上的编造投递会漏过。


### 本任务（小额真实校准，实验脚本，不改产品代码，现在可派发）

| # | 问题 | 做法要点 |
|---|---|---|
| R-1 | continuous 持续上传（含 ≥10 min 静音）连接是否存活，期间是否计费 | 同一连接：说 2 句 → 持续上传真实底噪 12 min → 再说 2 句；记录连接存活、关闭码（若有）、恢复后首句延迟、静音期间 response 数与 audio/text token。对照 AC-363 V-2：停传约 300 s 被 1007 关闭 |
| R-2 | 30–60 s 连续口述（含 1–3 s 停顿）在 `server_vad`（silence 800）与 `semantic_vad` 下的表现 | 同一合成语料两臂；记录条目数、碎片、说完→response 延迟分布、各条目转写与原稿的差异 |
| R-3 | 执行中补充 / 细化 / 改方向 / 取消四类语料的模型决策分布 | 实验脚本自带 RunDigest 草案（模拟一个正在执行的 run：覆盖的投递、排队、最近活动）与四种决策词汇的指令，每类 ≥5 句；只报读数，不设门槛 |

产出：`docs/operations/voice-realtime-continuous-keepalive-calibration.md`，行首字段与 AC-372 判据一致（`R-1 存活：`、`R-1 计费：`、`R-2 条目：`、`R-2 延迟：`、`R-2 转写：`、`R-3 决策：`、`运行次数：`、`花费：`）。

安全：
- 每连接 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION=0.05`，总上限 ¥1.5；
- 备用端口第二实例或脚本直连上游；
- dry-run 执行面（不向真实会话注入）；
- 合成 `sessionId`；`CLAUDE_SESSION_SCOPE_SWEEP=off`；
- 不重启 :3001（记录前后 pid）；只跑一次。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


<!-- dedup-ref --> 机制去重：AC-362（done）测 C-1/C-2/C-4/C-5，不含长时持续上传存活与执行中决策分布；AC-363（done）测的是停传，不是持续上传。

## Plan

1. 语料合成（TTS 或拼接 `experiments/voice-trim/fixtures/`，长静音用真实底噪录音循环而非数字零）；2. 实验脚本 `experiments/voice-realtime-continuous-keepalive/run.mts`；3. 单次运行；4. 报告。

## AC

- [ ] AC1：报告含 AC-372 判据要求的全部行首字段。
- [ ] AC2：R-1 附连接 id、关闭码或存活证据、静音期间 usage 原文；R-2 两臂对照表；R-3 每句决策与模型 intent 或 message 原文。
- [ ] AC3：报告写明运行次数 = 1、上限与实际花费、:3001 前后 pid 相同、dry-run 执行面。
- [ ] AC4：`npm run lint` 退出 0（若新增脚本受 lint 覆盖）。

## DoD

真实 `qwen3.8-omni-flash-realtime` 跑过一次，R-1..R-3 读数完整；产品代码 diff 为空；读数被 AC-374 的默认值与 AC-373 的指令措辞引用。

## Touches

- docs/operations/voice-realtime-continuous-keepalive-calibration.md (new)
- experiments/voice-realtime-continuous-keepalive/run.mts (new)
- experiments/voice-realtime-continuous-keepalive/corpus.json (new)
- tasks/gap-live-voice-continuous-keepalive-long-speech-calibration.md

## Notes

立项：Opus 常驻会话，2026-10-13（GOAL-044 / AC-372）。

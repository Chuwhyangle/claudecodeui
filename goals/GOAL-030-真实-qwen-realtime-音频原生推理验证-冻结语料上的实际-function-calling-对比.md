---
id: GOAL-030
title: 真实 Qwen Realtime 音频原生推理验证：冻结语料上的实际 function-calling 对比
status: active
kind: goal
origin: 续接 GOAL-029（`goals/GOAL-029-....md`）与其产出的
  `docs/experiments/2026-10-09-voice-realtime-ambiguity.md`；`docs/proposals/voice-native-control-plane.md`
  §10/§13 的证据纪律；2026-10-09 与人 yale 的后续讨论（明确要求从 deterministic stand-in 转向真实模型证据）。
activatedAt: 2026-10-08T23:15:36.413Z
statusLog:
  - at: 2026-10-08T23:15:36.413Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
---
## 背景

GOAL-029 建立了一个确定性替身版本的 prototype：离线假 WS 服务端、离线替身 ASR、离线替身 Qwen 工具调用，产出了 22/24 vs 10/24 的"结构优势"读数。**这个 achieved 状态只代表结构/benchmark infrastructure 已经闭环——bridge 的协议形状对得上现有 MCP 工具、评测 harness 跑得通、负对照能红——不能作为"真实 Qwen 模型有优势"的证据。** `docs/experiments/2026-10-09-voice-realtime-ambiguity.md` 自己的完成记录已经逐字写明这一点：

> "离线替身是完美读者。它按固定规则解析、没有认知误差率，所以 Arm B 的 22/24 是**能力上限的形状**，不是真实模型分数。"
> "TTS 音频未合成……一个 `.wav` 都没合成、没提交。后果：本读数对'识别错的字怎么影响歧义解析'**零信息**。"

本 GOAL 的唯一目的是补上这个证据缺口：用真实 `qwen3-omni-flash-realtime` WebSocket 端点、真实合成/录制的音频、真实模型自主发起的 function calling（对接 GOAL-029 已经冻结的 fixture-backed 语义读工具），和真实的现有 ASR→文本基线做同一段真实音频的 paired evaluation。

## 目标（不预设胜负）

回答一个具体问题：**模型本身是否能利用原始语音 + semantic context/tools，获得比现有 ASR→文本路径更好的最终意图**？在 GOAL-029 已冻结的四类场景（同音实体歧义、自我更正、指代消解、world-model/状态查询）语料上，用真实网络调用跑一次 paired 对比，记录准确率、失败类型、工具调用行为、延迟与长尾。**读数可以支持任何方向**，结果决定是否值得继续投入真实 `session_send` 生产集成——不是本 GOAL 要预先假定的结论。

## 范围

- Task A：真实 DashScope `qwen3-omni-flash-realtime` 传输层 + eval harness，复用 GOAL-029 的 bridge（`connect()` 不重写），只新增一个讲真实 WebSocket 的 `transport` 实现；离线半区可证，真实半区有保留的、可审查的调用轨迹证明不是确定性替身。
- Task B：在 Task A 之上，对 GOAL-029 冻结的全部四类语料跑真实音频的 paired 对比（现有 ASR→文本基线 vs 真实 Qwen Realtime 原生推理+语义工具），产出准确率、失败类型、工具调用行为（与最终正确率分开报告）、延迟长尾与人读 GO/NO-GO。

## 非目标

- 不接真实 `ChatControlService`/`session_send`——`gap-voice-realtime-session-send-smoke` 只在 Task B 的读数支持 GO 时才另外立案，NO-GO 则不立案，这不是本 GOAL 关闭的前提。
- 不做生产 UI、不做模式切换前端、不做语音输出/TTS 回放层（`docs/proposals/voice-native-control-plane.md` §8，仍是 roadmap）。
- 不扩大 GOAL-029 冻结的四类场景范围，不新增第五类场景。
- 不要求 Qwen 必须赢；不把这组读数当成任何后续产品决策的唯一依据——它只是本阶段要补的那一块证据。
- 不做多会话协调、不做 architecture-oriented workspace（`docs/proposals/voice-native-control-plane.md` §12，长期愿景，非本 GOAL）。
- 质量/准确率数字不进判据集（ADR-004 决策 8 既有原则）：两个任务的 AC 判定的是"真实证据是否被严谨、可审查地取到"，不是"Qwen 赢没赢"。

## 退出条件

- AC-308 真实传输与 eval harness：离线半区可证（零网络、CI 常跑），真实半区有保留的调用轨迹证明不是确定性替身。
- AC-309 真实 paired 证据记录：四类场景的真实音频对比读数、失败类型、工具调用行为（与最终正确率分开）、延迟长尾、人读 GO/NO-GO。

## 不做退出条件的范围内事

- `gap-voice-realtime-session-send-smoke`：只在 AC-309 的读数支持继续投入（GO）时才另外立案；NO-GO 时如实登记原因与需修正点，不立案 stretch，也不是本 GOAL 关闭的阻碍。

## 已知限制

- 真实模型调用有成本，重复次数按本仓库一贯的小样本纪律取值（≥3 次/条，只界定方向，不界定置信区间意义上的统计把握）。
- `qwen3-omni-flash-realtime` 是服务商的别名/接口，服务端升级后行为可能漂移；读数附带取数时间戳与模型版本信息（若端点可读）。
- 凭据只走本地实验机制（`.env.test` 一类），不入库；真实网络调用默认不在 CI 里重跑，只在手动 `--live` 触发时发生一次并冻结快照。
---
id: AC-309
title: 真实音频 paired 对比：ASR→文本 vs 真实 Qwen Realtime 原生推理+语义工具，四类场景+延迟长尾+GO/NO-GO
status: draft
kind: criterion
goal: GOAL-030
criterion: node experiments/voice-realtime-ambiguity/run-real.mjs
expect: 复用 GOAL-029/AC-306
  冻结的四类场景语料、标准答案、打分口径与负对照（只读，不修改；若发现口径缺陷按偏离记录处理，不先看结果再改判据）。对冻结语料的每一条合成/取得真实语音音频，同一段真实音频分别喂给：臂
  A（真实 DashScope `openai-compatible`/`dashscope-omni` 现有 ASR→文本基线的真实网络调用）与臂
  B（AC-308 的真实 qwen3-omni-flash-realtime 传输，模型自主对冻结的 fixture-backed 语义读工具发起
  function call，執行体回填 GOAL-029 已有的夹具数据，不是真的 `ChatControlService`）。每条语料重复 ≥3
  次取基本离散度（小样本、只界定方向，按本仓库一贯纪律如实登记为局限）。报告：总体与四类场景各自对冻结标准答案的准确率；负对照按预注册方向移动；主要失败类型分类；**工具调用行为与最终答案正确率分开报告**——模型是否调用了预期工具、调用了错的工具、什么都没调用、幻觉出一个不存在的工具，这组读数独立于"最终意图对不对"，明确回答"semantic
  tools 的结构优势"与"Qwen 是否真的会正确使用这些工具"是两个不同的数字；首次响应/function-call/最终意图三个节点的延迟，每臂给出
  p50/p90/最大值（长尾）。`--live` 执行真实付费的成对取数并冻结快照，默认离线重算该快照（同本仓库既有真实模型实验的
  `--live`/`--freeze`/默认离线约定）。记录末尾给出人读的 GO/NO-GO，不是任何机械判据的输入；GO 时才允许另外立案
  `gap-voice-realtime-session-send-smoke`，NO-GO 时如实登记原因与需修正点，不立案
  stretch。取假形态：空读数/负对照反向/跨运行拼接三条与 GOAL-029 的 AC-307 同形；第四条——若某条语料的 3
  次重复在延迟与模型输出上完全同质（零方差），runner 必须标记 `SUSPECTED_STAND_IN` 而不是当作干净读数接受。
origin: docs/proposals/voice-native-control-plane.md §10/§13 的证据纪律；GOAL-029 与
  `docs/experiments/2026-10-09-voice-realtime-ambiguity.md`（冻结语料/口径的复用来源，以及其"不代表真实模型优势"的自我限定）；对照先例
  `gap-asr-omni-paired-quality-record` 的九条判据结构与 `--live`/`--freeze` 约定
---

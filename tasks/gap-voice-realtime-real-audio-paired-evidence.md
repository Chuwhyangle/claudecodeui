---
id: gap-voice-realtime-real-audio-paired-evidence
title: 真实音频 paired 对比：ASR→文本 vs 真实 Qwen Realtime，四类场景 + GO/NO-GO（AC-309）
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-voice-realtime-dashscope-transport-harness
goal_ac: AC-309
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rli "voice-realtime" tasks/*.md goals/*.md` 只命中 GOAL-029/GOAL-030 已立案的同批次任务，无同机制重复。本任务是 GOAL-030 的第二块，`depends_on` Task A：没有真实传输层就没有真实臂可跑。

### 背景

GOAL-029/AC-306 已经冻结了四类场景的语料、标准答案、打分口径与负对照（`experiments/voice-realtime-ambiguity/PREREG.md`、`fixtures/`）。本任务**只读**这些冻结物，不修改，用真实音频跑一次真正的 paired 对比，把 GOAL-029 的"结构优势"读数换成"真实模型是否真的有优势"的读数。

### 规格修正（2026-10-09）

B 臂的目标模型由立案时的 `qwen3-omni-flash-realtime` 纠正为 **`qwen3.8-omni-flash-realtime`**——该别名（3.0）实测不支持 provider 侧 function calling，`qwen3.8-omni-flash-realtime` 才是本 GOAL 正式采用的目标模型（详见 Task A 的历史完成记录与 AC-308）。A 臂、冻结语料/标准答案/打分口径/负对照**不变**。`qwen3.8-omni-flash-realtime` 的 `session.update` 需要显式 `voice: "Tina"`，本任务的 runner 必须沿用 Task A transport 里已经固定的这一配置，不重新发明。

### 方案

1. 为冻结语料的全部条目合成/取得真实语音音频（TTS 或复用已有录音），落 `experiments/voice-realtime-ambiguity/fixtures/audio/`。
2. `experiments/voice-realtime-ambiguity/run-real.mjs`：对每条语料的真实音频，同一段音频分别喂给：
   - 臂 A：现有 ASR→文本基线（真实 DashScope 网络调用，不是离线替身）。
   - 臂 B：Task A 落地的真实 **`qwen3.8-omni-flash-realtime`** 传输 + bridge，模型自主对 GOAL-029 冻结的 fixture-backed 语义读工具发起 function call。
   每条重复 ≥3 次。`--live` 执行一次真实付费取数并落 `out/*-cache.json`（不入库），`--freeze` 冻结到 `fixtures/real-paired.json`，默认离线重算。
3. 打分复用 GOAL-029 冻结的口径（不改一行）；工具调用行为单独记一张表：预期工具/实际调用（命中、错调、未调用、幻觉出不存在的工具），和最终答案正确率分开统计。**未按 `tool_choice` 期望调用、工具/参数幻觉**这两类按 AC-308/AC-309 的风险登记要求，必须作为独立的失败类别出现在统计里（如果读数里确实没出现，如实记"未观察到"，不得假装这条风险不存在）。
4. 延迟：记录首次响应、function-call 发出、最终意图三个节点，每臂给出 p50/p90/最大值。
5. 记录 `docs/experiments/<date>-voice-realtime-real-paired.md`：总体与四类场景准确率、负对照方向、失败类型分类、工具调用行为表、延迟长尾、已知局限、人读 GO/NO-GO。`docs/experiments/README.md` 加一行索引。

### 边界（不做）

不改 GOAL-029 冻结的语料/口径/负对照；不改 Task A 的 transport/bridge 行为；不接真实 `ChatControlService`；不立案 `gap-voice-realtime-session-send-smoke`；质量数字不进判据集。

## AC

- [ ] AC1 runner 报 n，空读数不是绿：`node experiments/voice-realtime-ambiguity/run-real.mjs` 默认离线重算退出 0，打印 `n=<四类场景总条数> × 2 arm(s) × ≥3 rep(s)`；`--corpus=empty` 退出非 0。
- [ ] AC2 负对照能红：`--control=inverted` 退出非 0，判词指名对照与预测方向。
- [ ] AC3 不跨运行：同一个 run id；`--runs=straddle` 退出非 0。
- [ ] AC4 被测真实模块：runner 导入臂 A 的出货基线与臂 B 的 Task A transport（`qwen3.8-omni-flash-realtime`），不在 runner 内重写第二份请求/路由逻辑。
- [ ] AC5 工具调用行为与最终正确率分开报告，含"未按要求调用"与"工具/参数幻觉"两个独立类别。
- [ ] AC6 延迟长尾：首次响应/function-call/最终意图三个节点、每臂 p50/p90/最大值。
- [ ] AC7 非确定性检测：若任一语料条目的 ≥3 次重复在延迟与模型输出上完全同质（零方差），runner 标记 `SUSPECTED_STAND_IN`。
- [ ] AC8 记录存在且四类场景各有结论；`docs/experiments/README.md` 索引该文件。
- [ ] AC9 不进判据：记录与 runner 末行自陈"quality numbers are a reading and are NOT a criterion"。
- [ ] AC10 凭据不入库。
- [ ] AC11 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。
- [ ] AC12 如实登记 GO/NO-GO：GO 时注明"值得另外立案 `gap-voice-realtime-session-send-smoke`"；NO-GO 时列出需修正点，不立案 stretch。

## DoD

真实落地判据：同一段真实音频真的在两条真实路径（A 臂基线 vs B 臂 `qwen3.8-omni-flash-realtime`）上被公平比较过，空读数/负对照/跨运行/零方差替身嫌疑四类常见实验造假方式都被机械堵住，且"未按要求调用"/"工具幻觉"两类风险在读数里有一个诚实的位置（出现就记，不出现就如实记"未观察到"）。GO/NO-GO 是记录里的人读结论。

## Touches

- experiments/voice-realtime-ambiguity/fixtures/audio/ (new)
- experiments/voice-realtime-ambiguity/run-real.mjs (new)
- experiments/voice-realtime-ambiguity/fixtures/real-paired.json (new)
- docs/experiments/2026-10-09-voice-realtime-real-paired.md (new)
- docs/experiments/README.md
- tasks/gap-voice-realtime-real-audio-paired-evidence.md (self)
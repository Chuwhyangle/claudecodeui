---
id: gap-voice-turn-detection-p0-14-chinese-zeroshot-and-ft-readiness
title: Live Voice P0.14：中文零样本 Smart Turn v3.2 / turn-1-mini 评测 + 中文域适配/LoRA 可行性与
  GPU runbook（不训练、不付费、不动已落地 P0.13）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 立案，承接已合并 P0.13 的建议）

`gap-voice-turn-detection-p0-13-english-smart-turn-vs-turn1mini` 已 `done`（merge 到 develop，worktree 已回收）：英语上 Smart Turn v3.2 与 p99lab/turn-1-mini 原版（无 fine-tune）都存在真实、非退化的操作点同时满足 false-cutoff≤10% 且 missed-END≤10%，turn-1-mini 可行域更宽。其 `CONCLUSION.md` §10 明确写"建议另立中文 fine-tune 任务"，理由是 P0.11 已证明原版 Smart Turn 在**混合中英语料**上 0 达标——英语可用不代表中文可用,turn-1-mini 官方也**仅声称英语**。人 yale 已授权按该建议推进。

已有可复用资产（**只读复用,本任务不得改动**）：
- `experiments/voice-turn-detection-compare/eot-bench-adapters/`（P0.7/P0.11/P0.13 共用的 sweep 核心、`protocol.mts`、corpus 抽象）。
- `experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/`（P0.13 产物：Smart Turn checkpoint `pipecat-ai/smart-turn-v3`@`f766f81d3cfdf7737ac64aad813d91bbfd56bf93`、turn-1-mini `p99lab/turn-1-mini`@`076c86d1744a231d3a4cce31f3bbbd1211b4c281`、`p99turn` 1.2.3、4kHz 低通预处理自检、ONNX sha256 — pinned revision 与预处理必须**原样复用**，不得重新选版本）。
- `experiments/voice-turn-detection-compare/dataset-sources.json`：已核验 THCHS-30（OpenSLR SLR18）许可为 Apache-2.0（与上游 CSLT 文字口径有记录在案的分歧，需沿用已有记录,不必重查）。**THCHS-30 是逐句朗读的 ASR 语料（scripted single-utterance recordings），不是自然连续对话——不能把它的句间切分当天然语义 HOLD/END 标注**，这正是本任务必须防的陷阱（见下方 AC2）。

### 目标

在**零训练、零付费、零生产改动**的前提下，分两部分回答：
1. **中文零样本现状**：原版 Smart Turn v3.2 与 turn-1-mini（都不做任何 fine-tune）在真实中文自然语音上的 false-cutoff/missed-END 表现，用与 P0.13 相同协议但独立的中文 held-out 评测集。
2. **中文域适配可行性**：若零样本不达标，fine-tune/LoRA 路径在技术上是否可行（checkpoint+训练代码是否真能复现、候选数据集及许可、GPU 训练前检查清单），产出一份**书面 runbook**,不在本机执行训练。

### 边界 / 不做

- ⛔ **不改动、不触碰** P0.13 已合并的任何产物路径（`experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/**`）——只读引用，复用其 pinned revision/预处理逐字复述，不重新下载或重新选版本。
- ⛔ **不在本机训练**：本机无 GPU（已由 Gemma4 任务核实 `nvidia-smi` 不存在），任何 fine-tune/LoRA **只产出书面方案**（GPU runbook），不执行一次真实训练迭代、不下载训练专用的大权重。
- ⛔ **不触发任何付费 API**；中文样本的真实推理仍是本机 CPU ONNX（复用 P0.13 的加载方式），零 DashScope/零外部计费推理调用。
- ⛔ **不改默认 Live Voice 生产链路**；`git diff develop -- server/modules/voice-realtime/ src/modules/chat/voice-realtime/` 必须为空。
- ⛔ **不得把 ASR 单句录音（如 THCHS-30 的逐句朗读）当天然语义 HOLD 标注**；若要用 THCHS-30，必须人工复核候选停顿点是否为真实语义停顿而非句子边界，且与自然连续对话语料**分别统计**，不得合并掩盖。
- ⛔ **不得把 TTS 合成或人工拼接的音频当真实自然语音**；若使用,必须打标记并与真实录音分别统计。
- ⛔ **样本不足时禁止宣称达标**——明确写"样本量 N=.., 置信区间过宽,不支持达标/不达标结论"，不得用小样本点估计冒充结论。
- ⛔ **禁止"调完参数在同一份数据上评分"的过拟合结论**——中文评测集必须与任何用于调参/选阈值的集合不同（即便本任务不训练，也不能用同一批中文样本既选最优阈值又报告该阈值的指标）。
- ⛔ **跨模型阈值数值不可当等价比较**——Smart Turn 与 turn-1-mini 的 `threshold` 是两个模型各自的概率空间,数值相同不代表同一操作点;比较必须基于各自的 Pareto 前沿,不能说"两者 threshold=0.2 所以等价"。
- ⛔ 不自动建立后续 fine-tune 执行子任务——仅在中文零样本缺口确认、且 §5 调研证明数据/训练可行时，**在 CONCLUSION.md 里建议**，由人决定是否另立，本任务不代为创建。

## Plan

1. **查重与资产复用核验**：确认无既有重复任务（已查 `tasks/` 无 P0.14/中文/zeroshot 相关条目）；grep 证明本任务未修改 P0.13 产物路径；复用其 checkpoint revision/sha256/预处理代码（可 import 或复制只读引用，不重新实现）。
2. **中文 held-out 语料构建**（真实优先）：
   - 复核 P0.6/P0.7 已有中文真实样本（THCHS-30 子集）：人工过一遍候选停顿点，剔除/标记"句子边界≠语义 HOLD"的假阳性；记录复核方法与剔除率。
   - 调研合法可获取的中文**自然连续语音/对话**语料（如 AISHELL-4、MagicData 对话子集、或其它 speaker-分组且带自然停顿的公开中文语料），核验许可（参考 `dataset-sources.json` 已有方法：第一手许可证文字，不是搜索摘要转述）。
   - 若找不到足量自然对话语料，如实记录"样本不足"及具体缺口（缺多少 held-out 停顿点才能达到可信区间），不得拿 THCHS-30 单独凑数冒充达标证据。
3. **跨模型非退化 Pareto 对比**：复用 P0.13 的 sweep 核心（threshold×actionDelay×timeout），**排除 thr≤0.02 的近退化策略**（不只排除 thr=0）；额外加入两条基线——纯 VAD（固定静音阈值触发）与固定等待时长（无模型）——证明模型本身是否真的比基线有判别力；两模型分别报各自前沿，不共享阈值数值比较。
4. **指标与分层**：每个报告的工作点给 false-cutoff/missed-END 的 k/n + Wilson 95% CI、EOT 等待 p50/p90/max、推理 CPU 耗时（与等待分开列，复用 P0.13 口径）；按语种（中/英对照）、按 speaker/session 分组给分层误差；选点与报告指标必须用不同数据切分（held-out），避免过拟合结论。
5. **中文适配可行性调研（不训练）**：
   - 真实尝试加载 Smart Turn / turn-1-mini 的 PyTorch 原版 checkpoint + 官方训练代码（dry-run 到能跑一步 forward/loss 计算为止，不做完整训练迭代），记录"真能复现"还是"文档与实际不符"的具体证据。
   - 候选中文训练数据（AISHELL-1、THCHS-30、其它自然对话语料）及许可是否允许用于 fine-tune（区分"内部评测"和"训练再分发模型权重"两种使用场景的许可差异）。
   - 产出 GPU runbook：训练前检查清单（环境/依赖/显存预估）、语料构造步骤、speaker-disjoint train/val/test 切分方法、英语 retention regression（防止中文微调后英语能力退化的回归检查设计）、ONNX export/量化步骤——全部是**文字方案**，本任务不执行。
6. **交付物**：`RESULT.json`（中文零样本真实评测数据）、`CONCLUSION.md`（零样本结论 + 适配可行性结论 + 是否建议后续 fine-tune 子任务）、可复现脚本、`gpu-finetune-runbook.md`。

## AC

- [ ] AC1 查重与复用核验：机械证据（grep/diff）证明未修改 P0.13 已落地产物路径；checkpoint revision/sha256 与 P0.13 逐字一致；本分支 `git diff develop` 对生产三路径为空。
- [ ] AC2 中文 held-out 语料：以真实自然连续语音/对话为主；若含 THCHS-30 等 ASR 单句录音，记录人工复核方法与结果，且与自然对话样本分别统计；TTS/拼接样本单独标记分别统计；样本不足时 `CONCLUSION.md` 明确写"不足，不宣称达标"而非省略。
- [ ] AC3 非退化跨模型 Pareto：排除 thr≤0.02 的策略（非仅 thr=0）；两模型各自前沿分别报告，不以共享阈值数值比较；包含纯 VAD 与固定等待两条基线并给出对比结论（模型是否真的比基线强）。
- [ ] AC4 指标口径：每个报告点给 false-cutoff/missed-END k/n + Wilson 95% CI、EOT 等待 p50/p90/max、推理耗时（单列）、按语种/分组分层误差；选点数据切分与报告指标数据切分不同（或明确说明为何相同切分下该结论仍站得住），不得是"调参集=评分集"的同一份数据。
- [ ] AC5 中文适配可行性：记录对 PyTorch 原版 checkpoint+训练代码的真实加载/dry-run 结果（证据，不是读文档猜测）；候选中文训练数据集及许可核验（第一手文字）；交付 `gpu-finetune-runbook.md`（训练前检查清单、语料构造、speaker-disjoint split、英语 retention regression 设计、ONNX export/量化步骤），全部为方案，无一步真实训练在本机执行。
- [ ] AC6 零训练零付费零生产：机械证据证明本机未下载/未训练任何微调权重、未产生付费 API 调用（grep 无 DashScope/外部计费推理）、生产三路径 diff 为空；未触碰 P0.13 产物。
- [ ] AC7 交付物完整且不自动建子任务：`RESULT.json`/`CONCLUSION.md`/脚本/`gpu-finetune-runbook.md` 齐备；`CONCLUSION.md` 明确回答"中文零样本是否存在达标操作点"及"是否建议后续 fine-tune 子任务"，但本任务本身不创建该执行子任务。
- [ ] AC8 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

中文评测数字必须来自本任务对复用 checkpoint 的真实本地推理（不得插值、不得照抄模型自报数字）；语料不足必须显式声明置信度受限，不得拿小样本或 ASR 单句录音冒充自然语义标注结论；跨模型比较不得用共享阈值数值等价比较；GPU fine-tune 方案只是书面 runbook，本机不执行任何真实训练步骤；全程零付费 API 调用、零训练权重下载、零生产改动；未触碰 P0.13 已落地产物；后续 fine-tune 执行子任务不自动创建，只在证据支持时在交付物里建议。

## Touches

- experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/run-benchmark.mts (new)
- experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/corpus-license-review.json (new)
- experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/RESULT.json (new)
- experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/CONCLUSION.md (new)
- experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/gpu-finetune-runbook.md (new)
- experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/.gitignore (new)
- tasks/gap-voice-turn-detection-p0-14-chinese-zeroshot-and-ft-readiness.md (new)
---
id: gap-voice-turn-detection-p0-9-staged-cheap-feasibility
title: 低成本 Turn Detection 分阶段可行性 P0.9：阶段1 离线 VAD 多档重放（零付费）→ 阶段2 本地检测器对比（仍零付费）→
  门禁后才考虑非实时 Omni
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（执行顺序被用户明确纠正）

`gap-voice-turn-detection-p0-8-paired-realtime-vs-nonrealtime-pilot`（done）直接跳到真实付费的 Qwen Realtime + 非实时 Omni 配对测试，结果 No-Go，但细读发现 4 个"关键失败"里至少 2 个更像是本任务自己判分规则（"禁用词"匹配）和设计哲学（中继应逐字转发纠正前后内容，不应自行解析）冲突的产物，不是真实能力缺陷；另有 1 个是函数调用参数 JSON 截断，根因未查。

人 yale 本轮明确纠正执行顺序：**不要在查清纯本地/零成本方案是否够用之前就先花钱**。要求：

1. **阶段 1（零付费，离线重放）**：只复用 `gap-voice-turn-detection-p0-6-dataset-benchmark`/`...-p0-7-unified-realtime-benchmark` 已经采集好的真实音频候选点与时间戳（44 样本/73 候选点，含 LibriSpeech/THCHS-30 的真实人声与已标注的句中停顿/候选 END 点），**离线**用 VAD+静音等待在多档阈值（300/500/800/1200ms，以及中间必要的档）上重放，逐样本列出：哪些句中停顿在哪个阈值下会被误切断（false cutoff）、真正的 END 点需要等多久才会被判到。输出一个"在匹配 Qwen Realtime 现有可观察质量目标下的最小等待阈值"的结论。
2. **口径纠正**：评估"Qwen Realtime 现有质量目标"时，必须排除/明确标注受 `...-p0-7` 已查明的网络异常/timeout 污染的会话（11/24 里约 9 条是真实端点延迟/不稳定，2 条是测量方法假阴性），**不得**用那种被污染、分母本来就很小的读数（如某个操作点 denominator=6）直接当"Realtime 的真实质量基线"，也不得反过来凭极小分母（如 0/6）判定纯 VAD 不可行——两边都要先说清楚分母与污染情况。
3. **阶段 2（仍零付费，仅在阶段 1 不够用时才做）**：如果纯 VAD 在任何合理阈值下都达不到够用的质量（比如必须要的等待时间长到用户体验不可接受，或者误切断率压不下去），在**同一组数据**上加测已经真实跑过的本地模型——Smart Turn（P0.6/P0.7 的编译版）、LiveKit v1-mini（P0.6 已在隔离 sandbox 里真实测过）、以及优先尝试 turn-1-mini（p99lab，Apache-2.0 代码+权重，英文模型；**若环境里没装**，必须明确标记"未安装"而不是跳过不提或编个数字）——用跟 VAD 多档重放**同一套**对照方法，算出"容忍的质量损失 vs 延迟差"的具体 tradeoff 数字（不是定性描述）。
4. **门禁**：只有在阶段 1 或阶段 2 的结果**预先约定**的质量门槛（本任务执行前写死具体数字，不得事后调整）通过之后，才允许未来另立任务去跑非实时 Omni + tool_call；如果阶段 1/2 都不过，**只能**对"纯 VAD"（或"本地检测器集合"，视阶段 2 是否触发）写 No-Go，**不得**把这个 No-Go 延伸成"更强的端点模型（如真实跑一次 LiveKit 完整版、或接受非实时 Omni 本身）也不行"的结论——那是两件不同的事。

### 边界 / 不做（严格执行，不得自我扩大范围）

- ⛔ **本任务不得发起任何新的真实付费 Qwen Realtime 或非实时 Omni 调用**。既不是"先问一下预算"再调用，是**完全不碰**——这件事本身要等阶段 1/2 的门禁结果出来、由人 yale 另立新任务才能做。
- ⛔ **不得把本任务做成又一个大框架**：复用 P0.6/P0.7 已有的音频文件、manifest、候选点标注、事件时间轴记录工具；不新建一套平行的数据管线、不新建通用 adapter 协议层，就是在已有数据上跑几档阈值对比 + （如需要）几个本地模型的推理，产出一页数字结论。
- ⛔ 不扩充样本量、不新录音、不新合成语料——就用 P0.6/P0.7 已经有的 44 样本/73 候选点（或其中真实人声的子集）。
- ⛔ 不改默认 Live Voice 生产链路；`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。
- ⛔ LiveKit 若在阶段 2 用到，继续只在 P0.6 已搭好的隔离 sandbox 里跑，不新增生产集成路径。
- ⛔ 不得凭极小分母（个位数分母）的读数下任何"可行/不可行"的结论，必须先说清楚分母与样本是否受 P0.7 已查明的网络异常污染。

## Plan

1. **口径先行**：从 P0.7 的 `unifiedReplay.qwenStreaming` 原始数据里，剔除/标注受网络异常污染的会话（约 9/24，`...-p0-7` 已查明），用剩下干净的会话（以及 P0.7 的 batch 组读数）重新定义"Qwen Realtime 现有可观察质量目标"（具体数字，如误截断率/端点延迟分布），作为阶段 1/2 的对照基线；明确写出调整前后的分母变化。
2. **阶段 1 离线重放**：对 P0.6/P0.7 manifest 里每个真实人声候选点（含已标注的句中停顿/候选 END 时刻），用现有 `StreamingVad`（或其纯函数形态）在 300/500/800/1200ms 静音等待阈值（可按需加中间档）下重放，逐样本列出该阈值下的判定结果（false cutoff / 正确等到 END / 漏判）；汇总每档的误截断率与到 END 的等待延迟，画出"阈值→质量"的曲线（数值表即可，不要求出图）。
3. **阶段 1 结论**：是否存在一个阈值，使误截断率与延迟同时落在步骤 1 定义的质量目标内；若有，直接得出"最小够用等待阈值"的数字结论，阶段 2 可以跳过（但要写明为什么跳过）。
4. **阶段 2（仅阶段 1 不够用时触发）**：在同一组候选点上，用已经真实测过的 Smart Turn（编译版）、LiveKit v1-mini（P0.6 的隔离 sandbox）产出同口径读数；尝试引入 turn-1-mini（p99lab，Apache-2.0），若需要新装依赖，评估是否能在不碰生产依赖的隔离环境里装；若因环境限制无法装，明确标记"未安装，未测"，不得编造数字或静默跳过。计算每个候选方案相对阶段 1 定义的质量目标的"容忍质量损失 vs 延迟差"具体数字（例如"阈值 X 比纯 VAD 平均多等 Yms，但误截断率从 Z1 降到 Z2"）。
5. **门禁判定与一页结论**：预先写死的质量门槛（执行前定，不得事后调整）；产出一页 Markdown/文本结论（曲线/表格摘要 + 明确 Go/No-Go + 如 No-Go 则只对纯 VAD 或本地检测器集合下结论，不否定非实时 Omni 本身的可行性）。

## AC

- [ ] AC1 口径纠正：P0.7 污染会话的剔除/标注清单与剔除前后分母对比记入 artifact；阶段 1/2 对照的"质量目标"基线数字明确写出来源与分母。
- [ ] AC2 阶段 1 离线重放：至少 4 档阈值（300/500/800/1200ms）在 P0.6/P0.7 已有真实候选点上的离线重放结果，逐样本记录（不只是汇总率），汇总误截断率与到 END 延迟的"阈值→质量"数值表。
- [ ] AC3 阶段 1 结论：明确给出是否存在够用阈值及具体数字，或明确说明不存在、理由是什么（哪类句中停顿在所有阈值下都会被误切或都要等太久）。
- [ ] AC4 阶段 2（若触发）：Smart Turn/LiveKit v1-mini 同口径读数；turn-1-mini 若未安装需明确标记，不得编数字；每个方案的"质量损失 vs 延迟差"tradeoff 有具体数字。
- [ ] AC5 门禁与一页结论：质量门槛执行前写死；最终产出一页结论文档，Go/No-Go 明确，No-Go 时范围限定在纯 VAD 或本地检测器集合，不延伸否定非实时 Omni。
- [ ] AC6 零新增付费调用：机械证据（如 grep 代码/日志确认没有新的 DashScope WebSocket 连接或非实时 Omni HTTP 请求被发起）证明本任务全程零新增真实上游调用。
- [ ] AC7 范围约束：复用现有数据/工具，没有新建平行数据管线或通用 adapter 协议层；没有新增样本/录音/合成语料。
- [ ] AC8 生产面零改动：`git diff develop` 对三个生产路径文件/目录为空；LiveKit 若用到仍只在既有隔离 sandbox。
- [ ] AC9 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

阶段 1 的误截断率/延迟数字必须来自对已有真实音频的真实离线重放（不是估算）；P0.7 污染会话的剔除/标注必须基于真实数据而非假设；阶段 2（若触发）的本地模型读数必须真实运行产出，turn-1-mini 未安装则明确标记，不得假装测过；质量门槛必须在看到结果前写死；一页结论必须包含具体数字而非定性描述；全程零新增真实付费上游调用（机械可证）。本任务零改动生产默认 Live Voice 链路，不扩大样本/数据管线范围。

## Touches

- experiments/voice-turn-detection-compare/staged-feasibility/ (new)
- experiments/voice-turn-detection-compare/staged-feasibility/offline-vad-sweep.mts (new)
- experiments/voice-turn-detection-compare/staged-feasibility/stage2-local-detectors.mts (new)
- experiments/voice-turn-detection-compare/staged-feasibility/RESULT.json (new)
- experiments/voice-turn-detection-compare/staged-feasibility/CONCLUSION.md (new)
- tasks/gap-voice-turn-detection-p0-9-staged-cheap-feasibility.md
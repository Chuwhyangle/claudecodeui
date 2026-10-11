---
id: gap-voice-turn-detection-p0-5-expansion
title: 低成本 Turn Detection 对照 P0.5：Smart Turn harness
  开销根因、标注样本扩充（含自纠正）、MaAI/Vogent/DualTurn 新候选评估、LiveKit 条款复核、非实时 qwen
  探针再设计、状态机反例测试
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状

`gap-voice-turn-detection-pluggable-comparison-p0`（已 done，develop commit 37937a38）建立了四组对照 harness（`experiments/voice-turn-detection-compare/`）与 SPEC（`docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md`），但样本只有 8 条（19 候选点，TTS 合成）、Smart Turn v3.2 的端到端延迟 p90=167.4ms 中 128.5ms 来自本 harness 自己的 JS log-mel 前端（未与 Pipecat 官方处理路径对照过，不能排除是测量方法本身的问题）、非实时 qwen 探针只测了一条「犹豫未说完」的语料（回复文本正是对这种语料的合理行为，不能区分「模型不会调用工具」与「这段话本来就不该触发工具」）、且只覆盖了 Pipecat/LiveKit 两个候选检测器。

人 yale 在当前对话中新给出四个候选扩展与一组加深测量的明确指令，已授权立即推进（不是征求是否要做）：
1. Smart Turn harness 开销要定位根因：区分 warm/cold、CPU 时间 vs 墙钟延迟、准确率，并用 Pipecat 官方自己的音频处理路径做对照，防止测量方法本身带偏读数。
2. MaAI-Kyoto/MaAI（https://github.com/MaAI-Kyoto/MaAI）作为**首选新增候选**：2026-08-30 新增单通道 VAP 模式（`vap_mono`），README 称支持中/英/日；需先核实实际模型权重、授权条款、单通道行为，再决定能否在隔离 harness 里跑。
3. Vogent Turn（https://github.com/vogent/vogent-turn，HF `vogent/Vogent-Turn-80M`）：Whisper-Tiny（≤8s@16kHz）+ SmolLM2-135M 派生的 80M 分类头，作为 audio+text 辅助检测候选对照，**不得**拿它内部的 ASR/文本分支输出替代主 Qwen 音频推理——它作为一个独立检测器（喂音频、吐 END/CONTINUE）被测量，不是转写源。
4. DualTurn（https://github.com/anyreachai/dualturn）：研究性候选，只需核实代码/权重许可证与 0.5B 参数单 CPU 成本评估，**暂不需要**接入 harness 跑分。
5. LiveKit v1-mini：核对官方「free to use in any context at no additional cost」与 LiveKit Model License 条款是否冲突。

另需：扩充标注样本（含自我纠正场景「改成三十秒……不对，二十秒」、中英代码术语混合、句中停顿）、给出分母与置信区间或明确小样本局限（不编造真实中文语音样本）、状态机补反例测试（证伪 commit grace/turnVersion 对自纠正场景的处理）、重新设计非实时 qwen 探针使其能区分「接口不支持」「提示未触发」「schema 问题」「模型选择不调用」四种情况（P0 现有一条探针不构成结论）。

**本次追加（同会话内 follow-up）**：人 yale 进一步要求把 LiveKit Turn Detector v1-mini 从「条款脚注」（原 AC8）升级为与组 A（VAD）/组 B（Smart Turn）/MaAI 同口径的**正式对照组**，但前提是先重新核实 LiveKit Model License 最新文本；若条款明确禁止独立基准测试，不得绕过，而是记录阻塞点与用户本人需要采取的具体步骤。编排会话已在本回合通过 WebFetch 原文复核（见下方新增小节），结论：仍为硬阻塞，本次升级只做文档化加深与隔离就绪设计，不下载/不运行 v1-mini 权重。

### 本会话已完成的在线核实（供实现时引用，不必重新搜索，但必须在 harness 里独立验证可执行性/许可证细则）

- **MaAI-Kyoto/MaAI**：GitHub README 显示 2026-08-30 新增单通道 turn-taking（VAP）模式；API 文档（https://maai-kyoto.github.io/MaAI/）称 `vap_mono` 用独立 pretrained 权重、单编码器 + 因果 transformer，输出单一通道的值（不是说话人间归一化的双通道值）；README 称支持 English/Chinese/Japanese、形容为 lightweight，但**没有找到 CPU 基准数字**；**许可证未在搜索结果中出现，必须直接读仓库 LICENSE 文件**，不得假设。
- **Vogent Turn**：GitHub（inference 代码）Apache-2.0；但**权重**是「modified Apache 2.0」+ 更严格署名要求；HF model card 额外写了限制条款：横向语音代理平台**不得**把 Vogent-Turn-80M 设为默认检测器而不让终端用户看到/选择，必须让用户能显式选中 "Vogent Turn Detector"。一份第三方 GitHub PR 提到某项目因许可证排除了 LiveKit/TEN/Vogent 三者（二手信息，仅供参考，不是权威判断）。
- **DualTurn**：论文（Interspeech 2026）本身是 CC BY 4.0（只覆盖论文文本，不覆盖代码/权重）；模型 0.5B 参数（LoRA 9M 可训练），单 CPU 78ms 延迟（论文数字，未经本任务复测）；6 个输出头（EOT/HOLD/BOT/BC/VAD/FVAD）；**代码仓库与 HF checkpoint 的许可证本次搜索未找到，必须直接查 GitHub 仓库页与 HF model card**。
- **LiveKit v1-mini**：HF 上 `livekit/turn-detector` 的 LICENSE 文件（LiveKit Model License Agreement）原文：「you may use these LiveKit models freely but can only use them together with the LiveKit Agents framework」+「not to use any LiveKit Models on a standalone basis or with any other frameworks」。LiveKit 官方文档的「free to use in any context at no additional cost」说的是**定价**（不额外收费），不是许可授权范围；两句话分别回答「要钱吗」和「能在哪用」，**不矛盾**，但确认了 P0 对组 C `blocked-by-license` 的判断是对的（已有 P0 SPEC G7 行引用一手条款，这里只是补一条「免费 ≠ 许可范围」的澄清脚注，不是新开放问题）。

### LiveKit Model License 二次复核（本次追加，primary-source，Last Updated: November 25, 2024——与 P0 读到的同一版本，确认目前无更新版本）

- Section 1 / 3(i) 原文效果：「you may use these LiveKit models freely but can only use them together with the LiveKit Agents framework」——一个独立的 Node/TS 基准 harness（没有包在真实 LiveKit Agents 框架里）正是条款明确点名禁止的「standalone basis」；Section 3(i) 字面上就禁止这种独立 harness 跑分。
- Section 3(ii) 是**另一条独立风险**：禁止用 LiveKit Materials 或其输出「to improve or otherwise develop any other models that are not LiveKit Models」——即便有人把 benchmark 包进真实 LiveKit Agents 框架以满足 3(i)，用这份对照数字去决定在 Smart Turn / MaAI / 其它检测器之间为本产品选型，本身也可能落入这一条的覆盖范围。这是一个**法律解释问题，不是工程问题**，本任务不得单方面下结论。
- 条款全文中**没有任何** benchmark/evaluation/research 的豁免条款，也**没有**任何联系方式/流程用于申请不同许可。
- 结论：**确认为硬阻塞**，比 P0 的引用多了一份更强的一手条款定位（3(i) + 3(ii) 并列原因）。本任务不下载 LiveKit v1-mini 权重、不运行任何真实推理。组 C（LiveKit）继续保持 `blocked-by-license`、`measured:false`；本次升级把它从「跳过的脚注」正式改为「已设计、已就绪但被明确授权阻塞的对照组」——adapter 接口、与组 A/B 相同的 manifest 接入方式、相同的六读数 schema 均已设计，只是不执行真实推理。

### 给人 yale 本人的升级路径（worker 不能代为联系 LiveKit 或做法律承诺，以下步骤需人本人执行）

1. 通过 LiveKit 官方渠道（https://livekit.io/contact 或其 sales/business 联系表单——License 文件本身未提供其它地址）明确书面申请两项授权：(a) 在 LiveKit Agents 框架之外独立使用 v1-mini 做基准测试；(b) 把对照结果用于在非 LiveKit 检测器之间为本产品选型。两点都需书面确认覆盖，否则不得推进。
2. 低摩擦备选路径：把 benchmark 建在真实的 `livekit-agents` + `livekit-plugins-turn-detector` pipeline 内部（字面满足 Section 3(i)），但 Section 3(ii) 的选型风险依然存在，需要人自行判断是否接受，本任务不代为选择，只提示这个细微差别。
3. 不需要授权的零风险后备：在 SPEC 表格里把 LiveKit 自己公开的 `eot-bench` 结果，或本会话找到的 p99lab 第三方复测数字（v1-mini 约 27.8% false cutoffs @300ms、约 1070ms 延迟 @5% cutoffs，对比完整托管版 v1 约 9.9%——明确标注为**二手、非本仓复测**，硬件/方法不同）作为「引用，非本仓复测」的参考行收录，不冒充本仓实测。

### 边界 / 不做

- ⛔ 不接入运行时、不改默认 Live Voice 生产链路；`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。
- ⛔ 不重新评审已 done 的 P0 结论本身（Smart Turn/LiveKit 的既有读数不推翻，只补根因/扩充）。
- ⛔ DualTurn 不要求接入 harness 跑分（只做许可证+成本文档核实），不得强行集成。
- ⛔ Vogent Turn 评测时不得把它的内部转写/文本分支输出当成喂给 Qwen 的替代输入；它只作为独立检测器被测量。
- ⛔ 不编造真实人声标注样本；新增样本若无法合规录制，用明确 `synthetic:true` 标注的合成样本或如实报告局限（沿用 P0 的纪律）。
- ⛔ 非实时 qwen 新增的真实付费调用必须先在 artifact 里写死预算上限再发请求，超支即中止并记录；总花费含 P0 已花的 ¥0.00242。
- ⛔ 未取得 LiveKit 书面授权前，不得下载/运行 LiveKit v1-mini 权重；本任务只做文档化升级与隔离就绪设计。

## Plan

1. **Smart Turn 根因**：在 `experiments/voice-turn-detection-compare/adapters/smart-turn-v3.mts` 旁新增/扩展一条对照路径，直接调用 Pipecat 官方 `local_smart_turn_v3` 的音频预处理（而不是本 harness 自写的 JS log-mel），拆分 warm（权重已加载、模型已跑过一次）vs cold（首次加载）两种计时，CPU 时间与墙钟分别记录；定位 128.5ms 的开销落在哪一段（JS DFT 实现本身 / 重采样 / 其它）。
2. **MaAI 核实与评测**：读 `MaAI-Kyoto/MaAI` 仓库 LICENSE；若允许离线评估，在隔离 harness（不装进生产依赖，不联网除一次性拉权重）里跑 `vap_mono` 单通道模式，产出与组 A/B 同口径的误截断率/漏端点率/延迟 p50 p90/CPU/RAM；若许可证不明确或限制，记 `blocked-by-license` 或 `deferred-license-unclear`，不猜测。
3. **Vogent Turn 评测**：同样隔离 harness 跑 `vogent/Vogent-Turn-80M`，当作第五个独立检测器（输入音频，输出 END/CONTINUE），记录其权重许可证里的「横向平台需显式让用户选择」限制条款原文。
4. **DualTurn 文档核实**：查 GitHub 仓库页与 HF checkpoint 页的许可证字段（代码 license、权重 license，不是论文的 CC BY 4.0），把 0.5B/78ms 的论文数字标注「来源：论文，未本任务复测」，写入 SPEC 作为跟踪中的研究候选，不建 harness adapter。
5. **样本扩充**：扩充 `experiments/voice-turn-detection-compare/manifest.json`，新增自我纠正场景（如「改成三十秒……不对，二十秒」，标注 END/CONTINUE/CORRECTION 三态而不仅是二态）、中英代码术语混合、句中停顿；每条标 `source`（real/synthetic）与 `language`；若样本仍 < 20 条独立人声，继续如实标注 `sampleSizeCaveat` 并给出分母；若能达到更大样本，计算 Wilson 或 Clopper-Pearson 置信区间而不是裸比率。
6. **状态机反例测试**：在 `experiments/voice-turn-detection-compare/` 下新增一个独立的状态机参考实现模块（非生产代码，不接运行时）+ 测试文件，针对 SPEC 已写的 `IDLE→TURN_PENDING→COMMIT_GRACE→ACTION_COMMIT` 跑至少一条自我纠正反例（「改成三十秒……不对，二十秒」合成候选点序列）：断言 `turnVersion` 递增、旧版本结果被作废不发送、最终 `ACTION_COMMIT` 的内容是纠正后的版本，不是先说的版本。
7. **非实时 qwen 探针重设计**：预算先写死（新增真实调用上限，比如 ≤¥0.03，执行前记入 artifact），用**至少 2 条**语料重跑：(a) 一条**明确无歧义**的可执行指令（不是「犹豫未说完」的语料）、(b) P0 已用过的那条犹豫语料作对照；同时变化 system/tool 提示的明确程度，设计出能区分「接口结构性不支持音频+tools」vs「这条提示没有触发」vs「schema 本身有问题」vs「模型看到清晰指令仍选择不调用」四种读数的测量点，而不是单条样本的二元 supported/unsupported。
8. **LiveKit 脚注**：在 SPEC 现有 G7 行追加一条引用一手 LICENSE 原文的澄清脚注（「免费」≠「许可范围」），不重开已关闭的开放问题。
9. **SPEC 更新与 Go/No-Go 重算**：把新读数并入现有表格（不删除 P0 的行，新增行/新增列），同一音频与候选点上横向比较 floor VAD / Smart Turn（根因后）/ MaAI（若可测）/ 已引用的 Realtime；Go/No-Go 判据沿用 P0 写死的门槛，不得因为新数字好看就放宽门槛本身。
10. **LiveKit 升级为正式对照组（文档化）**：在 `experiments/voice-turn-detection-compare/adapters/livekit-v1-mini.mts` 中加深文档/阻塞说明——写入 Section 3(i)/3(ii) 一手原文定位、「无 benchmark 豁免条款、无申请许可联系方式」的结论、以及给人 yale 的三步升级路径（联系官方申请书面授权 / 包进真实 LiveKit Agents 框架的备选及其残余风险 / 引用 eot-bench 或 p99lab 二手数字作参考行）；adapter 文件保持纯文档+阻塞状态，**不**新增任何真实模型加载/推理代码路径；SPEC 表格把组 C 标注从「脚注」改为「已设计、授权阻塞」的正式对照组行，并收录一行「引用，非本仓复测」的参考数字。

## AC

- [x] AC1 Smart Turn 根因：新增对照路径使用 Pipecat 官方预处理，产出 warm/cold 分离的 CPU 时间与墙钟延迟数字，定位 128.5ms 端到端开销的来源（JS 前端 vs 其它），写入 `RESULT.json`（新字段，不覆盖 P0 既有字段）。
- [x] AC2 MaAI：仓库 LICENSE 原文已读并记录结论；若可测，产出与组 A/B 同口径六类读数；若不可测，`blocked-by-license` 或 `deferred-license-unclear` 并记录依据，不猜测数字。
- [x] AC3 Vogent Turn：作为独立检测器产出同口径读数（或同样走阻塞/延后记录路径），权重许可证的「横向平台需显式选择」条款原文记入 artifact；确认未把其内部文本分支喂给 Qwen。
- [x] AC4 DualTurn：SPEC 新增一节记录代码/权重许可证来源（不是论文许可证）与 0.5B/78ms 数字的论文出处标注，明确写「未集成，跟踪候选」，不新增 harness adapter 文件。
- [x] AC5 样本扩充：`manifest.json` 新增自我纠正/中英混合/句中停顿场景，三态标注（END/CONTINUE/CORRECTION），每条有 `source`(real/synthetic)与`language`；`RESULT.json` 顶层给出新的样本量与分母；若仍 < 20 条独立人声样本，`sampleSizeCaveat` 继续为真并说明原因；不得编造真实人声样本。
- [x] AC6 状态机反例测试：新测试文件针对「改成三十秒……不对，二十秒」场景断言 `turnVersion` 递增、旧结果作废不发送、最终 commit 内容正确；测试退出 0；该模块与测试均在 `experiments/` 下，不接运行时。
- [x] AC7 非实时 qwen 探针重设计：至少 2 条语料（含一条无歧义指令）+ 多种提示明确度的对照，预算上限在执行前写入 artifact（含 P0 已花 ¥0.00242 的累计口径），实际花费记录；读数能够区分接口结构性支持/提示未触发/schema 问题/模型选择不调用四种情况中至少能排除哪几种，不得只给一个笼统的 supported/unsupported。
- [x] AC8 LiveKit 脚注：SPEC G7 行追加一手 LICENSE 原文引用的澄清脚注，未重开已关闭的开放问题 1/2。
- [x] AC9 Go/No-Go 重算：SPEC 表格新增行/列反映新读数，门槛数值与 P0 写死的一致（未放宽），判定基于实测，不得先写结论再找数字。
- [x] AC10 生产面零改动：同 P0 的 AC8 判据，`git diff develop` 对三个生产路径文件/目录为空。
- [x] AC11 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与 `scripts/suite-duration-baseline.tsv`。
- [x] AC12 LiveKit 正式对照组升级（本次追加，用户 follow-up 指令）：`livekit-v1-mini.mts` 的文档/阻塞说明已加深到包含 Section 3(i)（独立 harness 即为「standalone basis」）与 Section 3(ii)（用对照结果做选型本身的独立风险）两条一手原文定位、「无 benchmark 豁免、无申请许可联系方式」的结论，以及三步用户升级路径（官方联系表单书面申请两项授权 / 包进真实 LiveKit Agents 框架的备选及其残余 3(ii) 风险 / 引用 eot-bench 或 p99lab 二手数字的无风险后备）；组 C 在 SPEC 中改标为「已设计、授权阻塞」的正式对照组（`measured:false` 保留，不伪造实测数字）；adapter 文件确认**没有**新增任何真实模型加载/推理代码路径（仍是纯文档+阻塞状态模块）；未获得书面授权前不下载/运行 v1-mini 权重。

## DoD

Smart Turn 根因数字必须来自真实本地运行（warm/cold 各自真实计时，不是估算）；MaAI/Vogent 的许可证结论必须基于真实读到的 LICENSE 文件原文（不是搜索摘要），可测则必须是真实本地推理读数；DualTurn 的许可证结论同样来自真实读到的仓库/HF 页面；非实时 qwen 新探针必须是真实付费调用、响应原文入 artifact、花费数字真实且在预先写死的上限内；状态机反例测试必须真实执行并通过（不是手写断言绕过真实状态转移逻辑）；SPEC 的 Go/No-Go 表每一格要么有实测数字要么有显式局限说明；LiveKit 对照组的「授权阻塞」结论必须基于真实读到的 LICENSE 原文（Section 3(i)/3(ii)），不得在未取得书面授权前运行任何真实 v1-mini 推理。本任务零改动生产默认 Live Voice 链路。

## Touches

- docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md
- experiments/voice-turn-detection-compare/manifest.json
- experiments/voice-turn-detection-compare/adapters/smart-turn-v3.mts
- experiments/voice-turn-detection-compare/adapters/maai-vap-mono.mts (new)
- experiments/voice-turn-detection-compare/adapters/vogent-turn.mts (new)
- experiments/voice-turn-detection-compare/adapters/livekit-v1-mini.mts（文档/阻塞说明加深：补 Section 3(i)/3(ii) 一手原文定位与升级路径；不得新增真实模型加载/推理代码路径，仍是纯文档+阻塞状态模块）
- experiments/voice-turn-detection-compare/oracle/whisper-log-mel-oracle.py (new)
- experiments/voice-turn-detection-compare/run.mts
- experiments/voice-turn-detection-compare/RESULT.json
- experiments/voice-turn-detection-compare/state-machine/turn-state-machine.mts (new)
- experiments/voice-turn-detection-compare/state-machine/turn-state-machine.test.mts (new)
- scripts/voice-turn-detection-compare.mjs
- tasks/gap-voice-turn-detection-p0-5-expansion.md

## 验证记录

- AC10 生产面零改动：`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 输出为空（exit 0）。
- AC11 静态门：`npm run typecheck`（root + server + scripts 三个 tsconfig）exit 0。首轮 scripts 项目报 3 处错误（TS2532/TS18048/TS2345，均在本次新增的 `scripts/voice-turn-detection-compare.mjs` probe 批量循环），已修（`Map` 取每格最坏上界 + plan 单元格窄化 guard），重跑 exit 0。未新增 `server/**` 测试文件 ⇒ 无需同步文件数钉子/耗时基线。
- AC6 状态机反例测试：`node_modules/.bin/tsx experiments/voice-turn-detection-compare/state-machine/turn-state-machine.test.mts` → 4 tests pass / 0 fail / exit 0。
- AC7 非实时 qwen 探针：5 次真实付费调用，本批实测 ¥0.019129（执行前写死上限 ¥0.03，最坏上界 ¥0.027414），累计实测 ¥0.021549；`explicit-forced` 命中 `session_send` 函调 ⇒ 接口=YES；`p0Reproduction.reproducible=false`（P0 单条读数不可复现，正是重设计的理由）。
- AC1 Smart Turn 根因：warm/cold 拆分 + numpy oracle（同一 recipe，特征逐位一致 `maxAbsDiff=0`）⇒ JS 前端 warm p90 ≈121 ms 是朴素 DFT 实现，oracle 仅 6.2 ms。
- 按 worker 边界**未运行**完整测试套件（suite 归 fan-in 驱动）。

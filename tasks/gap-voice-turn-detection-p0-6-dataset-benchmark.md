---
id: gap-voice-turn-detection-p0-6-dataset-benchmark
title: 低成本 Turn Detection 对照 P0.6：公开授权真实语音样本集扩充、Smart Turn 编译特征提取数值等价验证、LiveKit
  v1-mini 真实框架内实测路线、非实时 Qwen vs Realtime 工具选择对照
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

`gap-voice-turn-detection-pluggable-comparison-p0`（done）与 `gap-voice-turn-detection-p0-5-expansion`（done）建立了四组对照 harness，但样本始终是 0 条真实人声（12 条全部复用/衍生自既有 TTS fixture）、Smart Turn 的延迟根因已定位到 harness 自己的 JS DFT 实现但从未真的替换成编译版本去验证加速、LiveKit v1-mini 两轮都停在 `blocked-by-license`（基于对 Section 3(i)/3(ii) 的保守读法）、非实时 qwen 探针已证明接口支持函调但从未与 Realtime 路径的 `tool_choice` 行为做正式对照。

人 yale 本轮明确授权继续技术验证，并对 LiveKit 的结论提出异议：不接受把 P0.5 的 `blocked-by-license` 直接当最终答复，要求重新核实最新许可证文本、寻找合法的 LiveKit Agents 原生环境实验路线，允许时尽可能实测；但明确要求**不集成进 ClaudeCodeUI**（LiveKit 的模型/依赖绝不可进入生产运行环境或构建）。

### 用户授权决定（本轮追加，2026-10-11，可审计记录）

人 yale 在本次对话中明确确认：「我们计划执行的 LiveKit v1-mini 验证符合 LiveKit 许可，无需额外授权」，并指示据此解除本任务原先「需人本人联系 LiveKit 申请书面授权」的前置门槛，立即推进实测。记录如下，供 artifact 与后续审计引用：

- **决定时间**：2026-10-11（本轮对话）。
- **决定人**：人 yale（本仓库操作者/决策者）。
- **决定内容**：计划执行的测试方式——在隔离的 `livekit-agents` 官方 SDK 环境里，本地 CPU 推理 `inference.TurnDetector(version="v1-mini")`（或官方 `eot-bench` 工具），对本任务的音频样本集跑对照测量——判定为符合 LiveKit 许可，不需要再走「联系 LiveKit 官方申请书面授权」这条路径。
- **决定范围**：仅覆盖"按上述测试方式在隔离 benchmark 环境里实测 v1-mini"这一件事；**不**授权任何形式的生产集成、再分发 LiveKit 代码/权重、或超出本任务 Touches 范围的其它用途。
- **仍然硬性生效的边界**（本决定不改变）：LiveKit 的任何代码/依赖/权重结构上不得进入 ClaudeCodeUI 的生产运行环境或构建（见下方「边界 / 不做」与 AC8 的机械证据要求）；模型版本固定为 `v1-mini`（本地 CPU 推理变体），环境为本任务新增的隔离 sandbox（见 Touches 的 `livekit-sandbox/` 目录），版本/环境细节必须被 AC4 的 artifact 记录下来，不能只有决定本身没有可核实的执行细节。
- **对任务执行的影响**：worker 不需要再对 LiveKit 这一项走"重新核实许可证→若不确定→停下来要求人联系官方"的流程；直接按下方更新后的 AC4 搭建隔离环境并执行真实推理。若遇到的是**非许可证原因**的技术性障碍（环境/依赖/运行时报错），仍要如实记录为技术阻塞，不得混同为许可证阻塞,也不得谎称已测。

### 本会话已完成的在线核实（供实现时引用并重新验证，不得假设仍然成立就不查）

- **LiveKit 合法测试路线（新发现）**：官方 `livekit-agents` Python SDK（≥1.6.1）内置 v1-mini EOT 模型，纯本地 CPU 推理（ONNXRuntime CPUExecutionProvider），**不需要 LiveKit Cloud 账号**，通过 `inference.TurnDetector(version="v1-mini")` 在真实 `AgentSession` 里加载——这是官方 SDK 的真实调用路径，不是本仓自己模拟的 standalone 脚本，字面满足 Section 1/3(i)「须配合 LiveKit Agents 框架使用」的条件。来源：https://docs.livekit.io/agents/logic/turns/turn-detector/
- **LiveKit 官方自己维护一个对照 benchmark 仓库**：https://github.com/livekit/eot-bench（"LiveKit End-of-Turn Benchmark"），其中有一条已合并的 PR 把第三方开源模型（p99lab 的 turn-1/turn-1-mini）加入做横向对比。这是对 P0.5 保守解读 Section 3(ii)（禁止用其材料/输出「改进或另行开发非 LiveKit 模型」）的有力反证——LiveKit 自己公开拿自家模型和第三方竞品对照，与「禁止第三方做同类对照评测」的解读自相矛盾。人 yale 据此与上述其它判断已作出本轮的授权决定（见上一节），本任务不再要求重新论证这一点，但仍需在 artifact 里记录当前许可证原文的抓取时间与版本号，作为审计记录的一部分。
- **真实语音数据集候选**（许可证为搜索结果摘要，执行时必须读到一手 LICENSE 原文才能采信）：Mozilla Common Voice（HF 镜像标 CC0-1.0，含 zh-CN/en，体量大但可用 HuggingFace datasets-server 的 rows API 按需抽取少量样本而不必整包下载）；THCHS-30（OpenSLR SLR18 标 Apache-2.0，但原始 CSLT 说明写「仅限学术用户完全免费」，两者口径不一致，需读到 OpenSLR 实际分发的 LICENSE 文件为准，不能只信网页摘要）；LibriSpeech（常见认知是 CC BY 4.0，需到 openslr.org/12/ 核实原文，不得凭记忆采信）。

### 边界 / 不做

- ⛔ 不集成进 ClaudeCodeUI 生产运行环境或构建：LiveKit 的任何 Python 包、模型权重、`livekit-agents`/`eot-bench` 相关依赖只能活在一个独立的、`package.json`/`server/package.json`/任何构建或 CI 配置**都不引用**的 sandbox 目录里（例如 `experiments/voice-turn-detection-compare/livekit-sandbox/`，自带 `requirements.txt`/venv），结构上不可能被应用构建图拉入；AC 必须包含一条机械证据（grep/依赖图检查）证明这一点，不能只是口头承诺。
- ⛔ 不得把未测写成已测：LiveKit 的许可证门槛已由人 yale 本轮决定解除（见上方授权决定小节），但**技术执行**仍必须是真实本地推理读数，不是估算或抄第三方数字；遇到非许可证原因的技术障碍要如实记录，不得谎称已测。
- ⛔ 不得编造或冒充真实人声：新增真实音频必须来自确认许可证的公开数据集或已获授权素材；不能合法重新分发的素材只保留来源链接与获取脚本，不下载/不上传进仓库；达不到 20–50 条目标就如实报告缺口，不得硬凑数字或谎称来源。
- ⛔ 非实时 qwen 新增真实付费调用总预算 ≤ ¥0.05（含本任务范围内的调用，不含 P0/P0.5 已花的 ¥0.021549，分别记账），超支即中止并记录，需另行获批才能继续。
- ⛔ 不改默认 Live Voice 生产链路；`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。
- ⛔ MaAI（中文权重 CC-BY-NC-ND-4.0）与 Vogent（权重 HF gated，需人本人登录/接受条款）P0.5 已有明确结论，本任务不重新解禁，除非人 yale 本人已完成登录/接受条款（本任务不得代为操作）——本次授权决定**只**覆盖 LiveKit，不延伸到 MaAI/Vogent。

## Plan

1. **数据集候选核实**：对 Common Voice（zh-CN/en 子集）、THCHS-30、LibriSpeech 逐一读取一手 LICENSE/条款原文（不是摘要），记录 SPDX、是否允许本用途（产品内部评测）、是否允许重新分发个别样本文件；凡不能确认允许重新分发的，只记来源 URL + 抽取脚本，不落盘音频文件本身。
2. **真实样本抽取与标注**：用 HuggingFace datasets-server rows API 或等价轻量方式，从许可证清晰的数据集抽取若干条 zh/en 真实语音（不需要整包下载）；人工（本任务内，不外包）标注每条候选停顿点的 END/CONTINUE/CORRECTION/HOLD 真值；因技术术语、中英混杂、自我纠正、执行期间继续讲话这些场景在任何公开语料里都不天然存在，这些场景维持用已有/新增的明确标注 `synthetic:true` 的 TTS 补足，不伪造成真实人声。
3. **manifest 升版**：`experiments/voice-turn-detection-compare/manifest.json` 升级为 versioned dataset manifest（每条记录来源数据集/URL、许可证 SPDX、真实/合成、说话人标识、采样率、原始/重采样格式、起止时间戳、获取脚本路径）；无法达到 20–50 条时在 manifest 顶层字段里写清楚实际数量与原因。
4. **Smart Turn 编译特征提取**：引入一个编译的音频特征提取路径（如 WASM 或原生扩展的 mel/FFT 实现，而不是现有 JS 朴素 DFT），先对同一段音频产出的特征与现有 JS 实现、P0.5 的 numpy oracle 三方比较数值等价（阈内误差），再在新 manifest 上重测 warm/cold 延迟。
5. **MaAI/Vogent 复核**：按 P0.5 结论直接继承（不重跑许可证判断），除非发现新证据；仅更新到新 manifest 的候选点数量口径。
6. **LiveKit 真实框架内实测**（本轮授权后不再有条件分支）：重新抓取当前 LiveKit Model License 原文并记录抓取时间/版本，作为审计记录（不是用来重新论证是否可测——人 yale 已就此作出决定）；直接搭建隔离 Python 环境（独立 venv/sandbox，`requirements.txt` 固定版本，机械证明不被任何构建/CI 配置引用），用官方 SDK 的 `inference.TurnDetector(version="v1-mini")`（或官方 `eot-bench` 工具本身）对同一份新 manifest 跑真实推理，产出与组 A/B 同口径的六类读数；若遇到非许可证原因的技术障碍（环境/依赖/运行时报错）才记录为技术性阻塞并说明，不得以许可证为由中止。
7. **非实时 Qwen vs Realtime 工具选择对照**：同一批真实音频（含真实来源的样本），分别用非实时 `qwen3.8-omni-flash`（`tool_choice=auto` 与强制）与既有 Realtime 路径跑同一组请求，比较语义工具选择是否正确、参数准确性、漏调用/错误调用次数、延迟、`usage`；真实花费记账，上限 ¥0.05（本任务范围内，与 P0/P0.5 分别列示）。
8. **指标与置信区间**：误截断率、漏端点率、端点延迟 p50/p90、CPU/RAM、Action Commit 误执行，逐项给出分母；样本量仍不足 20 条时用 Wilson 区间而不是裸比率；在 caveats 里写明「不同数据集（TTS / Common Voice / THCHS-30 等）之间不可直接比较」，并复核各模型实际用的采样率/窗口/特征提取协议是否与 SPEC 记录一致。
9. **SPEC 与 Go/No-Go 更新**：在现有表格基础上新增本轮读数（不删除 P0/P0.5 行），门槛沿用已写死的数值。

## AC

- [ ] AC1 数据集许可证核实：至少 2 个候选数据集（建议 Common Voice + THCHS-30/LibriSpeech 之一）的一手 LICENSE 原文已读并记入 artifact，SPDX + 是否允许本用途 + 是否允许重分发单条样本均有结论，不采信网页摘要。
- [ ] AC2 真实样本抽取：至少新增若干条真实人声候选点（如抽取受阻，必须量化说明受阻原因——网络/格式/授权——而不是空手而归不解释）；manifest 对每条真实样本记录来源/许可证/说话人标识/采样率/格式/时间戳/获取脚本，达不到 20–50 条目标时顶层字段如实注明实际数量与原因。
- [ ] AC3 Smart Turn 编译特征提取：新特征提取路径与现有 JS 实现、P0.5 numpy oracle 三方数值比较在阈内一致（记录具体误差），随后给出 warm/cold 延迟新读数；若编译路径本身引入新误差，必须如实报告而非隐藏。
- [ ] AC4 LiveKit（本轮由人 yale 明确授权解除许可证前置门槛，见「用户授权决定」小节）：许可证原文重新抓取的时间戳记入 artifact（作为审计记录，不是用来决定是否可测）；**直接**搭建隔离 Python 环境（独立 venv/sandbox，固定版本 `requirements.txt`，机械证明不被任何构建/CI 配置引用，如 `grep -r livekit package.json server/package.json` 等为空、sandbox 目录不在任何 tsconfig/webpack/vite 配置扫描范围），用官方 `livekit-agents` SDK 的 `inference.TurnDetector(version="v1-mini")`（或官方 `eot-bench` 工具）对同一份新 manifest 跑真实本地 CPU 推理，产出误截断率/漏端点率/延迟p50p90/CPU/RAM 六类读数；artifact 必须记录模型版本（`v1-mini`）、SDK 版本号、环境描述（可复现）、本次授权决定的引用（指回「用户授权决定」小节的时间/决定人/决定内容）。若因非许可证原因（环境/依赖/运行时故障）仍无法产出读数，必须明确记录为技术性阻塞（不是许可证阻塞）并说明具体原因，不得谎称已测。
- [ ] AC5 非实时 Qwen vs Realtime 对照：同一批真实音频下的 `tool_choice=auto` 与强制对照、语义/参数准确性、漏调用/错误调用计数、延迟、usage 均有真实读数；真实花费 ≤ ¥0.05（本任务范围，与既有 ¥0.021549 分别列示），超支即中止并记录。
- [ ] AC6 指标与置信区间：Wilson 或等价区间计算存在于 artifact；caveats 明确写「不同数据集不可直接比较」；各模型采样率/窗口/特征提取协议逐一复核并记录是否与 SPEC 一致。
- [ ] AC7 SPEC/Go-No-Go 更新：新读数并入既有表格，门槛不变,判定基于实测。
- [ ] AC8 生产面零改动：`git diff develop` 对三个生产路径文件/目录为空；额外证明 sandbox 目录不出现在任何依赖/构建配置里。
- [ ] AC9 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

数据集许可证结论必须基于真实读到的 LICENSE 原文；真实样本的来源/权利/说话人标识/格式/时间戳必须真实可核；Smart Turn 编译特征提取的数值等价与延迟数字必须来自真实运行；LiveKit 的许可证门槛已由人 yale 本轮明确授权解除（见「用户授权决定」小节的可审计记录：决定时间/决定人/决定内容/决定范围），本任务必须据此产出真实本地推理读数（而不是继续走授权升级路径），模型版本/SDK版本/环境描述必须被记录、可复现；若因非许可证原因仍跑不起来，必须是有证据的技术性阻塞说明，不是假设。非实时 Qwen 对照必须是真实付费调用，花费真实且在预算内。本任务零改动生产默认 Live Voice 链路，LiveKit 相关代码/依赖/权重结构上不可能进入应用构建。

## Touches

- docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md
- experiments/voice-turn-detection-compare/manifest.json
- experiments/voice-turn-detection-compare/dataset-sources.json (new)
- experiments/voice-turn-detection-compare/adapters/smart-turn-v3.mts
- experiments/voice-turn-detection-compare/adapters/smart-turn-compiled-features.mts (new)
- experiments/voice-turn-detection-compare/adapters/livekit-v1-mini.mts
- experiments/voice-turn-detection-compare/livekit-sandbox/ (new)（isolated Python env, not referenced by any build config）
- experiments/voice-turn-detection-compare/run.mts
- experiments/voice-turn-detection-compare/RESULT.json
- scripts/voice-turn-detection-compare.mjs
- tasks/gap-voice-turn-detection-p0-6-dataset-benchmark.md
---
id: gap-voice-turn-detection-p0-7-unified-realtime-benchmark
title: 低成本 Turn Detection 对照 P0.7：统一 replay 基准下的 Qwen Realtime 流式事件时间轴测量，采纳
  eot-bench 协议与阈值-延迟 Pareto
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（方法学缺口，本轮被用户明确指出）

`gap-voice-turn-detection-pluggable-comparison-p0`→`...-p0-5-expansion`→`...-p0-6-dataset-benchmark`（均 done）在同一份 manifest（44 样本/73 候选点，含 32 条真实人声）上测了 VAD / Smart Turn（编译版）/ LiveKit v1-mini，但组 D（Qwen Realtime，`qwen3.8-omni-flash-realtime`）**从未在这份 manifest 上测过**——三轮都只是引用旧任务 `gap-voice-realtime-turn-detection-configurable-comparison` 的 `RESULT.json`，那份数据用的是**不同的语料、不同的时间点，且只有 3 档各一条连接的单样本对照**，不是在同一批真实音频、同一候选停顿点、同一标注上跑的。人 yale 明确拒绝这种"新旧数据拼表"的做法，要求本任务把 Qwen Realtime 真正搬到同一基准上。

另一个结构性缺口：Realtime 的语义 EOT/commit 不是像 VAD/Smart Turn/LiveKit 那样的单次离线分类——它是一个**会话内的事件**（上游 VAD 判定 → `input_audio_buffer.commit` → `response.create` → 工具调用），过去的测量把"模型推理耗时"和"用户从说完话到系统真正响应/调用工具"的墙钟时间混在一起，前者对 Realtime 而言还包含上游 `silence_duration_ms` 这个**配置出来的强制等待**，不是模型的计算时间。

### 采纳的评测协议：LiveKit 官方 `eot-bench`（Apache-2.0，本会话已查，执行时需重新核实版本未变）

- 仓库：https://github.com/livekit/eot-bench；数据：https://huggingface.co/datasets/livekit/eot-bench-data（Apache-2.0，14 语言真实人机对话，每行一个完整用户轮次，**每个 ≥100ms 的静音都标注**，最后一个标 `eot`、之前的标 `hold`——与本仓的 END/CONTINUE 标注体系对应，只是命名不同）。
- 协议：支持 BATCH adapter（`adapter_id`/`score_point`/`predict_batch(batch)` → 每点一个 `p_eot`，适合 VAD/Smart Turn/LiveKit 这类同步决策模型）与 **STREAMING adapter**（`adapter_id`/`concurrency`/`async predict_turn(row, *, inference_interval)` → 适合 Qwen Realtime 这类基于会话、事件驱动的模型）；因果评分（默认 `--inference-interval 0.1s`、`--transcript-lag 0.5s`），对 `threshold`/`action_delay`/`timeout` 三个旋钮做策略扫描，报告固定延迟/误截断预算下的操作点**与 Pareto 前沿**——这正是用户要求的"阈值延迟-误截断 Pareto"，不要重新发明，直接采纳或精确复刻其评分语义。
- 它已经用 STREAMING adapter 跑过 **OpenAI GPT Realtime 2**（一个可比的 realtime 语音模型）——这是给 Qwen Realtime 写 streaming adapter 的直接模板。
- 执行时必须：(a) 重新核实当前 LICENSE 原文（Apache-2.0，不假设未变）；(b) 核实数据集的许可证、切分版本号、本任务使用到的任何模型 pin（如 VAP checkpoint commit）是否仍是本会话记录的那些；(c) 审查后决定是直接调用 eot-bench 的 harness 代码（优先）还是只精确复刻其评分/sweep 语义到本仓已有脚手架（若直接依赖在隔离之外引入风险）。

### 边界 / 不做

- ⛔ 不得把"缺少流输出"推断为"模型出错"：捕获/重试逻辑必须明确区分「超时未收到任何响应」（inconclusive，记为未决）与「模型显式报错/拒绝」（真实错误），两者不能混为一谈。
- ⛔ 不得用新旧数据拼表：Qwen Realtime 这次必须在与 A/B/C 三组**完全相同**的音频样本与候选停顿点上测，不接受引用旧 `RESULT.json`。
- ⛔ 不集成 LiveKit 进 ClaudeCodeUI 生产环境或构建（沿用 P0.6 的隔离要求，不重新开放这个问题）；本任务若涉及 LiveKit（例如对齐已测的组 C 读数），只能在已有隔离 sandbox 内，不得新增生产集成路径。
- ⛔ 不改默认 Live Voice 生产链路；`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。
- ⛔ Qwen Realtime 新增真实上游调用预算 ≤ ¥0.05（与 P0/P0.5/P0.6 的既有花费分别记账，不合并计入同一个上限），超支即中止并记录，需另行获批才能继续——执行前必须先把预算上限写入 artifact。
- ⛔ 必须遵守既有真实上游的会话/用量限额（复用既有 `voice-realtime-dashscope-transport.ts` 里记录过的限制认知，不新造一套不考虑限额的压测）。

## Plan

1. **子集选择**：从现有 44 样本/73 候选点中，筛出"可再现（有抓取脚本/合成脚本能重跑，不是已丢失的一次性录音）且许可允许本用途"的子集，作为本轮四组统一 replay 的基准；记录筛选前后的样本数与候选点数、被排除的理由（不可再现 / 许可不明确）。
2. **eot-bench 协议核实与采纳**：重新读取 eot-bench 仓库与数据集的许可证原文、当前版本/commit pin；决定直接依赖其 harness 还是复刻评分语义，并记录决定理由。
3. **统一 adapter 层**：为 VAD（现有 StreamingVad）、Smart Turn（P0.6 的编译特征提取版）、LiveKit v1-mini（P0.6 的隔离 sandbox）各包一层 eot-bench 风格的 BATCH adapter（`score_point`/`predict_batch`），确保三者走同一套评分/阈值扫描代码，不是三套各写一遍的平行实现。
4. **Qwen Realtime STREAMING adapter**：实现 `async predict_turn(row, *, inference_interval)`，真实发起 DashScope Realtime WebSocket 会话，流式送入候选点对应音频（不是整段一次性 encode），记录完整事件时间轴（音频帧送达时刻 → 上游 `input_audio_buffer.speech_stopped`/VAD 判定时刻 → `input_audio_buffer.commit` 时刻 → `response.create` 时刻 → 首个响应 token / `session_send` 工具调用时刻），每个候选点用**独立会话**（会话重置），遵守既有用量限额；明确拆分「模型推理耗时」（收到完整音频后到产出响应的计算时间）与「用户等待端点时长」（候选点标注的静音起点到系统真正响应/调用工具的墙钟时间，后者必然包含上游 `silence_duration_ms` 这个配置出来的强制等待）两个数字，不得把二者混报成一个"延迟"。
5. **阈值-延迟 Pareto**：对 Qwen Realtime 的 `silence_duration_ms`（至少 400/800 两档，若预算允许再加 `semantic_vad`）与其它三组各自的可调阈值，按 eot-bench 的 sweep 语义产出误截断率 vs 端点延迟的操作点，画出/记录 Pareto 前沿（不要求真的出图，数值表即可）。
6. **Action Commit 误执行**：延续 P0.6 的正/反指令设计（真实人声里既要有"应该触发动作"的明确指令样本，也要有"不应触发"的陈述/朗读样本），对四组都算一个"若按此检测器的 END 信号直接触发动作"的模拟误执行率（VAD/Smart Turn/LiveKit 本身不做函调决策，但可以模拟"END 即触发"这个假设策略，使四组在这一指标上可比较）；Qwen Realtime 用其真实的函调结果（沿用 P0.6 `tool_choice=auto` 的真实读数，不重复花钱，除非该样本未被 P0.6 覆盖）。
7. **指标汇总**：false cutoff / missed end / 端点延迟 p50/p90（区分推理时长与用户等待时长）/ CPU/RAM（Realtime 不适用，标 N/A 而不是编造）/ Action Commit 误执行，逐项给出分母与置信区间；在 caveats 里写明本轮子集相对 P0.6 全集的覆盖差异。
8. **SPEC/Go-No-Go 更新**：把四组统一基准的读数并入现有表格（保留 P0–P0.6 历史行并标注"旧口径，非同基准"），门槛沿用已写死的数值，不因为统一基准后数字变化而放宽判据。

## AC

- [x] AC1 子集选择：记录可再现且许可允许的统一 replay 子集（样本数/候选点数），被排除样本与理由入 artifact。
- [x] AC2 eot-bench 协议核实：当前 LICENSE 原文、数据集许可证、相关模型/checkpoint 版本 pin 的重新核实记录（时间戳 + 来源），以及"直接依赖 harness 还是复刻评分语义"的决定与理由。
- [x] AC3 统一 BATCH adapter：VAD/Smart Turn（编译版）/LiveKit v1-mini 三组通过同一套 eot-bench 风格 `score_point`/`predict_batch` adapter 跑出读数（不是三套独立实现），读数与 P0.6 对应子集的历史读数做一致性抽查（同一候选点同一检测器的结果应一致，除非算法本身有版本变化并写明原因）。
- [x] AC4 Qwen Realtime STREAMING adapter：真实 DashScope WebSocket 流式会话，每候选点独立会话（会话重置），完整事件时间轴记录（帧送达/VAD判定/commit/response.create/首响应或函调时刻），明确区分「模型推理耗时」与「用户等待端点时长」两个独立数字；对"收到响应超时"与"模型显式报错"有明确不同的记录状态，不得混同或把超时报成错误。
- [x] AC5 阈值-延迟 Pareto：至少覆盖 Qwen Realtime 的 2 档 `silence_duration_ms`（+若预算允许的 `semantic_vad`）与其它三组各自阈值的误截断率-延迟操作点表，产出可独立复推的数值（不要求出图）。
- [x] AC6 Action Commit 误执行：四组在"若 END 信号直接触发动作"假设策略下的模拟误执行率可比较；Qwen Realtime 的真实函调误执行率（复用或扩展 P0.6 的正反指令样本）。
- [x] AC7 指标与置信区间：false cutoff/missed end/端点延迟p50p90（拆分两类耗时）/CPU-RAM（Realtime标N/A）/Action Commit误执行均有分母与区间；caveats 写明本轮子集对 P0.6 全集的覆盖差异。
- [x] AC8 预算与会话规则：Qwen Realtime 新增真实调用预算 ≤¥0.05（执行前写入 artifact 的上限，与既有花费分开记账），遵守既有用量限额认知，超支即中止记录。
- [x] AC9 SPEC/Go-No-Go 更新：统一基准读数并入表格，历史行标注"旧口径"保留不删，门槛不变。
- [x] AC10 生产面零改动：`git diff develop` 对三个生产路径文件/目录为空；LiveKit 仍只在既有隔离 sandbox 内，无新增生产集成路径。
- [x] AC11 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

子集选择的可再现性/许可证结论必须基于真实核查（不是假设）；eot-bench 的许可证/版本 pin 必须基于本轮重新读到的原文；三个批量检测器必须真的跑通同一套 adapter 代码产出一致读数；Qwen Realtime 的事件时间轴必须来自真实 WebSocket 会话的真实时间戳，不是估算；「推理耗时」与「用户等待端点时长」必须是两个独立记录的数字；超时与显式错误必须有不同的记录状态；Pareto 操作点表必须来自真实多档运行，不是插值猜测；Action Commit 误执行的模拟策略与真实函调结果必须分别标注清楚哪个是模拟哪个是真实；预算必须先写死后执行，真实花费与上限都记入 artifact。本任务零改动生产默认 Live Voice 链路，LiveKit 不新增生产集成路径。

## Touches

- docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md
- experiments/voice-turn-detection-compare/manifest.json
- experiments/voice-turn-detection-compare/eot-bench-adapters/ (new)
- experiments/voice-turn-detection-compare/eot-bench-adapters/vad-batch-adapter.mts (new)
- experiments/voice-turn-detection-compare/eot-bench-adapters/smart-turn-batch-adapter.mts (new)
- experiments/voice-turn-detection-compare/eot-bench-adapters/livekit-batch-adapter.mts (new)
- experiments/voice-turn-detection-compare/eot-bench-adapters/qwen-realtime-streaming-adapter.mts (new)
- experiments/voice-turn-detection-compare/run.mts
- experiments/voice-turn-detection-compare/RESULT.json
- scripts/voice-turn-detection-compare.mjs
- tasks/gap-voice-turn-detection-p0-7-unified-realtime-benchmark.md

## 验证记录

- 2026-10-11 本轮（第 2 次 exit-not-landed 复跑）：上一轮 fan-in suite 单文件红于 `server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts` 的 (2b)「用户 settings 为 remoteControlAtStartup:false ⇒ 同样启动成功」——报错 `Claude Code process exited with code 1`，即真实 `claude` 子进程在并发套件负载下 exit 1。该文件不在本任务 `## Touches`/diff 内，且非 `@load-sensitive-annotated`。
- 已 `git merge develop`（合入当轮 develop，merge commit 已提交）后在既有工作树内单独重跑该文件：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts` ⇒ tests 8 / pass 8 / fail 0，duration_ms ≈ 8851。结论：并发负载下的环境毛刺，不是本任务代码缺陷，无需改代码。
- 更早一轮 suite 红于 `server/modules/oauth/tests/oauth-dcr.test.ts`，同类并发临时文件竞态毛刺（对照记忆 `oauth-dcr-switch-count-walk-races-sibling-falsify-temp`）。
- 工作树状态：无未合并路径（`git diff --diff-filter=U` 为空），11/11 AC 勾选保持，`task_check` ok:true。
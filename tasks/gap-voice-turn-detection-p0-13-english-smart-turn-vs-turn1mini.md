---
id: gap-voice-turn-detection-p0-13-english-smart-turn-vs-turn1mini
title: Live Voice P0.13：英语样本上 Smart Turn v3.2 与 p99lab/turn-1-mini 原版统一
  benchmark（锁定 checkpoint、正确预处理、按 speaker/session 分组 paired replay）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 本会话核实）

- `...-p0-9-staged-cheap-feasibility`（done）：turn-1-mini 在本环境**未安装**（机械探测无包/无模块/无 checkout），未产出任何读数；Smart Turn v3.2 在 44 样本/73 候选点上最佳 F1 点 cutoff 0.103448（3/29）/missed 0.022727（1/44），卡在 0.10 预算外。该语料是中英混合，含 TTS 合成与 THCHS-30 中文，**不是**英语专项评测。
- `...-p0-11-finegrained-pareto-sweep`（在飞，8/8 AC 已勾，等 fan-in）：对 Smart Turn/LiveKit 做细化网格扫描，并只**探测** turn-1-mini 是否已安装，不安装、不评测它。⛔ 本任务不得触碰其 worktree 或 `finegrained-sweep/` 目录；若执行时它已落地 develop，**优先读取其 `finegrained-sweep/RESULT.json` 的 Smart Turn 细化读数**作为对照，不重复扫描同一网格。
- turn-1-mini 官方模型卡（https://huggingface.co/p99lab/turn-1-mini，本会话抓取）：权重与代码 **Apache-2.0**（第三方致谢在 `NOTICE`）；5.26M 参数；输入 **16 kHz 单声道，必须先 4 kHz 低通**（模型卡原文 "The 4 kHz low-pass is required"，否则分布外；基准所用滤波 `p99turn.audio.bandlimit_4k`，v1.2.0 起流式路径因果地施加同一滤波），80-bin log-mel、10 ms hop；**160 ms 步长 + 缓存注意力状态**的流式推理（模型卡称流式与离线前向一致到 1e-4）；ONNX 图内含低通与 log-mel；**仅英语**（未测其它语言、不声称多语）；安装 `pip install "p99turn[onnx] @ https://huggingface.co/p99lab/turn-1-mini/resolve/main/dist/p99turn-1.2.3-py3-none-any.whl"`，推理 `from p99turn.onnx_stream import Turn1MiniOnnx; Turn1MiniOnnx.from_pretrained(); turn.push(chunk)` → 每 20 ms 帧一个 P(end of turn)；模型卡报告其在 eot-bench 英语 validation split（400 turns、705 scored pauses）上 false cut-off@600ms 9.6%、5% 误截断下延迟 849 ms（**这是对方自报数字，本任务需自测，不得照抄**）。模型卡页面**未显示 repo commit SHA**，需在执行时经 HF API 锁定。
- eot-bench 数据（`livekit/eot-bench-data`）：P0.7 已核实 HF API `license:cc-by-4.0`、revision `ca9d98a9686b920a2d8c9eb984224ba9be74e4dd`；英语为其 14 语言之一；每个 ≥100 ms 停顿标注，末停顿 `eot`、其余 `hold`。

### 目标

在**纯英语**、**同一停顿标签**上，把 Smart Turn v3.2（复用既有编译特征提取 adapter，正确 Whisper log-mel 预处理）与 turn-1-mini（官方原版，无 fine-tune，官方流式路径含 4 kHz 低通）放在**同一 actionDelay/timeout 策略轴**上统一评测，回答"turn-1-mini 在英语上能否同时满足 false cutoff≤10% 与 missed END≤10%"。英语过门槛后才评估中文 fine-tune（另立任务）。

### 边界 / 不做

- ⛔ **原版、无 fine-tune**：两模型均用官方发布权重；不训练、不校准权重；阈值扫描不是 fine-tune。
- ⛔ **锁定版本**：执行前经 HF API 取得并写入 artifact：`p99lab/turn-1-mini` 的 repo commit SHA、所用 ONNX 文件 sha256、`p99turn` wheel 版本与 sha256；Smart Turn v3.2 所用 checkpoint 的来源 repo、commit SHA、ONNX 文件 sha256。取不到则如实记录"未锁定"并说明原因，不得假装已锁定。
- ⛔ **预处理正确性**：turn-1-mini 必须走官方 `p99turn` 路径（含 4 kHz 低通、160 ms 流式缓存）；不得用自写前端绕过低通。需做一项自检：同一段音频的官方流式输出与离线前向一致（模型卡称 ≤1e-4），记录实测差值。Smart Turn 复用 P0.6 已三方数值校验过的编译 mel 前端（16 kHz、8 s 窗口），不另写一套。
- ⛔ **不得填充模拟输出**：任一模型下载/依赖安装/加载失败，必须记录真实错误信息、环境（OS、Python、onnxruntime 版本）并把该模型行标为 `load-failed`/`not-run`，读数留空；不得用插值、对方自报数字或其它模型读数顶替。
- ⛔ **隔离**：Python 依赖装在本任务目录下独立 venv（自带 `requirements.txt` 锁版本），不进入 `package.json`/`server/package.json`/任何构建或 CI 配置；需机械证据（grep 构建配置无相关标记）。
- ⛔ **不付费 API 调用、不生产集成**：零 DashScope/任何付费上游调用；`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。
- ⛔ **不轻率合并全部语料**：本仓既有英语真实样本（P0.6 的 LibriSpeech，CC-BY-4.0）与 eot-bench 英语子集分别报告，再给合并读数；合并前按 speaker/session 分组，分组键缺失要如实说明。
- ⛔ 不修改既有共用 adapter 与 P0.6–P0.12 artifact；不触碰 P0.11/P0.12 的 worktree 与目录。
- ⛔ 阈值扫描选操作点时必须过滤 `threshold>0`（eot-bench 帕累托里每组都有 threshold=0 的退化行，不能当模型读数）。
- ⛔ 长跑命令显式传 timeout（后台 Bash 默认 10 分钟会被杀）。

## Plan

1. **环境与版本锁定**：在 `english-smart-turn-vs-turn1mini/` 下建独立 venv；经 HF API 取 `p99lab/turn-1-mini` commit SHA、Smart Turn v3.2 checkpoint 的 repo commit SHA；安装 `p99turn[onnx]==1.2.3`；记录所有文件 sha256、onnxruntime/Python 版本、license 原文抓取时间。加载失败如实记录。
2. **预处理自检**：turn-1-mini 官方流式（160 ms 推送）vs 离线前向在同一段英语音频上的最大差值；Smart Turn 编译前端沿用 P0.6 校验结论并做一次抽样复核。
3. **英语语料**：(a) 本仓既有 LibriSpeech 英语真实样本及其已有停顿标注；(b) 从 `livekit/eot-bench-data`（CC-BY-4.0，锁定 revision）合法下载英语子集的一个有界样本（≥50 个 turn 或全部英语 validation，视下载可行性），保留其原 `eot`/`hold` 标签；记录 speaker/session 分组键（数据集若无 speaker 字段，用 turn id/会话 id 并说明）。音频是否入库遵守许可证（CC-BY-4.0 允许但须署名；大文件改为记录获取脚本与 sha256）。
4. **统一回放**：两模型在**同一**候选停顿点上产出逐帧/逐点概率；用与 P0.7/P0.9 相同的 eot-bench 策略轴（threshold × actionDelay × timeout）扫描，产出各自帕累托前沿。
5. **指标**：false cutoff k/n、missed END k/n（均带 Wilson 95% 区间）、EOT 等待 p50/p90/max（从静音起点到判定 END）——与**推理 CPU 时间**（每次推理的 CPU ms，含特征提取）分开报告，不混为一个"延迟"。按语料来源（LibriSpeech / eot-bench）分别报告，再报合并；按 speaker/session 分组给出组级分布，检查是否被少数说话人主导。
6. **门槛**：执行前写死"英语门槛 = false cutoff≤10% 且 missed END≤10%（点估计），置信区间另列"；判定每个模型在同一策略轴上是否存在同时满足的操作点；过门槛才在结论里写"可另立任务评估中文 fine-tune"，不过门槛写清哪条不过。

## AC

- [x] AC1 版本锁定与环境记录：artifact 记录 turn-1-mini repo commit SHA、ONNX sha256、`p99turn` 版本与 wheel sha256、Smart Turn checkpoint 来源/commit/sha256、Python/onnxruntime/OS 版本、两模型 license 原文抓取时间；任何一项拿不到都标"未锁定"及原因。
- [x] AC2 真实加载：每个模型记录真实加载结果（成功/失败 + 原始错误文本）；失败的模型读数为空并标 `load-failed`，无任何模拟/插值/照抄自报数字的读数。
- [x] AC3 预处理自检：turn-1-mini 官方流式（160 ms，含 4 kHz 低通）与离线前向最大差值实测记录；确认未绕过低通（代码只经 `p99turn` 官方入口）。
- [x] AC4 英语语料与分组：LibriSpeech 子集与 eot-bench 英语子集分别列出 turn 数/停顿点数（eot 与 hold 分母）、来源 revision、license、speaker/session 分组键；未合并前先分别报告。
- [x] AC5 统一策略轴：两模型在同一候选点、同一 threshold×actionDelay×timeout 网格上扫描，帕累托前沿并列（已过滤 threshold=0 退化行）；若 P0.11 已落地，引用其 Smart Turn 细化读数作对照。
- [x] AC6 指标：每模型×每语料来源×合并给出 false cutoff k/n、missed END k/n（Wilson 95%）、EOT 等待 p50/p90/max；推理 CPU 时间（p50/p90，含特征提取）单列，不与等待合并。
- [x] AC7 门槛判定：执行前写死门槛；每模型明确"是否存在同时满足 false cutoff≤10% 且 missed END≤10% 的操作点"及该点数字与区间；结论写明是否建议另立中文 fine-tune 任务。
- [x] AC8 隔离与零付费：Python 环境只在本任务目录；grep 证明 `package.json`/`server/package.json`/tsconfig/vite/`scripts/test.sh` 无相关标记；零付费上游调用（grep 无 DashScope/外部推理 API）；生产三路径 diff 为空。
- [x] AC9 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

至少一个模型在真实英语音频上完成真实本地推理并产出带分母与置信区间的读数；turn-1-mini 若能加载，必须是官方原版经官方流式入口（含 4 kHz 低通）的真实输出；若任一模型加载失败，有原始错误与环境记录且读数为空；版本/许可证/数据 revision 可审计；零付费调用、零生产改动。

## Touches

- experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/requirements.txt (new)
- experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/fetch-eot-bench-english.py (new)
- experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/run-turn1mini.py (new)
- experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/run-benchmark.mts (new)
- experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/RESULT.json (new)
- experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/CONCLUSION.md (new)
- experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/.gitignore (new)
- tasks/gap-voice-turn-detection-p0-13-english-smart-turn-vs-turn1mini.md
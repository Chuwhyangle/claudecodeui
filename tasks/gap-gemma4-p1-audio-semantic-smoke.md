---
id: gap-gemma4-p1-audio-semantic-smoke
title: Gemma 4 P1：独立音频语义模型 smoke 验证（E2B-it/E4B-it，CPU 可行性 + GPU 部署脚本，zh/en
  动态上下文，零付费 API）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 本会话在线核实）

人 yale 正式授权启动 Gemma 4 P1 独立音频语义模型验证，与现有 `gap-voice-turn-detection-*` 系列（P0–P0.13，轮次检测/端点判定）不同——Gemma 4 是一个**独立的音频语义理解候选**，不是轮次检测器。本会话抓取 Google 官方 model card（`ai.google.dev/gemma/docs/core/model_card_4`）核实：

- **音频能力**：E2B、E4B、12B Unified 三档支持音频输入；E2B/E4B 用约 300M 参数的音频编码器，12B Unified 把音频波形通过轻量线性层直接投影进 LLM embedding 空间（细节未在页面说明，需任务内进一步核实）。**26B A4B 与 31B 不支持音频**（仅文本+图像）。
- **音频限制**：页面原文"Audio supports a maximum length of 30 seconds"——与人 yale 的 30 秒限制陈述一致。
- **输出**：仅文本。**License**：Apache 2.0（链接 `ai.google.dev/gemma/apache_2`，页面未明确谈商用条款，需读许可证原文）。**Context window**：E2B/E4B 为 128K。
- **未在该页面说明、需任务内核实**：E2B-it/E4B-it 的具体 Hugging Face repo 路径与 commit/revision、音频采样率与编码细节、是否需要在 HF 接受许可证才能下载（访问门槛）、推理所需的 `transformers`/其它库版本、硬件需求（该页面只说面向"mobile and edge devices"，无 VRAM/CPU 具体数字）。
- **本机环境**（本会话已查）：**无 GPU**（`nvidia-smi` 不存在），128 核 CPU，246GB RAM（155GB 可用）。因此本任务只能做 CPU 可行性检查，不能冒充在 GPU 上跑通。

**去重**：检索 "Gemma"/"E2B"/"audio semantic" 均无命中；与正在执行的 `gap-voice-turn-detection-p0-13-english-smart-turn-vs-turn1mini`（worker pid 1007996，独立 worktree `claudecodeui-wt-p0-13`）主题不同、路径不同，本任务不得触碰其 worktree 或 `experiments/voice-turn-detection-compare/` 目录。

### 目标

在独立的 `experiments/gemma4-audio-semantic/` 路径下做一次 smoke 验证：核实模型可访问性与真实加载情况，在 CPU 上跑尽量小的真实推理（若 CPU 不可行则如实记录原因与所需资源，产出可复制的 GPU 部署脚本），用项目相关的中英文短音频+动态文本上下文（Quay/worktree/MCP 等项目词库）测语义理解，严格区分真实推理与任何占位/模拟输出。

### 边界 / 不做

- ⛔ **零付费 API 调用**：全程只用本地模型权重（HF 下载是一次性获取权重，不是按次计费的推理 API）；若需要 HF 访问令牌/接受许可证才能下载，如实记录这一步骤与结果，不得用任何第三方付费推理服务代替本地加载。
- ⛔ **不得填充模拟数据**：模型加载失败（环境/依赖/权限/硬件任一原因）必须保留原始错误文本、记录环境（OS/Python/库版本/硬件），该项读数留空并标 `load-failed`，不得编造推理结果、延迟或资源数字。
- ⛔ **不假装在外部 GPU 上跑通**：本机无 GPU；若做不到真实 GPU 推理，只产出"可在有 GPU 的机器上复制执行"的部署脚本与说明，并在 README/结论里明确标注"本次验证范围 = CPU 可行性检查，GPU 路径未实测"。
- ⛔ **不碰生产 Voice provider**：不修改 `server/modules/voice-realtime/` 或任何现有语音 provider 接线；不触发真实的 Claude Code / Codex 工具执行（任何从模型输出解析出的"工具调用意图"只记录、不执行、不投递到任何真实会话）。
- ⛔ **不得使用真实敏感项目数据发送给任何第三方 API**：动态文本上下文（项目词库）可以包含 Quay/worktree/MCP 等**公开术语/概念名词**作为语义测试材料，但不得包含真实用户数据、真实任务内容、真实密钥/路径等敏感信息；且本任务模型全程本地加载推理，不经第三方 API 转发任何内容。
- ⛔ 不碰 `gap-voice-turn-detection-p0-13-*` 的 worktree 或目录；本任务产出独立 artifact。
- ⛔ 不改默认 Live Voice 生产链路；`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。
- ⛔ 长跑命令（模型下载、CPU 推理）显式传 timeout；若权重下载体量大，评估是否可行，不行则如实记录"受限于下载体量/时间，未完成"而非卡住不报。

## Plan

1. **核实模型可访问性**：经 Hugging Face API/页面确认 `google/gemma-4-E2B-it`（及 E4B-it，视体量选其一或都尝试）的 repo 是否存在、revision/commit、是否需要接受许可证门槛、文件大小、所需 `transformers`（或其它推理库）最低版本；记录核实时间与来源 URL。许可证原文读一次（不是转述 blog）。
2. **独立隔离环境**：`experiments/gemma4-audio-semantic/` 下建独立 Python venv（`requirements.txt` 锁版本），不进入 `package.json`/`server/package.json`/任何构建或 CI 配置，机械证据（grep）证明隔离。
3. **CPU 可行性 smoke**：尝试在 CPU 上加载最小可行的音频能力变体并跑一次最小推理（短音频+短文本）；记录加载耗时、显存/内存占用、CPU 推理延迟。若因模型体量/算力在合理时间内不可行，如实记录卡在哪一步（下载/加载/推理）、需要的资源估计，不强行跑到底耗尽资源。
4. **GPU 部署脚本**：无论 CPU smoke 是否成功，产出一份"假设有 GPU 环境"的可复制部署脚本（依赖安装、模型加载、推理调用示例），明确标注未在真实 GPU 上验证过。
5. **语义测试样本**：构造若干条**项目相关、中英文**的短音频（≤30 秒，遵守 Gemma 4 的限制），配合动态文本上下文（如"当前 Quay 任务"、"当前 worktree 路径"、"MCP 工具列表"这类**项目概念性词库**，不含真实敏感数据）；跑通过模型的音频+文本联合输入，观察输出是否结合了上下文（例如识别出 "Quay"、"worktree"、"MCP" 这类项目专有名词，而不是把它们转写成通用词）。
6. **指标**：加载/推理成功率、有上下文 vs 无上下文的语义实体识别改善（对比两种输入）、识别到的语义实体列表、延迟 p50/p90/max（若样本数够）、资源占用（CPU 时间、内存峰值）；若模型加载失败则上述指标留空并说明。
7. **交付物**：`RESULT.json`（结构化读数）、`README.md`（如何复现，含 CPU smoke 与 GPU 部署两条路径）、已测试音频规格记录（采样率、时长、格式）、30 秒限制的提示。

## AC

- [ ] AC1 模型可访问性核实：E2B-it/E4B-it 的 HF repo 存在性、revision、许可证门槛、文件大小、所需库版本均有核实记录与来源 URL 和核实时间；许可证原文抓取记录（不是转述）。
- [ ] AC2 隔离环境：独立 venv + `requirements.txt`；机械证据（grep `package.json`/`server/package.json`/tsconfig/vite/`scripts/test.sh`）证明零污染生产依赖。
- [ ] AC3 CPU 可行性真实记录：真实尝试加载与推理，记录真实结果（成功即给出真实延迟/资源数字；失败则给出原始错误文本+环境记录+卡在哪一步），不得用插值/编造数字顶替任一结果。
- [ ] AC4 GPU 部署脚本：产出可复制脚本与说明，明确标注"未在真实 GPU 上验证"。
- [ ] AC5 中英文+动态上下文样本：至少各若干条中文、英文短音频（≤30s，记录采样率/时长/格式），配合不含敏感数据的项目词库上下文；有上下文/无上下文两组对照。
- [ ] AC6 真实推理与 mock 严格区分：artifact 对每条读数标注是否来自真实模型推理（含模型/权重标识）；任何未能真实推理的格留空并标注原因，不得标为"mock 验证通过"之类混淆表述。
- [ ] AC7 指标：成功率、语义实体识别结果、上下文改善对比、延迟 p50/p90/max（可行时）、资源占用，均为真实测得或明确留空。
- [ ] AC8 无生产接触：未触发任何真实 Claude Code/Codex 工具执行；未修改生产 Voice provider；`git diff develop` 对三个生产路径为空；未使用真实敏感项目数据；全程零付费第三方推理 API 调用（机械证据：grep 无除 HF 权重下载外的外部推理 API 调用）。
- [ ] AC9 交付物齐全：`RESULT.json`/`README.md`/音频规格记录/30 秒限制说明均存在且与实测结果一致。
- [ ] AC10 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

模型可访问性与许可证结论必须基于本任务真实核实的一手来源；CPU smoke 的成功或失败都必须是真实尝试的结果（不是预判结论）；GPU 部署脚本产出但明确未验证；所有指标要么真实测得要么明确留空并说明原因；全程零付费 API 调用、零生产改动、零真实敏感数据外发（本任务模型全程本地加载，无第三方 API 转发）。

## Touches

- experiments/gemma4-audio-semantic/requirements.txt (new)
- experiments/gemma4-audio-semantic/verify-access.py (new)
- experiments/gemma4-audio-semantic/cpu-smoke.py (new)
- experiments/gemma4-audio-semantic/gpu-deploy-example.sh (new)
- experiments/gemma4-audio-semantic/samples/ (new)
- experiments/gemma4-audio-semantic/RESULT.json (new)
- experiments/gemma4-audio-semantic/README.md (new)
- experiments/gemma4-audio-semantic/.gitignore (new)
- tasks/gap-gemma4-p1-audio-semantic-smoke.md
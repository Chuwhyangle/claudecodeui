---
id: gap-gemma4-p1-audio-semantic-smoke
title: Gemma 4 P1：Google 官方托管 API discovery——Gemini API
  实际模态探测（list_models/supportedGenerationMethods + 3-5s 音频真实调用），E2B/E4B 原生音频另立任务
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（重大修正，2026-10-11 本轮，替换本任务原先的本机本地加载方案）

本任务原计划在本机下载 Gemma 4 E2B-it/E4B-it 权重做 CPU smoke——**人 yale 已纠正：本机无 GPU，禁止下载/加载大型权重；改为以 Google 官方托管 API 为主**。本次修正前未派发任何 worker（`worker-dispatch.json` 无条目、无 worktree），**无在飞实现**，本次是干净替换任务体，不是修改在途产物。

本会话重新核实 Google 官方文档 `https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api`：

- Gemini API 当前**只列出两个 Gemma 4 模型**：`gemma-4-31b-it`、`gemma-4-26b-a4b-it`。**`gemma-4-E2B-it` / `gemma-4-E4B-it` 均不出现在该页面**（已逐字核对）。
- 该页面**没有**说明这两个托管模型是否支持音频输入；页面横幅"Gemma 4 released with text, audio and image input..."是对 Gemma 4**系列整体**的宣传语，不是对这两个**托管 API 模型**的模态声明——**不能把系列级宣传等同于这两个 API 端点的实际能力**，这正是人 yale 要求的核心纪律：不假定支持音频，要用 `list_models`/`supportedGenerationMethods` 与真实 3–5 秒音频调用逐一验证。
- 页面未给出价格/免费额度细节，只说需要 API key、并链接到独立计价页。本任务执行时需自行查当前免费额度，优先免费，**未经人 yale 另行授权不得产生付费调用**（比此前 P0.x 系列"先写死 ¥0.05 上限"更严——这里是"默认 0 付费，若会产生费用先停下来回报，不得自行决定花钱"）。
- 本机环境（已查）：**无 GPU**（无 `nvidia-smi`），因此**本任务禁止下载/加载任何 Gemma 4 本地权重**（E2B/E4B 或任何其它尺寸），全部测试经网络 API 调用。
- 本机 `.env.test` 已配置 `GEMINI_API_KEY`（人 yale 确认"本机已经合法配置"）；本任务读取该变量调用官方 API，**日志/artifact 绝不打印该 key 的值**（包括不打印到 stdout、不写入任何 commit 的文件）。

### 目标

用本机已配置的 `GEMINI_API_KEY`，对 Google Gemini Developer API 做一次**只读 discovery + 最小真实验证**：

1. 调官方 `list_models`，核实当前实际可用的模型列表与每个模型的 `supportedGenerationMethods`、声明的输入模态。
2. 对每个声称支持音频（或模态不确定）的候选模型，用一条**真实的 3–5 秒匿名测试音频**发一次最小请求，记录真实返回：是否接受音频输入、返回内容、`usageMetadata`（token 用量）、是否报错/拒绝。
3. 若 `gemma-4-31b-it`/`gemma-4-26b-a4b-it` 经真实调用确认**不支持音频**（纯文本模型），**不得**把它们对纯文本请求的成功响应算作"音频模态验证通过"——这是人 yale 明确点名要避免的误算。
4. 若 E2B/E4B 确认不在 Gemini API 列表中，**记录为明确的 blocker**（不是失败，是范围发现），不强行用别的模型冒充它们。
5. 另外测试**已确认支持音频的 Google Gemini Flash 系列**模型（如 `gemini-2.5-flash` 或 discovery 当时实际可用的 flash 音频模型）作为**对照组**，**必须在 artifact 里明确标注这是 Gemini Flash，不是 Gemma 4**，不得混淆模型身份。
6. E2B/E4B 的原生音频能力验证（本地权重或第三方托管）**推迟到另一个任务**（第三方音频 API discovery 或外部 GPU 环境），本任务不尝试。

### 边界 / 不做

- ⛔ **禁止下载/加载任何 Gemma 4 本地权重**（本机无 GPU）；本任务只做网络 API discovery 与最小真实调用。
- ⛔ **默认零付费**：优先使用免费额度内的调用；若 discovery 发现某次调用会产生费用，**停止并在 artifact 里记录"需要人授权付费才能继续"**，不得自行决定花钱继续测试（不套用此前 P0.x 系列"写死¥0.05上限即可执行"的默契——这里要求的是更高门槛：默认不花钱，要花钱先停下回报）。
- ⛔ **不得把模态不支持误算成模态验证**：任何模型若经真实调用证明不接受音频输入（报错/拒绝/该端点本就是纯文本），必须明确记为"不支持音频"，不得因为它对纯文本输入返回成功就写成"验证通过"。
- ⛔ **不得混淆模型身份**：Gemini Flash 的音频测试结果必须单独成段并清楚标注"这是 Gemini Flash 对照组，不是 Gemma 4 E2B/E4B"，不得在摘要里把两者的数字并在一起而不加区分。
- ⛔ **日志/artifact 绝不打印 `GEMINI_API_KEY` 的值**：任何写入文件或 stdout 的内容都要过一遍"确认不含该环境变量原文"的检查（如长度/前缀匹配排查），哪怕是调试输出也不行。
- ⛔ 不改默认 Live Voice 生产链路；`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。
- ⛔ 只改 `experiments/` 与 `docs/`，零生产变更。
- ⛔ 不碰 `gap-voice-turn-detection-p0-13-*` 的 worktree 或目录（主题不同、路径不同）。
- ⛔ 不得编造 token usage、延迟或模态支持结论；任一探测失败需保留原始错误文本（不含 key 值）。

## Plan

1. **Discovery**：用 `.env.test` 的 `GEMINI_API_KEY` 调官方 `list_models`（或等价的 SDK 方法），记录返回的完整模型列表、每个模型的 `supportedGenerationMethods`、文档字段里声明的输入模态；特别核对 `gemma-4-31b-it`、`gemma-4-26b-a4b-it` 是否在列，以及是否存在任何 `gemma-4-E2B*`/`gemma-4-E4B*` 条目（预期没有，但要用真实调用结果确认而不是假定）。
2. **真实最小调用（每个候选模型一次，3–5 秒匿名测试音频）**：对 discovery 列出的、模态不确定或声称支持音频的模型，发一条最小请求（短音频+短文本），记录 HTTP 状态、返回内容摘要、`usageMetadata`、是否报错及错误原文。音频素材用匿名合成或已获授权的极短片段，不含任何真实敏感内容。
3. **口径判定**：逐模型写明"音频输入：支持/不支持/未声明测试"的结论，并列出判定依据（真实返回，不是文档转述）；`gemma-4-31b-it`/`gemma-4-26b-a4b-it` 若只接受纯文本，明确写"该端点为纯文本，不构成 Gemma 4 音频模态的验证"。
4. **Gemini Flash 对照组**：选一个官方已知支持音频的 Gemini Flash 模型，跑同样的 3–5 秒音频最小调用，记录同样的指标，并在报告里单独成段、清楚标注"对照组，非 Gemma 4"。
5. **E2B/E4B 范围声明**：在 artifact 顶层写明"E2B/E4B 未在 Gemini API 发现；原生音频验证（本地权重或第三方托管）超出本任务范围，留给后续任务"。
6. **预算与安全核查**：全程记录每次调用是否命中免费额度（若 API 返回费用相关字段）；若任何一步显示会产生费用，停止并记录，不继续执行后续步骤。执行完毕后自检 artifact 与日志文件，确认不包含 `GEMINI_API_KEY` 原文。
7. **交付物**：`RESULT.json`（逐模型真实读数）、`CONCLUSION.md`（一页摘要：discovery 结果、E2B/E4B blocker 声明、Gemini Flash 对照组结果、模态判定表、费用记录）。

## AC

- [ ] AC1 Discovery 真实执行：`list_models` 真实调用的完整返回记入 artifact（模型 ID、`supportedGenerationMethods`、原始响应片段），非凭文档假定。
- [ ] AC2 E2B/E4B 核查：artifact 明确记录 `gemma-4-E2B-it`/`gemma-4-E4B-it` 是否出现在真实 `list_models` 返回里；预期不出现时作为 blocker 写明，不得跳过不提。
- [ ] AC3 真实音频最小调用：对每个模态不确定/声称支持音频的模型，有一次真实 3–5 秒音频请求的 HTTP 状态、返回摘要、`usageMetadata`、错误原文（若有）；不得用插值或文档转述代替真实返回。
- [ ] AC4 口径纪律：`gemma-4-31b-it`/`gemma-4-26b-a4b-it` 若判定为纯文本，artifact 明确写"不构成音频模态验证"，不与真正的音频成功调用混为一谈。
- [ ] AC5 Gemini Flash 对照组：单独一段结果，标题/字段明确写"对照组，非 Gemma 4"，不与 Gemma 4 的数字混排在同一张不加区分的表里。
- [ ] AC6 预算纪律：优先免费额度；任何会产生费用的步骤如果被触发，artifact 记录"已停止，需人授权"而不是继续花钱；若全程都在免费额度内完成，明确记录"零付费"。
- [ ] AC7 密钥安全：机械自检（如对 `RESULT.json`/`CONCLUSION.md`/任何日志文件做字符串扫描）确认不包含 `GEMINI_API_KEY` 的值；记录该自检本身的执行与结果。
- [ ] AC8 范围边界：E2B/E4B 原生音频能力验证明确标"推迟到后续任务（第三方 API 或 GPU 环境）"，本任务不处理；`git diff develop` 对三个生产路径为空；未触碰 P0.13 的 worktree。
- [ ] AC9 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

Discovery 与音频调用的结果必须来自真实 API 响应，不是文档转述或假设；E2B/E4B 是否可用的结论必须基于真实 `list_models` 返回；任一模型的"音频支持"结论必须有真实调用证据，纯文本响应不得算作音频验证；Gemini Flash 对照组结果必须清楚标注身份、不与 Gemma 4 混淆；全程默认零付费，若触发计费步骤必须停止并记录待授权，不得自行花钱；`GEMINI_API_KEY` 的值绝不出现在任何 artifact 或日志里（有机械自检证据）。本任务零改动生产默认 Live Voice 链路，仅改动 `experiments/`/`docs/`。

## Touches

- experiments/gemma4-audio-semantic/discover-models.mjs (new)
- experiments/gemma4-audio-semantic/audio-probe.mjs (new)
- experiments/gemma4-audio-semantic/samples/ (new)（3-5s 匿名测试音频）
- experiments/gemma4-audio-semantic/RESULT.json (new)
- experiments/gemma4-audio-semantic/CONCLUSION.md (new)
- experiments/gemma4-audio-semantic/.gitignore (new)
- tasks/gap-gemma4-p1-audio-semantic-smoke.md
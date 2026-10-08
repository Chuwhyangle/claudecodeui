---
id: GOAL-029
title: Live Voice 原生语音推理的最小验证：Qwen Realtime + ClaudeCodeUI 语义控制
status: active
kind: goal
origin: docs/proposals/voice-native-control-plane.md（本提案 §10 的 prototype/GOAL
  规模判断、§0/§12/§13 的产品定位与长期愿景；2026-10-09 与人 yale 的多轮架构讨论的落地）
activatedAt: 2026-10-08T17:21:04.606Z
statusLog:
  - at: 2026-10-08T17:21:04.607Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
---
## 背景

`docs/proposals/voice-native-control-plane.md` 记录了一次完整的架构讨论：Live Voice mode 不是"给 Claude Code 加语音输入框"，而是 voice-native control plane——Qwen Realtime 在音频上直接做歧义消解、自我更正理解、指代解析，产出结构化意图后交给 Claude Code（通过 `server/modules/mcp-gateway/*` 已经存在的少数高层语义工具，而不是 Edit/Bash 级别的原始工具）。该提案 §10 判断：在真正投入这套架构之前，需要先建一个最小可验证 prototype，证明"audio-native Qwen Realtime + 高层语义工具"在典型歧义场景上确实优于现有 ASR→文本→Claude 路径——这是一个需要数据验证的假设，不是已证实的结论。

## 目标（不预设结论）

建立可复现的 prototype：对比 **voice-native Qwen Realtime + 高层语义工具**与**现有 ASR→text→Claude 路径**，在下面四类场景上是否具有实际优势：

1. 同音实体歧义（如本仓库自己的 "Quay" 与 "key" 这类无热词表时容易互相转错的词）；
2. 自我更正（"改一下 A——不对，是 B"）；
3. 指代消解（"这一段"、"刚才选的那个"，依赖屏幕/选区状态而不是纯音频）；
4. world-model / 状态查询（"刚才那个任务怎么样了"，依赖当前 run、排队、后台任务、挂起 approval、最近完成任务等状态，而不是语音内容本身）。

并据此决定是否进入产品化。**读数可以支持任何一个方向**——任务按"实验是否跑得严谨、记录是否完整"判定，不按"哪条路径赢了"判定（ADR-004 决策 8 的既有原则：质量数字不进判据集）。

## 范围

- 新增 `server/modules/voice-realtime/` 的 Realtime bridge 模块与工具 schema：建连/断连/重连的状态机、`session.update` 构建、function-call 路由、注入式 tool executor；离线可测（假 WS 服务端，零真实网络），工具 schema 覆盖六个既有 MCP 工具形状（`ui_visible_context`/`session_send`/`session_get`/`run_get`/`approvals_list`/`session_background`）。
- 四类场景的预注册语料、标准答案、打分口径，**取数前**冻结（含负对照）。
- 同一次运行、两条臂（现有 ASR→文本路径 vs 新 bridge）的对比读数记录，落 `docs/experiments/`。

## 非目标

- 不要求完整 Start Voice 式 UI、不做语音输出 / TTS（speech rendering / spoken-summary 层——见 `docs/proposals/voice-native-control-plane.md` §8，留在 roadmap，非本 GOAL）。
- 不做完整的 multi-project coordinator / multi-agent aggregation front-end（同提案 §12，长期愿景，非本 GOAL）。
- 不做 architecture-oriented workspace 的产品化（同提案 §12.4，长期方向，非本 GOAL）。
- 不接 `approval_answer` 的生产级确认 UX，不做任何 destructive action 的真实批准路径（同提案 §7 的风险分级设计留在 roadmap）。
- 不做状态跃迁驱动的完整后台主动通知体系接线（同提案 §6；复用现有 `claude-resident-sessions.md` 的 `notifyBackgroundWorkCompleted`/无人值守拦截机制，接线工作留给后续产品化 GOAL）。
- 不做长期重连韧性、移动端适配、前端 composer/模式切换 UI——本 GOAL 全程 Node 脚本驱动，零前端改动。
- 不接真实 Claude Code 会话落一次真的 `chat.send`；本 GOAL 范围内全部工具执行都是**注入的夹具数据**，不是活的 `ChatControlService` 调用（真实冒烟是可选的 stretch 任务，仅在本 GOAL 的对比读数支持继续投入时才另外立案）。
- 质量数字不进判据集：任务 AC 判定的是实验是否严谨、记录是否完整，不是"Qwen 赢没赢"。

## 退出条件

- AC-305 Realtime bridge 与工具调用在假 WS 服务端上离线可证（六个工具形状 schema 与现有 MCP 定义逐字段一致、路由正确、异常路径不崩溃、零真实网络）。
- AC-306 四类场景的语料、标准答案、打分口径（含负对照）在取数前冻结且结构完整。
- AC-307 同一运行内两条臂的对比读数记录存在，四类场景各有明确结论，质量数字不进判据，证据指针完整。

## 不做退出条件的范围内事

- 可选的生产冒烟任务（把工具真的接到 `ChatControlService`）——只在 AC-307 的读数支持继续投入时才另外立案，不在本 GOAL 当前范围内，也不是本 GOAL 关闭的前提。
- `docs/proposals/voice-native-control-plane.md` §6/§8/§12/§13 描述的后续能力（主动通知接线、speech rendering、multi-agent 协调、架构化工作空间、更高层经济学假设的评估）——全部是本提案记录的长期方向，不是本 GOAL 要交付的东西。

## 已知不等价点与限制

- 四类场景的语料是 TTS 合成，不是真人语音；读数只界定方向，不界定真实场景下的幅度。
- 对比臂的"现有 ASR→文本路径"用的是已出货的 `dashscope-omni` 书面化路径（`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`），不是其它可能的 ASR 组合。
- 本 GOAL 的工具执行全程是注入夹具，不是真实 `ChatControlService`——"实际优势"的读数只能回答"理解质量是否更好"，不能回答"接入生产环境是否顺畅"（那是可选 stretch 任务要回答的问题，且不保证会被立案）。
- `qwen3.8-omni-flash`/Realtime 端点是服务商别名/接口，服务端升级后行为可能漂移。
---
id: gap-voice-turn-detection-p0-8-paired-realtime-vs-nonrealtime-pilot
title: Live Voice 低成本全链路替代最小配对 Pilot（P0.8）：Realtime vs VAD+静音等待+非实时 Qwen
  Omni，逐例对照 + Go/No-Go
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（研究方向转折，本轮用户明确调整）

`gap-voice-turn-detection-pluggable-comparison-p0`→`...-p0-5-expansion`→`...-p0-6-dataset-benchmark`→`...-p0-7-unified-realtime-benchmark`（均 done）建立并跑通了一套孤立轮次检测器对照 harness（VAD/Smart Turn/LiveKit/Qwen Realtime 作为纯粹的端点判定器，在 44 样本/73 候选点上对比误截断/漏端点/延迟）。人 yale 本轮明确把研究问题从"哪个轮次检测器最好"转向"**低成本 VAD+静音等待+非实时 Qwen Omni 这整条全链路，能不能端到端替代现有 qwen3.8-omni-flash-realtime Live Voice Agent**"——这是一个更端到端的问题，要求先做**最小可行配对 pilot**（不是扩容数据、不是自研轮次检测器），有明确 go/no-go 再决定是否扩大样本。

### P0.7 的 11/24 timeout 归因复核（本会话已完成，供本任务引用，不要重新论证）

编排会话已派独立调查核实 `...-p0-7` 的 Qwen Realtime 流式测量里 11/24 会话标记 `timeout` 的真实原因，读了 `eot-bench-adapters/qwen-realtime-streaming-adapter.mts` 的判定代码与全部 11 条会话的原始线上事件日志：

- `status='timeout'` 的判定条件是「8 秒 close-wait 窗口内没有收到可归因的 `speech_stopped` 事件」，与 `create_response` 无关。
- `create_response:false` 是 **harness 自己设的客户端请求参数**（为了把"上游 VAD 判定时刻"和"模型生成耗时"分开测），服务端只是原样回显，**不是**服务端对内容"不值得回应"的语义判断——"这些 timeout 只是良性的无响应被误判"这个假说**不成立**，已被原始线上日志排除。
- 逐会话核实：约 2/11（`librispeech-000#0` @400 与 @800）是 harness 自己 90% 容差窗口的边界误判——`speech_stopped` 其实准时到了，只早了 25-91ms，是测量方法假阴性，不是真故障。其余约 9/11 显示真实的上游端点延迟/不稳定（1 条约 6.5 秒内零事件；1 条 `speech_started` 本身迟到 21-30 秒，而该 23 秒语料的真实语音从 t≈0 就开始；若干条有多轮 start/stop 但延迟 10-40+ 秒，部分在 harness 已放弃关闭连接之后才到）。
- **结论**：混合结果——一小部分是测量方法假阴性，更大一部分是真实的 Realtime 端点延迟信号，但只来自 24 个会话/12 条语料，**不构成生产质量的统计结论**。本任务的最小配对 pilot 正是为了在更贴近真实使用场景（真实编程口语指令）下、逐例可读地回答这个问题，而不是继续扩大同一类聚合百分比。

### 边界 / 不做

- ⛔ **不扩容既有轮次检测器语料、不自研/新引入任何轮次检测器**；本任务复用既有 `experiments/voice-turn-detection-compare/` harness 的基础设施（manifest 结构、事件时间轴记录工具、Qwen Realtime 流式 adapter 的会话管理代码），但聚焦的是**全链路**（检测+理解+决策+安全提交），不是又一轮检测器对比。
- ⛔ **所有动作必须 dry-run/sandbox，没有真实副作用**：无论是现有 Realtime 链路的 `session_send`，还是非实时 Qwen Omni 路径"愿意调用"的工具请求，本任务都只捕获"会发出什么"而**不实际投递**到任何真实 Claude Code 会话；不得让本任务的回放意外触达生产会话。
- ⛔ 不改默认 Live Voice 生产链路；`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。
- ⛔ 不得用小样本（6-10 条）的误截断/准确率百分比得出可泛化的结论；结果必须逐例对照展示，百分比只能作为辅助摘要，不能替代逐例判读。
- ⛔ 新增真实上游调用预算（Realtime + 非实时 Qwen Omni 合计）≤ ¥0.05（与 P0–P0.7 既有花费分开记账），执行前写死上限，超支即中止并记录，需另行获批才能继续。
- ⛔ 不得把"流式输出缺失"直接推断为"模型出错"：超时/未决与模型显式报错必须分别记录状态（沿用 P0.7 已验证的判定纪律）。

## Plan

1. **样本设计（6-10 条，真实编程口语，非朗读）**：覆盖完整单句指令、思考中停顿（「就是…那个…」）、补充限定（「改成三十秒……啊不对，是针对 staging 环境的」）、自我纠正、中英技术术语混杂（如 Quay/ClaudeCodeUI 的真实术语）、连续指令（一句话里含多个动作）。若无法合规录制真人声，使用明确标注 `synthetic:true` 的 TTS，并如实说明局限（沿用既有纪律，不编造真人声）。
2. **双链路配对执行**：
   a. **链路 A（现有 Realtime，线上默认）**：复用 P0.7 的流式 session 管理代码，对每条样本开一个真实会话，记录完整事件时间轴（音频送达→VAD 判定→commit→response.create→工具调用/文本回复），工具调用结果**只记录不投递**。
   b. **链路 B（VAD+静音等待+非实时 Qwen Omni）**：复用既有 VAD（StreamingVad）判定端点后，把累积的完整语音一次性送给非实时 `qwen3.8-omni-flash`（沿用 P0.6/P0.7 已验证的 audio+tools 请求格式），`tool_choice` 用 `auto`（贴近真实使用），记录端点判定到工具调用产出的墙钟时间，工具调用结果**只记录不投递**。
3. **逐例记录**：每条样本在两条链路下分别记录：语音结束→正确 tool call→安全提交的延迟（拆分"检测/等待耗时"与"模型推理耗时"）、任务理解是否正确（人工判读：工具调用的参数是否准确对应说话人意图）、误触发（说了不该触发动作的话却调用了）、漏触发（该触发却没调用）、重试次数、本例真实花费。
4. **汇总与 Go/No-Go**：先列逐例对照表（不先给汇总百分比），再给出汇总仅作辅助；按预先写死的 go/no-go 判据判定：
   - **Go**（可扩大到 30-50 条）条件：关键用例（至少完整单句+自我纠正+连续指令三类）两条链路都能跑通产出合理结果，没有严重误操作（误触发率在可忍受范围——执行前写死具体数字，不得事后调整），延迟与成本在可接受范围（同样执行前写死）。
   - **No-Go**：任一关键用例失败，按以下四类归因分类记录原因，不混为一谈：
     - **端点**（VAD/上游未能正确判定语音结束，如 P0.7 发现的那类延迟/缺失事件）
     - **语义**（端点判定对了，但模型没理解指令意图，工具调用参数错）
     - **流式**（协议/会话管理层面的问题，如连接不稳定、事件顺序错乱）
     - **Action Gate**（前面都对，但安全提交环节本身设计有缺陷，如没有正确的纠正宽限窗）

## AC

- [ ] AC1 样本设计：6-10 条真实编程口语样本，覆盖 Plan 第 1 步列出的全部场景类型（每类至少 1 条，若做不到就如实说明缺口而非硬凑）；标注 `synthetic:true`/真实来源，不冒充真人声。
- [ ] AC2 链路 A 真实执行：每条样本一条真实 Realtime 会话，完整事件时间轴记入 artifact，工具调用只记录不投递（有机械证据证明没有真实投递路径被触达，如 mock sink 的调用记录而非真实 session id）。
- [ ] AC3 链路 B 真实执行：每条样本经 VAD 端点判定后送非实时 Qwen Omni，端点到工具调用的墙钟时间记录，工具调用只记录不投递（同样有机械证据）。
- [ ] AC4 逐例对照表：每条样本两条链路并排的延迟拆分/理解正确性/误触发漏触发/重试次数/真实花费，先逐例展示再给汇总；汇总百分比必须标注"样本量 N=6-10，不构成可泛化结论"。
- [ ] AC5 Go/No-Go 判据执行前写死：误触发率可忍受阈值、延迟/成本可接受阈值在跑样本**之前**就写入 artifact，不得看到结果后再调整；最终判定基于实测数字。
- [ ] AC6 失败归因分类（若有 No-Go 案例）：按端点/语义/流式/Action Gate 四类记录每个失败案例的归因依据，不得笼统写"失败"。
- [ ] AC7 预算：新增真实调用（Realtime+非实时 Omni 合计）≤¥0.05，执行前写死上限，真实花费记入 artifact，超支即中止记录。
- [ ] AC8 无真实副作用：机械证据证明两条链路的工具调用均未触达任何真实 Claude Code 会话（dry-run/mock sink 的调用记录，不是真实 session_send 投递）。
- [ ] AC9 生产面零改动：`git diff develop` 对三个生产路径文件/目录为空。
- [ ] AC10 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

样本必须真实可用（标注来源/synthetic属性）；两条链路都必须是真实调用产出的真实读数（Realtime 真实会话、非实时 Qwen Omni 真实请求），不是估算或模拟数字；工具调用结果的"未投递"必须有机械证据，不是口头声明；Go/No-Go 判据必须在执行前写死，结果判定不得事后调整门槛；失败归因必须给出具体依据（事件时间轴/响应内容），不是笼统分类；预算必须真实记账且不超限。本任务零改动生产默认 Live Voice 链路，不扩容既有轮次检测器语料、不新增轮次检测器。

## Touches

- experiments/voice-turn-detection-compare/paired-pilot/ (new)
- experiments/voice-turn-detection-compare/paired-pilot/samples.json (new)
- experiments/voice-turn-detection-compare/paired-pilot/run-paired-pilot.mts (new)
- experiments/voice-turn-detection-compare/paired-pilot/RESULT.json (new)
- docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md
- tasks/gap-voice-turn-detection-p0-8-paired-realtime-vs-nonrealtime-pilot.md
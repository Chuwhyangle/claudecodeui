---
id: GOAL-034
title: Live Voice 分段中继：CloudCLI 端切分语音、带可读会话上下文、空闲换会话——每句成本与连接时长无关
status: active
kind: goal
origin: 2026-10-10 人 yale：基于
  `docs/proposals/voice-realtime-segmented-relay-SPEC.md`（commits
  b6f1e73d、75bd6a89）批准推进，并授权 P0 真实上游验证无需反复询问。决策：不限制使用时长；成本异常线只作用于自动测试；把 Claude
  Code 会话里用户可读的部分按字符预算放进上下文并如实标注，如何使用靠实测调；可用则做语义端点；不为想象中的安全风险设置新阻塞。本 GOAL 是
  GOAL-031/033 的增量，不重开它们，AC-310/311/315/316/317 的保证不受影响。2026-10-10/11 追加：人 yale
  要求分段中继默认开启并保留回退开关、账单不可得时不得虚构对账成功（见 AC-322）。
activatedAt: 2026-10-10T01:28:36.297Z
---
## 背景

线上 Live Voice（GOAL-031/033，已 achieved）链路已通，但实测暴露了成本结构问题（数据见 SPEC「实测事实」F1–F12，对账见 SPEC 附录 B）：

- 每次模型响应都要重读整个会话，上下文随响应次数增长约 75 token；4 句话的连接约 ¥0.0127，20 句约 ¥0.13，一小时（69 句）约 ¥1.1–1.4。
- 浏览器把 205 秒连续音频全部送上游，只有约 8.6 秒（含边缘约 14–16 秒）被上游 VAD 当作语音；上游 VAD 把一句话切碎，3 段语料产生 13 条转发消息。
- 语音模型对 Claude Code 会话一无所知（只带指令 + 一个工具声明，约 450 token），口述的文件名只能靠识别，日志里三次把 `voice.service.ts` 听成 `voice点se`。

## 目标

1. **成本与连接时长无关**：每句成本为常数；默认上下文包 2,000 字符时每句 ≤ ¥0.005（估算），69 句/小时 ≤ ¥0.35。
2. **只把语音发给上游**：CloudCLI（浏览器）做 VAD，合并短间隔，只上送语音段。
3. **带会话上下文**：把 Claude Code 会话里**用户在页面上看得见的「说出来的话」**（与前端折叠规则同源）按**字符预算**从最新往回取，如实标注为上下文放进上游会话；不对模型如何使用做过多约束，用 A/B 回放观察后再调。
4. **长连接可持续**：空闲时透明换上游会话（预热待命 + 空闲切换），浏览器无感；不限制使用时长。
5. **可观测、可调参、可对账**：每片段/响应/换会话有日志与用量；提示词与上下文模板热读取，改了不需要重启服务。
6. **语义端点**：模型与服务支持时，话没说完就等；不支持则不做。**P0-S4（2026-10-10）已实测不支持**——控制面只是回声（`semantic_vad` 与乱写的 `bogus_vad_type` 回显成同一组字段），提示词层面的等待 2 次运行 0 次生效，故本项按「不做」执行；「等一等」改由 C1 在 CloudCLI 侧静默判定、`holdTimeoutMs` 兜底转发实现。

## 非目标

不更换模型；不改 Claude Code 行为；不做 TTS；V1 不做用模型生成会话摘要；不改现有 2.5 秒合并窗口与忙等待投递；不把假想的安全问题设成阻塞（见 origin）。

## 分期与 AC

| 期 | AC | 任务 |
|---|---|---|
| P0 真实上游验证（总预算 ≤ ¥0.05） | AC-318 | `gap-voice-segmented-relay-p0a-commit-rotation-context`、`gap-voice-segmented-relay-p0b-endpoint-history-cache` |
| P1 切分与协议 | AC-319 | `gap-voice-segmented-relay-segmenter-relay-profile`、`gap-voice-segmented-relay-protocol-server-commit`、`gap-voice-segmented-relay-client-wiring`、`gap-voice-realtime-e2e-specs-red-under-default-segmented-mode`（默认开启后 e2e 夹具修复） |
| P2 上下文包与热修改 | AC-320 | `gap-voice-realtime-context-pack-and-hot-settings` |
| P3 换会话 | AC-321 | `gap-voice-realtime-upstream-pool-rotation` |
| P4 默认开启与对账 | AC-322 | `gap-voice-segmented-relay-rollout-and-reconcile` |

另有一条前置修复任务 `gap-voice-realtime-test-files-restore-quay-test-script-pins`：先前直接提交的新增测试文件让 `server/shared/tests/quay-test-script.test.ts` 的文件数钉子红了，须先修（不属于任何 AC，纯修复）。

## 成本与证据

- 成本模型与公式见 SPEC「成本模型」；单价（元/千 token）：文本输入 0.0015、音频输入 0.006、文本输出 0.0045；音频 7 token/秒、不足 1 秒按 1 秒（百炼 Qwen-Omni 文档）。
- **P0 总预算 ≤ ¥0.05**：P0a ≤ ¥0.04（S1 ≤ ¥0.01、S2 ≤ ¥0.005、S3 ≤ ¥0.025），P0b ≤ ¥0.01；每个探针内置累计估算花费守卫，超预算即中止并记录。
- 历史控制（P0-S5，2026-10-10）：助手 `OK` 条目可插入、`conversation.item.delete` 被接受且其后一次响应的 `input_tokens` 由 643 降到 481 ⇒ **不换会话即可控历史**，成本模型每句从 2 次响应降到 1 次（`r=1`）的前提成立；实际降幅待 P4 与账单对账。
- 缓存（P0-S6，2026-10-10）：同一段 2,000 字符前缀上两次响应的 `usage` 在任何深度都没有 cache 类字段，重复前缀按**全量**计费——成本模型不能按缓存打折，`T` 取整包 token。
- 其后每一期至多**一次**真实上游确认运行，预算写在各任务里；其余全部用假上游与录像回放。

## 协调

- 另一常驻会话正执行 Composer 双入口 UI 改造（分支 `task/gap-live-voice-composer-embedded-dual-entry`，工作树 `claudecodeui-worktrees/gap-live-voice-composer-embedded-dual-entry`），其 Touches 含 `ChatInterface.tsx`、`ChatComposer.tsx`、`VoiceInputButton.tsx`、`VoiceRealtimeBar.tsx`、`useVoiceRealtimeSession.ts`、`audioSource.ts`、两份 voice-realtime e2e spec。本 GOAL 的 P0/P1 服务端/P3 只改服务端、`experiments/` 与**新文件**，与其互不相交；凡要改上述共用客户端文件的任务（`client-wiring`、`context-pack…` 的客户端部分）显式 `depends_on` 该任务，串行，不并发写。
- 所有改动经 Quay 任务 worktree、测试、验收、合并，不再直接写 develop。

## 退出条件

- AC-318 P0 真实上游验证：手动音频提交、空闲上游会话切换、可读上下文注入已先于语义端点/历史控制/缓存验证；`RESULT.json` 的 S1–S6 各有 verdict/evidence/spendCny/notes，优先级顺序可审计，Σ spendCny ≤ ¥0.05，结论与 `docs/proposals/voice-realtime-segmented-relay-SPEC.md`「P0 结论」逐条对应；未 supported 的项写明降级路径。
- AC-319 P1 切分与协议：浏览器端只上送语音段（上游收到音频 ≤ 25 秒）、不吃字（CER 增量 ≤ +1.0%）、合并正确、重放幂等，旧连续 `audio` 帧协议行为不变；`quay goal gate AC-319` 须在默认配置与 `VOICE_REALTIME_MODE=continuous` 下都绿。
- AC-320 P2 上下文包与热修改：上下文包与前端的用户可读行折叠规则同源、按字符预算从最新往回组装、如实标注；提示词与模板每次新连接热读取，改文件无需重启；估计与实测 token 差超 20% 记告警。
- AC-321 P3 上游会话池：预热待命会话、空闲时无感切换（额外延迟 ≤ 300 ms），每次响应读入不随响应序号增长，60 分钟回放不因时长或总额终止。
- AC-322 P4 默认开启与对账（2026-10-10 人 yale 指示取代原「缺省仍连续」）：服务端默认声明 segmented-v1、`VOICE_REALTIME_MODE=continuous` 一键回退；成本回放测试线；一次真实 Qwen Realtime 运行的逐段/逐响应 usage 与本地日志估算逐项对账。**阿里云账单行与估算的逐位核对（≤1%）只能由人 yale 提供账单行**——未提供时记录必须写 `pending-external`，不得当作已对账。
- 或由人裁定放宽 / 取消其中任一条。
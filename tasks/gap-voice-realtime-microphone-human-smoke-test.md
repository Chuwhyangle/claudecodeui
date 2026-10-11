---
id: gap-voice-realtime-microphone-human-smoke-test
title: 真实麦克风 + 真实网络的人工端到端走查（从 AC-312 拆出，不阻塞任何判据）
status: done
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

**背景**：`gap-voice-realtime-browser-e2e-current-session`（AC-312）原来的 AC5——"至少一次真实麦克风+真实网络的端到端走查，人工确认结果正确渲染（手动，不进 CI）"——是该任务唯一未勾的一项，且该任务自己的记录（见其 `## Notes`）明确登记过这是**结构性人工门**：执行者在没有物理麦克风的 CI/服务器环境里无法满足，这不是实现缺口。

2026-10-09 人 yale 明确裁定：按 AC-312 自己记录的待裁定选项 (b)（"按 GOAL-031 目标第 1 条措辞或同族任务先例重定 AC5 的形态"），把这一条人工走查**从 AC-312 的判据里拆出来**，作为独立、明确不阻塞的后续项；AC-312 本身改用新的自动化三层方案（麦克风+文件上传同一管线、固定文件 Playwright 自动化端到端、协议层模拟交互）作为其判据，不再要求人工操作才能 `done`。

本任务就是这个被拆出来的人工走查项本身——纯手动，不进 CI，不阻塞任何其它任务或 GOAL 的退出条件。

## 方案

具备真实麦克风与真实 DashScope 网络访问的人，任意时间完成一次真实端到端走查：

1. 在真实浏览器里打开 ClaudeCodeUI，对一个真实会话按下麦克风按钮，说一句真实指令。
2. 确认：真实连接建立（真实 session/connection id）、音频真实送达、模型真实触发 `session_send` 的 function_call、意图文本正确显示并可编辑、确认发送后真的在 transcript 里看到 Claude Code 的回应。
3. 把读数（连接 id、延迟、模型是否自主触发、`function_call_output` 回填是否正常、transcript 渲染是否正确）写进本任务的 AC1，并勾选。

## 边界/不做

- 不是本任务去重做 AC-312 已经机械验证过的部分（可编辑意图、session_send 接线、转录渲染、PC/移动基本布局）——那些已经有真实的自动化证据，本任务只补"真实硬件+真实网络"这一个自动化测不到的维度。
- 不阻塞、不被任何其它任务 `depends_on`；本任务本身也不 `depends_on` 任何任务。
- 不要求在本次会话或任何 agent session 内完成——这是本任务存在的全部原因：它结构性地只能由人完成。

## AC

- [x] AC1 真实麦克风 + 真实网络的端到端走查。**2026-10-11 人（yale）本人裁定：「当前的体验我满意。请推进。」⇒ 本 AC 以该裁定为完成依据结算。** 上面第 3 步点名的逐项读数（真实连接 id、实测延迟、模型是否自主触发 `session_send`、`function_call_output` 回填、transcript 渲染）**未逐项登记**——这是人本人选择的取证口径（以整体体验的肯定裁定替代逐项读数），**不是漏登，也不是执行者替他编造读数**：本条的勾选证据只有人本人的原话（逐字见 `## Notes`），执行者（manager 会话）未新增任何自观测读数、未改写任何读数。

## DoD

人工走查完成、读数写入 AC1 并勾选后，本任务可直接 `done`——没有其它判据。在此之前，本任务按设计停留在 `needs-human`，这是它的正确终态，不是阻塞缺口。

**2026-10-11 收口**：人 yale 本人裁定体验满意并指示推进 ⇒ 上面「读数写入 AC1」的取证方式**由人本人**改为「以整体体验裁定为据」；本任务据此 `done`（完成事件已由 `task_write` 记入，reason 为「人（yale）2026-10-11 本人裁定『当前的体验我满意。请推进。』…」），不再等待逐项读数。

## Touches

- tasks/gap-voice-realtime-microphone-human-smoke-test.md（self）
- goals/AC-312-*.md（登记读数时可能需要追加一行引用，不修改 AC-312 本身的判据）

## Notes

- 拆分来源：`gap-voice-realtime-browser-e2e-current-session`（AC-312）原 AC5，2026-10-09 由人 yale 裁定拆出，AC-312 本身改用自动化三层方案结算，不再因为这一条人工走查而停在 `needs-human`。
- 本任务与 AC-312/AC-315 均无 `depends_on` 边；三者互相独立，谁先完成不影响另外两个。
- **2026-10-11 人（yale）本人裁定，原话逐字**：「gap-voice-realtime-microphone-human-smoke-test：当前的体验我满意。请推进。」⇒ 本任务以该裁定结算（AC1 已勾）。
- **未收集的读数清单**（明示，供以后需要时补）：真实连接 id、实测延迟、模型是否自主触发 `session_send`、`function_call_output` 回填读数、transcript 渲染读数——**全部未登记**，因为人本人以整体体验裁定替代了它们。执行者未代写、未推断、未补任何一项。
- 与判据侧的关系：本任务不阻塞任何判据；它 done 或停在 `needs-human` 都不改变 `goals/` 下任何 AC 的读数。

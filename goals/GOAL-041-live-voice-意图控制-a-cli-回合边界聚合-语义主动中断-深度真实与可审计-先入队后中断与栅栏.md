---
id: GOAL-041
title: Live Voice 意图控制 A+：CLI 回合边界聚合、语义主动中断、深度真实与可审计、先入队后中断与栅栏
status: achieved
kind: goal
origin: 人 yale 2026-10-12 授权按 A+ 推荐落地（Opus 常驻架构会话）。证据：journal
activatedAt: 2026-10-12T06:04:02.513Z
statusLog:
  - at: 2026-10-12T17:00:06.454Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

Live Voice 下 Claude Code 一轮执行（2026-10-12 实测每轮约 2–2.5 分钟）远长于语音句间隔，用户在执行中会不断追加、修正或推翻需求。2026-10-12 真实会话（journal 99df08d8 × transcript c6493eb6）表明：CLI 在回合边界把排队消息聚合成一条 user 消息，这本身就是合格的意图缓冲；但 relay 报的队列深度只增不减（报 10、真实 ≤2），prompt 只认停止词字面量导致「更主动地取消」被当作普通内容转发，中断回执与审计缺少 intent/heard，且现有中断路径先 abort 再释放修正，可能让旧队列先单独成轮。人 yale 已裁定采用 A+（SPEC §0.3 D-5..D-9、§18）：不建独立 Active Intent Buffer。

## 目标

1. 队列深度、状态注入、session_status 与 host lifecycle 对账，任何时刻对用户和模型说真话。
2. 中断仍是唯一元语 session_interrupt，由 Realtime 模型语义判断（停止或修正当前方向），无关键词；每次中断可审计（intent/heard/runId/triggerSeq）。
3. 修正先入队后中断，下一轮 = 剩余排队 + 修正，stale-first 为 0；runId+utteranceSeq 栅栏防止反复中断。
4. 已落地副作用保留并诚实告知；中断不触碰 Quay worker、后台任务与 cron。

## 范围

阶段 0：AC-338（深度真实）、AC-339（审计）、AC-340（删停止词规则）、AC-341（真实常驻 CLI E10 实验）。阶段 1：AC-342（先入队后中断 + 语义扩展）、AC-343（栅栏）、AC-344（诚实善后与边界）、AC-345（浏览器验收）、AC-346（语义抽样，不设门槛）。补充（2026-10-12 D-11）：AC-350（能力位 cancelQueuedInput 与 E9/E10 实测一致）；阶段 2：AC-351（语音待投递条目逐条撤回，仅 UI 确定性按钮）**已于 2026-10-14 按人裁定退役**（记录置 `superseded`：逐行撤回控件随其行一并退役，Live Voice 不留撤回/中断的可按控件；落地提交 `9ccdc6eb7`，后继读数载体 `voicePendingMessageCard.test.tsx`），不再是在域阶段。非目标：Steer、Fork、Rollback、独立 Active Intent Buffer（方案 B）、模型侧撤回/清空队列、停止 Quay worker。

## 退出条件

AC-338..AC-345、AC-350 的判据全部通过，AC-346 的抽样报告读数完整（AC-351 已于 2026-10-14 由人裁定置 `superseded`——逐行撤回控件随其行退役，它不再是本 GOAL 的在域保证，故不计入退出条件）；且 SPEC §18.7 的重开方案 B 条件均未触发（若触发，本 GOAL 以「A+ 不足」结论收口并回到 §18.2 重新讨论，而不是在本 GOAL 内实施 B）。
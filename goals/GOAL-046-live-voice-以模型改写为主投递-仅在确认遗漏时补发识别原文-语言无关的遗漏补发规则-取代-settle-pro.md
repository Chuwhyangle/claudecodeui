---
id: GOAL-046
title: Live Voice 以模型改写为主投递、仅在确认遗漏时补发识别原文：语言无关的遗漏补发规则（取代 settle producer 的兜底触发）
status: active
kind: goal
origin: 人 yale 2026-10-18 授权：接受 80–87% 精确率的自动补识别原文；≤6 字短句漏掉可忍受；不引入任何新 UI
  操作；规则须语言无关（中/英及少数大语种）；取代而非叠加 settle producer；AC-1 数值待 task 1 扫 H/G
  后锁定。证据：experiments/voice-relay-qb/（replay_rule.py、labels.json、flagged-for-review.md），SPEC：docs/proposals/voice-realtime-omission-fill-SPEC.md。
activatedAt: 2026-10-18T08:36:37.178Z
statusLog:
  - at: 2026-10-18T09:58:26.527Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
  - at: 2026-10-18T10:13:36.187Z
    from: achieved
    to: active
    actor: goal-cli
    reason: ""
---
## 背景

2026-10-17/18 对 Live Voice 连续模式的日志分析（47 个 continuous 连接、583 条最终转写）显示：用户说的话约 14% 的实质内容（≥7 字，日志实际读数）从未以任何形式送达 Claude；生产里的 settle producer（2.5 s 到点把水位线内的识别原文原样发出）在模拟里仍丢 9.8%，且把一部分本已被模型改写带上的句子再发一遍。用户要求：模型改写的 `session_send` 是主投递，识别原文只在能较高概率确认是模型遗漏时补发。

规则与证据见 `docs/proposals/voice-realtime-omission-fill-SPEC.md`（规则 v2，语言无关）与 `experiments/voice-relay-qb/replay_rule.py`（参考实现与回放工具）。日志回放：丢失 ≥7 字 9.8%（settle）→ 2.4%（v2），识别原文占比 7% → 14%，补发延迟 p50 = H = 12 s（待扫参降低）。

## 范围

- 任务 1：扫 H/G 与阈值，锁定参数文件，补齐与人工标注的对接；AC-398、AC-399。
- 任务 2：服务端纯函数模块 `planOmissionFills` 及其与 Python 参考实现的逐例一致性；AC-400。
- 任务 3：接入 ws-proxy，取代 settle producer 的丢话兜底触发（`MODEL_TEXT_REPLY` 逐字分支、忙等待与合并投递不变），并加 `interrupt_response:false`；AC-401。

## 非目标

- 不引入新 UI；不要求模型输出编号、时间戳或声明；不做 claims/名册。
- 不补 ≤6 字短句；不做标识符修复。
- 不验证英文及其他语种的精确率（无数据）；只保证它们不乱补。
- 不验证 `interrupt_response:false` 的真实送达效果（需新预算和修好的对照臂）。
- 不重启 :3001、不发布；上线需人工 build/restart。

## 退出条件

1. AC-398：参数文件与回放门锁定，R2 在冻结的连接清单上满足参数文件声明的阈值（且不劣于 SPEC 给出的外沿：丢失 ≥7 字 ≤ 3%，识别原文占比 ≤ 15%，模型与补发各一次 ≤ 3.6%，补发延迟 p50 < H）。
2. AC-399：补发列表对人工标注的精确率 ≥ 80%，且标注集上实际发生的补发 ≥ 15 条。
3. AC-400：TS 纯函数与 Python 参考实现对同一夹具逐例一致，表驱动单测覆盖 SPEC「测试」一节。
4. AC-401：ws-proxy 里 settle 不再触发丢话兜底，补发在 T_i 投递、写入日志；session.update 携带 `interrupt_response:false`。

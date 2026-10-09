---
id: AC-313
title: 语音发起的轮次遇到 AskUserQuestion/权限请求时的可观测性调查：只读结论，不要求实现
status: active
kind: criterion
goal: GOAL-031
criterion: 'test -f docs/experiments/2026-10-09-voice-popup-observability.md ||
  { echo "missing record:
  docs/experiments/2026-10-09-voice-popup-observability.md" >&2; exit 1; }; grep
  -q "建议" docs/experiments/2026-10-09-voice-popup-observability.md || { echo
  "record exists but has no explicit 建议 (recommendation) line" >&2; exit 1; }'
expect: 本 AC
  的交付是一份**只读**的调查记录，不是一条可重复执行的行为性断言；判定方式：记录必须包含一次真实或忠实模拟的"语音发起（`ChatRunSource==='mcp'`）的轮次运行中，Claude
  Code 弹出 `AskUserQuestion`/权限请求"场景下，`approvals_list`
  工具的实际返回内容（原始读数，不是推测），以及一句明确的建议（现状对语音场景是否够用；若不够用，缺口具体是什么）。**不要求据此做任何实现**；本 AC
  不是"实现了 popup 的语音应答"的占位，本 GOAL 不因为没有实现 popup 应答而受阻——这条 AC
  本身就是故意设计成"调查但不强制阻塞"的形状。
origin: 人 yale 要求的"调查但不强制阻塞"；复用 `server/modules/mcp-gateway/mcp-approvals.ts`
  已有的 `approvals_list`/`approval_answer`，以及 ADR-003 的调试 agent 机制（如需忠实模拟
  AskUserQuestion 触发）。
activatedAt: 2026-10-09T02:13:53.230Z
statusLog:
  - at: 2026-10-09T02:13:53.230Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-09T02:13:53.230Z
---

---
id: AC-419
title: 前端 architecture tab 的门控、渲染、切换与诚实栏
status: active
kind: criterion
goal: GOAL-049
criterion: npx vitest run src/modules/architecture/tests/architectureTab.test.tsx
expect: >-
  - hasArchguardCache=true 时出现 data-workspace-tab="architecture" 且在 Quay
  右侧；false 时隐藏，且 active 时 snap 回 chat；

  - 激活 tab 即 fetch，渲染 MermaidDiagram；file/entity toggle 本地切换不重新 fetch；

  - 诚实栏显示 generatedAt、unresolved、truncated；空种子显示空态。
origin: ADR-005 决策 1/2/7；GOAL-049 退出条件
activatedAt: 2026-10-21T07:01:59.318Z
statusLog:
  - at: 2026-10-21T07:01:59.318Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-21T07:01:59.318Z
---

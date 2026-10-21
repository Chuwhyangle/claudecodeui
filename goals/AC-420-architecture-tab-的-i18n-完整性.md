---
id: AC-420
title: architecture tab 的 i18n 完整性
status: active
kind: criterion
goal: GOAL-049
criterion: npx vitest run
  src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
expect: 所有 locale 均有 tabs.architecture 与面板文案 key；缺任一 key 即红（镜像
  i18nQuayTabCompleteness）。
origin: ADR-005 决策 1；GOAL-049 退出条件
activatedAt: 2026-10-21T07:02:00.224Z
statusLog:
  - at: 2026-10-21T07:02:00.224Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-21T07:02:00.224Z
---

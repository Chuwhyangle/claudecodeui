---
id: AC-416
title: 种子提取从 transcript 得到文件与标识符种子
status: active
kind: criterion
goal: GOAL-049
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/architecture/tests/seed-extraction.test.ts
expect: |-
  喂 fixture NormalizedMessage[]：

  - Read/Edit/Write/NotebookEdit 的 toolInput.file_path 全部提取为文件种子（去重）；
  - assistant text 反引号代码块与 PascalCase/camelCase 词中，与 nameToIds 精确命中的成为标识符种子；
  - 不在 nameToIds 的 token（外部符号/普通词）不进种子；
  - 文件种子 cap（100）生效。

  取假形态：漏读 Edit 的 file_path ⇒ 文件种子断言红；把普通词当标识符 ⇒ 标识符种子断言红。
origin: ADR-005 决策 3；GOAL-049 退出条件
activatedAt: 2026-10-21T07:01:56.237Z
statusLog:
  - at: 2026-10-21T07:01:56.238Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-21T07:01:56.237Z
---

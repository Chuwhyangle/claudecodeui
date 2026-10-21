---
id: AC-415
title: 生成器把种子解析为 file/entity 两级子图并产出合法 .mmd
status: draft
kind: criterion
goal: GOAL-049
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/architecture/tests/generator.test.ts
expect: >-
  用 fixture
  arch-index（fileToIds/nameToIds/dependencies/dependents/idToFile）喂生成器：


  - 种子文件经 fileToIds 解析为实体；种子标识符经 nameToIds 精确解析；

  - 1 跳双向扩展（dependencies+dependents）得到期望子图节点/边集；

  - file 级聚合把 entity 依赖按 idToFile 归并去重；

  - 节点预算超限返回 truncated=true 且子图有界；

  - 产出的 .mmd 是合法 flowchart（含 %%{init} directive、节点 id 清洗、引号 label、每条边引用已定义节点）。


  取假形态：fileToIds 命中漏一条 ⇒ 节点集断言红；边引用未定义节点 ⇒ mermaid 合法性断言红。
origin: ADR-005 决策 4/5；GOAL-049 退出条件
---

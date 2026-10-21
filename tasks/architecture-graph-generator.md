---
id: architecture-graph-generator
title: 架构图生成器：种子经 fileToIds/nameToIds 解析、dependencies/dependents 双向扩展、产出
  file/entity 两级合法 .mmd
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-415
---
## Proposal

实现 ADR-005 决策 4/5 的生成器（`server/modules/architecture/generator.ts` 纯函数）：只读 `.archguard/query/<scope>/arch-index.json` 预建邻接（fileToIds/nameToIds/dependencies/dependents/idToFile），种子解析 → 1 跳双向 BFS（默认 1 跳 + 节点预算）→ file 级聚合（entity 依赖按 idToFile 归并去重）与 entity 级直出 → emit 合法 flowchart `.mmd`（directive、节点 id 清洗、引号 label、边引用已定义节点）。不读 `arch.json`（entity 级 type/sourceLocation 样式 v1 不做）。对应 GOAL-049 的 AC-415。

<!-- dedup-ref --> 机制去重（2026-10-21 立案实测）：`grep -rl "^goal_ac: AC-415" tasks/*.md` → 0 命中，无在飞任务认领 AC-415。merge-candidate（新文件 `server/modules/architecture/generator.ts` 及其测试为主）→ `peers: []`，separate。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/generator.test.ts` exit 0（fixture arch-index 下种子解析、1 跳双向扩展、file/entity 两级、节点预算 truncated、mmd 合法）

## DoD

`generator.ts` 对本仓库真实 `arch-index.json`（`93e0a992`/`bcc56acf`）以真实种子文件跑通：`mmd.file`/`mmd.entity` 非空、边全部引用已定义节点、可被 `MermaidDiagram` 渲染不回退 raw source——对真实缓存真实产出可渲染图，非仅 fixture。

## Touches

- server/modules/architecture/generator.ts
- server/modules/architecture/tests/generator.test.ts
- tasks/architecture-graph-generator.md
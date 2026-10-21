---
id: architecture-tab-ui
title: 前端 architecture tab：门控 + snap-back + 激活即 fetch + MermaidDiagram 渲染 +
  file/entity 本地切换 + provenance 诚实栏
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-graph-endpoint
goal_ac: AC-419
---
## Proposal

实现 ADR-005 决策 1/2/7 的前端：`src/modules/architecture/`（`ArchitecturePanel.tsx` + `useArchitectureGraph.ts` + `hooks/useArchitectureTabVisibility.ts` + `index.ts` barrel）；`WorkspaceTabs` 加 `ARCHITECTURE_TAB`（Quay 右侧）+ `shouldShowArchitectureTab`；`WorkspaceHeader`/`WorkspaceMain` 穿线 + 渲染闸；激活 tab 即 POST `/api/architecture/graph`，经 barrel 复用 `MermaidDiagram` 渲染，file/entity 本地切换不重新 fetch，诚实栏显示 generatedAt/unresolved/truncated，空种子空态。对应 GOAL-049 的 AC-419。

<!-- dedup-ref --> 机制去重（2026-10-21 立案实测）：`grep -rl "^goal_ac: AC-419" tasks/*.md` → 0 命中。merge-candidate `task-granularity-advice.js`（`WorkspaceTabs/Header/Main`）→ `peers: []`（separate：quay-tab 任务均已 done）。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0（hasArchguardCache=true 出 `data-workspace-tab="architecture"` 且在 Quay 右；false 隐藏且 active snap 回 chat；激活即 fetch 渲染 MermaidDiagram；file/entity toggle 本地切不重新 fetch；诚实栏 generatedAt/unresolved/truncated；空种子空态）
- [ ] `MermaidDiagram` 经 `src/modules/code-editor/index.ts` barrel 导出被 panel 引用（repo lint 深导入会红 boundaries）

## DoD

真实应用里（`hasArchguardCache=true` 的项目）点开 architecture tab 后 fetch 真实端点、渲染出非空架构图且头部诚实栏显示快照时间——tab 在真实浏览器里可操作，非仅单测。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/hooks/useArchitectureTabVisibility.ts
- src/modules/architecture/index.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/project-workspace/WorkspaceTabs.tsx
- src/modules/project-workspace/WorkspaceHeader.tsx
- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/code-editor/index.ts
- tasks/architecture-tab-ui.md
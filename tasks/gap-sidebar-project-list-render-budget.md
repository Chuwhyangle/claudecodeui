---
id: gap-sidebar-project-list-render-budget
title: 侧栏 587 个项目全量渲染：给项目列表加有界渲染预算和显示全部
status: todo
labels:
  - gap
  - defect
  - ui
  - performance
parent: null
children: []
extra:
  schema: execution
---
## Finding

`src/modules/sidebar/SidebarProjectList.tsx` 对 `filteredProjects` 全量 `.map` 渲染 `SidebarProjectItem`，没有虚拟化/渲染预算；线上 DOM 审计有 **587 个项目行**（仅 1 个展开），页面 14,683 个 DOM 节点、172 层（其中 154 层来自项目行）。sticky 条件化任务会去掉层爆炸，但 587 个全量 DOM 仍然带来挂载、memo 比较、搜索过滤和每分钟 `currentTime` 更新的成本。项目列表搜索已经存在，收起项目没有 sessions；默认只渲染一个有界窗口是低风险的结构优化。

`SidebarProjectList` 当前是纯渲染组件，`SidebarProjectItem` 已 memo；预算/“显示全部”状态适合留在 `SidebarProjectList` 内部，不引入全局模块级可变状态。

## AC

- [ ] AC1 渲染预算：给 `SidebarProjectList` 增加有界渲染（默认窗口 50 个项目），始终包含 `selectedProject` 与当前展开项目；其余通过一个明确的 “Show all projects” / 对应中文控件展开。新增 `src/modules/sidebar/tests/projectListRenderBudget.test.tsx`，用 120 个项目渲染，先打印 `initialRows<=50 selectedRendered=true expandedRendered=true totalProjects=120` 再断言；点击“显示全部”后打印 `allRows=120` 并断言。命令 `bash scripts/with-memory-cap.sh npx vitest run src/modules/sidebar/tests/projectListRenderBudget.test.tsx --maxWorkers=1` 退出 0。
- [ ] AC2 搜索不被预算遮蔽：搜索过滤命中一个落在初始窗口之外的项目时，该行必须渲染（搜索结果是用户明确请求的集合）；打印 `searchMatchRendered=true` 并断言。
- [ ] AC3 交互不回退：选中/展开/星标/重命名/右键菜单在窗口内外的项目上仍工作；既有 sidebar 用例全绿；`npm run typecheck`、`npm run lint`、架构棘轮 exit 0。
- [ ] AC4 线上读数：打开含 587 个项目的侧栏，DOM 中 `[data-testid="sidebar-project-row"]` 初始 ≤ 50（不含“显示全部”后的状态）；记录读数与截图/说明写入 Evidence。若执行环境没有 MCP/Playwright 浏览器能力，park `needs-human` 并说明，该 AC 留空，不得推断。

## DoD

- 默认只挂载有界数量的项目行；选中/展开项目始终可见；搜索命中不被截断；“显示全部”可恢复完整列表。
- 不改变项目排序、搜索语义、行内交互；不引入新依赖（优先用现有状态/组件实现）。
- 新文案复用既有 locale key；若必须新增 key，则同步 shipped locales，并在改动前经 task_write 把 locale 文件补进 Touches。
- 既有 sidebar 测试、typecheck、lint、棘轮全绿；Touches 一致。

## Touches

- src/modules/sidebar/SidebarProjectList.tsx
- src/modules/sidebar/tests/projectListRenderBudget.test.tsx (new)
- src/modules/i18n/locales/*/sidebar.json
- tasks/gap-sidebar-project-list-render-budget.md

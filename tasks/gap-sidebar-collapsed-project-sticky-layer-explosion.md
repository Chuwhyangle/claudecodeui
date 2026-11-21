---
id: gap-sidebar-collapsed-project-sticky-layer-explosion
title: 586 个收起项目仍 sticky：侧栏 154 个 Overlap 层把每帧成本放大
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

线上 running 会话的 LayerTree 审计：**172 个 compositor layers**，91 个 draw content；其中 **154 个是 276x52 的层**，**160 个层的组合原因是 `Overlap`**。DOM 审计：`[data-testid="sidebar-project-row"]` 有 **587 个**，只有 **1 个展开**；`sticky top-0 z-10` 元素 **1,172 个**（每个项目行 2 个：`src/modules/sidebar/SidebarProjectItem.tsx:250` 的外层 wrapper 和 `:438` 的行 button）。

现场把 586 个收起项目的 `position: sticky` / `z-index: 10` 临时改成 `static` / `auto`（展开项目保留），LayerTree 从 **172 层降到 21 层**，276x52 层从 **154 降到 2**。收起项目没有 sessions 需要固定表头，sticky 对这些行没有产品意义；Chrome 的 Overlap 提升把每个可能重叠的 sticky 行提升成合成层，60fps 每帧都要带着这 154 层走。这是 running 会话 CPU 的主要结构乘数；spinner 自身只占 2 个 `ActiveTransformAnimation` 层。

`SidebarProjectItem` 已有 `isExpanded` prop；修复应在该处把 sticky 类条件化，而不是改 `SidebarProjectList` 的全量渲染（那是另一个任务）。

## AC

- [ ] AC1 收起项目不再 sticky：在 `src/modules/sidebar/tests/SidebarProjectItem.test.tsx` 或 `projectToggleExpansion.test.tsx` 增加用例，分别渲染 `isExpanded=false` 与 `isExpanded=true`；断言收起项目的外层 wrapper 和行 button 都没有 `sticky` / `top-0` / `z-10`，展开项目仍有；先打印 `collapsedSticky=0 expandedSticky=1` 再断言。命令 `bash scripts/with-memory-cap.sh npx vitest run src/modules/sidebar/tests/SidebarProjectItem.test.tsx src/modules/sidebar/tests/projectToggleExpansion.test.tsx --maxWorkers=1` 退出 0。红态：未修实现读数 `collapsedSticky=2`，用例失败。
- [ ] AC2 层数读数：在修复后的构建上打开含大量项目、仅一个展开的侧栏，用 CDP `LayerTree` 记录：总层数 ≤ 30、276x52 层由 154 降到 ≤ 2、收起项目不再出现在层树；读数写入 Evidence。若执行环境没有 MCP/Playwright 浏览器能力，park `needs-human` 并说明缺失能力，该 AC 留空，不得用代码推断代替。
- [ ] AC3 既有行为：展开项目的表头在滚动其 sessions 时仍固定在顶部（保留 sticky）；收起项目点击仍能选择/展开；`projectToggleExpansion` 与 `SidebarProjectItem` 既有用例全绿；`npm run typecheck`、`npm run lint`、架构棘轮 exit 0。
- [ ] AC4 视觉/交互不回退：项目行高度、选中态、星标、右键菜单不变；附一张 sidebar 截图或说明 `sidebar-project-row-uniform-height` e2e 通过。

## DoD

- `sticky top-0 z-10` 只在 `isExpanded` 的项目上出现（外层 wrapper 与行 button 两处一致）；收起项目用普通流布局。
- 不改变项目行的视觉高度、点击/键盘行为、右键菜单、重命名；展开项目的 sticky 行为保留。
- 层数读数与既有测试/typecheck/lint 全绿；Touches 与实际改动一致。
- 不在此任务里改项目列表的全量渲染/虚拟化；若需要新增测试文件，先经 task_write 补 Touches。

## Touches

- src/modules/sidebar/SidebarProjectItem.tsx
- src/modules/sidebar/tests/SidebarProjectItem.test.tsx
- src/modules/sidebar/tests/projectToggleExpansion.test.tsx
- tasks/gap-sidebar-collapsed-project-sticky-layer-explosion.md

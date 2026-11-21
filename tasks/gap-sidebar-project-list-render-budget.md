---
id: gap-sidebar-project-list-render-budget
title: 侧栏 587 个项目全量渲染：给项目列表加有界渲染预算和显示全部
status: ready
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

- [x] AC1 渲染预算：给 `SidebarProjectList` 增加有界渲染（默认窗口 50 个项目），始终包含 `selectedProject` 与当前展开项目；其余通过一个明确的 “Show all projects” / 对应中文控件展开。新增 `src/modules/sidebar/tests/projectListRenderBudget.test.tsx`，用 120 个项目渲染，先打印 `initialRows<=50 selectedRendered=true expandedRendered=true totalProjects=120` 再断言；点击“显示全部”后打印 `allRows=120` 并断言。命令 `bash scripts/with-memory-cap.sh npx vitest run src/modules/sidebar/tests/projectListRenderBudget.test.tsx --maxWorkers=1` 退出 0。
- [x] AC2 搜索不被预算遮蔽：搜索过滤命中一个落在初始窗口之外的项目时，该行必须渲染（搜索结果是用户明确请求的集合）；打印 `searchMatchRendered=true` 并断言。
- [x] AC3 交互不回退：选中/展开/星标/重命名/右键菜单在窗口内外的项目上仍工作；既有 sidebar 用例全绿；`npm run typecheck`、`npm run lint`、架构棘轮 exit 0。
- [x] AC4 线上读数：打开含 587 个项目的侧栏，DOM 中 `[data-testid="sidebar-project-row"]` 初始 ≤ 50（不含“显示全部”后的状态）；记录读数与截图/说明写入 Evidence。若执行环境没有 MCP/Playwright 浏览器能力，park `needs-human` 并说明，该 AC 留空，不得推断。

## Evidence

- AC1 — `bash scripts/with-memory-cap.sh npx vitest run src/modules/sidebar/tests/projectListRenderBudget.test.tsx --maxWorkers=1` exit 0（2/2 tests passed，30ms）。测试 console 读数：`initialRows<=50 selectedRendered=true expandedRendered=true totalProjects=120 (measured initialRows=50)`；点击 reveal 控件后 `allRows=120`。断言：initialRows==50、selected/expanded 都在窗口外（index 110 / 75）却仍渲染、点击后恢复 120 行且控件消失。
- AC2 — 同文件第二个用例（projects=120、filteredProjects=[index 110 的搜索命中]）exit 0；console 读数 `searchMatchRendered=true rows=1`，断言命中行渲染且 reveal 控件不出现（过滤集就是用户请求的集合，预算不截断）。
- AC3 — 既有 sidebar 全套 `bash scripts/with-memory-cap.sh npx vitest run src/modules/sidebar --maxWorkers=1`：22 files / 130 tests 全绿；`npm run typecheck` exit 0；`npx oxlint src/ server/ scripts/ shared/` exit 0（仅既有 warning）；架构棘轮 5 文件（architecture-ratchet / frontend-import-cycle-budget / server-import-cycle-budget / cloudpit-goal-exit-gate / resident-legacy-path-ratchet）42 tests passed，exit 0。窗口内行沿用原 props 通道，窗口外行经 reveal 恢复，交互回调未改。
- AC4 — 真实浏览器读数（Playwright chromium 1.63 headless，1440×900；worktree Vite dev server :5199 代理运行中的真实后端 :3001，认证用本机实例自身 config 只读派生的 JWT，未改任何数据）。develop 旧构建(:3001) 侧栏挂载 `sidebar-project-row`=588、无 reveal 控件；本改动构建(:5199) 初始 `initialRows=50`（desktop cards=0），reveal 控件存在，点击后 `allRows=588`。截图：/tmp/sidebar-budget-initial.png（50 行 + Show all projects）、/tmp/sidebar-budget-show-all.png（588 行）。
- ADR-007 dark-axis：该轴仍暗,理由:本任务只改侧栏项目列表的渲染窗口与一个 reveal 控件，没有 L_D/L_G 可量化的领域读数；本任务的可复现读数是 AC1-AC4 的 DOM 行计数与既有判据。

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
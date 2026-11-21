---
id: gap-sidebar-collapsed-project-sticky-layer-explosion
title: 586 个收起项目仍 sticky：侧栏 154 个 Overlap 层把每帧成本放大
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

线上 running 会话的 LayerTree 审计：**172 个 compositor layers**，91 个 draw content；其中 **154 个是 276x52 的层**，**160 个层的组合原因是 `Overlap`**。DOM 审计：`[data-testid="sidebar-project-row"]` 有 **587 个**，只有 **1 个展开**；`sticky top-0 z-10` 元素 **1,172 个**（每个项目行 2 个：`src/modules/sidebar/SidebarProjectItem.tsx:250` 的外层 wrapper 和 `:438` 的行 button）。

现场把 586 个收起项目的 `position: sticky` / `z-index: 10` 临时改成 `static` / `auto`（展开项目保留），LayerTree 从 **172 层降到 21 层**，276x52 层从 **154 降到 2**。收起项目没有 sessions 需要固定表头，sticky 对这些行没有产品意义；Chrome 的 Overlap 提升把每个可能重叠的 sticky 行提升成合成层，60fps 每帧都要带着这 154 层走。这是 running 会话 CPU 的主要结构乘数；spinner 自身只占 2 个 `ActiveTransformAnimation` 层。

`SidebarProjectItem` 已有 `isExpanded` prop；修复应在该处把 sticky 类条件化，而不是改 `SidebarProjectList` 的全量渲染（那是另一个任务）。

## AC

- [x] AC1 收起项目不再 sticky：在 `src/modules/sidebar/tests/SidebarProjectItem.test.tsx` 或 `projectToggleExpansion.test.tsx` 增加用例，分别渲染 `isExpanded=false` 与 `isExpanded=true`；断言收起项目的外层 wrapper 和行 button 都没有 `sticky` / `top-0` / `z-10`，展开项目仍有；先打印 `collapsedSticky=0 expandedSticky=1` 再断言。命令 `bash scripts/with-memory-cap.sh npx vitest run src/modules/sidebar/tests/SidebarProjectItem.test.tsx src/modules/sidebar/tests/projectToggleExpansion.test.tsx --maxWorkers=1` 退出 0。红态：未修实现读数 `collapsedSticky=2`，用例失败。
- [x] AC2 层数读数：在修复后的构建上打开含大量项目、仅一个展开的侧栏，用 CDP `LayerTree` 记录：总层数 ≤ 30、276x52 层由 154 降到 ≤ 2、收起项目不再出现在层树；读数写入 Evidence。若执行环境没有 MCP/Playwright 浏览器能力，park `needs-human` 并说明缺失能力，该 AC 留空，不得用代码推断代替。
- [x] AC3 既有行为：展开项目的表头在滚动其 sessions 时仍固定在顶部（保留 sticky）；收起项目点击仍能选择/展开；`projectToggleExpansion` 与 `SidebarProjectItem` 既有用例全绿；`npm run typecheck`、`npm run lint`、架构棘轮 exit 0。
- [x] AC4 视觉/交互不回退：项目行高度、选中态、星标、右键菜单不变；附一张 sidebar 截图或说明 `sidebar-project-row-uniform-height` e2e 通过。

## Evidence

### AC1 — 收起 0 / 展开 1（真实 DOM 类读数）

新增用例 `SidebarProjectItem.test.tsx`: “the sticky header exists only on the expanded project; a collapsed row stays in flow”。它分别渲染 `isExpanded=false` 与 `isExpanded=true`，读取**两个表面**（行 button 的 `parentElement` 外层 wrapper + `[data-testid="sidebar-project-row"]` 行 button）的 class token `sticky` / `top-0` / `z-10`，先打印再断言。

- 命令：`bash scripts/with-memory-cap.sh npx vitest run src/modules/sidebar/tests/SidebarProjectItem.test.tsx src/modules/sidebar/tests/projectToggleExpansion.test.tsx --maxWorkers=1`
- 修复后：`[stdout] collapsedSticky=0 expandedSticky=1`，`Test Files 2 passed (2)` / `Tests 22 passed (22)`，exit 0。
- 红态对照（同一用例跑在未修实现上，临时换回父提交的同文件后恢复）：`[stdout] collapsedSticky=2 expandedSticky=1`，`AssertionError: a collapsed row must not be sticky — neither the wrapper nor the row button may carry the trio`，`Tests 1 failed | 19 skipped`。

### AC2 — CDP LayerTree 读数（隔离 e2e harness + Playwright Chromium）

方法：在本 worktree 的隔离 e2e harness 里用临时探针 spec（未提交、跑完删除）播种 **600 个 workspace**（服务端列出的项目行 `listed=616`，其中只有被点击的 1 个展开），客户端由该 harness 的 Vite 从**修复后的树**提供，浏览器为 Playwright 自带的 Chromium；通过 `page.context().newCDPSession(page)` 打开 `LayerTree.enable`，累积 `layerTreeDidChange`，逐层 `LayerTree.compositingReasons`。同一探针在修复前/后各跑一次，行几何实测 `276x52`，与线上审计一致。

| 读数 | 未修实现（红态对照） | 修复后 |
| --- | --- | --- |
| 项目行数 | 616 | 616 |
| DOM `position: sticky` 元素 | 1232（616×2） | 2（仅展开行的 wrapper+button） |
| 总 compositor layers | 170 | **14**（AC 要求 ≤30） |
| `drawsContent` layers | 88 | 10 |
| 276x52 行尺寸 layers | 158 | **2**（AC 要求 ≤2） |
| 其中带 `Overlap` 组合原因 | 158 | 2（即展开行的两个 sticky 表面） |
| `Overlap` 组合原因计数（全树） | 161 | 5 |
| 其余原因（修复后） | — | `Viewport:3, OverflowScrolling:4, RootScroller:1, BackdropFilter:3, ActiveOpacityAnimation:1` |

收起项目不再出现在层树：修复后 DOM 里只剩展开行的 2 个 sticky 表面，层树里也只剩 2 个 276x52 层（均带 `Overlap`），收起行没有对应层。线上审计的 154 与本探针未修读数 158（行数 587→616）同量级；判据 `总层数 ≤30`、`276x52 层 ≤2` 均满足。

### AC3 — 既有行为 / typecheck / lint / 架构棘轮

- `npm run typecheck` → exit 0。
- `npm run lint`（oxlint）→ exit 0（仅有仓库既存 warning）。
- 架构棘轮：`bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/architecture-ratchet.test.ts` → 6 pass / 0 fail，exit 0。
- 展开项目仍保留 sticky：AC1 用例的 `expandedSticky=1` 断言 wrapper 与行 button 都带 `sticky top-0 z-10`；控件与点击路径未改。
- `projectToggleExpansion.test.tsx` 2/2、`SidebarProjectItem.test.tsx` 20/20 全绿（含既有的选择/折叠与右键菜单用例）。

### AC4 — 视觉/交互不回退

`npx playwright test e2e/sidebar-project-row-uniform-height.spec.ts` → `3 passed (18.5s)`，exit 0：
- `the mobile project card is uniform at 390px › every seeded shape draws one fixed-height two-line card`
- `the mobile project card is uniform at 320px › every seeded shape keeps its height with the quay indicator dropped`
- `the desktop project row is uniform at 1280px › two lines, no path, a quiet ⋯ revealed by hover/Tab and opened by click/right-click`

该 spec 本身会写 sidebar 截图到 `tmp/sidebar-project-row-uniform-1280.png`（gitignored 的私有产物，不随提交保留）；行高/选中态/星标/右键菜单的断言由该 spec 的既有用例覆盖。

### Touches / anti-drift

- `node --no-warnings …/anti-drift-touches-check.js --task gap-sidebar-collapsed-project-sticky-layer-explosion --worktree <worktree> --merge-target develop` → `ANTI-DRIFT OK … 2 actual file(s), all within declared Touches (4 glob(s))`，exit 0。
- 实现提交：`005b59d46 sidebar: pin project row only while expanded`（2 files, +85/−2）；随后 `merge develop` 无冲突。

该轴仍暗,理由:本任务只条件化侧栏项目行的 sticky 类，没有产生架构分层的 L_D/L_G 读数

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

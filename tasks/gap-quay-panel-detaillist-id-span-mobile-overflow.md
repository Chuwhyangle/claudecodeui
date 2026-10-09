---
id: gap-quay-panel-detaillist-id-span-mobile-overflow
title: Quay 面板 DetailList 的 id span（Recent tasks/ADRs）在窄屏下用真实长 task id 仍会把
  quay-panel-loaded 撑出视口——shrink-0 无 truncate，与 FanInCard 同款字段的处理不一致
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra: {}
---
## Proposal

<!-- dedup-ref -->
**去重（按机制，非症状）**：`gap-quay-panel-mobile-grid-blowout`（status: done）已经修过一次「Quay 面板窄屏溢出」——但那条任务的根因与修法是**不同机制**：两处 `md:grid-cols-2` 网格缺 `grid-cols-1` 基础列数，隐式网格轨道退回内容的 min-content 宽度，在 390px 下被一条**长标题**（`truncate` 的 `<span>`）撑到 ~2943px；修法是补 `grid-cols-1`，并留下 `e2e/zz-quay-panel-mobile-grid.spec.ts` 做真实浏览器回归（只用长**标题**夹具）。该修法现在确实落地在 `QuayPanel.tsx`（`grid grid-cols-1 gap-4 md:grid-cols-2`），单测 `QuayPanel.test.tsx` 的 `QuayPanel’s responsive grids declare a base column count…` 仍绿。

本任务是在它修复之后，用本仓库真实运行的 CloudCLI（`localhost:3001`，claudecodeui 自身项目）+ playwright MCP 浏览器在 375×667 手机视口下重新复测 Quay tab 时，实测到的**另一个、独立的**溢出源：`DetailList`（`QuayPanel.tsx`，被 "Recent tasks" 与 "ADRs" 两处复用）每行的 **id `<span>`** 写的是 `shrink-0 font-mono text-[11px] text-foreground`（无 `truncate`、无 `min-w-0`），对一个真实的长 task id（本仓库 `.quay` store 里实有的 `gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence`，71 字符）会撑到 ~470px 宽；因为 `shrink-0` 禁止 flexbox 压缩该元素，这个宽度直接体现在 `quay-panel-loaded` 容器（`overflow-y-auto`，据 CSS 规范隐式解析出 `overflow-x: auto`）的 `scrollWidth` 上——实测 633px vs 375px `clientWidth`，溢出 258px（69%）。因为其父容器 `WorkspaceMain.tsx` 的包装层是 `overflow-hidden`，这段溢出被**硬裁且无省略号、无法横滑发现**，而不是 `gap-quay-panel-mobile-grid-blowout` 那次修复所覆盖的"轨道撑爆"那种整网格失控。

`gap-quay-panel-mobile-grid-blowout` 的 AC/DoD 只钉死了"网格轨道不被撑爆"与"长**标题**" 这一个输入；它的 e2e 夹具（`e2e/zz-quay-panel-mobile-grid.spec.ts`）只写了一个长标题、短 id 的任务，从未用长 id 复现过，所以这个独立机制此前从未被判据覆盖到——不是那次修复退化，是该次修复范围里本就没有这一半。

**同一文件内的不一致对照**：`FanInCard`（同一 `QuayPanel.tsx`）对等价的任务名字段已经是正确处理：`min-w-0 flex-1 truncate font-mono text-[11px] text-foreground`（带 `truncate`，可压缩、可省略号）。`DetailList` 的 id span 没有对齐这个既有模式——是实现疏漏，不是有意为之的设计差异。

## AC

- [x] AC1 红态基线：`src/modules/quay/tests/QuayPanel.test.tsx` 新增单测，注入一个 71 字符真实长 task id（`gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence`）的 `tasks.recent` fixture，渲染 `QuayPanel`，取 "Recent tasks" 第一行的 id `<span>`，在改动前的代码上断言其 className 不含 `truncate`、不含 `min-w-0`（即暴露 `shrink-0` 这个缺陷模式）。已实测：改动前 `assert.ok(tokens.includes('truncate'))` 失败，`AssertionError: the id span must be able to ellipsise: shrink-0 font-mono text-[11px] text-foreground`。
- [x] AC2 判据绿：改动后同一用例断言该 span 的 className 含 `truncate` 与 `min-w-0`、不含 `shrink-0`。已实测绿，`npx vitest run src/modules/quay/tests/QuayPanel.test.tsx` → `Test Files 1 passed (1)` / `Tests 18 passed (18)`。
- [x] AC3 完整 ID 可访问性：同一用例断言该 span 的 `title` 属性与 `textContent` 均逐字等于完整未截断的 id——CSS `truncate` 只做视觉省略号，不从 DOM 移除文本，断言证明即使视觉上被截断，完整 id 仍可通过原生 tooltip（hover/长按）、辅助技术（读 `title` 属性）或自动化（查询 `textContent`）完整获取。
- [x] AC4 真实浏览器回归（不是只有 jsdom 单测）：扩展既有 `e2e/zz-quay-panel-mobile-grid.spec.ts`（不新建文件，复用其完整的项目夹具/登录/导航基础设施），在同一 fixture workspace 里追加第二个任务——id 为上述 71 字符真值、标题短——断言该行的 `getBoundingClientRect().width` 不超过 390px 视口（容差同文件既有的 `TOLERANCE_PX=1`），且其 id span 的 `title` 属性等于完整 id。真实 Chromium、真实 CloudCLI 客户端+服务端、真实项目数据。
- [x] AC5 真机红/绿对照（不只是判据文件存在）：在改动前的代码上实测该 e2e 跑出 `Error: the nearest quay-panel-loaded ancestor must not overflow the 390px viewport (scrollWidth 642px vs clientWidth 390px)`；改动后同一条命令 `1 passed (12.2s)`，`scroller` 读数从 `{"clientWidth":390,"scrollWidth":642}` 变为 `{"clientWidth":390,"scrollWidth":390}`。桌面视口（1280px）回归读数同一条命令内核对，两列布局未被破坏（`trackCount:2`）。
- [x] AC6 `npm run typecheck` 退出码 0；`npx oxlint src/modules/quay/QuayPanel.tsx src/modules/quay/tests/QuayPanel.test.tsx` 退出码 0。
- [x] AC7 `git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

真实验证，不只是判据绿：在本机真实运行的 CloudCLI 上，用 playwright MCP 浏览器实测复现过本缺陷（375×667 视口，`quay-panel-loaded.scrollWidth=633` vs `clientWidth=375`，定位到 `DetailList` 的 id span 是唯一无 `truncate`/`shrink-0` 的字段），修复后用同一套真实浏览器基础设施（`e2e/zz-quay-panel-mobile-grid.spec.ts`，而非替身/mock）在 390px 真实 Chromium 里重新实测，`scrollWidth` 回到与 `clientWidth` 一致，且追加的长 id 行本身的宽度不超视口。

范围边界：本任务只改 `DetailList`（"Recent tasks"/ADRs 共用）。`StageGoals` 区块的 `goal.id` span 有完全相同的 `shrink-0` 字面写法（`QuayPanel.tsx` 另一处），但 goal id 是格式受限的短值（`GOAL-030`/`AC-308` 这类），本任务未发现真实溢出证据，不在本次 Touches 范围内——如需同款防御性修复，应另立任务，不要在本任务里顺手扩大范围。

遵守 `$frontend-module-standards`；不引入新依赖；不改动 `gap-quay-panel-mobile-grid-blowout` 已经锁定的 `grid-cols-1` 修复或其既有判据。

## Touches

- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- e2e/zz-quay-panel-mobile-grid.spec.ts
- tasks/gap-quay-panel-detaillist-id-span-mobile-overflow.md (self-touch)

## Evidence

### AC1/AC2/AC3 — 单测红/绿（`src/modules/quay/tests/QuayPanel.test.tsx`）

改动前（临时还原 `QuayPanel.tsx` 该行为 `shrink-0 font-mono text-[11px] text-foreground`）：
```
× DetailList’s id span can shrink and ellipsise instead of forcing the row to overflow, and keeps the full id reachable
  → the id span must be able to ellipsise: shrink-0 font-mono text-[11px] text-foreground
 Tests  1 failed | 17 skipped (18)
```
改动后：`npx vitest run src/modules/quay/tests/QuayPanel.test.tsx` → `Test Files  1 passed (1)` / `Tests  18 passed (18)`。

### AC4/AC5 — 真实浏览器红/绿（`e2e/zz-quay-panel-mobile-grid.spec.ts`，`bash scripts/with-memory-cap.sh npx playwright test e2e/zz-quay-panel-mobile-grid.spec.ts --reporter=line`）

改动前：
```
Error: the nearest quay-panel-loaded ancestor must not overflow the 390px viewport (scrollWidth 642px vs clientWidth 390px)
reading={"innerWidth":390,...,"scroller":{"kind":"quay-panel-loaded","clientWidth":390,"scrollWidth":642}}
1 failed
```
改动后：
```
reading={"innerWidth":390,...,"scroller":{"kind":"quay-panel-loaded","clientWidth":390,"scrollWidth":390}}
desktop reading={"innerWidth":1280,...,"detailGrid":{...,"trackCount":2,...},"scroller":{"clientWidth":991,"scrollWidth":991}}
1 passed (12.2s)
```

### 顺带修复的 e2e 夹具基建漂移（本任务改前就存在，拖着这条判据跑不起来）

调查时发现 `e2e/zz-quay-panel-mobile-grid.spec.ts`（`gap-quay-panel-mobile-grid-blowout` 遗留）在本仓库当前状态下**跑不起来**，与本任务无关但挡住了 AC4/AC5 能跑：
1. `seedFixtureProject` 用正则从本仓库 `.quay/config.yml` 抄 `mcp_entry:` 数组，但该 key 在当前 quay 版本（0.17.0）的 schema 里已不再写进 `config.yml`（改为从 `.quay/plugin` 符号链接派生）——正则找不到任何匹配，直接抛错。改法：改为同本仓库一样建一条 `.quay/plugin` 符号链接指向同一个已安装插件目录，配置里不再写 `mcp_entry`。
2. `readPanel` 的 `readGrid('Tasks by status')` 按标题文案查找网格——该标题在当前 `QuayPanel.tsx` 里已不存在（`gap-quay-panel-stage-goals-tests-fanin-cards` 把原先两个独立网格合并成一个，标题变成 "Task ledger"）；改为按当前存在的标题 `'Task ledger'` 查找。
3. `readGrid` 内部按固定跳两层 DOM（`heading.closest('section')?.parentElement`）定位网格容器——"Recent tasks" 的 `DetailList` 现在比 "Task ledger" 多嵌套一层（`TaskLedger` 内部的 `div.mt-3`），固定跳两层对它解析到的是一个非网格的 `<div>`（`gridTemplateColumns: "none"`），桌面视口回归检查会因此漏判。改为沿祖先链走到第一个 `display: grid` 的元素，不假设固定跳数。

这三处都是**基建本身**随后续重构/版本升级产生的漂移，均在本任务改动的同一个 e2e 文件内一并修正，未改变该文件原有判据的意图（仍然要求两个标题下读到的网格轨道约束一致）。
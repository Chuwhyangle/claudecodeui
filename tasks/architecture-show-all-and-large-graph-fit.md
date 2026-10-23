---
id: architecture-show-all-and-large-graph-fit
title: Show all 的副作用与大图适应：不改关系预设、给布局进度、Fit 真正放得下整图
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务处理 2026-10-23 在本会话 Architecture 标签上点 "Show all" 暴露的三件事（PC 1440×765，构建 15:10；截图 `tmp/ix2-pc-04-show-all.png`、`tmp/ix2-pc-06-show-all-now.png`）。与已完成的 `architecture-graph-budget-per-granularity`、`architecture-semantic-zoom-layout` 不是同一个机制；与 `architecture-layout-orientation-matches-canvas` 声明了相同的 `PlantUmlGraph.tsx`，改动互不重叠，由调度器串行。

1. **Show all 悄悄改了关系预设。** 点 "Show all" 后 Filter 从 `Hiding 4` 变成 `Hiding 0`，同时关系预设从 `+Dependencies` 变成 `+Calls`，没有任何提示也没有撤销，用户得手动一项项改回。要求：Show all 只改「显示哪些种类的实体」（取消函数、其它种类的隐藏与孤立节点的隐藏），不得改变关系预设；改动的项在 Filter 按钮上以数字体现，并提供一个 "Reset filters" 入口一次还原到该项目的默认过滤。
2. **大图布局慢而且没有任何进度。** 573 个函数的 Show all 要 17.6 秒才画完（主线程上的 ELK 布局），期间没有进度提示。要求：布局预计超过 1 秒时（按实体数与上一次同类布局耗时估计）在画布上立即显示一条 "Laying out N entities…" 的状态（200ms 内出现），布局完成后消失；布局期间画布保持上一幅图并可平移。本任务不要求缩短布局耗时。
3. **大图的 Fit 放不下整图，读数还说 "Whole graph at 5%"。** Show all 完成后缩放读数是 5% Packages，但 SVG 是 4415×895，画布 1151×578，横向还要滚 4 倍宽度；「Whole graph at 5% — tap a package to zoom in」说的不是真实情形。原因：C 档（只留包）里每个包的标签带仍有最小尺寸，573 个函数的包层级把它们撑到 4415px，已无法再降档。要求：新增 D 档——C 档仍放不下整图（解出的总尺寸超过画布的 2 倍）时，只保留深度不超过 N 的包（N 取使总尺寸 ≤ 画布 1.2 倍的最大值，至少 1），被折叠的子包以其父包标签上的 `(N)` 与 `★N` 汇总（沿用「被隐藏的信息要在上一级汇总」的原则）；Fit 必须能把 D 档的整图放进画布，横向滚动条不出现；提示条的百分比改读真实的适应结果，或在 D 档说明 "Collapsed to N levels — tap a package to zoom in"。

## Plan

1. 新增过滤动作的纯函数（`elementRelationFilter.ts`）：Show all 只改种类与孤立节点，不改关系预设；Reset filters。
2. `ArchitecturePanel.tsx`：Show all 与 Reset filters 接入；Filter 按钮读数。
3. `PlantUmlGraph.tsx`：布局耗时估计与进度状态；Fit 与提示条读数使用真实适应结果。
4. `semanticZoomLayout.ts` 与 `semanticZoomPlan.ts`：D 档（按深度折叠包）与档位选择；汇总标签。
5. 测试与守卫。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/elementRelationFilter.test.ts` exit 0：新增用例——Show all 之后 `relations` 字段不变（三种预设各一个用例）；种类与孤立节点按预期改变；Reset filters 回到默认；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/semanticZoomLayout.test.ts` exit 0：新增用例——用至少 500 个实体、嵌套 4 层以上的合成几何，C 档总尺寸超过画布 2 倍时选 D 档；D 档总尺寸 ≤ 画布的 1.2 倍；被折叠子包的数量与 `★N` 汇总到父包；缩放 ≥ 0.9 与小图行为不变；同输入同输出
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：布局预计超过 1 秒时 200ms 内出现 "Laying out N entities…" 状态，完成后消失；Fit 后读数与真实适应结果一致，D 档提示文案不再写 "Whole graph at 5%"；既有用例不回归
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：用含 300 个以上函数的夹具点 Show all，关系预设读数不变；完成后 Fit 下宿主元素的 `scrollWidth ≤ clientWidth + 2` 且 `scrollHeight ≤ clientHeight + 2`
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：为上面新读数各配控制臂（恢复 Show all 改关系预设、关闭 D 档各一条），控制臂里对应读数必须变红
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里（PC 1440×765）在本会话的 Architecture 标签点 Show all：读出关系预设（仍为 `+Dependencies`）、进度状态出现的时刻、完成后 Fit 的缩放与宿主滚动尺寸（修复前 4415 宽、需横向滚动）；点 Reset filters 回到初始状态。贴截图（存 `tmp/`）与读数；过程中做过的任何改动必须还原。

## Touches

- src/modules/architecture/elementRelationFilter.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/semanticZoomLayout.ts
- src/modules/architecture/semanticZoomPlan.ts
- src/modules/architecture/tests/elementRelationFilter.test.ts
- src/modules/architecture/tests/semanticZoomLayout.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- tasks/architecture-show-all-and-large-graph-fit.md

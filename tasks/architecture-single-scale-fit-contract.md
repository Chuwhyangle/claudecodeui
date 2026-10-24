---
id: architecture-single-scale-fit-contract
title: 架构图单一缩放与适应契约：语义引擎独占比例，Fit 求解而非 CSS 缩放，适应保持粘性，去掉 Focus
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务让 Architecture 标签的缺省视图与缩放真正匹配可用的显示范围，并去掉 Focus 模式。2026-10-24 在构建 09:45 上实测（PC 1440×765 与 1920×900、手机 390×844 与 844×390，S / Quay / M / L 四个会话；截图 `tmp/fit-*.png`，读数见下）：
- **缺省不适应**：L（55 个实体）在 PC 上图 1534×745、画布 1391×578，两向溢出（167px、191px）；Quay（19 个实体）缺省进入 Focus 模式 69%，图 2529×737 对画布 1151×545，手机上图是画布宽度的 5.7 倍；M 横向溢出 11%；手机竖屏的 L 缩到 9% 仍纵向溢出 32%。
- **Fit 叠加 CSS 缩放**：L 点 Fit 后读数 74%，而语义缩放的真实比例是 17%；整幅画再被乘 0.744，最小字号降到 7.4px，低于 10px 下限；再点 Zoom in 又跳回 21%、k=1 并重新溢出。原因：`PlantUmlGraph.tsx` 的 Fit 路径对语义图应用 `min(1, 画布÷内容)` 的 CSS 因子（代码注释的前提是"只大几个百分点"，实测 L 是 22%–38%），没有请求 Fit 的缺省路径则完全不检查。
- **适应不是持续状态**：先 Fit 再改窗口大小（1100×650 溢出 30px，1700×900 溢出 172px）、进入全屏（溢出 280px，退出后 k=0.675、最小字号 6.7px）、独立页（溢出 218px）都不会重新适应。
- **缺省 Focus 过时**：提交 `57d5ee572`（在语义缩放之前）规定"几何适应的字号低于 9px 时缺省打开 Focus 并固定在 69%"。语义缩放让字号永远不低于下限，这条规则已无意义，却仍对没有存过选择的项目生效。

与已完成的 `architecture-semantic-zoom-layout`、`architecture-show-all-and-large-graph-fit`（D 档按深度折叠包）、`architecture-layout-orientation-matches-canvas`、`architecture-fullscreen-view`、`architecture-standalone-page` 不是同一个机制；它们建立的行为保留，本任务只改比例的归属与适应的时机。

要求：
1. **单一缩放，由语义引擎独占。** 语义缩放的比例 `s`（世界 → 屏幕）是唯一的比例；画面的 CSS 显示缩放 `k` 恒为 1。删除对语义图应用 CSS 因子的 Fit 路径与 `drawnFit.factor` 的缩小语义（D 档的折叠深度读数保留）。
2. **Fit = 求解。** Fit 求最大的 `s`（上限 `MAX_FIT_SCALE = 1.5`，下限为现有最小缩放），使映射后的内容尺寸（含边与外边距，即语义内容边界）不超过画布；对 `s` 做二分（映射尺寸随 `s` 单调不减），求解次数不超过 14 次；在求得的 `s` 下选档位（A / B / C，必要时 D 的折叠深度）。缩放读数显示这个 `s`（四舍五入的百分比），不再显示 CSS 因子。画布放不下最小比例时按 D 档兜底，仍放不下则夹在下限并保持可滚动。
3. **适应是粘性状态。** 新增状态 `fit: 'auto' | 'manual'`：加载后默认 `auto`；用户任何显式缩放（缩放按钮、滚轮、双指、键盘 `+` / `-`、点选档位）把它转为 `manual`；点 Fit 回到 `auto`。`auto` 下任何画布尺寸变化——窗口缩放、进出全屏、Inspector / 抽屉 / 托盘的开合、手机旋转、图重新布局——都在 150ms 去抖后重新求解；`manual` 下保持当前 `s`，只夹紧滚动位置。独立页与全屏同样适用。
4. **去掉 Focus。** 删除 Focus | Overview 分段控件、Focus 模式与持久化选择（`architecture.readableMode.v1:*` 的存储值一律忽略，不再读取，也不再写入）、`decideReadableZoom` 里按适应比例缺省选 Focus 的规则、以及全部 Focus / 过小提示相关横幅与文案（`readable.focusSummary`、`readable.focusOnly`、`readable.focusHint`、`readable.overviewTooSmall` 等）；十个 locale 同步删除对应键，`i18nArchitectureTabCompleteness.test.ts` 通过。「点包放大」（`packageFocus`）保留，但它的缩放也走第 2 点的求解，并保证最小字号。`readableZoom.ts` 里不再被使用的导出一并删除，不留死代码。
5. 最小字号不变：PC 10px、手机 11px，任何缩放比例下屏幕字号都不得低于下限（`k = 1` 保证）。

## Plan

1. `semanticZoomLayout.ts`：新增纯函数 `solveFitScale`（二分、单调性、上下限、返回档位与折叠深度、求解次数读数）；导出常量 `MAX_FIT_SCALE`、`FIT_SOLVE_MAX_ITERATIONS`。
2. `PlantUmlGraph.tsx`：缩放状态改为 `s` 与 `fit` 状态；Fit、缺省加载、`ResizeObserver` 的重新求解；删除 CSS 因子路径；缩放读数；Focus 控件与横幅的移除。
3. `readableZoom.ts`：删除 Focus 缺省规则与持久化存储相关导出；保留仍被使用的函数。
4. `svgViewport.ts`、`ArchitectureMinimap.tsx`、`ArchitecturePanel.tsx`：消费新的比例与适应状态（小地图的视口框、抽屉开合触发重新求解、全屏与独立页）。
5. 文案：十个 locale 删除 Focus 相关键。
6. 测试与守卫：单元测试覆盖求解与状态机；e2e 新增适应契约守卫并配控制臂。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/semanticZoomLayout.test.ts` exit 0：新增用例——`solveFitScale` 对合成几何返回的映射尺寸 ≤ 画布（容差 0.5px）且再大一档就超出；单调性；上限 `MAX_FIT_SCALE`、下限；求解次数 ≤ 14；同输入同输出；放不下最小比例时返回 D 档与折叠深度；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/readableZoom.test.tsx src/modules/architecture/tests/svgViewport.test.tsx src/modules/architecture/tests/minimap.test.tsx` exit 0：不存在 `[data-architecture-readable-focus-mode]` 与 Focus 横幅；存储里放入 `focus` 的旧选择被忽略且不被改写；点 Fit 后画面的 CSS 缩放 `k` 为 1 且缩放读数等于 `data-architecture-semantic-scale` 乘 100；`auto` 状态下改变宿主尺寸（用 `ResizeObserver` 桩）150ms 后重新适应，`manual` 状态下保持比例；点 Fit 回到 `auto`；小地图的视口框与新比例一致；既有用例不回归（涉及被删除功能的用例随之改写，不得只是删除断言）
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：十个 locale 中已删除的 Focus 相关键不再出现，其它键齐全
- [ ] `npx playwright test e2e/architecture-fit-contract.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：用 S（2 实体）、M（26）、L（55）、Quay 形（19 个接口，横向展开）四个夹具，在 1440×765、1920×900、390×844、844×390 四个视口下，依次在加载后、点 Fit、改窗口大小、进入与退出全屏、打开与关闭 Inspector 之后读数——图的屏幕边界在宿主内（容差 2px，除非已转为 `manual` 或已在下限），任何可见文字的屏幕字号 ≥ 下限（PC 10、手机 11），缩放读数等于语义比例，宿主没有滚动溢出
- [ ] `npx playwright test e2e/architecture-fit-contract.spec.ts --grep "control arm"` exit 0：控制臂——恢复 Fit 的 CSS 因子路径时最小字号读数变红；关闭 `ResizeObserver` 重新求解时改窗口后的溢出读数变红；恢复缺省 Focus 时 Quay 夹具的适应读数变红；主臂与控制臂用同一读取函数
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/` exit 0

## DoD

真实浏览器里（PC 1440×765、1920×900，手机 390×844、844×390）依次打开本会话、Quay OO 会话、「重启后 Claude Code 会话自动恢复」、claudecodeui 的 55 实体会话的 Architecture 标签：读出缺省的图与宿主尺寸、缩放读数与最小字号（修复前 L 溢出 167×191px、Fit 后最小字号 7.4px、Quay 缺省 Focus），点 Fit、改窗口大小、进出全屏各读一次，确认都在宿主内；确认界面上不再有 Focus 控件和 "Readable zoom is on" 横幅。截图存 `tmp/` 并贴进 Evidence；做过的任何改动必须还原。

## Touches

- src/modules/architecture/semanticZoomLayout.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/readableZoom.ts
- src/modules/architecture/svgViewport.ts
- src/modules/architecture/ArchitectureMinimap.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/tests/semanticZoomLayout.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/readableZoom.test.tsx
- src/modules/architecture/tests/svgViewport.test.tsx
- src/modules/architecture/tests/minimap.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- e2e/architecture-fit-contract.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- tasks/architecture-single-scale-fit-contract.md

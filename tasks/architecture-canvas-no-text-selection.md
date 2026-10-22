---
id: architecture-canvas-no-text-selection
title: 画布内不支持文本选择：拖动平移与双击下钻不再选中文字
status: done
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-22 实测：在 architecture tab 的画布上拖动很容易选中大量文本——从空白处拖动选中 634 个字符，从节点标签开始拖动选中 595 个字符，双击还会选中一个单词（而双击是下钻手势）。architecture 模块里没有任何 `user-select` 或 `select-none`，画布容器、`svg`、`text` 的计算值都是 `auto`。图是用来看和操作的，不是用来复制文字的（复制走「Text」页与导出菜单）。

修法：
1. 画布容器与其中的 `svg`、`text`/`tspan` 设置 `user-select: none`（含 `-webkit-user-select: none`），手机长按加 `-webkit-touch-callout: none`；缩略图、缩放簇、浮层同样不可选。
2. 平移手势在 `pointerdown`/`mousedown` 上对画布内的主键按下 `preventDefault()`（不吞掉点击与节点选择，也不影响浏览器对滚轮的处理）；拖动过程中若已有选区则清掉（`getSelection().removeAllRanges()`）。
3. 不影响停靠区：检查器与「Text」页里的文字（会话命中摘录、PlantUML 文本、成员列表）仍可正常选择与复制；`<pre>` 里的文本保持可选。
4. 键盘可达性与屏幕阅读器不受影响（`user-select` 不改变可访问树）。

## AC

- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：画布容器与其中的 `svg`、`text` 的内联样式或注入的样式里 `user-select` 为 `none`；检查器与文本页（`role="complementary"` 内）不带 `user-select: none`；既有平移、点击选中、双击下钻用例不回归
- [x] `npx vitest run src/modules/architecture/tests/mobileGestures.test.tsx` exit 0：触摸档位下画布带 `-webkit-touch-callout: none`，长按、捏合、双击手势用例不回归
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（在既有几何守卫里增加断言，整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 为它加条目并写明实测）：在真实浏览器里从空白处拖动、从节点标签开始拖动、双击标签三种操作之后 `window.getSelection().toString().length` 都为 0；在检查器的文本上拖动仍能选中非空文本（证明没有误伤停靠区）
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：新增控制臂——对画布注入 `user-select: auto` 后，同样的拖动读数落到大于 0（证明守卫能取假），主臂与控制臂用同一读取函数
- [x] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器里打开任一会话的 architecture tab，从空白处、从节点标签、双击标签各操作一次，页面上没有出现任何选区高亮（贴三次 `getSelection().toString().length` 都为 0 的读数）；在检查器里选中一段会话命中文字能正常复制。证据是读数与截图。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitectureMinimap.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/mobileGestures.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- tasks/architecture-canvas-no-text-selection.md

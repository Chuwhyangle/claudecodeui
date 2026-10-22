---
id: architecture-interaction-consistency-fixes
title: 交互一致性：缩放档位条去重并修状态残留、关闭停靠区清选择、选中节点打开检查器、搜索回车定位而不是下钻、无关系时不整图压暗
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-22 用 MCP 浏览器逐项操作已落地的只读功能，发现一组「各功能单独都对、叠在一起就不一致」的交互问题。

1. **缩放档位条重复且数字矛盾**：画布上方同时出现 `Overview 100% · Back to overview · Explosion view · Focus · Overview` 与 `Focus 69% · Back to overview · Explosion view · Focus · Overview`，同一个概念有标签、按钮、说明句三处；「Back to overview」在没有下钻时也出现（`PlantUmlGraph.tsx` 的 `backButton` 由 `!atDefaultView` 决定，状态跨视角残留）；类图切到文件图再切回，上次的邻域下钻视图又回来。修法：档位条只有一组 `Focus | Overview` 分段控件加一个缩放读数；「Back to overview」只在确有下钻（neighbourhood/group）时出现，写成面包屑「返回 X」；切换类图/文件图时下钻状态重置为默认视图；说明句（`Readable zoom is on…`、`zoom in on {{package}} and N other package(s)`）合并成一句并只在 Focus 档出现。
2. **关闭停靠区不清选择**：点 × 关闭检查器后，选择与压暗仍在（实测 51 个 `.arch-dim`、1+2 个高亮），要点空白才清。修法：关闭停靠区同时清选择；`Escape` 的既有两步行为（先关停靠区、再清选择）保持，且仍 `stopPropagation`。
3. **选中节点打开的是上次用的「Text」页**：先点过「Text」，之后选中节点打开停靠区仍停在 Text。修法：由选择触发的打开一律落在 Inspector；Text 页只由工具栏「Text」按钮或页签切换打开。
4. **搜索回车是整图下钻**：回车后整张图换成该实体的邻域视图，上下文丢了。修法：回车 = 在当前图里居中并选中该实体（沿用既有的居中能力）；`Shift+Enter` 或结果行上的次级按钮「查看邻域」才下钻；实体不在当前画出的图里（被筛选隐藏、或超出布局预算）时，结果行给出原因并提供「显示它」一键操作（对隐藏函数即钉住/放开对应筛选，不得静默无反应）。
5. **选中无关系的节点会把整张图压暗**：选中 `displayName` 这类关系全被筛选隐藏的节点，其余节点被压到 15% 不透明度，却没有任何高亮可看。修法：仅当存在至少一个被高亮的关联节点/边时才压暗；压暗强度提高到不低于 35% 不透明度，保证未选中节点仍可读。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/explosionLod.test.tsx` exit 0：档位条里只有一组 `Focus | Overview` 控件与一个缩放读数，不再同时出现标签式的 `Overview/Focus` 文字；`Back to overview` 仅在邻域/组视图下出现；切换类图↔文件图后视图为默认视图；缩放读数在档位条与缩放簇里是同一个数
- [ ] 同上命令：关闭停靠区（× 按钮与 Escape）后选择已清空且无 `.arch-dim`；选中节点时无论上次停在哪个页签都打开 Inspector；搜索回车在当前图里居中并选中且视图不变；`Shift+Enter` 进入邻域；不在当前图里的实体显示原因与「显示它」操作且点击后该实体出现；选中无关联高亮的节点时不出现任何 `.arch-dim`，有高亮时未选中节点不透明度不低于 0.35
- [ ] `npx vitest run src/modules/architecture/tests/dockInspector.test.tsx src/modules/architecture/tests/selectionModel.test.ts` exit 0（既有用例不回归；涉及「关闭保留选择」「单击直接下钻」的旧断言已逐处改写并列在实施记录）；`chat.abort` 调用计数在所有 Escape 用例里为 0
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器打开 claudecodeui 项目任一会话的 architecture tab：档位条是一组 `Focus | Overview` 加一个缩放数；下钻某实体后出现「返回」面包屑，返回后再切文件图、切回类图都是默认视图；选中节点→关闭停靠区，画面不再压暗；先点 Text 再选节点，打开的是检查器；在搜索框输入名字回车，当前图里居中选中该实体而不是整图换成邻域；选中一个没有关系的函数时画面不变暗。证据是前后截图与读数。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/ArchitectureDock.tsx
- src/modules/architecture/ArchitectureInspector.tsx
- src/modules/architecture/selectionModel.ts
- src/modules/architecture/explosionLod.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/explosionLod.test.tsx
- src/modules/architecture/tests/dockInspector.test.tsx
- src/modules/architecture/tests/selectionModel.test.ts
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/de/common.json
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
- tasks/architecture-interaction-consistency-fixes.md

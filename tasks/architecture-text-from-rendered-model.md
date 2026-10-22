---
id: architecture-text-from-rendered-model
title: 文本页改用上游：渲染走 renderDetailed，文本取 toPlantUml(被画出的 model)，子图范围用
  applyView/过滤后的 model 序列化
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-text-panel
  - architecture-upgrade-plantuml-js-0-3
---
## Proposal

文本页（相关任务）首版的 PlantUML 文本来自我们本地桥接层在 view/transform/detail 之前产出的那份，页内因此注明「按桥接层输出」——聚合边、枢纽折叠等 plantuml-js 内部变换不在文本里体现，文本与屏幕上画的并不完全一致。plantuml-js 0.3.0 提供了两样东西把这个缺口补上：`renderDetailed(puml, options)` 返回 `{ model, layout, svg, layoutMs, hiddenTransitive }`，其中 `model` 是**真正被布局和绘制的那份**；`toPlantUml(model)` 把任意 `PlantUmlModel` 序列化回文本（往返 `parsePlantUml` 稳定，`checkSyntax` 无 error）。本任务把文本页的唯一接缝 `buildPlantUmlText(graph, scope)`（`plantUmlText.ts`）换成上游实现，调用方与既有测试不动。

1. 面板的渲染调用由 `createRenderer(...).render(puml)` 改为 `renderDetailed(puml, options)`，保留返回的 `model` 与 `layout`（后者也可以替换缩略图/视野范围对 SVG 的 bbox 反读，但那不在本任务范围，不动）。
2. **三种范围**：全图 = `toPlantUml(drawnModel)`；当前视野内 = 取 `layout` 里与视口相交的节点 id 集合，从 `drawnModel` 过滤出子模型再序列化；选中 +1 邻居 = `toPlantUml(applyView(drawnModel, { kind: 'neighborhood', entity, hops: 1 }))`（多选时对每个选中项取并集）。不再手拼文本。
3. 文本页里「按桥接层输出」的说明去掉；「语法通过」徽标仍用 `checkSyntax`；体量读数与分级不变。
4. 回退：上游函数在运行时缺失或抛错时回落到现有的桥接层文本并在页内如实标注，不让文本页空掉。

## AC

- [x] `npx vitest run src/modules/architecture/tests/plantUmlText.test.ts` exit 0：新增用例——全图文本等于 `toPlantUml(renderDetailed(...).model)` 逐字相同；对含聚合边与 `<<function>>`/成员分栏的 fixture，文本经 `parsePlantUml` 再 `toPlantUml` 稳定且 `checkSyntax` 无 error；「视野内」与「选中 +1」两种范围的节点集合正确；上游函数抛错时回落到桥接层文本并带「回退」标记；既有用例（范围、体量、分级）不回归
- [x] `npx vitest run src/modules/architecture/tests/textPanel.test.tsx src/modules/architecture/tests/architectureTab.test.tsx` exit 0：页内不再出现「按桥接层输出」；回退时出现回退标注；既有用例不回归
- [x] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器打开 quay 会话 architecture tab，文本页的全图 PlantUML 与屏幕上画出的节点一一对应（挑 5 个节点核对文本里都在、被隐藏/折叠的不在）；对一张含聚合边的图，文本里是聚合后的边而不是原始边（贴一段对照）；把文本粘进 PlantUML 渲染器，画出的图与屏幕一致（贴截图）。

## Touches

- src/modules/architecture/plantUmlText.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitectureTextPanel.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/tests/plantUmlText.test.ts
- src/modules/architecture/tests/textPanel.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- tasks/architecture-text-from-rendered-model.md
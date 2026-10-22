---
id: architecture-first-open-and-marker-polish
title: 首次打开的小问题：空检查器的停靠区默认不展开、「Budget-limited」只在真有预算约束时出现、种子标记在种子占多数时降级
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-22 在 3 个会话里看到三处「默认状态」的小问题：

1. **默认打开的停靠区是空的**：live voice 会话一进来，右侧就是 320px 的检查器，只写着「Select a node or a relation on the drawing.」，把画布挤到 831px。只在一个会话里看到，原因没有验证（疑似记住了上次的开合状态）。修法：停靠区只在用户显式打开（点「Text」或选中节点）时展开；**没有选择且没有显式打开过**时不展开；「记住开合」只记住用户在**当前选择存在**时的显式开关，换会话、重新进入时若没有选择就不自动展开；检查器内容为空时不单独占一列（空状态只在用户点开它时出现）。实现前先读 `ArchitecturePanel.tsx` 里 `dockOpen` 的初始值与持久化逻辑，把真实原因写进实施记录。
2. **「Budget-limited」误报**：live voice 会话只有 19 个相关实体，详情、布局、服务端三层预算都没有约束，读数仍显示 `Budget-limited`。`readoutNumbers.ts` 里 `limitedLayers` 由 `detailCut`/`layoutCut`/`serverCut` 决定（第 128–131 行附近）；疑似把「隐藏孤立节点」造成的差（19 相关、画出 18）算成了详情裁剪，该原因没有验证。修法：先复现并定位（写进实施记录），再让 `detailCut` 只在「详情档位裁剪」真的丢了节点时为真；隐藏孤立节点、元素/关系筛选造成的减少不得触发预算标记（它们在读数第二行已经有自己的说明）。
3. **种子标记在种子占多数时失去意义**：15/18 个节点都是橙色粗边框，高亮不再能区分任何东西。修法：当会话直接提及的种子占被画出实体的 50% 以上时，种子标记降级为更轻的形式（细边框加小圆点，不再是粗橙框），图例里同步说明「种子很多时用轻标记」；种子占少数时保持现状。阈值写成具名常量，在实施记录里给出这四个会话的实测占比。**注意**：后续「会话提到的实体按种类决定是否保持显示、默认全关」的任务落地后，被提到的函数默认不再被画出，画面里的种子会少很多；所以本条的行为要用夹具（种子占多数、占少数各一个）来断言，不要依赖某个真实会话在某个默认设置下的占比。

## AC

- [x] `npx vitest run src/modules/architecture/tests/dockInspector.test.tsx src/modules/architecture/tests/architectureTab.test.tsx` exit 0：首次进入（无选择、无显式打开记录）时停靠区不渲染；选中节点后打开；用户显式关闭后换会话再进入仍不自动展开；点「Text」可显式打开且无选择时也能打开；既有停靠区用例不回归
- [x] `npx vitest run src/modules/architecture/tests/readoutNumbers.test.ts` exit 0：新增用例——相关 19、画出 18（差 1 个孤立节点）、三层预算都未触发时 `limitedLayers` 为空且读数不出现预算标记；详情真的裁掉节点时仍标 `detail`；既有分层用例不回归
- [x] `npx vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts src/modules/architecture/tests/architectureTab.test.tsx` exit 0：种子占画出实体 50% 及以上时种子标记为轻形式（不含粗橙框的样式类），占少数时保持原样式；图例文案同步；既有种子标记用例在少数种子的夹具上不回归
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器里依次打开 live voice 会话与另外两个会话的 architecture tab：首次打开没有展开的空检查器、画布占满；live voice 会话（19 个相关）读数里没有 `Budget-limited`。种子标记的两种形态用夹具验证（种子占多数的夹具是轻形式、占少数的夹具仍是粗橙框，贴两张截图与占比读数）；若在真实会话里把「保持显示会话里提到的函数」打开后种子占多数，同样应当是轻形式。贴三个会话的读数与截图。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/ArchitectureDock.tsx
- src/modules/architecture/ArchitectureMinimap.tsx
- src/modules/architecture/readoutNumbers.ts
- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/dockInspector.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/readoutNumbers.test.ts
- src/modules/architecture/tests/archguardToPlantUml.test.ts
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
- tasks/architecture-first-open-and-marker-polish.md

## Implementation Notes

**1. 停靠区为什么一进来就是空的（真实原因）**：`ArchitecturePanel.tsx` 的 `dockOpen` 初始值是 `useState<boolean>(readStoredDockOpen)`，而 `readStoredDockOpen` 直接读 localStorage 的 `architecture.dock.open`；`changeDockOpen` 每次开合都写回该键。只要这个浏览器以前开过检查器，新会话/重新进入就会先展开一个 320px 的空检查器（无选择时 inspector 页只有 `architecture.dock.empty`）。第二个成因：面板跨会话常驻，`dockOpen` 是组件 state，换会话只清 selection（`sync-scope`）不清 dock —— 旧会话开着的检查器会跟着进入新会话，变成空列。修法：

- `dockOpen` 初始值恒为 `false`；删除 `readStoredDockOpen` / `writeStoredDockOpen` / `DOCK_STORAGE_KEY`。删而不是留：现在所有打开都由手势驱动（新选择，或工具栏 Text），一个没有读者的持久化字节只会让人以为还有「记住」语义。
- 新增 `dockExplicitlyOpened`：只有「读者点 Text 自己打开」为真；选择驱动的打开为假。
- session/project 变化时关闭 dock 并清该标志；selection 变空且不是显式打开时也关闭 —— 空检查器永远不单独占一列，只有读者自己点开时才显示空状态。
- 首次进入不渲染、选中后打开、显式关闭后换会话不重开、Text 无选择可打开，分别由 `dockInspector.test.tsx` 的四个新用例钉住。

**2. Budget-limited 误报的原因（已复现）**：`readoutNumbers.ts` 原先用 `detailCut = detailRetained < returnedCount`；而面板的 `detailRetained` 来自 `rankArchitectureDetail(displayNeighbourhood…)`，是「显示筛选之后」的图（默认 `hideIsolated: true`，还会按 kind/relation 裁剪）。`returnedCount` 是服务器返回数（含被筛掉的节点），两者一比，任何被显示筛选去掉的节点都被算成「详情档位裁剪」。live voice 会话（453eb2bd…，19 related、服务端 `hidden.isolated = 1`）正是 19 > 18 ⇒ 误报。修法：`buildReadout` 新增可选 `detailInScope`（详情档位真正排名的集合大小，即筛选后 in-scope 数），`detailCut = detailRetained < detailInScope`；省略时回退到 `returnedCount`，老调用方语义不变。面板传入 `displayNeighbourhood.nodes.length`。被筛选掉的节点仍由读数第二行（`1 isolated nodes` / kind / relation parts）说明。

**3. 种子标记阈值与四个会话的实测占比**：`LIGHT_SEED_SHARE_THRESHOLD = 0.5`（`archguardToPlantUml.ts` 的具名常量）；`seedMarkerMode(nodes)` 在 seeds ≥ 50% 时返回 `light`：细边框 + 小圆点（`arch-seed-light` / `[data-architecture-seed-dot]`），不再使用 `arch-seed` 的粗橙框；少数时保持原样。图例在轻形式生效时追加 `architecture.legend.seedLight`（12 个 locale 齐全）。

实测（2026-10-23，经本机 3001 端口按默认 class 读数请求：`hops=2`、默认 kinds、dependency 关系预设；占比 = direct 种子 / 画出的 entity 节点，画出的数量按服务端 `hidden.isolated` 扣减）：

| 会话 | 相关 | 画出 | direct 种子 | 占比 |
|---|---|---|---|---|
| 现有语音模型的上下文识别对比（a7cf4315） | 13 | 13 | 10 | 76.9% |
| Architecture tab 架构图（c5a57036） | 40 | 40 | 40 | 100% |
| qwen3.8-flash 用量来源（4ca40d37） | 1 | 1 | 1 | 100% |
| live voice 语音识别接入 voice input（453eb2bd） | 19 | 18（隐藏 1 个孤立节点） | 15 | 83.3% |

四个会话的默认 class 读数都已是种子占多数 —— 也就是 Proposal 里「15/18 个节点都是橙色粗边框」的那个形态，50% 阈值对它们全部走轻形式。按 Proposal 的要求，行为断言仍用夹具（种子占多数 `MAJORITY_SEED_RESULT`、占少数 `CLASS_DIAGRAM_RESULT`），不依赖真实会话在某个默认设置下的占比。真实浏览器截图与最终读数属于 DoD 的人工/驱动侧核验；本 worker 已闭合上面四组 AC 命令、typecheck 与 build。
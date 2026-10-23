---
id: architecture-semantic-zoom-layout
title: 架构图语义缩放：单调拉伸布局 + 最小字号 + UML 形态不退化（替换现有按层隐藏的 LOD）
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务替换已完成的 `architecture-explosion-zoom-lod`、`architecture-lod-labels-and-edges-polish`、`architecture-mobile-default-fit-and-density` 所建立的「按缩放比整层隐藏实体、覆盖层重画包标题」机制；这三个任务各自的验收仍然成立到本任务把对应行为改写为止，改写的部分由本任务的 AC 接管。合并决定：无开放任务与本任务的 Touches 重叠（task-granularity-advice 读数 peers=[]），单独立案。

问题（2026-10-23 在真实浏览器里用 Quay OO 与 live voice 两个会话、PC 与手机视口、65/46/33/17/6% 五个缩放档实测）：缩小后实体按整层隐藏而包框保持满尺寸，留下大块空白；包名与类名随缩放缩到不可读；覆盖层标题互相重叠并与原标题重影；成员文字隐藏后类框仍然画满，没有 UML 的两条横线；手机上缩放中心落在空白处。

设计已经过 14 轮在真实页面上的原型迭代并获人确认，全文在 `docs/proposals/architecture-semantic-zoom/README.md`，参考实现是同目录 `reference/prototype-v14.js`，参考图是 `reference/v14-montage-{pc,m}-{quay,voice}.png`（每张含 65/46/33/17/6% 五个缩放档）。实现者必须先通读该 README，再读原型脚本；README 是需求，原型是行为参照，两者冲突以 README 为准。

七条原则（逐条可验收）：1 基线是原布局乘缩放，约 90% 以上完全还原；2 每个可见元素有最小尺寸，文字固定在最小字号（PC 10px、手机 11px）放不下就省略绝不缩小；3 满足最小尺寸只靠对 x、y 各一次的单调分段线性映射（顺序、对齐、包含、折线正交性全保留）；4 文字隐藏的类框可压缩，从格子左上角起按紧凑高度绘制，边的端点跟随；5 拉伸预算超过 1.8 倍就降档（A 类名与成员，B 只留类框，C 只留包）；6 被隐藏的信息在上一级汇总（包名后 `(N)`，C 档加橙色 `★N` 表示该包内被会话直接提到的实体数）；7 UML 形态不退化（包标签是含右侧封口的完整小矩形标签页，类框始终保留标题 / 属性 / 方法两条横线，接口只有方法时一条）。

范围：客户端 `src/modules/architecture/`。不改 plantuml-js 输出契约；属性 / 方法分格在 plantuml-js 提供分格元素之前，按成员文本是否含 `(` 近似，并把近似集中在一个函数里，便于之后换成读新类名。已就分格元素、标签页闭合形态、几何元数据三件事向 plantuml-js 会话发出请求，不阻塞本任务。

## Plan

1. 纯函数引擎 `semanticZoomLayout.ts`：输入是从渲染出的 SVG 读到的几何（实体矩形、包矩形、包含关系、折线边与箭头、成员文本）加缩放、最小字号、视口；输出是 x/y 两个映射、选定的档位、拉伸比。含约束求解（前向一遍加长路径）、可压缩间距判定、档位选择、内容最密窗口锚点。无 DOM、无 React。
2. 纯函数规划 `semanticZoomPlan.ts`：类名排版（整行、驼峰折两行、中间省略）、类框紧凑高度与分格位置、包标签（最后一段加计数加 ★N）、粘性包名（最多 2 个）、边不透明度三档、边端点随类框收缩的平移、成员行与 `… +N more` 的排布。
3. 渲染接入：`PlantUmlGraph.tsx` 在 plantuml-js 的 SVG 之上，按引擎结果重写几何（保持 `data-entity-id`、`data-package-id`、`data-edge-source`、`data-edge-target` 契约），原覆盖层标题机制退役；类框、包框、边仍是可命中的 SVG 元素。
4. 交互经映射：选择、置顶与排除徽标、命中测试、拖拽、滚轮与双指缩放、小地图视口框、适应视图，全部改为经过同一套映射换算，缩放锚点使用「内容最密窗口」。
5. 档位读数与 i18n：缩放读数旁的档位名由 Entities / Subpackages / Packages 改为随 A / B / C 档变化的文案，十个 locale 同步，`i18nArchitectureTabCompleteness.test.ts` 通过。
6. 退役与保留：删除 `explosionLod.ts` 中按层隐藏的深度阈值与覆盖标题规划，保留防抖与死区的调度器并让档位切换使用它；`readableZoom.ts` 的默认适应逻辑保持行为不变。
7. 验收几何守卫与控制臂：e2e 增加对最小字号、标签带不遮挡、两条横线、单调性、边端点贴边的读数断言，并为每条断言配一个能取假的控制臂。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/semanticZoomLayout.test.ts` exit 0：覆盖单调性（任意两点映射后顺序不变且映射非减）、缩放 ≥ 0.9 时映射等于恒等缩放、最小尺寸约束被满足且只在约束处拉伸、可压缩间距随 α 从 0 到 1 渐变、拉伸比超过 1.8 时降档且降档顺序是 A、B、C、同一输入同一输出、内容最密窗口锚点在稀疏图上不落在空白处；夹具用 plantuml-js 对仓库内已提交的小图夹具实际布局得到的几何，不是手写矩形
- [ ] `npx vitest run src/modules/architecture/tests/semanticZoomPlan.test.ts` exit 0：类名排版三级回退（整行、驼峰折两行、中间省略，非高亮至少保留 9 个字符、被提到的至少 6 个）、两行类名使标题格加高、类框紧凑高度与两条横线位置（接口只有方法时一条）、包标签取最后一段加计数且 C 档追加 `★N`、粘性包名不超过 2 个、边不透明度在 22/40/100 三个边界上取 0.85/0.5/0.3/0.18、边端点在类框被缩短后落在新的底边或侧边上
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：缩放读数旁的档位名随档位变化；缩小后 `data-entity-id`、`data-package-id`、`data-edge-source`、`data-edge-target` 契约仍在；原覆盖标题层 `[data-architecture-lod-labels]` 不再出现；选择与置顶徽标在缩放后仍作用于正确的实体；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/explosionLod.test.tsx src/modules/architecture/tests/minimap.test.tsx src/modules/architecture/tests/svgViewport.test.tsx src/modules/architecture/tests/readableZoom.test.tsx src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：调度器的防抖与 8% 死区用例保留并通过；小地图视口框在非线性映射下仍与画布可见区域对应；十个 locale 的新文案齐全
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（在既有几何守卫里增加断言，整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 为它更新条目并写明实测）：对 1440×765 与 390×844 两个视口、65/46/33/17/6% 五个缩放档，读出的所有可见文字的屏幕字号 ≥ 最小字号（PC 10、手机 11）；每个可见类框含两条横线（接口只有方法时一条）；包标签带与任何类框的屏幕矩形不相交；包标签页含右侧封口；映射单调（同一行的类框在缩放前后左右顺序不变）；边端点落在可见类框的边界上；C 档下可见的类框数为 0 且每个含被提到实体的包带 `★N`
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：为上面每条断言新增控制臂（关闭最小字号、关闭标签带预留、关闭端点跟随、关闭单调约束各一条），主臂与控制臂用同一读取函数，控制臂里对应读数必须变红，证明守卫能取假
- [ ] `npm run typecheck` 与 `npm run build` exit 0；`npm run lint` 对 `src/modules/architecture/` exit 0（新增文件在现有目录下平铺，不新建模块目录）

## DoD

真实浏览器里分别用 1440×765 与 390×844 打开 claudecodeui 项目的「Quay 的 OO 设计重构」会话与 live voice 相关会话的 Architecture 标签，在 65/46/33/17/6% 五个缩放档截图，与 `docs/proposals/architecture-semantic-zoom/reference/v14-montage-*.png` 并排比对：类框始终有两条横线、包标签页封口、文字不小于最小字号、无遮挡与重影、缩小时不再出现大块空包框、手机缩放中心不落在空白处、6% 档用 `★N` 表示被提到的实体。把 20 张截图（2 视口 × 2 会话 × 5 档）与几何读数贴进 Evidence。该视觉比对属于人工复核步骤，AC 里的几何守卫是它的机械替身。

## Touches

- src/modules/architecture/semanticZoomLayout.ts
- src/modules/architecture/semanticZoomPlan.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/explosionLod.ts
- src/modules/architecture/svgViewport.ts
- src/modules/architecture/ArchitectureMinimap.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/tests/semanticZoomLayout.test.ts
- src/modules/architecture/tests/semanticZoomPlan.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/explosionLod.test.tsx
- src/modules/architecture/tests/minimap.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/id/common.json
- tasks/architecture-semantic-zoom-layout.md

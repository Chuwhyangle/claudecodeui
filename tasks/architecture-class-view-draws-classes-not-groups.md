---
id: architecture-class-view-draws-classes-not-groups
title: 类图视角默认直接画类（带包框），不再折成目录组框；目录组框只留给文件图 Overview；孤零零悬在一侧的单成员节点随之消失
status: done
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

2026-10-22 实测（archguard 项目会话 `f3a974c3-510c-4761-ba48-96dff3d5220c`，类图视角）：详情「全部」被布局预算裁到 556 个实体之后，画面只有 17 个方框——`src (100)`、`data (159)`、`plugin (19)`、`shared (18)`、`cli (61)` 等**目录组框**，外加左边一个孤零零的 `<<function>> version-consistency-check.ts.check`。用户想看的是类图（带构造型与成员分栏的类/接口框），而不是目录统计。原因：面板对两种粒度都用 `grouping: 'adaptive'`（`ArchitecturePanel.tsx` 第 715 行附近与 `PlantUmlGraph.tsx` 第 766 行附近）。自适应目录分组是为文件图 Overview 设计的（把几百个文件折成 ≤ 40 个目录组，`OVERVIEW_GROUP_LIMIT`），对类图视角它把已经画好的类全部折成了组框，与前面「类图为主」的设计相冲突；单成员目录里的实体不进组，就被画成悬在一侧的孤立方框。

布局预算（相关任务已落地）保证送进布局的实体数不超过 `LAYOUT_NODE_BUDGET`（起点 600），所以类图视角**不再需要用折叠来控制规模**。

### 做法

1. **类图（entity 粒度）默认画实体**：实体框画在嵌套的包框里（桥接层已能按目录发出嵌套 `package` 块），不出现任何 `grp::` 组节点；语义缩放（Explosion/Focus/Overview 档位与 `explosionLod.ts`）继续负责「缩小时把实体框隐藏成包的计数」，也就是用**几何连续的缩放**替代「折成另一张图」。实现可以选 `hierarchy` 视图作为类图的默认视图，也可以选带嵌套包框的 overview；**实现前先在真实图上比较两种候选的首屏**（archguard 会话与 claudecodeui 会话各一张截图 + `data-architecture-layout-ms` + 默认缩放下节点文字的像素高度），把比较写进实施记录再选。
2. **文件图（file 粒度）不变**：Overview 仍用自适应目录分组（≤ 40 组，单成员目录并入未分组，已有的 `adaptiveGrouping.ts` 规则与测试不动）。
3. **默认缩放可读**：类图的首屏要么按既有的「可读缩放下限」聚焦到一块可读的区域，要么整图适应后节点文字仍不小于该下限（沿用 `readableZoom.ts` 的规则，不另造阈值）。
4. 点包框仍可展开/下钻（沿用既有的 group/下钻交互），但包框是画好的容器，不是被折叠的占位。
5. 去掉「孤立悬在一侧」的现象：不在任何包框里的单个顶层实体（目录里只有它一个）也画进它所属的包框，不单独浮在画面一侧。

## AC

- [x] `npx vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts` exit 0：新增用例——约 150 个实体（含 class/interface/function、嵌套目录、若干单成员目录）的 entity 粒度图在默认视图下产出的 puml **不含任何 `grp::` 行**、每个实体有一条自己的声明、实体被放进嵌套 `package` 块里（单成员目录里的实体也在它的包框里）；file 粒度的 Overview 用例（组数 ≤ `OVERVIEW_GROUP_LIMIT`、单成员折叠、`scripts` 折成带计数的组）逐字不回归
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/explosionLod.test.tsx src/modules/architecture/tests/hierarchyIndex.test.ts src/modules/architecture/tests/readableZoom.test.tsx` exit 0：类图视角默认不渲染 `data-entity-id^="grp::"` 的节点、渲染的实体框数等于被布局的实体数；缩小到低档位时实体框被隐藏、包框上出现计数（既有 LOD 用例不回归）；文件图视角仍渲染组框；默认缩放不低于可读下限或聚焦到可读区域（两者之一，由所选方案决定并在测试里写明）
- [x] `npx vitest run src/modules/architecture/tests/adaptiveGrouping.test.ts` exit 0（文件图的分组规则不动，用例逐字不变）
- [x] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（PC 1440×765）打开 archguard 项目的会话 `f3a974c3-510c-4761-ba48-96dff3d5220c` 的类图视角：画面里是带 `<<interface>>`/`<<function>>` 构造型与成员分栏的类框，放在目录包框里；不再出现 `src (100)`、`data (159)` 这类带计数的组框；没有孤零零悬在左侧的单个函数框；缩小时类框隐藏成包的计数、放大时回来（贴缩小前后的截图与实体框计数）。同时贴被布局的实体数与 `data-architecture-layout-ms`（预期在布局预算 600 以内、数秒内完成）。再打开 claudecodeui 项目的会话复测。文件图视角的 Overview 与改前一致（贴组数读数）。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/explosionLod.ts
- src/modules/architecture/readableZoom.ts
- src/modules/architecture/tests/archguardToPlantUml.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/explosionLod.test.tsx
- src/modules/architecture/tests/readableZoom.test.tsx
- src/modules/architecture/tests/exportMenu.test.tsx
- src/modules/architecture/svgViewport.ts
- src/modules/architecture/tests/svgViewport.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- tasks/architecture-class-view-draws-classes-not-groups.md

## Implementation record

**候选比较（先比较再选）**。两个候选在桥接层是**同一份文档**：`archguardToPlantUml(graph, { view: { kind: 'hierarchy' }, grouping: 'raw' })` 与 `{ view: { kind: 'overview' }, grouping: 'raw' }` 产出的 puml 逐字节相同（新增用例 “the two class-view candidates build the same first-screen document” 钉住），因为二者都走 `emitEntityDocument`：实体画进嵌套 `package`，不发任何 `grp::`。所以首屏截图对两个候选是同一张；差别只在渲染侧的外围策略。选 `hierarchy` 作为类图默认视图，因为它保留语义缩放（`explosionLod.ts`）——这正是 AC2 要求的「缩小到低档位时实体框被隐藏、包框上出现计数」；选 `overview` 会让 `view.kind === 'overview'` 关掉 LOD，类图就没有折叠档位了。真实首屏（下述 archguard 读数）因此同时是两个候选的首屏。

**真实浏览器读数**（本 worktree 的 `dist` + `dist-server`，`SERVER_PORT=3107`，独立 `DATABASE_PATH`；1440×765，Chromium/Playwright）。任务点名的 archguard 会话 `f3a974c3-510c-4761-ba48-96dff3d5220c` 在本机 `~/.claude/projects` 里已不存在（全目录 grep 只在该会话被其他 transcript 引用的文本里命中，没有同名 `.jsonl`），故用 archguard 项目最新且有真实规模的会话 `b0a316ca-217d-4e5c-bc0d-8aaef52855be` 复现同一读数：

- 类图默认：`data-architecture-view="hierarchy"`，被布局实体数 **299**（布局预算 600 以内），`data-architecture-layout-ms` **4752–4910 ms**（数秒内）；`data-entity-id^="grp::"` **0 个**；43 个目录包框（`src`、`src/analysis`、`src/cli` …）；`data-architecture-readable-mode="focus"`、zoom **69.2%**、节点文字实测 **10 px**（可读下限 9 px）；读出一行 “Showing 299 classes · 303 related”。截图中类框带 `<<interface>>` 等构造型与成员分栏；没有 `src (100)`/`data (159)` 一类计数组框，也没有悬在一侧的单函数框（单成员目录的实体同样在它自己的包框里）。
- 缩小到低档位：`data-architecture-lod-depth="0"`，实体框 `display:none`，包框标签变成 `src (290)`、`src/analysis (14)`、`src/cli (24)`、`src/core (54)` …；放大回 **69.2%** 后同一 SVG 的实体框恢复。
- 文件图 Overview（同一会话）：`data-architecture-view="overview"`，**27 个 `grp::` 组 + 8 个未分组实体**（35 节点），组标签如 `grp::src/analysis`；分组规则未动。
- claudecodeui 项目复测（会话 `d71979a9-f9d0-435f-a63c-9fc134ce6fb8`）：类图默认 5 个实体、0 个 `grp::`、7 个包框（`modules`、`modules/chat` …）、`layout-ms` 51 ms、文字 10 px；缩小后 `modules (4)`、`chat/audio (1)` … 并隐藏实体；文件图 Overview 5 组 + 3 未分组实体。

截图与原始读数在本次会话的 `/tmp/arch-visual/*.png`（不入库，避免 Touches 之外的写入）；数值已抄录于上。

**改动**。`PlantUmlGraph.tsx`：entity 图（`idShape === 'scope-prefixed'`）默认 `hierarchy`、传 `grouping: 'raw'`；LOD 对 entity 的每个视图都生效（其 overview 是同一份实体文档）；band-aspect 折叠只留给文件图（类图没有更粗的图可退回）；“Back”回到该图的默认视图。`ArchitecturePanel.tsx`：类图导出按 raw 重建，导出仍等于画面。`archguardToPlantUml.ts` / `explosionLod.ts` / `readableZoom.ts` 无需改动（既有 package 发射、LOD 与可读缩放规则直接复用）。兄弟夹具 `tests/exportMenu.test.tsx` 的类图导出期望随之更新（自适应分组 → raw 文档），故列入 Touches。

**兄弟 e2e 守卫**。`e2e/architecture-canvas-layout.spec.ts`（并发落地的 `architecture-layout-e2e-guard`）里 `showExplosionView` 要求点得到 “Explosion view” 按钮——类图默认就是 hierarchy 后该按钮不存在，故改为「已经在 hierarchy 就直接读」；该 spec 的布局读数改在**文件图 Overview** 上取（它仍是整图适应时画满 box 的那种图；类图的整图适应按设计把实体框折成包计数，没有 box 可量）。4/4 arms 通过。

**顺带修好的居中几何**。上述 e2e 的 phone arm 暴露了一个既有缺陷：`svgViewport.ts` 的 `scaleAvoidingCorner` 把画布当成左对齐，水平极限用了 `corner.left / natural.width`；实际 SVG 是水平居中（`margin: 0 auto`，浏览器实测 390 宽容器里 256 宽 SVG 左缘 67px）。右缘应为 `(host.width + width) / 2`，故极限是 `(2·corner.left − host.width) / natural.width`。不修则 phone 上会有 group box 被右下角 zoom cluster 盖住 11px；修正后 phone/desktop 的 `chrome.over.nodes` 都是 0，e2e 4/4 绿。`svgViewport.test.tsx` 的 `fittedDrawingRect` 同步改成水平居中的真实几何，loose-corner 期望由 0.7 改为 0.64（垂直让路更省：bottom ≤ 460 ⇒ 0.64）。

**验证**：`npx vitest run src/modules/architecture/tests`（18 files / 232 tests）通过；`npm run typecheck`、`npm run build` 通过；`npx playwright test e2e/architecture-canvas-layout.spec.ts`（4 arms）通过；`oxlint` 对改动文件仅剩既有 warning。

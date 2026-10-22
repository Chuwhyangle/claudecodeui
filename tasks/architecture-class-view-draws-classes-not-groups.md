---
id: architecture-class-view-draws-classes-not-groups
title: 类图视角默认直接画类（带包框），不再折成目录组框；目录组框只留给文件图 Overview；孤零零悬在一侧的单成员节点随之消失
status: ready
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

- [ ] `npx vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts` exit 0：新增用例——约 150 个实体（含 class/interface/function、嵌套目录、若干单成员目录）的 entity 粒度图在默认视图下产出的 puml **不含任何 `grp::` 行**、每个实体有一条自己的声明、实体被放进嵌套 `package` 块里（单成员目录里的实体也在它的包框里）；file 粒度的 Overview 用例（组数 ≤ `OVERVIEW_GROUP_LIMIT`、单成员折叠、`scripts` 折成带计数的组）逐字不回归
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/explosionLod.test.tsx src/modules/architecture/tests/hierarchyIndex.test.ts src/modules/architecture/tests/readableZoom.test.tsx` exit 0：类图视角默认不渲染 `data-entity-id^="grp::"` 的节点、渲染的实体框数等于被布局的实体数；缩小到低档位时实体框被隐藏、包框上出现计数（既有 LOD 用例不回归）；文件图视角仍渲染组框；默认缩放不低于可读下限或聚焦到可读区域（两者之一，由所选方案决定并在测试里写明）
- [ ] `npx vitest run src/modules/architecture/tests/adaptiveGrouping.test.ts` exit 0（文件图的分组规则不动，用例逐字不变）
- [ ] `npm run typecheck` 与 `npm run build` 通过

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
- tasks/architecture-class-view-draws-classes-not-groups.md
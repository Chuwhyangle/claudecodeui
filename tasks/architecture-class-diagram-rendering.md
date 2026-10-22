---
id: architecture-class-diagram-rendering
title: Entity 图按 UML 类图画：构造型 + 成员分栏 + 纯类名标签；边标签默认隐藏、会话种子高亮
status: done
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-entity-kind-and-members-payload
---
## Proposal

评审结论：Entity 图应当是 UML 类图（架构师熟悉的语法），现在节点是一行 `rolling-slope-check.ts.haltVerdict` 样的框——类名淹没在文件名里，没有构造型与成员分栏。数据通路（节点 `kind`、`members`）由相关任务补齐；本任务只改桥接与渲染，按 UML 如实画：

1. **节点形态**（`archguardToPlantUml.ts`，entity 粒度、`grouping: 'raw'` 与 `'adaptive'` 两条路径一致）：`class` 画三栏（类名 / 字段 / 方法）；`interface` 带 `<<interface>>`；`enum`/`abstract` 对应 plantuml-js 已支持的 `EntityKind`；**function 画成单栏框并带 `<<function>>` 构造型**，不伪造成员栏。成员带可见性符号（`+ - # ~`）与签名；`membersTruncated` 时末尾画 `… +N`。没有 `kind` 的旧形态节点保持现状。
2. **标签只放实体名**：`haltVerdict` 而不是 `rolling-slope-check.ts.haltVerdict`；所在文件由 package 框承载（已有嵌套 package），并写进悬停提示的 `<title>`。同名实体在同一 package 内冲突时才回落带文件名的限定名。`displayName` 的 file 图语义不动。
3. **边标签默认隐藏**：`<<call>>`/`<<uses>>` 不再画在每条边上（满屏重叠、信息量低）；悬停或选中某节点时，其关联边显示关系类型，既有的 hover 高亮保持。继承/实现/组合/聚合的箭头形状（`--|>`、`..|>`、`o--`）不变，它们本身就是语义。
4. **会话种子高亮**：会话里提到的实体（`distance === 0`）用统一的描边 + 非颜色的标记（粗框）区分，不只靠颜色。
5. 不改 SVG/DOM 契约：`data-entity-id`、`data-package-id`、`uml-node`/`uml-edge` 保持，hover/下钻/爆炸 LOD/hierarchyIndex 继续工作。

## AC

- [x] `npx vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts` exit 0：新增用例用 class（含字段/方法）、interface、function 三种 kind 的真实形态 fixture，断言产出 puml 含 `class`/`interface` 声明、成员行带可见性符号、function 带 `<<function>>` 且无成员栏；标签是实体名而不是 `file.ts.Name`；缺 `kind` 的旧 fixture 产物与改前逐字相同
- [x] 同文件新增用例：同一 package 内两个同名实体时回落限定名且两者可区分；`membersTruncated` 时出现 `… +N` 行
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/hierarchyIndex.test.ts src/modules/architecture/tests/explosionLod.test.tsx` exit 0：默认状态 SVG 中没有任何边标签文本，悬停某节点后其关联边出现关系类型文本，移开后消失；`distance === 0` 的节点带种子标记属性；既有 hover/缩放/爆炸/下钻用例不回归
- [x] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（PC 1440×900）打开 quay 会话的 architecture tab，Entity 视角：能看到 interface 带 `<<interface>>`、function 带 `<<function>>` 的单栏框、少量 class 的三栏框；标签是纯实体名，所在文件在 package 框上；`<<call>>` 不再铺满画面，悬停才出现；会话提到的实体一眼可辨。截图对照改前（`/tmp/arch-pc-entity.png` 那一版）。

## Touches

- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/tests/archguardToPlantUml.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/architecture-class-diagram-rendering.md
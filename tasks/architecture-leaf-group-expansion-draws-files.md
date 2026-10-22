---
id: architecture-leaf-group-expansion-draws-files
title: 展开叶目录组时画出组内文件（不再回显同一个组框，229 个文件目前完全不可达）
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

2026-10-22 复测 quay 会话 e2dd27de 的 architecture tab：Overview 里点击 `plugin/scripts (229)` 组框后，图上出现的还是**同一个** `plugin/scripts (229)` 组框，再点还是它——该目录下 229 个文件在 UI 里完全不可达。

根因（离线用真实图 `/tmp/quay-arch-graph.json` 的 321 个 file 节点复现，当前 main checkout 代码）：

- `adaptiveGroupViewDocument`（`src/modules/architecture/archguardToPlantUml.ts:390-413`）在 `onlyGroup.prefix === prefix` 时只在 `onlyGroup.count <= OVERVIEW_GROUP_LIMIT`（40）分支才把实体画平；229 > 40，于是落到 `emitGroupedDocument`，而 `computeAdaptiveGrouping` 对「所有文件都直接位于该目录」的输入只能产出一个等于前缀的组。
- 实测产物逐字是 `@startuml / class "plugin/scripts (229)" as g0 / @enduml`（1 个 class、`grouped: true`），组节点 id 仍是 `grp::plugin/scripts` ⇒ 点击后 `PlantUmlGraph.tsx:461-471` 再次 `setView({kind:'group', prefix:'plugin/scripts'})`，视图不变。
- 同一个回环不止发生在「唯一组」上：一个目录若既有子目录又有大量直接文件，`groupDirectNodes: true` 会把直接文件折成一个 `prefix === 视图前缀` 的组框，点它同样原地打转。所以判据要按**组前缀是否等于视图前缀**来定，而不是按「组是否唯一」来定。
- 40 这个上限本来是为了避免 Overview 画太多框，但展开是用户**显式**要求看内部，用同一个上限挡住自己，等于把整个目录封死。`OVERVIEW_GROUP_LIMIT` 只有在「还有更细的子目录可分组」时才有意义。

修法（最小改动，保留既有语义）：

1. 在 `adaptiveGroupViewDocument` 里，**任何 `prefix === 视图前缀` 的组都不再画成可下钻的组框**：其成员直接画平（走 `emitEntityDocument` 的实体路径），无论该组是否唯一、count 多大、是否超过 `OVERVIEW_GROUP_LIMIT`。更深的子目录组照常出组框（组数仍受 `OVERVIEW_GROUP_LIMIT` 约束）。
2. 画平的数量上界交给已有的服务端节点预算（`maxNodes`/`Node budget reached` 提示）；若被预算截断，保留现有截断提示，不新增静默丢弃。
3. 画平的直接文件与子目录组之间仍要有边：成员被画平后，原来指向组框的聚合边按「组内外」重新落到具体实体上，保持「不因折叠丢边」；实施记录里写清边是怎么落回去的。
4. 不改 SVG/DOM 契约（`data-entity-id`、`data-package-id` 不变），hover/下钻/爆炸 LOD 继续工作。

## AC

- [ ] 新增用例（真实形态 fixture：file 图 id 为项目相对路径）钉住：叶目录 229 个文件、prefix 等于该目录时，group 视图产出 229 条 `class` 行、0 条 `grp::` 行、`grouped === false`，且边数不被折叠吞掉；`npx vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts` exit 0
- [ ] 反向用例：目录**既有子目录又有 50+ 个直接文件**时，子目录仍是组框，而视图前缀对应的组框消失（产物中不存在 `grp::<视图前缀>` 行、也不存在文本等于 `<前缀> (N)` 的 class 行），直接文件以实体出现；单成员组折叠规则（`adaptiveGrouping.ts` 的 `count < 2` 分支）不回归
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：overview 点击组框进入 group 视图后，组框不再与来源相同（读数：group 视图里 `class` 数 > 1 且没有任何 class 文本等于来源组标签），既有 hover/缩放/爆炸/下钻用例不回归
- [ ] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（默认与 390×844 移动视口各一次）打开 quay 会话 `/session/e2dd27de-3257-44ab-8209-4f5ac6858459` 的 architecture tab：Overview 点击 `plugin/scripts (229)` 后图上是该目录的 229 个文件（或按节点预算截断并显示既有截断提示），不再是同一个组框；选择 `packages/quay/src (12)` 这类**有子目录**的组展开后，子目录仍是组框、本层直接文件画平、再点任一子目录组仍能继续下钻（不原地打转）；返回 Overview 再进一次仍成立。证据是浏览器截图/快照里的 class 数量与标签，不是「测试绿了」。

不放水：不提高 `OVERVIEW_GROUP_LIMIT` 来绕过（那只会把 Overview 本身弄乱）、不删组框、不把 229 改成采样显示而不告知。

## Touches

- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/adaptiveGrouping.ts
- src/modules/architecture/tests/archguardToPlantUml.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/architecture-leaf-group-expansion-draws-files.md
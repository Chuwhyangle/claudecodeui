---
id: architecture-grouping-singleton-and-label-polish
title: 分组去噪：单成员组直接画成节点，孤立文件节点带目录上下文
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

2026-10-22 重启后用 Playwright MCP 复测 quay 会话（e2dd27de）的 Overview，自适应分组已把组数从 236 降到 16，但两处视觉噪声仍在，都在本地分组逻辑里（`adaptiveGrouping.ts` / `archguardToPlantUml.ts`）：

1. **单成员组是噪声。** `quay/src/fan-in (1)`、`quay/bin (1)`、`quay/src/gate/factories (1)` 等组只含 1 个节点，却画成一个带计数的组框；点开后也只是一个节点。`computeAdaptiveGrouping` 对 `count === 1` 的组没有特殊处理（`adaptiveGrouping.ts:152-162`）。
2. **孤立文件节点只显示文件名，没有目录。** 例如 `stamp-version.ts`、`resolve-version.ts`、`version-carriers.ts`、`manager-visual-check.py` 画成裸文件名，而组标签带完整路径，风格不一致，重名文件也会混淆。这些节点来自 `AdaptiveGrouping.ungroupedNodeIds`（根目录下的文件，`adaptiveGrouping.ts:127-130`），按 `displayName(node.id)` 渲染（`archguardToPlantUml.ts:248/305`），而 `directoryPathOf`/`scopeRelativePath` 假设 id 以 `<scopeKey>/` 开头并剥掉第一段。**实现前先核实**：file 粒度图的节点 id 是项目相对文件路径、entity 粒度图的才是 `<scopeKey>/<relpath>.<Name>`，两者共用同一套 `scopeRelativePath` 是否会把 file 图的第一级目录误当 scopeKey 剥掉（这可能是孤立节点丢目录、也可能是组名缺顶层目录的原因）；以实测的 id 形态为准，不凭上面的推断改。

修法：
- **单成员组折叠**：`computeAdaptiveGrouping` 结果中 `count === 1` 的组不再作为组输出，而是把唯一成员并入 `ungroupedNodeIds`（按单个节点画），overview 与 group 视图共用同一规则；含边的聚合（包级加权边、折叠计数）保持一致，不因折叠丢边。
- **孤立节点标签带目录**：孤立（未分组）文件节点的显示名使用项目相对完整路径（沿用 `displayName` 前截不截后的规则，`MAX_DISPLAY_DIR_SEGMENTS`），与组标签风格一致；若实测发现 id 形态问题，同时修正对应的剥离逻辑。
- 不改 SVG/DOM 契约（`data-entity-id`、`data-package-id` 不变），hover/下钻/爆炸 LOD 继续工作。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/adaptiveGrouping.test.ts` exit 0：任何输出的组 `count ≥ 2`；单成员目录的成员出现在 `ungroupedNodeIds`；折叠后总节点数守恒（组内节点数之和 + 未分组 = 输入）；既有「`scripts` 折成一个带计数的组」「组数 ≤ 上限」用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：overview 中孤立文件节点的 label 含目录前缀而非裸文件名；两个同名文件在不同目录时 label 可区分；单成员目录不再出现 `(1)` 组标签；既有 hover/缩放/爆炸/下钻用例不回归
- [ ] 新增用例钉住 file 图与 entity 图两种 id 形态下 `scopeRelativePath`/`directoryPathOf` 的行为（用真实形态的 fixture，不用合成的单一形态）
- [ ] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实 quay 会话（`/session/e2dd27de-3257-44ab-8209-4f5ac6858459`）PC 与移动视口打开 architecture tab：Overview 中没有任何 `(1)` 的组框；`stamp-version.ts` 这类孤立文件显示为带目录的路径（如 `…/scripts/stamp-version.ts`），同名文件可区分；其余分组（`scripts (229)` 等）不变。

## Touches

- src/modules/architecture/adaptiveGrouping.ts
- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/tests/adaptiveGrouping.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/architecture-grouping-singleton-and-label-polish.md
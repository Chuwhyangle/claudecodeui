---
id: architecture-overview-adaptive-directory-grouping
title: Overview 按目录层自适应分组：叶子目录成一个带计数的组，组数不超过上限
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

2026-10-22 用 Playwright MCP 在真实应用里实测（quay 会话 e2dd27de，PC 1440×900）：Overview 画了 242 个节点，其中 **236 个是 `grp::` 组、229 个组名以文件扩展名结尾、227 个在 `scripts/` 下**（如 `grp::scripts/anti-drift-touches-check.ts`），图自然尺寸 32880×9860，fit 缩放被钳在 5%，是一团灰色。根因是 `OVERVIEW_DEPTH = 2`（`archguardToPlantUml.ts:59`，`PlantUmlGraph.tsx:170` 以固定深度调用渲染器 overview）把**文件名也算成一层**：`scripts/` 是约 230 个文件的平铺目录，永远折不起来。claudecodeui 会话（路径层次深）恰好表现正常（46 个组、fit 26%），所以此前没暴露。

修法：分组依据是**目录层**而不是路径段总数，并自适应。
- 自适应深度：对深度 d=1..N 统计「前 d 段」产生的不同组数（不足 d 段的路径是其自身目录之外的顶层文件，按其目录算），取使组数 ≤ 上限（默认 40，常量）的最大 d；叶子目录（如 `scripts/`）本身就是一个组，标签带计数，如 `scripts (229)`。
- 同一规则用于 `group` 视图：展开某个组时对该前缀下的子路径再按同样的自适应规则分组，而不是直接平铺 229 个文件。
- 深度由本端计算后传给渲染器（`view: { kind: 'overview', depth }`），不依赖 plantuml-js 改动；若渲染器的 `groupByPathPrefix` 仍把文件名当一层，则在桥接层先把文件名剥掉再分组（实现时读 `node_modules/@yalehwang/plantuml-js` 的 `groupByPathPrefix` 确认，不凭印象）。

## AC

- [x] `npx vitest run src/modules/architecture/tests/adaptiveGrouping.test.ts` exit 0：平铺 230 个文件的 `scripts/` 折成 1 个组且计数正确；深层路径（claudecodeui 形态）组数 ≤ 上限且比旧固定深度 2 不退化；组数上限被遵守；任一组名都不以文件扩展名结尾（对目录型分组）
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：`group` 视图展开平铺大目录时再次分组、不平铺全部文件；既有 hover/缩放/爆炸/下钻用例不回归
- [x] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实 quay 会话（`/session/e2dd27de-3257-44ab-8209-4f5ac6858459`）打开 architecture tab：Overview 不再出现以文件名结尾的组，组数 ≤ 40，`scripts` 显示为单个带计数的组；点开该组后是再分组的子视图而不是 229 个文件平铺。claudecodeui 会话的 Overview 仍保持约 46 个组的可读分层。

## Touches

- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/hierarchyIndex.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/adaptiveGrouping.ts
- src/modules/architecture/tests/adaptiveGrouping.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/architecture-overview-adaptive-directory-grouping.md

## Evidence

2026-10-22 续做轮（复用既有 worktree，分支实现 commit 48e1164；本轮另把 develop 合入分支）：

- `npx vitest run src/modules/architecture/tests/adaptiveGrouping.test.ts` → 8/8 passed，exit 0
- `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` → 27/27 passed，exit 0
- `npm run typecheck` → exit 0
- `npm run build` → exit 0
- anti-drift Touches check → OK（5 个实际文件均在声明的 Touches 内）
- DoD 的真机会话视觉复核未在本轮执行：需要运行中的应用与真实 quay 会话，本轮只做到自动化判据全绿。

## Blocker

**2026-10-21T23:08:15.016Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 0/3，剩余未勾 3）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：f0ee36eb-fc67-4d9f-a1dc-29acf04bf032

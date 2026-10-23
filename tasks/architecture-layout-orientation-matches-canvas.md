---
id: architecture-layout-orientation-matches-canvas
title: 架构图缺省布局方向跟画布形状走：宽画布向右、竖屏向下，小图双布局挑适应缩放更大者
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
depends_on:
  - architecture-node-size-from-drawn-content
---
## Proposal

<!-- dedup-ref -->本任务让缺省布局的形状与画布形状匹配。2026-10-23 在真实浏览器里（本会话的 Architecture 标签）测得：PC 画布 1151×578，图缩放后 658×537，宽向只用了 57%、高向 93%，缩放 72% 受高度限制；手机画布 390×620，图 352×308，宽 90%、高 50%，缩放 38% 受宽度限制。缩放本身按「适应」是对的，问题出在布局形状。已完成的 `architecture-layout-aspect-hint`、`architecture-narrow-container-layer-bound` 已把容器比例传给 ELK（`createLayoutEngine({ aspectRatio })`），但对「连通的小图 / 一条依赖链」`elk.aspectRatio` 是空操作，层式布局一定竖着叠；本任务是在它们之后补上「按画布形状选布局方向」，不改它们已有行为。没有开放任务与本任务的核心文件（`elkAspectEngine.ts`）重叠。

要求：
1. 画布明显比图宽（画布宽高比 / 图的宽高比 ≥ `ORIENTATION_RATIO_THRESHOLD = 1.5`）时，用 `elk.direction = RIGHT` 再布一次，两种方向里挑「适应缩放更大」（即 `min(画布宽 / 图宽, 画布高 / 图高)` 更大）的那个；相等或差距不到 5% 保持原方向（避免来回跳）。
2. 只对小图做双布局：实体数 ≤ `ORIENTATION_DUAL_MAX_ENTITIES = 150` 且第一次布局耗时 ≤ `ORIENTATION_DUAL_MAX_MS = 600` 时才做第二次；超出则保持现状，并在读数里记录原因。
3. 画布比例变化触发的重新布局（`shouldRelayoutForAspect`）沿用同一套选择，选择结果按「图指纹 + 画布比例分档」缓存，不重复布局。
4. 手机竖屏不翻转：画布比图高时保持向下，靠节点尺寸（`architecture-node-size-from-drawn-content`）把图缩窄。
5. 方向选择是布局输入，不是事后缩放：选择 RIGHT 时 `createLayoutEngine` 额外带 `elk` 原始选项 `elk.direction`，并保持引擎构造点唯一。

## Plan

1. `elkAspectEngine.ts`：`createLayoutEngine` 增加可选的 `direction`，通过 plantuml-js 的 `ElkLayoutOptions` 原始 `elk` 选项传入；仍是唯一构造点。
2. 新增纯函数（同文件或同级新文件 `layoutOrientation.ts`）：给定两次布局结果的尺寸、画布尺寸，返回选择与理由；单元测试覆盖阈值、5% 迟滞、预算回退、确定性。
3. `PlantUmlGraph.tsx`：布局流程接入双布局与缓存，把选择与理由写进现有的布局读数（性能 / 诊断）。
4. 测试与守卫：`layoutAspect.test.tsx` 与 e2e 读数覆盖填充率，并配控制臂。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/layoutAspect.test.tsx` exit 0：新增用例——宽画布（1151×578）加两实体依赖链夹具选 RIGHT 且适应缩放更大；窄画布（390×620）选向下；两种方向适应缩放相差不到 5% 时保持向下；实体数超过 150 或第一次布局耗时超过预算时不做第二次布局并给出原因；同输入同输出；缓存命中时不重复布局（计数）
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：缩放读数与布局读数包含所选方向与理由；既有用例不回归
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：用两实体依赖链夹具，1440×765 视口下缺省图的面积填充率（图缩放后面积 / 画布面积）≥ 0.6，390×844 视口下 ≥ 0.6（修复前分别约 0.53 与 0.45）
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：新增控制臂——强制只用向下布局时 PC 视口的填充率读数越界变红，主臂与控制臂用同一读取函数
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里打开本项目任一含有两个以上实体的会话（例如本会话）的 Architecture 标签，PC 1440×765 与手机 390×844 各截一张缺省图，读出画布尺寸、图尺寸、填充率与所选方向（修复前 PC 0.53、手机 0.45）；再用较宽的 1920×900 视口看一遍。另在一个大图会话（实体数超过 150，例如 Quay OO 的 Show all 状态）确认没有变慢、方向保持向下。截图存 `tmp/` 并贴进 Evidence；过程中做过的任何改动必须还原。

## Touches

- src/modules/architecture/elkAspectEngine.ts
- src/modules/architecture/layoutOrientation.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/layoutAspect.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- tasks/architecture-layout-orientation-matches-canvas.md

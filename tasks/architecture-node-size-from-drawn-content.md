---
id: architecture-node-size-from-drawn-content
title: 架构图类框尺寸只按画出来的内容定：成员裁剪在布局之前，导出与 Inspector 保持完整
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务让类框的世界尺寸只由「实际会画出来的内容」决定。2026-10-23 在真实浏览器里（本会话的 Architecture 标签，PC 1440×765 与手机 390×844）发现：`VoiceFrameProcessor` 的上游几何是 `data-w=856`、`data-h=160`（`data-attrs-h=90`、`data-ops-h=36`），屏幕上画出来的最长文字却只有 241px；手机上整张图因此只能缩到 38%（宽 90%、高 50%，一半高度空着）。与已完成的 `architecture-entity-kind-and-members-payload`、`architecture-semantic-zoom-layout` 不是同一个机制，没有开放任务声明相同的核心文件（`archguardToPlantUml.ts`），单独立案；`PlantUmlGraph.tsx` 与其它几个架构任务重叠，由调度器串行。

原因（已读 plantuml-js 0.4.0 源码并在真实页面核对）：`estimateEntitySize`（`foundation/layout.js`）用 `entity.members` 里**所有**成员的原文取最长一行来定宽，高度也按全部成员行算。这个类有 7 个成员，被 "… +2 more" 折叠掉的 `+ process(inputs: Float32Array<ArrayBufferLike>[][], outputs: Float32Array<ArrayBufferLike>[][]): boolean`（105 个字符）撑出了 856 的宽度。≤40 个实体的图走 `detail='full'`，不在布局前裁成员；我们的渲染在布局之后才折叠，所以出现「布局按全部成员量尺寸、绘制只画一部分」。

要求：
1. 在把图交给布局之前，应用侧先把每个实体的成员裁成「会画出来的样子」：每行最多 `MEMBER_MAX_CHARS = 48` 个字符，超出的以 `…` 结尾；每个实体最多 `MEMBER_MAX_ROWS = 6` 行成员，超出的换成一行折叠标记，文本形如 `… +N more (M members)`（与上游 0.4.0 的标记行同形，便于读取层统一识别）。两个常量集中定义在一处。
2. 只改「给布局和画面用的那份图」；Text 面板、Copy PlantUML、PlantUML / Mermaid 导出和 Inspector 的成员列表仍用完整成员文本（`Show all N` 仍列出全部）。
3. 语义缩放在缩放 ≥ 90% 时是恒等映射：此时每个实体显示最多 6 行加折叠标记，更多成员看 Inspector。这是有意的取舍，写进设计说明。
4. plantuml-js 已被请求提供 `memberMaxChars` / `memberMaxRows` 两个选项（让 `estimateEntitySize` 与渲染一致）。本任务不等它：先在应用侧裁剪；上游发版后只需把裁剪换成传选项，常量与行为保持不变。

## Plan

1. `archguardToPlantUml.ts`：新增只作用于「绘制 / 布局用图」的成员裁剪（字符上限、行数上限、折叠标记行），导出常量；导出与文本路径继续用未裁剪的成员。
2. `PlantUmlGraph.tsx`：布局与渲染使用裁剪后的图；`onDrawnPlantUmlChange` 与导出使用的文本保持完整成员（沿用现有的两份图分离，必要时显式拆成两个函数调用）。
3. 夹具：`e2e/support/architectureFixture.ts` 增加一个与真实情形同形的两实体依赖链夹具（一个类含 7 个成员，其中两条超长签名；另一个类含 20 个成员），供单元测试与 e2e 共用。
4. 测试与守卫：单元测试覆盖裁剪与导出完整性；e2e 读数覆盖「节点世界宽度与画出文字宽度的比」与手机缺省缩放，并配控制臂。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts` exit 0：新增用例——成员文字超过 48 个字符时被裁成 48 个字符以内并以 `…` 结尾；一个实体成员超过 6 个时只保留 6 行并追加一行 `… +N more (M members)`（N、M 数值正确）；不超限的实体与成员原样不变；Text / 导出用的图仍含完整成员原文（用含 105 个字符签名的成员断言）；同一输入同一输出
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/layoutAspect.test.tsx` exit 0：用 plantuml-js 对夹具实际布局，含超长签名的类的 `data-w` 不超过 `1.35 × 最长可见文字宽度 + 24`（最长可见文字取自画出的成员行与类名）；Text 面板与 Copy PlantUML 的文本里仍含完整的 105 字符签名；既有用例不回归
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：用上述夹具，在 1440×765 与 390×844 两个视口下，每个实体框的世界宽度与其最长画出文字的世界宽度之比 ≤ 1.35 加 24 的绝对余量；390×844 视口的缺省缩放 ≥ 60%（修复前该夹具约 38%）
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：新增控制臂——关闭成员裁剪后同一读数里节点宽度比与手机缺省缩放同时越界变红，主臂与控制臂用同一读取函数
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里打开本项目任一含有两个以上实体的会话（例如本会话）的 Architecture 标签，PC 1440×765 与手机 390×844 各截一张缺省图，并读出 `VoiceFrameProcessor` 的 `data-w`（修复前 856）、手机缺省缩放（修复前 38%）、画布填充率；Inspector 里该类的成员列表仍有完整签名，Text 面板的 PlantUML 仍含完整签名。截图存 `tmp/` 并贴进 Evidence；过程中做过的选中、置顶、过滤改动必须还原。

## Touches

- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/archguardToPlantUml.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/layoutAspect.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- tasks/architecture-node-size-from-drawn-content.md

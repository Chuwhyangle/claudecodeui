---
id: architecture-node-size-from-drawn-content
title: 架构图类框尺寸只按画出来的内容定：成员裁剪在布局之前，导出与 Inspector 保持完整
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务让类框的世界尺寸只由「实际会画出来的内容」决定，做法是使用 plantuml-js 0.5.0 的成员上限选项。2026-10-23 在真实浏览器里（本会话的 Architecture 标签，PC 1440×765 与手机 390×844）发现：`VoiceFrameProcessor` 的上游几何是 `data-w=856`、`data-h=160`（`data-attrs-h=90`、`data-ops-h=36`），屏幕上画出来的最长文字却只有 241px；手机上整张图因此只能缩到 38%（宽 90%、高 50%，一半高度空着）。与已完成的 `architecture-entity-kind-and-members-payload`、`architecture-semantic-zoom-layout` 不是同一个机制，没有开放任务声明相同的核心文件（`archguardToPlantUml.ts`），单独立案；`PlantUmlGraph.tsx` 与其它几个架构任务重叠，由调度器串行。

原因（已读 plantuml-js 0.4.0 源码并在真实页面核对）：`estimateEntitySize`（`foundation/layout.js`）用 `entity.members` 里**所有**成员的原文取最长一行来定宽，高度也按全部成员行算。这个类有 7 个成员，被 "… +2 more" 折叠掉的 `+ process(inputs: Float32Array<ArrayBufferLike>[][], outputs: Float32Array<ArrayBufferLike>[][]): boolean`（105 个字符）撑出了 856 的宽度。≤40 个实体的图走 `detail='full'`，不在布局前裁成员；我们的渲染在布局之后才折叠，所以出现「布局按全部成员量尺寸、绘制只画一部分」。

要求：
1. 使用 plantuml-js 0.5.0 新增的渲染选项（已发布，挂在 `RendererOptions`，与 `detail` 同族）：依赖升到 `@yalehwang/plantuml-js@^0.5.0`，应用向渲染入口传 `memberMaxChars: 48`、`memberMaxRows: 6`。这两个选项让成员行超过 48 个字符时以 `…` 截断、每个实体最多画 6 行成员、超出用 `… +N more (M members)` 标记行，且 `estimateEntitySize` 与渲染都按截断后的文字（`PlantUmlMember.display`）量尺寸；`raw` 原文不会被改，`renderDetailed().model` 里 Inspector 与导出仍读完整文本。常量 48 与 6 集中定义在一处（`MEMBER_MAX_CHARS`、`MEMBER_MAX_ROWS`）。若 `npm install` 暂时解析不到 0.5.0（刚发布，registry 仍在传播），等待并重试，不要回退到应用侧自己裁剪。
2. 不在应用侧再复制一份裁剪逻辑；Text 面板、Copy PlantUML、导出和 Inspector 的成员列表仍用完整成员文本（`Show all N` 仍列出全部）。
3. 语义缩放在缩放 ≥ 90% 时是恒等映射：此时每个实体显示最多 6 行加折叠标记，更多成员看 Inspector。这是有意的取舍，写进设计说明。
4. 与语义缩放读取层的关系：上游折叠标记行 `… +N more (M members)` 由读取层识别并作为总数来源，不要在应用里再画第二个标记。

## Plan

1. `package.json` 与 `package-lock.json`：升级 `@yalehwang/plantuml-js` 到 `^0.5.0`。
2. `PlantUmlGraph.tsx`：把 `memberMaxChars` 与 `memberMaxRows`（常量 `MEMBER_MAX_CHARS`、`MEMBER_MAX_ROWS`）传给渲染入口；确认 Text 面板与导出读取的仍是未截断的 model。
3. `archguardToPlantUml.ts`：不改成员内容；仅在需要时导出上面两个常量供渲染入口与测试使用。
4. 夹具：`e2e/support/architectureFixture.ts` 增加一个与真实情形同形的两实体依赖链夹具（一个类含 7 个成员，其中两条超长签名；另一个类含 20 个成员），供单元测试与 e2e 共用。
5. 测试与守卫：单元测试覆盖选项传递与导出完整性；e2e 读数覆盖「节点世界宽度与画出文字宽度的比」与手机缺省缩放，并配控制臂。

## AC

- [ ] `npm ls @yalehwang/plantuml-js --depth=0` 输出的版本 ≥ 0.5.0 且 exit 0；`npx vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——渲染入口被调用时带 `memberMaxChars: 48` 与 `memberMaxRows: 6`；用含 105 个字符签名的成员的夹具渲染后，画出的成员文字不超过 48 个字符且以 `…` 结尾，成员超过 6 个的实体只画 6 行加一行 `… +N more (M members)`（N、M 数值正确）；`renderDetailed().model` 里该成员的 `raw` 仍是完整 105 字符，Text 面板与 Copy PlantUML 的文本里仍含完整签名；不超限的实体不变；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/layoutAspect.test.tsx` exit 0：用 plantuml-js 对夹具实际布局，含超长签名的类的 `data-w` 不超过 `1.35 × 最长可见文字宽度 + 24`（最长可见文字取自画出的成员行与类名）
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：用上述夹具，在 1440×765 与 390×844 两个视口下，每个实体框的世界宽度与其最长画出文字的世界宽度之比 ≤ 1.35 加 24 的绝对余量；390×844 视口的缺省缩放 ≥ 60%（修复前该夹具约 38%）
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：新增控制臂——不传这两个选项时同一读数里节点宽度比与手机缺省缩放同时越界变红，主臂与控制臂用同一读取函数
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里打开本项目任一含有两个以上实体的会话（例如本会话）的 Architecture 标签，PC 1440×765 与手机 390×844 各截一张缺省图，并读出 `VoiceFrameProcessor` 的 `data-w`（修复前 856）、手机缺省缩放（修复前 38%）、画布填充率；Inspector 里该类的成员列表仍有完整签名，Text 面板的 PlantUML 仍含完整签名。截图存 `tmp/` 并贴进 Evidence；过程中做过的选中、置顶、过滤改动必须还原。

## Touches

- package.json
- package-lock.json
- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/archguardToPlantUml.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/layoutAspect.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- tasks/architecture-node-size-from-drawn-content.md

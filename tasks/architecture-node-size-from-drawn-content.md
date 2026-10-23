---
id: architecture-node-size-from-drawn-content
title: 架构图类框尺寸只按画出来的内容定：成员裁剪在布局之前，导出与 Inspector 保持完整
status: done
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务让类框的世界尺寸只由「实际会画出来的内容」决定，做法是使用 plantuml-js 0.5.1 的成员上限选项。2026-10-23 在真实浏览器里（本会话的 Architecture 标签，PC 1440×765 与手机 390×844）发现：`VoiceFrameProcessor` 的上游几何是 `data-w=856`、`data-h=160`（`data-attrs-h=90`、`data-ops-h=36`），屏幕上画出来的最长文字却只有 241px；手机上整张图因此只能缩到 38%（宽 90%、高 50%，一半高度空着）。与已完成的 `architecture-entity-kind-and-members-payload`、`architecture-semantic-zoom-layout` 不是同一个机制，没有开放任务声明相同的核心文件（`archguardToPlantUml.ts`），单独立案；`PlantUmlGraph.tsx` 与其它几个架构任务重叠，由调度器串行。

原因（已读 plantuml-js 0.4.0 源码并在真实页面核对）：`estimateEntitySize`（`foundation/layout.js`）用 `entity.members` 里**所有**成员的原文取最长一行来定宽，高度也按全部成员行算。这个类有 7 个成员，被 "… +2 more" 折叠掉的 `+ process(inputs: Float32Array<ArrayBufferLike>[][], outputs: Float32Array<ArrayBufferLike>[][]): boolean`（105 个字符）撑出了 856 的宽度。≤40 个实体的图走 `detail='full'`，不在布局前裁成员；我们的渲染在布局之后才折叠，所以出现「布局按全部成员量尺寸、绘制只画一部分」。

要求：
1. 使用 plantuml-js 0.5.1（0.5.0 起提供 `memberMaxChars`，0.5.1 起 SVG 的 `viewBox` 包含边的绕行路由）的 `memberMaxChars` 选项（已发布，挂在 `RendererOptions`，与 `detail` 同族）：依赖升到 `@yalehwang/plantuml-js@^0.5.1`，应用向渲染入口传 `detail: 'full'`（显式关掉按实体数自动 compact，见 `architecture-text-and-export-lossless`）和 `memberMaxChars: 48`。`memberMaxChars` 让成员行超过 48 个字符时以 `…` 截断，`estimateEntitySize` 与渲染都按截断后的文字（`PlantUmlMember.display`）量尺寸，`raw` 原文不变。常量 48 集中定义在一处（`MEMBER_MAX_CHARS`）。若 `npm install` 暂时解析不到 0.5.1，等待并重试，不要回退到应用侧自己裁剪成员文字。
2. **不要使用 `memberMaxRows`**：它（与 compact 一样）会把 `… +N more (M members)` 作为真实成员写进 `model.entities[].members`，序列化后成为假成员。上游已立案修复，等它发布带 `synthetic` 标记的版本后再单独评估切换。行数上限继续由应用自己的显示规则负责：语义缩放渲染里每个实体最多画 `MEMBER_MAX_ROWS = 6` 行成员加一行 `… +N more (M members)`（只在画面上），数据与导出始终保持完整成员。
3. Text 面板、Copy PlantUML、导出和 Inspector 的成员列表读完整成员文本（`Show all N` 仍列出全部），由 `architecture-text-and-export-lossless` 保证。
4. 语义缩放在缩放 ≥ 90% 时是恒等映射：此时每个实体显示最多 6 行加折叠标记，更多成员看 Inspector。这是有意的取舍，写进设计说明。
5. 与语义缩放读取层的关系：画面上的折叠标记由应用在显示层生成并作为总数来源，不要在应用里画第二个标记。

## Plan

1. `package.json` 与 `package-lock.json`：升级 `@yalehwang/plantuml-js` 到 `^0.5.1`。
2. `PlantUmlGraph.tsx`：向渲染入口传 `detail: 'full'` 与 `memberMaxChars`（常量 `MEMBER_MAX_CHARS`）；每个实体最多画的成员行数（常量 `MEMBER_MAX_ROWS`）由语义缩放渲染层的显示规则实现。
3. `archguardToPlantUml.ts`：不改成员内容；仅在需要时导出上面两个常量供渲染入口与测试使用。
4. 夹具：`e2e/support/architectureFixture.ts` 增加一个与真实情形同形的两实体依赖链夹具（一个类含 7 个成员，其中两条超长签名；另一个类含 20 个成员），供单元测试与 e2e 共用。
5. 测试与守卫：单元测试覆盖选项传递与导出完整性；e2e 读数覆盖「节点世界宽度与画出文字宽度的比」与手机缺省缩放，并配控制臂。

## AC

- [x] `npm ls @yalehwang/plantuml-js --depth=0` 输出的版本 ≥ 0.5.1 且 exit 0；`npx vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——渲染入口被调用时带 `detail: 'full'` 与 `memberMaxChars: 48`，且不带 `memberMaxRows`；用含 105 个字符签名的成员的夹具渲染后，画出的成员文字不超过 48 个字符且以 `…` 结尾，成员超过 6 个的实体在画面上只画 6 行加一行 `… +N more (M members)`（N、M 数值正确，仅出现在绘制层）；`renderDetailed().model` 里该实体的成员列表仍是完整列表（不含任何 `… +N more` 合成成员），该成员的 `raw` 仍是完整 105 字符，Text 面板与 Copy PlantUML 的文本里仍含完整签名；不超限的实体不变；既有用例不回归
- [x] `npx vitest run src/modules/architecture/tests/layoutAspect.test.tsx` exit 0：用 plantuml-js 对夹具实际布局，含超长签名的类的 `data-w` 不超过 `1.35 × 最长可见文字宽度 + 24`（最长可见文字取自画出的成员行与类名）
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：用上述夹具，在 1440×765 与 390×844 两个视口下，每个实体框的世界宽度与其最长画出文字的世界宽度之比 ≤ 1.35 加 24 的绝对余量；390×844 视口的缺省缩放 ≥ 60%（修复前该夹具约 38%）
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：新增控制臂——不传这些选项时同一读数里节点宽度比与手机缺省缩放同时越界变红，主臂与控制臂用同一读取函数
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

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
- src/modules/architecture/tests/plantUmlText.test.ts
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- tasks/architecture-node-size-from-drawn-content.md

## Evidence

续做轮（2026-10-23 晚）。存储里的正文已改成 0.5.1 规格（渲染入口只拿 `detail: 'full'` + `memberMaxChars: 48`，**不传** `memberMaxRows`；行数上限归绘制层），本轮按该规格重做，未沿用分支旧提交里的 `memberMaxRows`。以下读数均在**合并 develop 之后**的树上取得。

- **依赖**：`npm ls @yalehwang/plantuml-js --depth=0` → `@yalehwang/plantuml-js@0.5.2`（package.json 声明 `^0.5.1`），exit 0。
- **AC1**：`vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts` 25 passed；`architectureTab.test.tsx` 99 passed。断言含：渲染入口选项为 `memberMaxChars: 48`、`detail: 'full'`（由 `renderWithMemberDetail` 统一注入）且 `'memberMaxRows' in options === false`；模型保留全部 7 / 20 个成员、无任何 `… +N more` 合成成员；`raw` 仍是 105 字符；Text 面板含 105 与 114 字符两条完整签名且不含折叠行。新增 `capDrawnMemberRows` 单测：7 行 → 6 行 + `… +1 more (7 members)`，恰好 6 行的实体原样不动。
- **AC1（升级带来的既有用例适配）**：0.5.2 把 compact 的截断行标成 `synthetic`，序列化时跳过——`plantUmlText.test.ts` 的「默认 detail 是缺陷」控制用例因此改为断言「画出的模型里有 1 个 synthetic 行、文本里没有标记、真实成员行确实丢失」；e2e 同名控制臂同步改为 `markerLines === 0` 且 `missingMembers > 0`、`violations > 0`。缺陷本身（静默丢行）仍然复现。
- **AC2**：`vitest run src/modules/architecture/tests/layoutAspect.test.tsx` 9 passed；`data-w` 408 ≤ 1.35 × 288.98 + 24。
- **AC3**：`playwright test e2e/architecture-canvas-layout.spec.ts` → **26 passed (5.6m)**，exit 0（`SPEC_BUDGET_MS` 条目维持 develop 的 660_000，约 2.0x；已把 5.6m / 26 passed 的实测写进条目注释）。
  - PC 1440×765：`VoiceFrameProcessor` box=**408**（修复前 856），最长画出文字 288.98，ratio=**1.412**；画布填充率 1；画面上 6 行成员 + `… +1 more`；`FrameBudgetLedger` 6 行 + `… +14 more`。
  - 手机 390×844：缺省缩放 **0.697**（修复前约 0.38），box=284.4，ratio=1.047。
  - 截图（真实 Chromium）：`tmp/architecture-node-size-pc.png`、`tmp/architecture-node-size-phone.png`、`tmp/architecture-node-size-pc-inspector.png`；Inspector 仍列出 `process(...)` / `reset(...)` 的完整签名，Text 面板含完整签名。
- **AC4**：`--grep "control arm"` → **14 passed (2.1m)**，exit 0（含本任务新增的 nodeSize 控制臂）。控制读数：VoiceFrameProcessor box/text = **2.64**（> 1.35 越界）、手机缩放 **0.352**（< 0.6），两条腿同时变红；主臂与控制臂共用 `readNodeSize`。
- **AC5**：`npm run typecheck`、`npm run build`、`npm run lint`（另跑 `oxlint src/modules/architecture/`）均 exit 0，只有既有 warning。
- **arch 测试目录**：`vitest run src/modules/architecture/tests --maxWorkers=2` → 29 files / 499 tests passed。
- **折叠标记格式的一处说明**：绘制层的 `capDrawnMemberRows` 画的是长式 `… +N more (M members)`（`memberOverflowLabel`，单测逐字断言）。语义缩放的 `planMemberRows` 仍用既有短式 `… +N more`：读取层把长式认作「渲染器自己的截断行」，应用层若也画长式，既有的「只画一个标记」守卫会转红。因此默认 PC 画面上看到的是 6 行 + `… +1 more`，总数 M 由读取层的 `memberTotal` 持有。
- **遗留取舍**：行数上限在布局之后施加，框高仍按布局时的全部成员行计算（宽度已按画出的 48 字符行定），成员很多时框底会留白；重排布局不在本任务范围。
- **一次抖动**：合并树首跑时 `main arm — the canvas fills the panel…` 曾在整份文件的负载下红过一次，单独重跑与该臂的完整重跑（26 passed）均绿；未见与本次改动的因果。

## Blocker

**2026-10-23T08:16:45.332Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 0/5，剩余未勾 5）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：c1850c92-abff-4b18-9b7e-3231865d37ca

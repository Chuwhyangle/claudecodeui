---
id: architecture-semantic-zoom-render-regressions
title: 语义缩放渲染回归修复：边被外框裁掉、属性与方法分错格
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务修复 `architecture-semantic-zoom-layout` 与 `architecture-semantic-zoom-defects-polish`（均已 done）在真实浏览器里暴露的两个渲染回归，不改变它们建立的原则与档位。两个任务的几何守卫通过，说明守卫没有覆盖下面这两条读数；本任务补上守卫与控制臂。没有开放任务与本任务的核心文件（`semanticZoomLayout.ts`、`semanticZoomRead.ts`）重叠，其余文件与其它架构任务重叠，由调度器串行。

证据（2026-10-23，构建 15:10，PC 1440×765，会话「重启后 Claude Code 会话自动恢复」缺省缩放 18% 与本会话的 Architecture 标签；截图 `tmp/cl-01-top-clipped.png`、`tmp/cl-03-top-unclipped.png`、`tmp/ix2-pc-00-default.png`、`tmp/ix2-pc-02-neighbourhood.png`）：

1. **边被最外层包框的轮廓裁掉。** 该图的 SVG `viewBox` 是 `[0,0,1148,477]`，恰好等于所有包框的并集 `[0,0,1148,477]`；62 条边的坐标范围是 `[-4,-9,1132,462]`，其中 5 条（`CodexProvider→IProviderAuth`、`CursorProvider→IProviderAuth`、`CursorProvider→IProviderSkills`、`CursorProvider→IProviderSessions`、`ClaudeResidentHostDriver→ClaudeResidentSessionRegistries`）有一部分在 SVG 之外，沿外框外侧走的横线与竖线整段不可见（把 SVG 的 `overflow` 临时改成 visible 后它们出现）。原因：`semanticZoomLayout.ts` 约 776–785 行计算内容边界时只取「所有包框加所有类框」，注释写着 "the drawing's outermost objects"，没有算边；渲染时又把画布裁成该边界并平移到原点，SVG 根元素 `overflow: hidden`。ELK 原本在复合包外留了边距（plantuml-js 原始输出的包从 40px 才开始），缩放 < 90% 的语义缩放路径把这圈边距切掉了；≥ 90% 是恒等映射，保留原始边距，所以放大后不裁。Quay OO 的图没有被裁的边，claudecodeui 的另一个会话有 4 条（最多越界 6px），本会话只有一条边，不受影响。要求：内容边界 = 包框 ∪ 类框 ∪ 所有边的折线点 ∪ 箭头图形，再加固定外边距 `SEMANTIC_CONTENT_MARGIN_PX = 12`（笔画宽度与箭头也算在内）；画布底色、`viewBox`、小地图的内容框与 Fit 读数都使用同一个边界，不得各算各的。
2. **属性与方法放错了格。** 本会话的 `StreamingVad`：第一格里是 `buildSegments()`、`constructor()`、`floorPercentile()`、`flush()` 四个方法，第二格里是 `endpointFrames`、`energies`、`frameIndex`、`maxSegmentEnabled` 四个属性；`VoiceFrameProcessor` 的 `process()` 在属性格里、`framesAt` 在方法格里。原因（已读代码）：`semanticZoomRead.ts` 的 `membersOf` 在载荷成员种类数组长度等于保留成员数时，按下标把 payload 的种类套到渲染器的成员文本上；但 0.4.0 渲染器按「先属性后方法」的顺序画（`archguardToPlantUml.ts` 的成员行也是先 field 后 method），而 payload 里是图自己的原始顺序（属性与方法交错），两个序列下标对不上，于是种类被错位地套上。要求：读取层只按渲染器自己的 `uml-attr` / `uml-op` 类分组（0.4.0 已由 model 的成员种类生成，属性类型里含括号的字段也不会被误判），删除按下标套用 payload 种类的路径；同一个实体里任何一行的所属格必须等于该成员的真实种类。

## Plan

1. `semanticZoomLayout.ts`：内容边界计入边折线点、箭头图形与外边距；导出常量；所有消费方（画布底色、`viewBox`、小地图内容框、Fit）读同一个返回值。
2. `semanticZoomRead.ts`：`membersOf` 只读 `uml-attr` / `uml-op`；删除 `memberKindsById` 按下标套用的路径及其注释；调用方不再传该提示。
3. `PlantUmlGraph.tsx`：把新的内容边界接到绘制（画布矩形、根元素尺寸、平移）；移除对 `memberKindsById` 的传递。
4. 夹具与守卫：`e2e/support/architectureFixture.ts` 增加两个夹具——（a）沿最外层包框外侧走线的图（至少 5 条边在外圈绕行），（b）成员在 payload 里属性与方法交错排列的类；单元测试与 e2e 读数各配控制臂。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/semanticZoomLayout.test.ts` exit 0：新增用例——用 plantuml-js 对「外圈走线」夹具实际布局得到的几何，内容边界包含所有边折线点与箭头图形且大于等于包框并集加 12px 外边距；去掉边后边界恢复为包框并集（证明读数取决于边）；缩放 ≥ 0.9 时行为与既有恒等映射一致；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/semanticZoomRead.test.ts` exit 0：新增用例——成员在 payload 里属性与方法交错的夹具，读出的每个成员的格与其真实种类一致（逐个成员断言，不只断言个数）；类型里含括号的字段被读成属性；不再存在按下标套用 payload 种类的路径（用测试断言读取函数的参数里没有 `kinds`），既有用例不回归
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：用上述两个夹具，1440×765 与 390×844 两个视口、65/46/33/17/6% 五档下，所有边的折线点与箭头都在 SVG 盒内（容差 0.5px）；每个类框里第二条分隔线之上的行都是属性、之下的行都是方法（按夹具已知的种类逐行断言）
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：新增控制臂——只按包框与类框算内容边界时边越界读数变红；恢复按下标套用 payload 种类时分格读数变红；主臂与控制臂用同一读取函数
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里（PC 1440×765）打开会话「重启后 Claude Code 会话自动恢复」的 Architecture 标签，缺省缩放下读出所有边的坐标范围与 SVG 盒（修复前 5 条越界、最多 9px），并截图与 `tmp/cl-01-top-clipped.png` 对比，外圈走线可见；打开本会话的 Architecture 标签，`StreamingVad` 与 `VoiceFrameProcessor` 的属性都在第一格、方法都在第二格，截图并列出每个成员所在格。另用 Quay OO 会话确认没有回归。截图存 `tmp/` 并贴进 Evidence；过程中做过的任何改动必须还原。

## Touches

- src/modules/architecture/semanticZoomLayout.ts
- src/modules/architecture/semanticZoomRead.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/semanticZoomLayout.test.ts
- src/modules/architecture/tests/semanticZoomRead.test.ts
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- tasks/architecture-semantic-zoom-render-regressions.md

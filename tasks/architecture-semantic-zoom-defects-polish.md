---
id: architecture-semantic-zoom-defects-polish
title: 架构图语义缩放缺陷修补：构造型文字最小字号、粘性包名重影与遮挡、上游溢出行去重、分隔线定位、置顶徽标读名、名字按实际宽度换行
status: done
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务修复 `architecture-semantic-zoom-layout`（已 done，语义缩放引擎与渲染）在真实浏览器里暴露的八处缺陷（1–4 来自 20 张五档截图，5–8 来自随后在本会话 Architecture 标签上的交互探查，源码核对过原因），不改变它建立的原则与档位。该任务的 AC 全部通过，说明它的几何守卫没有覆盖到下面这些读数；本任务同时补上守卫与控制臂。合并决定：没有开放任务与本任务 Touches 重叠，单独立案。

证据（2026-10-23 重启到新构建后，用 MCP 浏览器在 1440×765 与 390×844 两个视口、Quay OO 与 claudecodeui 两个项目的图上，各取 65/46/33/17/6% 五档，共 20 张截图，存于 `tmp/sz-verify/`，拼图 `tmp/sz-verify/montage-{pc,m}-{quay,cui}.png`；参考设计在提交 `e8bd1acbb` 与 `7c7135598` 的 `docs/proposals/architecture-semantic-zoom/`，worktree 里没有该目录时用 `git show e8bd1acbb:docs/proposals/architecture-semantic-zoom/README.md` 读取）：

1. **接口框里的 `<<interface>>` 文字低于最小字号。** A 档下每个接口节点的构造型文字屏幕字号只有约 8px（手机约 8.8px），低于下限（PC 10px、手机 11px）。plantuml-js 0.4.0 把它作为单独的小字输出，渲染层没有对它应用最小字号规则。要求：A 档下构造型文字要么按最小字号绘制且标题格高度随之计算（不得把标题压到不可读），要么在放不下时隐藏；二者选其一并写进设计说明，但任何可见文字的屏幕字号都不得低于下限。
2. **粘性包名与包自己的标签页重影。** 6% 手机档下，`providers`、`list` 的粘性标签叠在同一个包的 `claude (14) ★2` 标签页上，盖住一半，而这两个包自己的标签页明明在视口内；提示条 `overviewTooSmall` 也压住了 `modules`、`chat`。要求：粘性包名只在该包自己的标签页已经滚出视口（标签页矩形与视口不相交）时才显示；提示条不得压住任何包的标签页，必要时移到不与标签页相交的位置。
3. **粘性包名盖住类名。** 手机 33% 与 17% 下 `cursor (7)` 半透明地压在 `CursorProvider` 上，PC 上顶部 `list` 标签只露出 `hst`（被裁成不可读的碎片）。要求：粘性标签的屏幕矩形不得与任何可见类名文字的矩形相交（放不下就不显示该粘性标签），且粘性标签必须完整显示，不得被视口边缘裁成碎片。
4. **成员区出现 plantuml-js 自己的溢出行，与我们的 `… +N more` 重复。** 手机 65% 下 `CursorMcpProvider` 的方法区第一行是 `… +1 more (5 members)`，下面又有我们画的 `… +2 more`。要求：读取层（`semanticZoomRead.ts`）把上游输出的溢出提示行从成员列表里剔除，只保留一处溢出提示，且总数以上游的 `(N members)` 为准。

5. **属性 / 方法分隔线穿过成员文字。** PC 的 `StreamingVad` 与 `VoiceFrameProcessor`、手机的 `StreamingVad` 里，第二条分隔线画在 `- pendingCount: number`、`- noise: number`、`- forceCutSearchFrames: number` 这类成员行上。原因：`planCompartmentRules` 把这条线放在类体高度的 50%（只有方法时放在 6px），是比例；成员行（`planMemberRows`）却从标题格下方逐行往下排，与线位置各算各的。要求：成员文字显示时，这条线按成员行定位——位置是「标题格高度 + 属性行数 × 行高 + 内边距」，属性在线上、方法在线下，线与任何成员文字矩形不相交；成员文字隐藏时保持现有的紧凑比例。属性行与方法行必须按读取层的 `attr` / `op` 分组排列，不得把全部成员当成一个列表。
6. **置顶实体的类名被读成 `📌`。** 置顶后该实体的标题位置显示缺字方块、类名消失（真实页面 DOM 核对：节点的名字位置只有一个内容为 `📌` 的 `<text>`，原类名不在其中）。原因：`annotateNodes` 用 `insertBefore(badge, firstChild)` 把置顶徽标 `<text class="arch-pinned-badge">` 插到节点最前面，读取层取「第一个 `<text>`」当类名，于是类名读成了 `📌`；渲染层随后又在左上角再画一个徽标。要求：读取层按角色识别类名（排除 `.arch-pinned-badge`、`.arch-selected-check`、构造型与成员文本），不依赖子元素顺序；每个置顶实体只画一个徽标；类名永远等于该实体的标签。
7. **名字在宽框里仍折成两行。** `VoiceFrameProcessor` 在 615px 宽的框里写成 `VoiceFrame / Processor`。原因：`planEntityName` 在规划阶段用固定上限 `CLASS_NAME_MAX_WIDTH_PX = 130` 决定「单行 / 折两行」，与最终框的实际宽度无关；原型 v14 是在绘制时按实际框宽再选。要求：规划保留最小宽度计算，绘制时按该框映射后的实际宽度重新选择：单行放得下就单行，其次折两行，最后中间省略；标题格高度随所选行数确定，不得因为单行放得下却仍占两行高度。
8. **所有构造型文字都要遵守最小字号，不只接口。** 条目 1 对接口的要求扩展到函数与枚举：渲染层绘制构造型文字时写死 `font-size = fontPx * 0.8`（本身就低于下限），接口、函数、枚举都走这一行。要求同条目 1，且函数节点只有一个小格时不得画出空的第二格。

## Plan

1. `semanticZoomRead.ts`：识别并剔除上游溢出提示行（文本形如 `… +K more (N members)`，来自 0.4.0 渲染器），读出 N 作为成员总数；构造型文字作为单独字段读出，不并入成员。
2. `semanticZoomPlan.ts` 与 `semanticZoomLayout.ts`：构造型文字的规划（按最小字号绘制并计入标题格高度，或放不下时隐藏）；粘性包名的出现条件改为「自己的标签页矩形与视口不相交」，并增加与类名文字矩形、提示条矩形的避让；粘性标签整体落在视口内。
3. `PlantUmlGraph.tsx`：把上面的规划结果接入绘制，提示条位置与标签页避让。
4. 几何守卫补全：在 `e2e/architecture-canvas-layout.spec.ts` 里让「可见文字的屏幕字号 ≥ 下限」的读数覆盖构造型文字和所有粘性标签；新增「粘性标签与自己的标签页不同时可见」「粘性标签矩形与可见类名文字矩形不相交」「成员区不含上游溢出行」的读数，并为每条配控制臂。
5. `semanticZoomPlan.ts`：`planCompartmentRules` 增加「成员行已显示」的入口，按属性行数与行高定位第二条线；`planMemberRows` 按 `attr` / `op` 分组输出并返回分组边界；`planEntityName` 保留最小宽度，另提供按实际宽度选择单行 / 折行 / 省略的函数供绘制调用。
6. `semanticZoomRead.ts`：类名读取按角色（排除徽标、选中勾、构造型、成员），并用置顶实体的夹具验证；`PlantUmlGraph.tsx` 只画一个置顶徽标。
7. 构造型文字的字号规则覆盖接口、函数、枚举三种。

## AC

- [x] `npx vitest run src/modules/architecture/tests/semanticZoomRead.test.ts` exit 0：新增用例用 0.4.0 渲染器对一个成员数超过显示上限的类实际渲染出的 SVG，断言上游溢出提示行不出现在成员列表里、读出的成员总数等于该行的 `(N members)`，以及一个只有溢出提示行而无其它成员的边界用例
- [x] `npx vitest run src/modules/architecture/tests/semanticZoomPlan.test.ts` exit 0：新增用例覆盖构造型文字（按最小字号绘制且标题格高度随之增加，或放不下时被隐藏，两条路径各一个用例，屏幕字号永远不低于下限）、粘性包名只在自己的标签页矩形与视口不相交时出现、粘性标签避开类名文字矩形与提示条矩形、粘性标签完整落在视口内
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/canvasLayoutContract.test.tsx` exit 0：既有用例不回归；提示条与包标签页的屏幕矩形不相交
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：在 1440×765 与 390×844 两个视口、Quay OO 与 claudecodeui 两类夹具、65/46/33/17/6% 五档下，所有可见文字（含构造型文字与粘性标签）的屏幕字号 ≥ 下限；粘性标签与其所属包自己的标签页不同时可见；粘性标签矩形与任何可见类名文字矩形不相交；成员区文本里不含上游溢出行
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：为上面新增的每条读数各配一个控制臂（关闭构造型字号规则、关闭粘性标签出现条件、关闭粘性避让、关闭溢出行剔除各一条），主臂与控制臂用同一读取函数，控制臂里对应读数必须变红
- [x] `npx vitest run src/modules/architecture/tests/semanticZoomPlan.test.ts src/modules/architecture/tests/semanticZoomRead.test.ts` exit 0：新增用例覆盖——成员显示时第二条分隔线位于最后一个属性行之下、第一个方法行之上且与所有成员行矩形不相交（含只有属性、只有方法、两者都有、属性行被「… +N more」截断四种）；一个置顶实体的夹具（节点最前面有徽标 `<text>`）读出的类名等于实体标签而不是 `📌`，且只产生一个徽标；`planEntityName` 的按实际宽度选择：615px 宽度下 `VoiceFrameProcessor` 取单行，宽度不足时取折两行，再不足取中间省略，标题格高度分别为单行高与两行高；函数、枚举节点的构造型文字字号不低于下限，函数节点只有一条规则
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（同上一条 e2e AC 的预算说明）：新增读数——任一显示成员文字的类框里，分隔线的屏幕矩形与所有成员文字矩形不相交；置顶一个实体后该实体的类名文字等于其标签且框内只有一个徽标；在宽度足够的框里类名只占一行
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：为上面三条新读数各配控制臂（恢复按比例定位分隔线、恢复按第一个 `<text>` 读类名、恢复固定 130px 的单行 / 折行判定各一条），控制臂里对应读数必须变红
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里分别用 1440×765 与 390×844 打开 Quay OO 与 claudecodeui 两个项目的 Architecture 标签，在 65/46/33/17/6% 五档截图（共 20 张，存 `tmp/` 并贴进 Evidence），与 `tmp/sz-verify/` 里的修复前截图并排比对：接口框的构造型文字不再低于最小字号，6% 手机档的 `providers`、`list` 不再与 `claude (14) ★2` 重影，手机 33% 与 17% 的 `cursor (7)` 不再压住类名，手机 65% 的 `CursorMcpProvider` 只有一处溢出提示。贴出几何读数。另外在 PC 上置顶一个实体并截图，类名可读、只有一个徽标、分隔线不穿过成员文字；截图后必须取消置顶，让图回到初始状态。

## Touches

- src/modules/architecture/semanticZoomRead.ts
- src/modules/architecture/semanticZoomPlan.ts
- src/modules/architecture/semanticZoomLayout.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/semanticZoomRead.test.ts
- src/modules/architecture/tests/semanticZoomPlan.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/canvasLayoutContract.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- tasks/architecture-semantic-zoom-defects-polish.md

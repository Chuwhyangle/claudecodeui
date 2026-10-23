---
id: architecture-semantic-zoom-defects-polish
title: 架构图语义缩放缺陷修补：构造型文字最小字号、粘性包名重影与遮挡、上游溢出行去重
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务修复 `architecture-semantic-zoom-layout`（已 done，语义缩放引擎与渲染）在真实浏览器里暴露的四处缺陷，不改变它建立的原则与档位。该任务的 AC 全部通过，说明它的几何守卫没有覆盖到下面这些读数；本任务同时补上守卫与控制臂。合并决定：没有开放任务与本任务 Touches 重叠，单独立案。

证据（2026-10-23 重启到新构建后，用 MCP 浏览器在 1440×765 与 390×844 两个视口、Quay OO 与 claudecodeui 两个项目的图上，各取 65/46/33/17/6% 五档，共 20 张截图，存于 `tmp/sz-verify/`，拼图 `tmp/sz-verify/montage-{pc,m}-{quay,cui}.png`；参考设计在提交 `e8bd1acbb` 与 `7c7135598` 的 `docs/proposals/architecture-semantic-zoom/`，worktree 里没有该目录时用 `git show e8bd1acbb:docs/proposals/architecture-semantic-zoom/README.md` 读取）：

1. **接口框里的 `<<interface>>` 文字低于最小字号。** A 档下每个接口节点的构造型文字屏幕字号只有约 8px（手机约 8.8px），低于下限（PC 10px、手机 11px）。plantuml-js 0.4.0 把它作为单独的小字输出，渲染层没有对它应用最小字号规则。要求：A 档下构造型文字要么按最小字号绘制且标题格高度随之计算（不得把标题压到不可读），要么在放不下时隐藏；二者选其一并写进设计说明，但任何可见文字的屏幕字号都不得低于下限。
2. **粘性包名与包自己的标签页重影。** 6% 手机档下，`providers`、`list` 的粘性标签叠在同一个包的 `claude (14) ★2` 标签页上，盖住一半，而这两个包自己的标签页明明在视口内；提示条 `overviewTooSmall` 也压住了 `modules`、`chat`。要求：粘性包名只在该包自己的标签页已经滚出视口（标签页矩形与视口不相交）时才显示；提示条不得压住任何包的标签页，必要时移到不与标签页相交的位置。
3. **粘性包名盖住类名。** 手机 33% 与 17% 下 `cursor (7)` 半透明地压在 `CursorProvider` 上，PC 上顶部 `list` 标签只露出 `hst`（被裁成不可读的碎片）。要求：粘性标签的屏幕矩形不得与任何可见类名文字的矩形相交（放不下就不显示该粘性标签），且粘性标签必须完整显示，不得被视口边缘裁成碎片。
4. **成员区出现 plantuml-js 自己的溢出行，与我们的 `… +N more` 重复。** 手机 65% 下 `CursorMcpProvider` 的方法区第一行是 `… +1 more (5 members)`，下面又有我们画的 `… +2 more`。要求：读取层（`semanticZoomRead.ts`）把上游输出的溢出提示行从成员列表里剔除，只保留一处溢出提示，且总数以上游的 `(N members)` 为准。

## Plan

1. `semanticZoomRead.ts`：识别并剔除上游溢出提示行（文本形如 `… +K more (N members)`，来自 0.4.0 渲染器），读出 N 作为成员总数；构造型文字作为单独字段读出，不并入成员。
2. `semanticZoomPlan.ts` 与 `semanticZoomLayout.ts`：构造型文字的规划（按最小字号绘制并计入标题格高度，或放不下时隐藏）；粘性包名的出现条件改为「自己的标签页矩形与视口不相交」，并增加与类名文字矩形、提示条矩形的避让；粘性标签整体落在视口内。
3. `PlantUmlGraph.tsx`：把上面的规划结果接入绘制，提示条位置与标签页避让。
4. 几何守卫补全：在 `e2e/architecture-canvas-layout.spec.ts` 里让「可见文字的屏幕字号 ≥ 下限」的读数覆盖构造型文字和所有粘性标签；新增「粘性标签与自己的标签页不同时可见」「粘性标签矩形与可见类名文字矩形不相交」「成员区不含上游溢出行」的读数，并为每条配控制臂。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/semanticZoomRead.test.ts` exit 0：新增用例用 0.4.0 渲染器对一个成员数超过显示上限的类实际渲染出的 SVG，断言上游溢出提示行不出现在成员列表里、读出的成员总数等于该行的 `(N members)`，以及一个只有溢出提示行而无其它成员的边界用例
- [ ] `npx vitest run src/modules/architecture/tests/semanticZoomPlan.test.ts` exit 0：新增用例覆盖构造型文字（按最小字号绘制且标题格高度随之增加，或放不下时被隐藏，两条路径各一个用例，屏幕字号永远不低于下限）、粘性包名只在自己的标签页矩形与视口不相交时出现、粘性标签避开类名文字矩形与提示条矩形、粘性标签完整落在视口内
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/canvasLayoutContract.test.tsx` exit 0：既有用例不回归；提示条与包标签页的屏幕矩形不相交
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：在 1440×765 与 390×844 两个视口、Quay OO 与 claudecodeui 两类夹具、65/46/33/17/6% 五档下，所有可见文字（含构造型文字与粘性标签）的屏幕字号 ≥ 下限；粘性标签与其所属包自己的标签页不同时可见；粘性标签矩形与任何可见类名文字矩形不相交；成员区文本里不含上游溢出行
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：为上面新增的每条读数各配一个控制臂（关闭构造型字号规则、关闭粘性标签出现条件、关闭粘性避让、关闭溢出行剔除各一条），主臂与控制臂用同一读取函数，控制臂里对应读数必须变红
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里分别用 1440×765 与 390×844 打开 Quay OO 与 claudecodeui 两个项目的 Architecture 标签，在 65/46/33/17/6% 五档截图（共 20 张，存 `tmp/` 并贴进 Evidence），与 `tmp/sz-verify/` 里的修复前截图并排比对：接口框的构造型文字不再低于最小字号，6% 手机档的 `providers`、`list` 不再与 `claude (14) ★2` 重影，手机 33% 与 17% 的 `cursor (7)` 不再压住类名，手机 65% 的 `CursorMcpProvider` 只有一处溢出提示。贴出几何读数。

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

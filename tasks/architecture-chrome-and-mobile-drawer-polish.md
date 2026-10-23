---
id: architecture-chrome-and-mobile-drawer-polish
title: 架构 tab 手机抽屉、画布外观、搜索结果行与撤销提示：档位按钮文字、重复关闭、托盘避让、Focus 按下态、画布底色、Focus
  横幅、搜索名字截断、Undo 停留时间
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务收拢 2026-10-23 在真实浏览器里（PC 1440×765 与手机 390×844，本会话的 Architecture 标签）做交互探查时发现的界面外观、手机抽屉与搜索、撤销提示方面的缺陷，原因都已对到源码。它与 `architecture-semantic-zoom-defects-polish` 声明了部分相同文件（`PlantUmlGraph.tsx`、`architectureTab.test.tsx`、`e2e/architecture-canvas-layout.spec.ts`），改动内容互不重叠，由调度器按 Touches 串行，单独立案。

证据截图在 `tmp/ix-pc-*.png`（00–23）与 `tmp/ix-m-*.png`（00–03）。

1. **手机抽屉的三个档位按钮可见文字全是 "Half"。** `ArchitectureDock.tsx` 触摸抽屉里按钮文字写成 `{snapLabels[snap]}`（当前档位），应是 `{snapLabels[nextSnap]}`；`aria-label` 是对的，所以只有看得见的文字错。要求：三个按钮各显示自己的档位名（Collapsed / Half / Full 的本地化文案），当前档位有按下态样式。
2. **手机抽屉里有两个叠在一起的 "Close inspector"。** 触摸抽屉的档位行里画了一个 ×，`tabList` 末尾又有一个 ×，两个都带 `data-architecture-dock-close`。要求：触摸抽屉里只保留一个关闭按钮；桌面侧栏行为不变。
3. **选择托盘与手机抽屉互相压住。** "1 selected ▴" 浮条压在抽屉底部，抽屉里 Members 列表看不全；抽屉又盖住被选实体的主体。要求：抽屉打开时托盘不得与抽屉内容区的屏幕矩形相交（托盘上移到抽屉上沿之上或并入抽屉头部二选一，写进设计说明），抽屉打开后被选实体的框顶部仍在可见区内。
4. **Focus / Overview 切换没有按下态，且手机 Adjust 面板里这一行布局失衡。** 两个按钮用 `aria-pressed` 表示状态，但共用的 `TOOLBAR_BUTTON_CLASS` 没有任何按下态样式，PC 与手机都看不出当前是哪个；手机 View 行里按钮右对齐、左边大片空白。要求：按下态有明确的视觉区分（不只靠颜色，例如加粗加底色），View 行在手机 Adjust 面板里左对齐或铺满。
5. **画布的白色底矩形与灰色面板对不齐。** `semanticApply` 把 plantuml-js 自带的白底 `.uml-canvas` 调整成映射后内容的宽高，内容之外露出灰色面板，边缘出现一圈白色矩形缝（PC 与手机都有）。要求：画布底色与面板一致，或铺满整个画布区域，二者选其一；不得出现只包住内容的白色矩形。
6. **Focus 横幅有三个毛病。** 点 Focus 后出现 "Readable zoom is on: focused on … — choose Overview to see the whole grap…"：(a) 文案写 "(0 other package(s))"，即使没有其它包可切换也显示；(b) 容器是 `truncate`，文字被截成 "whole grap…"；(c) 横幅出现时工具栏那一行变高，把画布往下推（布局抖动）。要求：没有其它包（count 为 0）时用已有的 `architecture.plantuml.readable.focusOnly` 文案或不显示；文字完整可读（折行或移到不挤占工具栏的位置）；横幅出现与消失不得改变画布顶边的位置。

7. **搜索结果每行把名字截成 8 个字符，重复的灰字却完整显示。** 在搜索框输入 `Architecture`，"Elsewhere in the project" 下每行显示 `ArchitectureC…`、`Architecture…`，需要区分的类名和路径看不到，每行却都带 "Not in the current graph" 灰字（`architecture.search.notInGraph`，`ArchitecturePanel.tsx` 约 2933 行）。要求：类名（连同种类字形）完整显示，放不下时折行或在行内换到第二行，不得为了灰字而截断；路径放第二行、靠左截断（保留文件名一侧）；"Not in the current graph" 只在分组标题处说明一次，不再逐行重复；每个按钮（Show it / ＋）的可访问名称包含实体名。
8. **置顶 / 移除后的 "Undo" 提示只停留 6 秒。** `CURATION_TOAST_MS = 6000`，超过后只能走 Adjusted ▾ → Restore 逐项还原。要求：提示停留时间延长到 12 秒（悬停与键盘焦点仍暂停计时），并且 Adjusted 弹层在存在可撤销的最近一次操作时，弹层头部提供同一个 "Undo" 入口，让提示消失后仍能撤销最近一步。

不在本任务范围（已交给人决定，不要实现）：多选时 Inspector 只显示 "3 selected"、范围 / 详情 / 跳数在无效时没有反馈、图变化后是否重新适应缩放、小地图与缩放按钮与托盘遮挡图的取舍。

## Plan

1. `ArchitectureDock.tsx`：修正档位按钮文字与按下态；触摸抽屉只留一个关闭按钮。
2. `ArchitectureSelectionTray.tsx` 与 `ArchitecturePanel.tsx`：抽屉打开时托盘的位置与抽屉内容区互不相交；被选实体在抽屉打开后仍可见（必要时平移画布）。
3. `PlantUmlGraph.tsx`：`TOOLBAR_BUTTON_CLASS` 的按下态样式；`semanticApply` 里画布底色处理；Focus 横幅的文案条件、折行与定位。
4. `ArchitecturePanel.tsx` 的 Adjust 面板：View 行布局。
5. `ArchitecturePanel.tsx`：搜索结果行布局（名字完整、路径第二行、分组标题说明一次）；`CURATION_TOAST_MS` 与 Adjusted 弹层头部的 Undo 入口。
6. 测试与守卫：单元测试覆盖档位文字、单一关闭按钮、横幅条件与按下态；e2e 读数覆盖托盘与抽屉不相交、画布底色、横幅不改变画布顶边，并配控制臂。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/dockInspector.test.tsx` exit 0：触摸抽屉的三个档位按钮各自显示 `snapLabels` 里自己的文案、当前档位 `aria-pressed` 为真且样式与另两个不同；触摸抽屉里 `data-architecture-dock-close` 恰好一个；桌面侧栏的关闭按钮仍是一个，既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/selectionTray.test.tsx src/modules/architecture/tests/architectureTab.test.tsx` exit 0：触摸界面抽屉打开时托盘的矩形与抽屉内容区矩形不相交；Focus / Overview 按下态带有区别于未按下的样式类；`count` 为 0 时 Focus 横幅使用 `focusOnly` 文案（或不渲染），不出现 "(0 other package(s))"；横幅文案不带 `truncate`；`.uml-canvas` 的填充与面板底色一致或覆盖整个画布区
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：手机视口点选一个实体后，托盘矩形与抽屉内容区矩形不相交，被选实体框的顶边在可见区内；PC 与手机视口里画布区域内没有与面板底色不同的、只包住内容的矩形；点击 Focus 前后画布顶边的屏幕纵坐标差为 0；三个档位按钮的可见文字两两不同
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：为上面新读数各配控制臂（恢复 `snapLabels[snap]`、恢复第二个关闭按钮、恢复白底矩形、恢复横幅撑高各一条），控制臂里对应读数必须变红
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——搜索结果行里类名元素不带 `truncate` 类且完整包含 28 个字符的类名文本，路径元素在第二行且靠左截断；"Not in the current graph" 文案在搜索结果列表里恰好出现一次（分组标题）而不是每行一次；Show it 与 ＋ 按钮的可访问名称包含实体名；置顶后的提示在 11 秒时仍存在、13 秒后消失（假定时器），悬停时暂停；存在可撤销的最近一次操作时 Adjusted 弹层头部有 "Undo"，点它与点提示里的 "Undo" 效果相同；既有用例不回归
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（同上一条 e2e AC 的预算说明）：新增读数——搜索结果列表里每行类名文本的 `scrollWidth ≤ clientWidth`（名字不被截断，名字不超过 40 个字符的行）且列表里不含逐行重复的灰字
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0；不新增 i18n 键（复用已有的 `focusOnly`）

## DoD

真实浏览器里用 390×844 打开本项目任一有两个以上实体的会话的 Architecture 标签，点选实体打开抽屉：三个档位按钮文字各不相同、只有一个关闭按钮、托盘不压住抽屉、被选实体仍可见；切换 Focus / Overview 时能看出哪个被按下；用 1440×765 看画布没有白色矩形缝，点 Focus 时工具栏与画布不抖动。每条贴前后截图（存 `tmp/`）。截图中做过的任何选中、置顶、过滤改动必须还原，让图回到初始状态。

## Touches

- src/modules/architecture/ArchitectureDock.tsx
- src/modules/architecture/ArchitectureSelectionTray.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/CurationToast.tsx
- src/modules/architecture/ArchitectureCurationManager.tsx
- src/modules/architecture/tests/dockInspector.test.tsx
- src/modules/architecture/tests/selectionTray.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- playwright.config.ts
- tasks/architecture-chrome-and-mobile-drawer-polish.md

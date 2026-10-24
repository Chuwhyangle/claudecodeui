---
id: architecture-readout-minimap-hover-layout
title: 架构图读数、小地图与悬停信息条布局：缩放读数单一来源，小地图画轮廓并避让控件，悬停条不被遮挡
status: done
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->2026-10-24 在真实浏览器里探查 Architecture 标签（PC 1440×765，会话 f9602ca3 的 55 实体 L 图，截图 `tmp/ux-08-L-fullscreen.png`）发现三处同属"画布底部与角落叠层"的布局缺陷。已检索 `architecture-*` 的 todo / ready 任务，没有与本任务共用 Touches 的开放任务；与已完成的 `architecture-single-scale-fit-contract`（缩放读数等于语义比例）不是同一机制，该契约保留。

三处缺陷与要求：
(a) **缩放百分比出现两次**：工具栏（右上）与画布右下角各显示一次。要求只保留一个来源，读数仍等于 `data-architecture-semantic-scale` 乘 100。
(b) **小地图画实心块，并压住右下角缩放控件与底部信息条**。要求按档位画简化轮廓（线框，不画实心填充），并按底部叠层的共享布局避开缩放控件与信息条。
(c) **悬停信息条被截断，且被"1 selected · Send to chat ▴"药丸遮住**。要求底部叠层使用共享的底部槽位布局：悬停信息条、选中药丸、小地图、缩放控件互不重叠；信息条放不下时以省略号截断并在 `title` 属性里给出完整文字，不允许无省略号的硬截断。

PC 宽度（1440×765）与手机宽度（390×844、844×390）都要核对；手机上沿用现有最小字号 11px、PC 10px。

## AC

- [x] `npx vitest run src/modules/architecture/tests/minimap.test.tsx` exit 0：新增用例——小地图在各档位绘制轮廓（描边、无实心填充的实体矩形），视口框与语义比例一致；小地图矩形与缩放控件、底部信息条矩形不相交；既有用例不回归
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——页面上缩放百分比文本只出现一处；存在选中药丸与悬停信息条时二者矩形不相交；信息条文字超宽时带省略号样式且 `title` 属性等于完整文字；既有用例不回归
- [x] `npx playwright test e2e/architecture-overlay-layout.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：L（55 实体）夹具在 1440×765、390×844、844×390 三个视口下，读取小地图、缩放控件、底部信息条、选中药丸、悬停信息条的屏幕矩形，两两不相交（容差 1px），缩放百分比可见文本只有一处，信息条不被无省略号截断
- [x] `npx playwright test e2e/architecture-overlay-layout.spec.ts --grep "control arm"` exit 0：控制臂——恢复第二处缩放读数、恢复小地图实心块、取消共享槽位布局时对应读数变红，主臂与控制臂用同一读取函数
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/` exit 0

## DoD

真实浏览器（MCP 浏览器）里，PC 1440×765 与手机 390×844、844×390 打开 claudecodeui 的 55 实体 L 会话 Architecture 标签，亲手走一遍：缩放、Fit、悬停实体、选中实体呼出药丸、全屏，逐项确认缩放读数只有一处、小地图是轮廓且不压控件与信息条、悬停条完整可读或带省略号与 title；截图存 `tmp/` 并贴进 Evidence。仓库里若存在 Architecture 场景，另跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告与检查点截图；不存在则在 Evidence 里写明。任何临时改动必须还原。遵循 `.agents/skills/frontend-module-standards`。

## Touches

- src/modules/architecture/ArchitectureMinimap.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/ArchitectureSelectionTray.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/bottomSlotLayout.ts
- src/modules/architecture/tests/minimap.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- e2e/architecture-overlay-layout.spec.ts
- playwright.config.ts
- tasks/architecture-readout-minimap-hover-layout.md

## Evidence

实现（分支 `task/architecture-readout-minimap-hover-layout`，commit `ec35a808c`）：

- 新增 `src/modules/architecture/bottomSlotLayout.ts`：底部叠层的唯一几何声明。`bottomCornerLayout` 给角落槽位（小地图 + 缩放控件）方向/内缩/间距；`cornerChromeRects` / `bottomInfoSlotRect` / `rectsOverlap` 是纯函数模型，供运行时、单测与 e2e 读数对齐；`overlayLayoutDefect()` 是 DEV-only 控制臂拉杆（生产构建不含）。
- `PlantUmlGraph.tsx`：缩放百分比只有一个宿主——桌面（有 in-flow 行）画在行内 `data-architecture-zoom-level`，compact 档（行不在屏上，Adjust 面板默认关闭）画在画布缩放簇 `data-architecture-zoom-cluster-level`，同一时刻页面上只有一个 `NN%`；角落槽位的 inset/间距/方向改读共享模型。
- `ArchitectureMinimap.tsx`：底图逐实体/包 `strokeRect` 轮廓（包 0.75px、实体 1px、种子换色），不再 `fillRect`；画布暴露 `data-architecture-minimap-mode=outline|solid` 供读数；实心块只在控制臂分支恢复。
- `ArchitectureSelectionTray.tsx`：浮动药丸从"底部居中/整宽"改为共享 INFO 槽位（左下、8px 内缩），与右下角落槽位不可能相交。
- `ArchitecturePanel.tsx`：悬停信息条合成单一字符串，单行 `overflow:hidden + text-overflow:ellipsis + white-space:nowrap` 且 `title` 恒等于完整文字；`placeHoverHint` 的障碍集合加入药丸、展开托盘与**文档级** dock/drawer（dock 是 canvas region 的兄弟节点，原先用 container.querySelectorAll 找不到，导致竖屏时悬停条被抽屉盖住）。
- `e2e/architecture-overlay-layout.spec.ts`（新增，已加入 `DEBUG_AGENT_SPEC_FILES`）：55 实体 L 夹具、三个视口，一次 `page.evaluate` 读同帧五个表面矩形 + 可见百分比 + 小地图模式 + 悬停条省略号/title；主臂与控制臂共用 `readOverlayLayout`。

AC 逐条：

1. `npx vitest run src/modules/architecture/tests/minimap.test.tsx` → **16 passed**。更新既有 1000 节点用例断言（仅背景 1 次 fillRect、1000 次 ≤1px 轮廓、范围框仍 2px）；新增：PC 160×100 与手机 96×64 两档 + 两档语义 tier 均只画轮廓且实体块零填充；`cornerChromeRects` 模型下小地图/缩放控件/底部信息条两两不相交（1px 容差），并给出「不加障碍物则压住小地图」的正向对照。
2. `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` → **123 passed**（原 121 + 2）。新增：页面上 `^\d+%$` 可见文本恰好 1 处且归 in-flow 行，cluster 无第二读数；选中后悬停另一实体，实测矩形不压药丸/小地图/缩放控件，`textOverflow=ellipsis`、`overflow=hidden`、`whiteSpace=nowrap`、`title === textContent`。既有 `a semantic drawing states ONE scale` 用例改为断言「恰好一处」。
3. `npx playwright test e2e/architecture-overlay-layout.spec.ts` → **2 passed (1.2m)**（配置求值 + 两个 webServer + 浏览器启动 + 夹具 + Fit/全屏 DoD 手势都计入；`SPEC_BUDGET_MS['architecture-overlay-layout.spec.ts']=480_000`，注释写明实测）。三视口同帧读数：
   - PC 1440×765：minimap 166×106、controls 78×133、bottomBar（来源页脚）1151×35.5、pill 164×26、infoBar 319×20.5，`overlaps=[]`，`percentages=["56%"]`，`minimapMode=outline`。
   - phone 390×844：minimap 102×70、controls 268×52、bottomBar 390×53、pill 164×44、infoBar 320×20.5，`overlaps=[]`，`percentages=["26%"]`，`outline`。
   - landscape 844×390：minimap 102×70、controls 222×44、pill 141.6×44、infoBar 308×20.5，`overlaps=[]`，`percentages=["30%"]`，`outline`；该档按既有已落地判据把来源页脚折进工具栏，故 bottomBar 无底部矩形（`bottomBar=folded-into-toolbar`），其余四个面仍逐对检查。
   - 三档悬停条均 `title === 可见文字`、始终省略号样式；`truncated=false`（320px 文本在 85% 上限内放得下），截断路径由单测直接覆盖。
4. `npx playwright test e2e/architecture-overlay-layout.spec.ts --grep "control arm"` → **1 passed (35.8s)**。同一读取函数的三个缺陷臂：`duplicate-readout` → `percentages=["56%","56%"]`；`solid-minimap` → `minimapMode=solid`；`no-slot-layout`（竖屏，药丸恢复居中且悬停条不再避让药丸）→ `overlaps=["pillxinfoBar"]`。
5. `npm run typecheck` exit 0（client + server + scripts）、`npm run build` exit 0、`npm run lint` exit 0（仅仓库既有 warning）。

DoD（真实浏览器）：

- 本会话没有 MCP 浏览器工具，按既有方法用一次性真实 Chromium（Playwright）覆盖等价操作；没有临时改动需要还原（新增 e2e 是判据本体）。
- 三个视口均亲手执行：放大（两次 + 循环至小地图出现，进入 manual 缩放）、悬停实体、点击实体呼出药丸；PC 另执行 Fit（画布快捷键 `0`，`data-architecture-fit=auto`）与全屏（`data-architecture-fullscreen=true` 后 Escape 退出）。逐项确认：百分比只出现一处；小地图是轮廓（`outline`）且与缩放控件有正间距；悬停条位于药丸之上且 `title` 是完整文字。
- 截图（`tmp/architecture-overlay-layout/`，git-ignored）：`pc-00-corner.png`、`pc-01-overlay-layout.png`、`pc-02-fit.png`、`pc-03-fullscreen.png`、`phone-portrait-00-corner.png`、`phone-portrait-01-overlay-layout.png`、`phone-portrait-02-fit.png`、`phone-landscape-00-corner.png`、`phone-landscape-01-overlay-layout.png`、`phone-landscape-02-fit.png`、`control-duplicate-readout.png`、`control-solid-minimap.png`、`control-no-slot-layout.png`。
- 仓库内 Architecture 场景：`e2e/scenarios/` 只有 `cockpit-mode-switch.json` 与 `quay-wall-focus-pin-utter.json`，不存在 Architecture 场景，故未运行 `node scripts/ui-scenario.mjs`。

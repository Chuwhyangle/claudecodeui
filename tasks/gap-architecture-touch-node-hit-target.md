---
id: gap-architecture-touch-node-hit-target
title: 架构图节点在粗指针下的点击面积：命中区不小于 44px，密集图先选中居中再开检查器
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-23 审查：文件图在适配缩放下，节点（`[data-entity-id]`）屏幕高度实测约 10px（`getBoundingClientRect().height` 为 9.9），远低于 WCAG 2.5.5 的 44px 触控目标。工具栏按钮已有 `TOUCH_TARGET_STYLE`（44px，`hooks/useTouchLayout.ts`，仅粗指针生效），但画布内的节点没有对应处理，密集图里手指几乎点不准。注：本次审查所用 Playwright 是细指针，工具栏按钮的小尺寸是测试环境假象，不在本任务范围；节点 10px 是 SVG 缩放的几何结果，与指针类型无关，所以确实成立。

机制：命中区等于可见形状，缩放后同比缩小。改法（二选一，实现时按验证结果决定，必须在任务里记录选择与理由）：
- A. 粗指针下给每个节点叠一个透明命中矩形，屏幕尺寸不小于 44×44 CSS px（半径 = 22 / 当前 scale），在节点密集时按最近中心点裁决，避免重叠命中框吞掉点击。
- B. 粗指针下首次点击先选中并居中放大该节点，再次点击同一节点才打开检查器（`ArchitectureInspector`）；这条路径对密集图更稳，不依赖透明层。
无论哪种，细指针（桌面）行为保持不变；包框 `grp::` 的点击行为保持不变。

<!-- dedup-ref --> 相关：`architecture-landscape-phone-layout`（ready）、`architecture-standalone-page`（ready）同改 ArchitecturePanel.tsx，调度器串行；本任务主要改 graphDom.ts / PlantUmlGraph.tsx 的命中逻辑：separate。

## AC

- [x] 新增 vitest 用例（用例名含 `touch hit area`）：模拟粗指针（`matchMedia('(pointer: coarse)')` 为真），在缩放使节点屏幕高度小于 20px 的夹具上，对离节点中心 20px 内的点触发点击，选中的是最近的节点。
- [x] 若采用方案 B：粗指针下首次点击后 `selection` 为该节点且视口已居中到它，检查器未打开；第二次点击后检查器打开（vitest 断言）。若采用方案 A：命中矩形的屏幕尺寸不小于 44px（断言）。
- [x] 细指针下行为不变：同一夹具在 `pointer: fine` 下首次点击即选中并打开检查器（vitest 断言）。
- [x] `npx vitest run src/modules/architecture/tests/mobileGestures.test.tsx` 与 `src/modules/architecture/tests/selectionTray.test.tsx` 退出码 0。

## Decision

采用方案 A（透明命中矩形 + 最近中心点裁决）。理由：B 需要把当前「首次触屏点按即选中并打开检查器」的契约改成「首次只选中、第二次才打开」，而 `selectionTray.test.tsx` 的抽屉/托盘联动与 `ArchitecturePanel` 的 selection→dock 效应都建立在该契约上；改它会引入抑制后重开的时序状态，并把本任务从「命中几何」扩大成触屏语义重写。A 只在渲染层加几何：`graphDom.ts` 的 `addNodeHitTargets` 按 SVG 实测缩放（`44 / scale`）给每个可见节点挂透明矩形（`data-architecture-node-hit`，`pointer-events: all`），`nearestNodeHitId` 在重叠时按最近中心点裁决；`PlantUmlGraph` 的点击处理在粗指针下先走该裁决，再回落到边/节点原有路径。细指针不加任何矩形，包框 `grp::` 的点击路径不变。

## DoD

真实落地：MCP 浏览器（390×844，必须 `hasTouch:true, isMobile:true`）在会话 45ac161a 的文件图上，用触屏点按（不是 DOM click）选中一个具体文件节点（不是 `grp::` 包框），截图存 `tmp/` 并贴出：选中状态可见、检查器给出该实体名。涉及 UI，按 AGENTS.md 同时贴 `node scripts/ui-scenario.mjs` 场景报告（存在可用场景时）。

## Touches

- src/modules/architecture/graphDom.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/graphStyles.ts
- src/modules/architecture/hooks/useTouchLayout.ts
- src/modules/architecture/tests/mobileGestures.test.tsx
- src/modules/architecture/tests/selectionTray.test.tsx
- tasks/gap-architecture-touch-node-hit-target.md

## Verification

- AC1/AC2/AC3 的 vitest 读数（`mobileGestures.test.tsx`，共 4 条新用例，用例名均含 `touch hit area`）：
  - `a coarse tap within 20px of a node centre selects the nearest node`：夹具按 viewBox×0.1 的屏幕缩放加载，断言所选节点可见高度 `< 20px`、点距中心 `≤ 20px`，点击后 `.arch-selected[data-entity-id]` 就是最近中心点的节点；
  - `every drawn node gets a coarse hit rectangle of at least 44px on screen`：每个 `[data-architecture-node-hit]` 的 `data-architecture-hit-screen-width/-height` 均 `≥ 44`，同一节点的可见高度 `< 20px`；
  - `overlapping coarse targets resolve to the nearest node centre`：两个 44px 框重叠、中心距 25px 时，点落在两者框内按最近中心点返回；stub 节点无目标；细指针下矩形被移除；
  - `a fine pointer click still selects and opens the inspector on the first click`：细指针首次点击即选中并打开检查器（`data-architecture-inspector-path` 为点击的文件），且没有粗指针覆盖层。
- AC4：`npx vitest run src/modules/architecture/tests/mobileGestures.test.tsx src/modules/architecture/tests/selectionTray.test.tsx` → exit 0，2 files / 29 tests passed。
- DoD（真实浏览器）：本会话没有可用的 MCP 浏览器工具，按仓库惯例用一次性 Playwright 脚本驱动真实 Chromium：viewport 390×844、`hasTouch:true`、`isMobile:true`，`matchMedia('(pointer: coarse)')` 为真；冷启动 `/session/45ac161a-6452-462b-8dda-401f6759d88e`（隐藏会话，经 `sidebarShownHiddenSessionProjects` 露出，深链直达），切到 File graph（`data-architecture-view=overview`，120 files）。用 `page.touchscreen.tap`（真实触摸事件，非 DOM click）在距 `src/modules/skills/ProviderSkills.tsx` 节点中心 16.9px（可见框半高仅 13.8px，故点在可见形状之外、44px 命中区内）处点按：选中 `src/modules/skills/ProviderSkills.tsx`（非 `grp::`），检查器抽屉打开并给出该实体（名称 `tsx`、路径 `src/modules/skills/ProviderSkills.tsx`），页面共 40 个 `data-architecture-node-hit`，其中命中矩形 `data-architecture-hit-screen-height = 44`。截图：`tmp/arch-touch-before.png`、`tmp/arch-touch-after.png`（选中蓝框 + “1 selected” 托盘 + Inspector 可见）。
- `node scripts/ui-scenario.mjs`：仓库现有场景只有 `e2e/scenarios/quay-wall-focus-pin-utter.json`（Quay wall 焦点钉住），没有 architecture 可用场景，故按 AGENTS.md 的「存在可用场景时」不适用；架构面本身的浏览器回归由上面的真实 Chromium 点按承担。
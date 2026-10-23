---
id: gap-architecture-mobile-default-readable-focus
title: 架构图手机端默认进可读的 Focus 模式：总览缩放低于可读下限时不再默认 25% 总览
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-23 审查（390×844，会话 45ac161a 的文件图，120 个文件）：默认视图是 Overview，缩放读数 25%，节点文字约 3px，完全不可读，图只占画布约一半高度。源码根因：`readableZoom.ts` 第 306 行 `const defaultMode: ReadableZoomMode = 'overview'`；已存在的 Focus 模式（以 `MIN_READABLE_FONT_PX=9`、`READABLE_ZOOM_SCALE` 为下限，居中到种子）只能在「Adjust」面板里手动切，且用户并不知道。

机制：缺省模式不看「几何适配后字号是否可读」。改法：
- `readableZoom.ts` 的缺省模式改为按输入决定：当 `fitScale < READABLE_ZOOM_SCALE`（总览会低于可读下限）时缺省 `focus`，否则保持 `overview`。该规则对桌面同样成立（桌面大图同样不可读），不需要按设备分支。
- 用户已持久化的选择（`READABLE_MODE_STORAGE_PREFIX` 的 localStorage 键）优先，不被覆盖。
- 画布上给一个常驻的「聚焦 / 总览」胶囊切换（现在藏在 Adjust 面板里，`data-architecture-readable-overview-mode`），用户不用打开面板就能回总览。
- 「Fit to view」按钮的 pressed 状态与当前模式一致，不再在 25% 时显示为 pressed 而图不可读。

<!-- dedup-ref --> 相关：`architecture-layout-orientation-matches-canvas`（todo，改布局方向、与默认缩放同属 PlantUmlGraph 区域）。本任务不改布局方向，只改缺省模式与切换入口：separate。

## AC

- [ ] `readableZoom.ts` 导出的缺省模式判定有单测：`fitScale` 小于 `READABLE_ZOOM_SCALE` 且无持久化选择时返回 `focus`；`fitScale` 不小于它时返回 `overview`；有持久化选择时以持久化为准（`npx vitest run src/modules/architecture/tests/readableZoom.test.tsx` 退出码 0，含这三个用例）。
- [ ] 渲染一个 120 节点量级的文件图夹具：初始 `data-architecture-readable-overview-mode` 元素 `aria-pressed` 为 `false`，且渲染的节点标题字号不小于 `MIN_READABLE_FONT_PX`（vitest 断言）。
- [ ] 画布上存在聚焦/总览切换，点击切到总览后 `aria-pressed` 为 `true` 并写入持久化键；刷新（重新渲染）后保持。
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` 与 `src/modules/architecture/tests/mobileGestures.test.tsx` 退出码 0。

## DoD

真实落地：MCP 浏览器（390×844，触屏上下文）打开会话 45ac161a 的文件图，不做任何操作，截图存 `tmp/` 并贴出：节点文字可读，且能一键切回总览。涉及 UI，按 AGENTS.md 同时贴 `node scripts/ui-scenario.mjs` 场景报告（存在可用场景时）。

## Touches

- src/modules/architecture/readableZoom.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/tests/readableZoom.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/mobileGestures.test.tsx
- tasks/gap-architecture-mobile-default-readable-focus.md

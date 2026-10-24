---
id: architecture-readout-minimap-hover-layout
title: 架构图读数、小地图与悬停信息条布局：缩放读数单一来源，小地图画轮廓并避让控件，悬停条不被遮挡
status: ready
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

- [ ] `npx vitest run src/modules/architecture/tests/minimap.test.tsx` exit 0：新增用例——小地图在各档位绘制轮廓（描边、无实心填充的实体矩形），视口框与语义比例一致；小地图矩形与缩放控件、底部信息条矩形不相交；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——页面上缩放百分比文本只出现一处；存在选中药丸与悬停信息条时二者矩形不相交；信息条文字超宽时带省略号样式且 `title` 属性等于完整文字；既有用例不回归
- [ ] `npx playwright test e2e/architecture-overlay-layout.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：L（55 实体）夹具在 1440×765、390×844、844×390 三个视口下，读取小地图、缩放控件、底部信息条、选中药丸、悬停信息条的屏幕矩形，两两不相交（容差 1px），缩放百分比可见文本只有一处，信息条不被无省略号截断
- [ ] `npx playwright test e2e/architecture-overlay-layout.spec.ts --grep "control arm"` exit 0：控制臂——恢复第二处缩放读数、恢复小地图实心块、取消共享槽位布局时对应读数变红，主臂与控制臂用同一读取函数
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/` exit 0

## DoD

真实浏览器（MCP 浏览器）里，PC 1440×765 与手机 390×844、844×390 打开 claudecodeui 的 55 实体 L 会话 Architecture 标签，亲手走一遍：缩放、Fit、悬停实体、选中实体呼出药丸、全屏，逐项确认缩放读数只有一处、小地图是轮廓且不压控件与信息条、悬停条完整可读或带省略号与 title；截图存 `tmp/` 并贴进 Evidence。仓库里若存在 Architecture 场景，另跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告与检查点截图；不存在则在 Evidence 里写明。任何临时改动必须还原。遵循 `.agents/skills/frontend-module-standards`。

## Touches

- src/modules/architecture/ArchitectureMinimap.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/minimap.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- e2e/architecture-overlay-layout.spec.ts
- playwright.config.ts
- tasks/architecture-readout-minimap-hover-layout.md

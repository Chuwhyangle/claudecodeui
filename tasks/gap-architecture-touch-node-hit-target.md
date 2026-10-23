---
id: gap-architecture-touch-node-hit-target
title: 架构图节点在粗指针下的点击面积：命中区不小于 44px，密集图先选中居中再开检查器
status: ready
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

- [ ] 新增 vitest 用例（用例名含 `touch hit area`）：模拟粗指针（`matchMedia('(pointer: coarse)')` 为真），在缩放使节点屏幕高度小于 20px 的夹具上，对离节点中心 20px 内的点触发点击，选中的是最近的节点。
- [ ] 若采用方案 B：粗指针下首次点击后 `selection` 为该节点且视口已居中到它，检查器未打开；第二次点击后检查器打开（vitest 断言）。若采用方案 A：命中矩形的屏幕尺寸不小于 44px（断言）。
- [ ] 细指针下行为不变：同一夹具在 `pointer: fine` 下首次点击即选中并打开检查器（vitest 断言）。
- [ ] `npx vitest run src/modules/architecture/tests/mobileGestures.test.tsx` 与 `src/modules/architecture/tests/selectionTray.test.tsx` 退出码 0。

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

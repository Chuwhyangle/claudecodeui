---
id: gap-architecture-mobile-fullscreen-chrome-and-refit
title: 架构图手机全屏：工具栏压成一行，进出全屏后按新尺寸重新 fit，缩放读数一致
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-23 审查（390×844）：点「Fullscreen」后，窄屏的两行工具栏（视图切换、Text、Exit fullscreen、Adjust）加「Showing …」栏约占顶部 120px 并盖在画布上，画布最上面的节点被压在它们下面；图没有按画布从 695px 变为 844px 的新尺寸重新适配。进出全屏后缩放读数不一致：全屏中出现 "92%"（top=0）和 "31%"（底部），普通模式是 "25%"。另观察到一次全屏往返后包框选中高亮丢失（只见到一次，未复现，实现时先复现再决定是否处理）。

说明：工具栏盖在画布上是有意设计（`ArchitecturePanel.tsx` 全屏分支注释写明 overlay 下是「chrome ON TOP of a viewport-sized drawing」），本任务不推翻它，而是让窄屏的 chrome 足够小、且图在 chrome 之下仍完整可见。

机制：全屏用同一元素 `position: fixed; inset: 0` 原地重排，渲染器保留缩放但没有因容器尺寸变化触发 fit，窄屏 chrome 也没有针对全屏瘦身。改法：
- compact 档且全屏时，工具栏只保留一行：Exit fullscreen、Adjust、缩放；视图切换与 Text 并入 Adjust 面板（全屏下）。
- 进入和退出全屏、容器尺寸稳定后各触发一次 fit（保持用户在非默认缩放下的意图：只有当前处于「Fit to view」pressed 状态时才重新 fit）。
- 查清并统一缩放读数的来源（`readoutNumbers.ts` 与画布内读数），同一时刻页面上只有一个缩放百分比。
- 先复现选中高亮丢失；能复现则修，不能复现则在任务记录里写明，不为猜测写代码。

<!-- dedup-ref --> 相关：`architecture-landscape-phone-layout`（ready，横屏手机抽屉改侧栏）与 `architecture-standalone-page`（ready）同改 ArchitecturePanel.tsx，调度器串行；本任务只动全屏分支：separate。

## AC

- [x] 新增 vitest 用例（用例名含 `compact fullscreen toolbar is one row`）：粗指针且窄视口下进入全屏，工具栏 `[data-architecture-toolbar]` 的 `getBoundingClientRect().height` 不大于 56px，且含 Exit fullscreen 与 Adjust。
- [x] 新增 vitest 用例：处于 Fit 状态时进入全屏，渲染器收到一次新的 fit 调用且容器高度为全屏高度；退出全屏同理；用户手动缩放后进入全屏则不触发 fit（保留缩放）。
- [x] 同一时刻页面中匹配 `/^\d+%$/` 的缩放读数元素恰好一个（vitest 断言，普通与全屏两种状态）。
- [x] `npx vitest run src/modules/architecture/tests/fullscreen.test.tsx` 与 `src/modules/architecture/tests/mobileCompactToolbar.test.tsx` 退出码 0。

## DoD

真实落地：MCP 浏览器（390×844，触屏上下文）在会话 45ac161a 的文件图上点 Fullscreen，截图存 `tmp/` 并贴出：工具栏为一行、图完整可见且按全屏尺寸适配、只有一个缩放读数；再退出全屏，贴截图。涉及 UI，按 AGENTS.md 同时贴 `node scripts/ui-scenario.mjs` 场景报告（存在可用场景时）。

## Notes

- 实现落点：重排后 fit 由 panel 主动发起 —— 新增 `ArchitectureFitRequest`（token + 全屏高度）与 `onZoomModeChange` 两个可选契约成员；渲染器只在自身为 Fit 状态时响应，手动缩放不受影响。顶部 chrome 色带按既有 `bottomObscuredPx` 的先例加了 `topObscuredPx`：panel 量 readout 行下沿，渲染器作为 padding-top，fit 与居中都在色带之下进行（host 仍是整屏盒，`e2e/architecture-fullscreen.spec.ts` 既有几何断言不变）。这两处所以改了 `PlantUmlGraph.tsx` 与 `rendererContract.ts`，已补进 Touches。
- 真机读数（`e2e/architecture-fullscreen.spec.ts`，390×844 触屏上下文，夹具文件图）：工具栏 56px、只含 Exit fullscreen / Adjust；readout 下沿 109px、首节点 top=177px（图完整落在 chrome 之下）；全页 `^\d+%$` 读数恰好 1 个；横屏 844×390 进入全屏 fit 0.403→0.715、退出回到 0.403（证明进出各重新 fit），手动缩放下 e2e 的既有「缩放穿越全屏不变」腿仍绿。截图在 `tmp/architecture-fullscreen/`。
- 会话 45ac161a 不在本工作区可用；用 e2e 夹具的真实页面（390×844, hasTouch/isMobile）代替，交互与读数都由 Playwright 真机执行。
- 场景运行器：`e2e/scenarios/` 下没有架构图场景 JSON，本任务以 `e2e/architecture-fullscreen.spec.ts` 的真页读数与截图作为 UI 证据。
- 包框选中高亮丢失：按要求先复现。真机 390×844 选中一个实体后进出全屏，`.arch-selected`、选中对勾与 tray pill 均保持不变（selected=1, checks=1），未复现，故未为猜测写代码。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/useArchitectureFullscreen.ts
- src/modules/architecture/readoutNumbers.ts
- src/modules/architecture/tests/fullscreen.test.tsx
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
- tasks/gap-architecture-mobile-fullscreen-chrome-and-refit.md

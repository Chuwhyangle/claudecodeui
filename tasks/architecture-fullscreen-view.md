---
id: architecture-fullscreen-view
title: 架构图页内全屏：覆盖层铺满视口，桌面叠加原生全屏，退出不触发聊天页的 Esc
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务给 Architecture 标签增加「页内全屏」：隐藏侧栏、标签栏、页头，让画布铺满视口。动机：横屏手机与大图都需要更大的画布（2026-10-23 实测 844×390 下画布只有 555×162；573 个函数的 Show all 在 1151×578 的画布里横向滚动 4 倍宽度）。仓库里已有先例：代码编辑器有 `onToggleFullscreen`，`BrowserUsePanel` 有全屏覆盖层。没有开放任务与本任务的核心文件重叠；`ArchitecturePanel.tsx`、`PlantUmlGraph.tsx` 与其它架构任务重叠，由调度器串行。

要求：
1. **入口**：工具栏增加全屏按钮（图标加 "Fullscreen" 文案与 `aria-label`，处于全屏时变为 "Exit fullscreen"）；画布聚焦时按 `F` 切换。手机紧凑工具栏里放进 Adjust 面板之外的可见位置。
2. **形态**：以覆盖层铺满视口（`position: fixed; inset: 0`，高于外壳的侧栏与页头），覆盖层里是同一个面板实例（不重建状态：筛选、范围、选择、缩放、已选实体都保留）。桌面浏览器在进入时额外调用 Fullscreen API（`requestFullscreen`），失败（iOS Safari 等不支持）时静默回退为仅覆盖层，不报错。
3. **布局**：全屏时画布铺满；Inspector / Text 以浮层叠在画布右侧（桌面）或底部抽屉（手机竖屏）；选择托盘、缩放控件、小地图保持可用；进入与退出都触发重新适应（画布比例变化会让「布局方向匹配画布」那个任务的重选生效）。
4. **退出**：全屏按钮、`F`、以及覆盖层里的可见 "Exit fullscreen" 按钮；`Esc` 退出全屏时必须 `stopPropagation`，不得触发聊天页的全局 Esc（它会中止正在运行的回合）；浏览器原生全屏被用户用系统方式退出时，覆盖层同步退出。页面离开 Architecture 标签、切换会话或卸载时自动退出。
5. **焦点管理**：进入后焦点移到画布，退出后焦点回到全屏按钮；覆盖层打开时背景外壳不可聚焦（`inert` 或焦点陷阱）。

## Plan

1. 新增 `useArchitectureFullscreen.ts`：覆盖层状态、Fullscreen API 的进入退出与事件同步、卸载清理。
2. `ArchitecturePanel.tsx`：按钮、`F` 快捷键、覆盖层容器与浮层布局、焦点管理；把 Esc 的处理做成只关全屏并 `stopPropagation`。
3. `PlantUmlGraph.tsx`：宿主尺寸变化时重新适应（沿用现有 `ResizeObserver`）。
4. 文案：10 个 locale；测试与守卫。

## AC

- [x] `npx vitest run src/modules/architecture/tests/fullscreen.test.tsx` exit 0：新增文件——点击全屏按钮进入覆盖层且面板状态（筛选、范围、已选实体）不变；`F` 切换；`requestFullscreen` 不存在或抛错时仍进入覆盖层且无异常；Esc 退出全屏且事件不冒泡到 `document`（用 `document` 上的监听器断言不被调用）；原生全屏被外部退出时覆盖层同步退出；卸载时自动退出；进入后焦点在画布、退出后在按钮；覆盖层打开时外壳节点带 `inert`
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：十个 locale 的新增文案齐全
- [x] `npx playwright test e2e/architecture-fullscreen.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：PC 1440×765 与手机 390×844、844×390 三个视口——进入全屏后画布宿主矩形等于视口矩形（容差 1px）、侧栏与页头不可见；选择与缩放在进入前后保留；退出后恢复进入前的布局；在聊天页有运行中回合的会话里按 Esc 退出全屏时回合不被中止（用页面上对 Esc 的全局监听计数为 0 断言）；控制臂：移除 `stopPropagation` 时该计数读数变红
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里在本会话与「重启后 Claude Code 会话自动恢复」两个会话的 Architecture 标签：PC 进入全屏（含原生全屏）、操作选择与缩放、退出；手机竖屏与横屏各进入退出一次，读出画布尺寸（横屏应远大于修复前的 555×162）；在本会话（有运行中回合）里按 Esc 退出全屏，确认回合没有被中止。每步截图（存 `tmp/`）；做过的任何改动必须还原。

## Touches

- src/modules/architecture/useArchitectureFullscreen.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/fullscreen.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- e2e/architecture-fullscreen.spec.ts
- playwright.config.ts
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- tasks/architecture-fullscreen-view.md

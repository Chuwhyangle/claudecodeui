---
id: cockpit-header-controls-and-badge-consistency
title: 驾驶舱页头控件一致性：手机遥控按钮统一样式且手机端隐藏、模式切换重复渲染、注意力徽标说明来源并可点进 needs-human 优先的 fleet 视图
status: ready
labels:
  - cockpit
  - ui
  - ux
parent: null
children: []
extra:
  schema: execution
---
## Proposal

决策出处：2026-10-24 驾驶舱 UX 走查（截图 `tmp/ux-*.png`）。已在工作区未提交修复的不重复立案：模式切换段 md+ 为 28px、切换控件 x 位置跨视图稳定、手机遥控二维码改为绝对定位浮层、无变化的 `zoom in` 回显 refused 样式。本任务收页头剩余三处：

(a) 页头「Phone remote」是 22px 高、12px 字、带边框的按钮，旁边是 28px 图标式切换，风格与高度不一致；手机（< md）上它会折到第二行，白白多占约 60px，而且在手机上扫自己的屏幕没有意义。
(b) 模式切换在 DOM 里渲染了两份（`a[data-mode-switch-link=cockpit]` 匹配 2 个元素，疑为桌面 + 抽屉各一份），读屏会重复朗读，选择器也会误命中。
(c) 注意力徽标显示 1，而 claudecodeui 的 board 写「0 needs human」：徽标合计的是全部已登记项目（真正需要人的是 quay-fleet），用户无法对上。

方案：
1. 「Phone remote」与切换 / 图标按钮同高同样式（沿用 Settings 同款按钮尺寸）；< md 下隐藏该按钮，或收进页头溢出菜单；
2. 每个布局只渲染一份模式切换，或对不可见那份加 `aria-hidden` 且不可聚焦（以 DOM 中可访问的实例唯一为准）；
3. 徽标的 tooltip 与 aria-label 列出有待办的项目名与各自数量（「1 项需要你：quay-fleet」）；在驾驶舱内点击徽标打开 fleet 视图，并把 needs-human > 0 的项目排在最前（或加过滤），不再只是跳到当前视图。

相关但不同机制：`cockpit-entry-mode-switch-and-attention-badge`（done）建了徽标，只给了合计与 aria-label，未说明来源。同改 CockpitPage.tsx / CockpitStage.tsx 的其他 cockpit 任务由调度器串行，不设 depends_on。

## AC

- [x] AC1: `npx vitest run src/modules/sidebar/tests/SidebarModeSwitch.test.tsx` exit 0——fleet-summary 桩中 quay-fleet 有 1 项 needs-human、claudecodeui 为 0：徽标 aria-label 与 title 含「quay-fleet」及数量 1、不含 claudecodeui；多个项目时按数量降序列出。
- [x] AC2: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——整页渲染后可访问的模式切换实例唯一（`getAllByRole('link', {name: ...})` 中未被 aria-hidden 的恰好一份）；点击徽标后视图为 fleet 且 needs-human 项目排在最前（读渲染顺序）。
- [x] AC3: 同一测试文件——「Phone remote」按钮带与图标按钮共用的尺寸类（断言 className 含该共用类，而非 jsdom 量尺寸）；< md 断言类含 `hidden`（`md:` 断点显示）。
- [x] AC4: `npx vitest run src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts` exit 0——新文案键 12 个 locale 齐全。
- [x] AC5: `npm run typecheck` 通过。

## DoD

- **MCP 浏览器实际操作 + 截图（必做，存 `tmp/`）**：PC 1440×900 与手机 390×844：页头修改前后对照，用 `browser_evaluate` 读回 `document.querySelectorAll('a[data-mode-switch-link=cockpit]')` 中可访问实例数为 1、「Phone remote」包围盒高度与图标按钮一致、手机宽度下该按钮不可见且页头不再折行；悬停徽标截图 tooltip；点击徽标截图 needs-human 项目排首位。
- 场景运行器：`node scripts/ui-scenario.mjs e2e/scenarios/cockpit-mode-switch.json` 贴报告与检查点截图。
- 隔离实例必须关闭 residentRestore：`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`（或用 `scripts/isolated-instance.sh`）。

## Touches

- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitStage.tsx
- src/modules/sidebar/SidebarModeSwitch.tsx
- src/modules/sidebar/hooks/useFleetAttention.ts
- src/modules/sidebar/tests/SidebarModeSwitch.test.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
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
- tasks/cockpit-header-controls-and-badge-consistency.md

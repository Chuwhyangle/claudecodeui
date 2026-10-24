---
id: cockpit-phone-narrow-viewport-layout
title: 驾驶舱手机窄屏（390×844）布局：页头过高、在途条溢出、项目条无滚动提示、触控目标不足 44px、底部输入坞占 1/3 视口
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

决策出处：2026-10-24 驾驶舱 UX 走查，390×844 实测（截图 `tmp/ux-*.png`）。`observation-wall-ui`（done）已声明移动端 44×44 / 无溢出，但真实读数仍不达标：

1. 页头约占 120px。
2. 在途条 ③④ 宽 624px / 857px，被裁切，既不换行也无滚动提示。
3. 横向项目条把「meta-cc」从词中间截断，没有渐隐或滚动提示。
4. Refresh 26px、语音输入与 Run 32px、项目条每项 30px 高，均低于 44px 触控目标（模式切换已是 44）。
5. 命令坞 + 两行 Focus 标签占去约 1/3 视口。

方案：
1. 手机页头压缩为单行（标题 + 模式切换 + 溢出菜单），次要控件进菜单；
2. 在途条沿用 `cockpit-board-and-fleet-readability-polish` 的统一 chip 布局并 max-w-full、内容换行；若那条尚未落地，本任务先自带 `max-w-full` + 换行；
3. 项目条加右缘渐隐遮罩与 scroll-snap，项目名不在词中截断（整项滚动出入）；
4. 手机宽度下 Refresh、语音输入、Run、项目条每项最小 44×44；
5. 命令坞默认收成单行输入 + 图标，Focus 标签单行省略，展开按需；舞台底部内边距等于坞高度，末项可完整滚出。

相关但不同机制：`cockpit-mobile-layout-and-legibility`（superseded）与 `observation-wall-ui`（done）；本任务是其落地后实测仍失败的残项。因 jsdom 不量布局，可测量的 AC 放在 Playwright 步骤。chip 布局与 `cockpit-board-and-fleet-readability-polish` 同改 CockpitStage.tsx，由调度器串行，不设 depends_on（本任务不依赖其结果）。

## AC

- [ ] AC1: `npx playwright test e2e/cockpit-phone-narrow.spec.ts` exit 0（新建；在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）——视口 390×844：页头高度 <= 64px；`document.documentElement.scrollWidth <= innerWidth`；所有可见 button / a / input 的包围盒 >= 44×44（读函数列出违规元素名）；每个在途 chip 的右缘 <= 视口宽；坞高度 <= 视口高的 20%；最后一项可滚出且不与坞重叠。
- [ ] AC2: 同一 spec——项目条：容器 `scrollWidth > clientWidth` 时右缘遮罩元素存在；任一项目名不被容器边缘截断一半（可见宽度 == 整项宽度或完全不可见）；控制臂：把遮罩与 snap 去掉、触控尺寸强制为 30px 后同一读取函数判红。
- [ ] AC3: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——项目条容器带 `snap-x` 与遮罩类、项目项带 `min-h-[44px]`/`min-w-[44px]` 类（类名断言，不量像素）；Refresh、语音、Run 按钮带手机最小尺寸类；既有用例不弱化。
- [ ] AC4: `npx vitest run src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts` 与 `npm run typecheck` 均 exit 0。

## DoD

- **MCP 浏览器实际操作 + 截图（必做，存 `tmp/`）**：390×844 下 fleet 视图、board 视图、命令坞展开 / 收起、项目条横向滚动，修改前后对照；`browser_evaluate` 读回 AC1 的度量并贴出。PC 1440×900 回归截图确认无变化。
- 场景运行器：`node scripts/ui-scenario.mjs e2e/scenarios/cockpit-mode-switch.json` 贴报告与检查点截图（手机视口）。
- 隔离实例必须关闭 residentRestore：`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`（或用 `scripts/isolated-instance.sh`）。

## Touches

- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/CockpitInput.tsx
- src/modules/quay/QuayPanel.tsx
- e2e/cockpit-phone-narrow.spec.ts
- playwright.config.ts
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
- tasks/cockpit-phone-narrow-viewport-layout.md

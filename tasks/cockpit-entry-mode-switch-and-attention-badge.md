---
id: cockpit-entry-mode-switch-and-attention-badge
title: 驾驶舱入口：侧边栏头部「会话/驾驶舱」模式切换（含回程）+ needs-human 注意力徽标 + 项目行深链 + 命令面板
status: done
labels:
  - cockpit
  - ui
  - sidebar
parent: null
children: []
extra: {}
---
## Proposal

决策出处：用户 2026-10-24 确认的驾驶舱入口方案。现状：主界面没有任何通往 `/cockpit` 的入口，只能手输地址；驾驶舱页头也没有回到 CloudCLI 的链接（进去只能靠浏览器后退）。

用户的决定：
1. **主入口是侧边栏头部的模式切换控件**——「会话模式 / 驾驶舱模式」，放在设置按钮左边（不是一个普通的跳转按钮）。
2. **注意力徽标现在就做**。
3. **项目级深链放进项目的操作里**（不改 QuayIndicator 的点击行为）。

方案：
1. **模式切换控件**（新组件，sidebar 模块经 barrel 引用 cockpit 模块导出的路径工具）：一个两段式切换（图标 + tooltip：「会话」/「驾驶舱」），当前模式高亮。
   - 侧边栏头部：设置按钮左边。侧边栏收起时（`SidebarCollapsed`）出现在竖排图标列里；手机抽屉里同样出现，点击区域 ≥ 44×44。
   - **驾驶舱页头同一位置也放这个控件**（当前模式 = 驾驶舱），这就是回程；不另做一个「返回」链接。
   - 两段都实现为真实的 `<a href>`（经路由 basename 生成，不写死 `/cockpit`），普通点击走站内路由，Ctrl/中键点击由浏览器在新标签打开——驾驶舱常驻另一块屏幕时用。
   - **切换保留上下文**：会话 → 驾驶舱时，若当前选中了一个已登记到 quay-fleet 的项目，直接打开该项目的 board 视图，否则打开 fleet 视图；驾驶舱 → 会话时，回到进入驾驶舱前的会话路由（记在 sessionStorage），没有则回首页。
2. **注意力徽标**：驾驶舱那一段上叠一个小数字 = 全部已登记项目的 needs-human 合计（数据来自 `GET /api/quay/fleet-summary`，复用已有请求或 60 秒轮询，页面不可见时暂停）。为 0 时不显示；fleet 状态不是 ok 时显示一个灰点并在 tooltip 里说明原因（来自 `fleet.state`）。徽标数字有 aria-label（「3 个项目事项需要你」）。
3. **项目级深链**：项目行现有的行内操作组（重命名 / 星标 / 删除所在的那组）里加一项「在驾驶舱中查看」，打开 `/cockpit?view=board&project=<fleet 项目 id>`；项目未登记到 quay-fleet 时该项不显示。
4. **命令面板**：加两条命令「打开驾驶舱」「在新窗口打开驾驶舱」。

## AC

- [x] AC1: `npx vitest run src/modules/sidebar/tests/SidebarModeSwitch.test.tsx` exit 0——侧边栏头部的模式切换位于设置按钮之前；两段都是带 href 的链接且 href 经 basename 生成（basename 为 `/ccui` 时 href 以 `/ccui/cockpit` 开头）；当前模式段带 `aria-current`；选中已登记项目时驾驶舱段的 href 指向该项目的 board 视图（用 fleet 项目 id）；收起态与手机抽屉中都渲染该控件。
- [x] AC2: 同一测试文件——徽标：fleet-summary 桩合计 needs-human 为 3 时显示「3」及对应 aria-label；为 0 时不渲染数字；`fleet.state` 为 missing 时渲染灰点且 tooltip 含原因；页面隐藏时不轮询（假定时器计数）。
- [x] AC3: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——驾驶舱页头渲染同一模式切换控件且当前段为驾驶舱；会话段 href 为进入前记下的会话路由，无记录时为首页。
- [x] AC4: `npx vitest run src/modules/sidebar/tests/SidebarProjectItem.test.tsx` exit 0（不存在则新建）——已登记项目的行内操作含「在驾驶舱中查看」且链接到其 board 视图；未登记项目不含该项。
- [x] AC5: `npx vitest run src/modules/command-palette/tests` 中相关用例——命令面板含「打开驾驶舱」「在新窗口打开驾驶舱」两条命令；既有用例不弱化。
- [x] AC6: `npm run typecheck` 通过；文案覆盖 12 个 locale（扩展既有 i18n 完整性测试）。

## DoD

- **浏览器实际操作 + 截图（必做，PC 1440×900 与手机 390×844 各一套）**：侧边栏展开 / 收起 / 手机抽屉三处的切换控件与徽标；从一个已登记项目的会话页切到驾驶舱落在该项目 board；从驾驶舱切回原会话；Ctrl+点击在新标签打开；项目行「在驾驶舱中查看」。截图存 `tmp/`。
- 场景运行器可用时补场景与报告。
- 隔离实例验证必须关闭 residentRestore（`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`），否则会对线上同一批会话重复起进程。

## Touches

- src/modules/sidebar/Sidebar.tsx
- src/modules/sidebar/SidebarHeader.tsx
- src/modules/sidebar/SidebarCollapsed.tsx
- src/modules/sidebar/SidebarContent.tsx
- src/modules/sidebar/SidebarProjectItem.tsx
- src/modules/sidebar/SidebarModeSwitch.tsx
- src/modules/sidebar/hooks/useFleetAttention.ts
- src/modules/sidebar/hooks/useFleetTaskCounts.ts
- src/modules/sidebar/index.ts
- src/modules/sidebar/tests/SidebarModeSwitch.test.tsx
- src/modules/sidebar/tests/SidebarProjectItem.test.tsx
- src/modules/cockpit/index.ts
- src/modules/cockpit/cockpitView.ts
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
- src/modules/command-palette/CommandPalette.tsx
- src/modules/command-palette/tests/CommandPalette.test.tsx
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
- tasks/cockpit-entry-mode-switch-and-attention-badge.md

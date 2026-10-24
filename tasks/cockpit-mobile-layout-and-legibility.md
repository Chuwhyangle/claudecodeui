---
id: cockpit-mobile-layout-and-legibility
title: 驾驶舱走查（布局/视觉）：手机沿用两栏、状态条透字遮挡、开发读数占主界面、READ-ONLY 失实、低对比小字、二维码常驻页头
status: superseded
labels:
  - cockpit
  - ui
  - mobile
parent: null
children: []
extra: {}
depends_on:
  - cockpit-walkthrough-interaction-defects
---
## Proposal

决策出处：2026-10-24 驾驶舱现状走查（同 `cockpit-walkthrough-interaction-defects`，截图 `tmp/ux/`）。本任务收**布局 / 视觉 / 可读性**类问题。

问题（均为实测）：
1. **手机上的 `/cockpit` 直接沿用桌面两栏布局**：左边「PROJECTS」列表占掉近一半宽度，磁贴被挤成窄列、文字折行（「1 needs / human」）；项目列表的每一项只有 167×24，远小于 44×44 的触控目标；输入框里的麦克风与发送按钮 32×32。
2. **手机上底部状态条与输入框盖在磁贴上**：状态条背景不是实心，下面磁贴的文字（「quay-fleet」「DRIVER STALE」）透出来和状态文字重叠；最后几块磁贴被输入框挡住，滚不出来。
3. **状态条给人看的是开发读数**：「Focus: quay://quay-fleet/board」「last change → first frame 46 ms」「← Desktop · 539007」。URI、首帧耗时、设备短 id 是调试信息，占据主界面最显眼的一行。
4. **「READ-ONLY」徽标已经不准确**：驾驶舱现在可以经预览确认向会话发送消息，页头仍写着 READ-ONLY（嵌入的 quay 面板里还有第二个 READ-ONLY）。
5. **对比度不足的小字**：页头副标题、操作提示、「driver stale / driver unavailable」徽标、状态条、遥控器的「Focus」「Connected」「running」等，字号 10–11px，对比度 4.0–4.4，低于 4.5。
6. **桌面页头被二维码长期占据**：120px 高的二维码 + 说明常驻页头右侧，把页头撑到约 130px；它只在第一次配对时有用。
7. **未登记项目与已登记项目同等醒目**：fleet 视图里 4 个未登记项目（虚线框）与可操作的项目混排在同一网格里、同样大小。
8. **board 视图嵌入的 quay 面板自带一整套页头**（「quay status · READ-ONLY · Driver running · Last synced … · Refresh」），与驾驶舱页头重复，像是把另一个页面塞进来。

方案：
1. 手机宽度（< 768px）下项目列表折叠为页头里的项目下拉 / 横向滚动条；磁贴单列铺满；所有可点元素 ≥ 44×44。
2. 底部状态条与输入框使用实心背景，主内容区底部留出等高的内边距，最后一块磁贴可完整滚出。
3. 状态条只显示人能读的信息：「焦点：① quay-fleet · 来自 手机」；URI、首帧耗时与设备 id 收进一个可展开的「详情」或只在开发构建 / `?debug=1` 下显示。
4. 去掉 READ-ONLY 徽标（驾驶舱页头与嵌入面板都去掉），或在确认发送不可用时才显示「只读」。
5. 所有正文与辅助文字对比度 ≥ 4.5（含徽标），最小字号 12px。
6. 二维码收成页头里的一个「手机遥控」小按钮，点开弹出二维码；已有遥控器连接时按钮显示「已连接」。
7. 未登记项目排在已登记项目之后，收进一个可折叠的「未登记到 quay-fleet（4）」分组。
8. board 视图里嵌入的 quay 面板去掉自己的页头（状态与刷新并入驾驶舱页头），只保留内容区。

## AC

- [ ] AC1: `npx playwright test e2e/cockpit-visual.spec.ts` exit 0（在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 中更新该文件条目并写明实测）——手机视口 390×844：页面无横向溢出；所有可见按钮 / 链接 / 输入的包围盒 ≥ 44×44；主内容最后一块磁贴可滚动到完全可见且不与状态条或输入框重叠（读包围盒判定）；正文与辅助文字对比度 ≥ 4.5、字号 ≥ 12px（同一读取函数）；控制臂：把状态条背景强制设为透明后，重叠判定读红。
- [ ] AC2: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——状态条默认文本不含 `quay://`、不含「first frame」、不含设备短 id；`?debug=1` 下包含；页面不渲染「READ-ONLY」；二维码默认不渲染，点「手机遥控」后渲染；未登记项目在已登记项目之后的折叠分组里。
- [ ] AC3: `npx vitest run src/modules/quay/tests/QuayPanel.test.tsx` exit 0——嵌入模式下不渲染面板自带页头；独立模式（Quay tab）不变。
- [ ] AC4: `npm run typecheck` 通过；文案覆盖 12 个 locale。

## DoD

- **浏览器实际操作 + 截图（必做）**：PC 1440×900 与手机 390×844 下的 fleet 视图、board 视图、遥控器，修改前后对照（存 `tmp/`）。
- 隔离实例必须关闭 residentRestore（`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`）。

## Touches

- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/CockpitRemote.tsx
- src/modules/cockpit/CockpitInput.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- e2e/cockpit-visual.spec.ts
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
- tasks/cockpit-mobile-layout-and-legibility.md


2026-10-24 用户确认：由 observation-wall-ui（观察墙 T5）取代；其中在新模型下仍成立的条目已并入该任务。
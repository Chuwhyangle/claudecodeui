---
id: cockpit-unregistered-project-click-feedback
title: 驾驶舱项目条：点击未登记 / 驱动不可用的项目无任何反馈，需置灰并给出原因，序号寻址与磁贴编号对齐
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

决策出处：2026-10-24 驾驶舱 UX 走查。项目条里点击未登记到 quay-fleet 或驱动不可用的项目（cantus、meta-cc、quay-dogfood-goal030、gap-official-dist-…）什么都不发生：不跳转、无回声、无置灰，而 fleet 卡片上同一批项目明确写着「DRIVER UNAVAILABLE / Not registered with quay-fleet」。用户无从判断是点坏了还是不可点。另外 fleet 磁贴的 ①–⑤ 序号只覆盖已登记项目，与项目条及数字键寻址的对应关系没有说明。

方案：
1. 项目条里不可聚焦的项目显示为明确的禁用态（降低对比但文字对比度仍 >= 4.5、`aria-disabled="true"`、不进 tab 顺序抖动），tooltip / title 写原因（未登记到 quay-fleet / 驱动不可用，来自 fleet-summary 的 reason）；
2. 点击仍可触发，产生「被拒」样式回声：原因 + 下一步（例如「未登记到 quay-fleet；运行 quay-fleet registry add 后刷新」），沿用已有的 refused 回声样式，不再静默；
3. 序号：数字键 / 口述序号只作用于已登记（可聚焦）项目，在 fleet 视图加一行说明或 tooltip「编号只给已登记项目」；按下未编号项目对应的数字时给出回声而非无反应。

相关但不同机制：`cockpit-stage-visual-attention-fixes`（已 done）处理强调色与序号标签大小；`observation-wall-ui`（已 done）把未登记项目收进折叠分组，但项目条点击反馈未覆盖。与 `cockpit-header-controls-and-badge-consistency`、`cockpit-board-and-fleet-readability-polish` 同改 CockpitStage.tsx，由调度器串行，不设 depends_on。

## AC

- [ ] AC1: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——fleet 摘要夹具含 1 个已登记、1 个未登记、1 个驱动不可用项目：后两者的项目条按钮带 `aria-disabled="true"` 与含原因的 title；已登记项目不带。
- [ ] AC2: 同一测试文件——点击未登记项目：视图与焦点不变，回声出现且为 refused 类型（data 属性），文本含原因与下一步；点击已登记项目照常进入 board（既有行为不弱化）。
- [ ] AC3: 同一测试文件——fleet 视图含说明「编号只给已登记项目」的文案节点；按未编号对应的数字键产生回声而非静默。
- [ ] AC4: `npx vitest run src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts` exit 0——新增文案键在 12 个 locale 齐全。
- [ ] AC5: `npm run typecheck` 通过。

## DoD

- **MCP 浏览器实际操作 + 截图（必做，存 `tmp/`）**：真实 fleet 数据的隔离实例上，点击 cantus、meta-cc、quay-dogfood-goal030，截图禁用态、tooltip 与 refused 回声；点击已登记项目对照截图。PC 1440×900 与手机 390×844 各一套。
- 场景运行器：跑 `node scripts/ui-scenario.mjs e2e/scenarios/cockpit-mode-switch.json` 确认无回归并贴报告。
- 隔离实例必须关闭 residentRestore：`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`（或用 `scripts/isolated-instance.sh`）。

## Touches

- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/CockpitPage.tsx
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
- tasks/cockpit-unregistered-project-click-feedback.md

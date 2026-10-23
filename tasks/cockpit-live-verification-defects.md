---
id: cockpit-live-verification-defects
title: 驾驶舱实测缺陷：fleet CLI 缺失静默降级、方向键语义错乱、输入框抢焦点、预览显示会话 UUID、来源分不出设备
status: todo
labels:
  - cockpit
  - ui
  - regression
parent: null
children: []
extra: {}
depends_on:
  - cockpit-phone-remote-input
---
## Proposal

决策出处：2026-10-23 对线上构建的实测（同一份 `dist`/`dist-server` 起隔离实例 :3141，复制的数据库，headless 浏览器两窗口驱动）。中枢跨设备同步、意图切视图、发送预览与取消都已实际可用；以下是实测发现的缺陷。

1. **fleet CLI 缺失时静默降级**：线上 :3001 的服务环境没有 `QUAY_FLEET_BIN`，`quay-fleet` 也不在 PATH 上。结果 `fleet-summary` 里所有项目 `fleetProjectId: null`，驾驶舱所有磁贴都显示「未登记到 quay-fleet」、没有一个可聚焦，解引用一律 `unknown-project`——界面看起来像「项目都没登记」，真实原因是「找不到 fleet CLI」。（运维侧已补 systemd drop-in `70-quay-fleet.conf`，待重启生效；本条只修产品行为。）
2. **方向键语义错乱**：fleet 视图（3 列网格）在 quay-fleet（第 1 行第 1 列）上按 → 不动，按 ↓ 却移到右边的 claudecodeui；board 视图里 ↓ 从 ① 移到同一行的 ②；← 无效。上下被当成线性前后，左右没有实现。
3. **输入框加载即抢焦点**：页面加载后 `document.activeElement` 是输入框，方向键全部进了输入框（按设计输入框聚焦时方向键归它），用户第一次按方向键没有任何反应。
4. **发送预览显示会话 UUID**：预览为「→ claudecodeui / c5a57036-de6c-…：…」，看不出发给哪个会话；也没有标明目标来源（钉选 / 最近打开）。
5. **事件来源分不出设备**：桌面页与手机尺寸页的事件来源都显示「Chrome · Linux」，「来自手机」的回显没有意义。

方案：
1. 服务端区分「fleet CLI 不可用」与「项目未登记」：`fleet-summary` 返回顶层 `fleet: {available: false, reason}`；驾驶舱在项目条上方显示一行「找不到 quay-fleet（设置 QUAY_FLEET_BIN）」，磁贴不再逐个显示「未登记」。
2. 方向键按显示端上报的 `display.pos {row, column}` 做二维吸附：→/← 同行相邻列，↓/↑ 同列相邻行（目标行没有该列时取最近列）；越界不动。
3. 输入框不自动聚焦；页面加载后焦点在舞台。按 `/` 或点击进入输入框（按住空格说话不受影响）。
4. 预览显示目标会话的标题（无标题时显示「未命名会话」+ 短 id），并标明来源「已钉选」/「最近打开」。
5. 事件来源使用设备的可读名：沿用 ui-client-registry 的设备名；没有名字时按视口宽度给出「手机」/「桌面」并附短 deviceId。

## AC

- [ ] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/quay-fleet-project-id.test.ts` exit 0——fleet CLI 不存在时 `fleet-summary` 顶层 `fleet.available === false` 且带 reason；CLI 可用但项目无匹配时 `fleet.available === true` 且该项目 `fleetProjectId: null`。
- [ ] AC2: `npx tsx --tsconfig server/tsconfig.json --test server/modules/cockpit/tests/cockpit-reducer.test.ts` exit 0——3 列网格夹具：(1,1) 按 → 到 (1,2)、按 ↓ 到 (2,1)；(1,2) 按 ← 回 (1,1)；最后一行不满时 ↓ 取最近列；越界不动。
- [ ] AC3: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——加载后输入框不是 activeElement，第一次按 → 即移动焦点；`fleet.available === false` 时显示一行 CLI 缺失提示且不逐个显示「未登记」；预览显示会话标题与来源标签，不出现 UUID 形态的会话 id（无标题时只出现短 id）。
- [ ] AC4: `npm run typecheck` 通过。

## DoD

- **MCP 浏览器（或独立 Playwright）实际操作 + 截图（必做）**：fleet 视图上依次按 → ↓ ← ↑，截图并读回焦点 URI 序列；无 `QUAY_FLEET_BIN` 启动一个隔离实例，截图 CLI 缺失提示；一桌面一手机两窗口，手机发起的事件在桌面回显为「手机」。截图存 `tmp/`。
- 场景运行器可用时补场景与报告。

## Touches

- server/modules/quay/quay-fleet-project-id.ts
- server/modules/quay/quay.service.ts
- server/modules/quay/tests/quay-fleet-project-id.test.ts
- server/modules/cockpit/cockpit.reducer.ts
- server/modules/cockpit/cockpit-hub.service.ts
- server/modules/cockpit/tests/cockpit-reducer.test.ts
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/CockpitInput.tsx
- src/modules/cockpit/cockpitRouting.ts
- src/modules/cockpit/hooks/useCockpitHub.ts
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
- tasks/cockpit-live-verification-defects.md
